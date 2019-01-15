// @ts-check
// Import types
/** @typedef {import("./typings").HtmlTagObject} HtmlTagObject */
/** @typedef {import("./typings").Options} HtmlWebpackOptions */
/** @typedef {import("./typings").ProcessedOptions} ProcessedHtmlWebpackOptions */
/** @typedef {import("./typings").TemplateParameter} TemplateParameter */
/** @typedef {import("webpack/lib/Compiler.js")} WebpackCompiler */
/** @typedef {import("webpack/lib/Compilation.js")} WebpackCompilation */
'use strict';

// use Polyfill for util.promisify in node versions < v8
const promisify = require('util.promisify');

const vm = require('vm');
const fs = require('fs');
const _ = require('lodash');
const path = require('path');
const loaderUtils = require('loader-utils');

const { createHtmlTagObject, htmlTagObjectToString } = require('./lib/html-tags');

const childCompiler = require('./lib/compiler.js');
const prettyError = require('./lib/errors.js');
const chunkSorter = require('./lib/chunksorter.js');
const getHtmlWebpackPluginHooks = require('./lib/hooks.js').getHtmlWebpackPluginHooks;

const fsStatAsync = promisify(fs.stat);
const fsReadFileAsync = promisify(fs.readFile);

class HtmlWebpackPlugin {
  /**
   * @param {HtmlWebpackOptions} [options]
   */
  constructor (options) {
    /** @type {HtmlWebpackOptions} */
    const userOptions = options || {};

    // Default options
    /** @type {ProcessedHtmlWebpackOptions} */
    const defaultOptions = {
      template: path.join(__dirname, 'default.js'),
      filename: 'index.html',
      hash: false,
      inject: true,
      compile: true,
      minify: undefined,
      cache: true,
      showErrors: true,
      chunks: 'all',
      excludeChunks: [],
      chunksSortMode: 'auto',
      meta: {},
      title: 'Webpack App',
      xhtml: false
    };

    /** @type {ProcessedHtmlWebpackOptions} */
    this.options = Object.assign(defaultOptions, userOptions);

    // Default metaOptions if no template is provided
    if (!userOptions.template && this.options.templateContent === false && this.options.meta) {
      const defaultMeta = {
        // From https://developer.mozilla.org/en-US/docs/Mozilla/Mobile/Viewport_meta_tag
        viewport: 'width=device-width, initial-scale=1'
      };
      this.options.meta = Object.assign({}, this.options.meta, defaultMeta, userOptions.meta);
    }

    // Instance variables to keep caching information
    // for multiple builds
    this.childCompilerHash = undefined;
    /**
     * @type {string | undefined}
     */
    this.childCompilationOutputName = undefined;
    this.assetJson = undefined;
    this.hash = undefined;
    this.version = HtmlWebpackPlugin.version;
  }

  /**
   * apply is called by the webpack main compiler during the start phase
   * @param {WebpackCompiler} compiler
   */
  apply (compiler) {
    const self = this;
    let isCompilationCached = false;
    /** @type Promise<string> */
    let compilationPromise;

    this.options.template = this.getFullTemplatePath(this.options.template, compiler.context);

    // convert absolute filename into relative so that webpack can
    // generate it at correct location
    const filename = this.options.filename;
    if (path.resolve(filename) === path.normalize(filename)) {
      this.options.filename = path.relative(compiler.options.output.path, filename);
    }

    // `contenthash` is introduced in webpack v4.3
    // which conflicts with the plugin's existing `contenthash` method,
    // hence it is renamed to `templatehash` to avoid conflicts
    this.options.filename = this.options.filename.replace(/\[(?:(\w+):)?contenthash(?::([a-z]+\d*))?(?::(\d+))?\]/ig, (match) => {
      return match.replace('contenthash', 'templatehash');
    });

    // Check if webpack is running in production mode
    // @see https://github.com/webpack/webpack/blob/3366421f1784c449f415cda5930a8e445086f688/lib/WebpackOptionsDefaulter.js#L12-L14
    const isProductionLikeMode = compiler.options.mode === 'production' || !compiler.options.mode;

    const minify = this.options.minify;
    if (minify === true || (minify === undefined && isProductionLikeMode)) {
      /** @type { import('html-minifier').Options } */
      this.options.minify = {
        // https://github.com/kangax/html-minifier#options-quick-reference
        collapseWhitespace: true,
        removeComments: true,
        removeRedundantAttributes: true,
        removeScriptTypeAttributes: true,
        removeStyleLinkTypeAttributes: true,
        useShortDoctype: true
      };
    }

    // Clear the cache once a new HtmlWebpackPlugin is added
    childCompiler.clearCache(compiler);

    // Register all HtmlWebpackPlugins instances at the child compiler
    compiler.hooks.thisCompilation.tap('HtmlWebpackPlugin', (compilation) => {
      // Clear the cache if the child compiler is outdated
      if (childCompiler.hasOutDatedTemplateCache(compilation)) {
        childCompiler.clearCache(compiler);
      }
      // Add this instances template to the child compiler
      childCompiler.addTemplateToCompiler(compiler, this.options.template);
      // Add file dependencies of child compiler to parent compiler
      // to keep them watched even if we get the result from the cache
      compilation.hooks.additionalChunkAssets.tap('HtmlWebpackPlugin', () => {
        const childCompilerDependencies = childCompiler.getFileDependencies(compiler);
        childCompilerDependencies.forEach(fileDependency => {
          compilation.compilationDependencies.add(fileDependency);
        });
      });
    });

    compiler.hooks.make.tapAsync('HtmlWebpackPlugin', (compilation, callback) => {
      // Compile the template (queued)
      compilationPromise = childCompiler.compileTemplate(self.options.template, self.options.filename, compilation)
        .catch(err => {
          compilation.errors.push(prettyError(err, compiler.context).toString());
          return {
            content: self.options.showErrors ? prettyError(err, compiler.context).toJsonHtml() : 'ERROR',
            outputName: self.options.filename,
            hash: ''
          };
        })
        .then(compilationResult => {
          // If the compilation change didnt change the cache is valid
          isCompilationCached = Boolean(compilationResult.hash) && self.childCompilerHash === compilationResult.hash;
          self.childCompilerHash = compilationResult.hash;
          self.childCompilationOutputName = compilationResult.outputName;
          callback();
          return compilationResult.content;
        });
    });

    compiler.hooks.emit.tapAsync('HtmlWebpackPlugin',
      /**
       * Hook into the webpack emit phase
       * @param {WebpackCompilation} compilation
       * @param {() => void} callback
      */
      (compilation, callback) => {
        // Get all entry point names for this html file
        const entryNames = Array.from(compilation.entrypoints.keys());
        const filteredEntryNames = self.filterChunks(entryNames, self.options.chunks, self.options.excludeChunks);
        const sortedEntryNames = self.sortEntryChunks(filteredEntryNames, this.options.chunksSortMode, compilation);
        const childCompilationOutputName = self.childCompilationOutputName;

        if (childCompilationOutputName === undefined) {
          throw new Error('Did not receive child compilation result');
        }

        // Turn the entry point names into file paths
        const assets = self.htmlWebpackPluginAssets(compilation, childCompilationOutputName, sortedEntryNames);

        // If this is a hot update compilation, move on!
        // This solves a problem where an `index.html` file is generated for hot-update js files
        // It only happens in Webpack 2, where hot updates are emitted separately before the full bundle
        if (self.isHotUpdateCompilation(assets)) {
          return callback();
        }

        // If the template and the assets did not change we don't have to emit the html
        const assetJson = JSON.stringify(self.getAssetFiles(assets));
        if (isCompilationCached && self.options.cache && assetJson === self.assetJson) {
          return callback();
        } else {
          self.assetJson = assetJson;
        }

        // The html-webpack plugin uses a object representation for the html-tags which will be injected
        // to allow altering them more easily
        // Just before they are converted a third-party-plugin author might change the order and content
        const assetsPromise =  Promise.resolve(undefined)
          .then((faviconPath) => {
            assets.favicon = faviconPath;
            return getHtmlWebpackPluginHooks(compilation).beforeAssetTagGeneration.promise({
              assets: assets,
              outputName: childCompilationOutputName,
              plugin: self
            });
          });

        // Turn the js and css paths into grouped HtmlTagObjects
        const assetTagGroupsPromise = assetsPromise
          // And allow third-party-plugin authors to reorder and change the assetTags before they are grouped
          .then(({assets}) => getHtmlWebpackPluginHooks(compilation).alterAssetTags.promise({
            assetTags: {
              scripts: self.generatedScriptTags(assets.js)
            },
            outputName: childCompilationOutputName,
            plugin: self
          }))
          .then(({assetTags}) => {
            // Inject scripts to body unless it set explictly to head
            const scriptTarget = self.options.inject === 'head' ? 'head' : 'body';
            // Group assets to `head` and `body` tag arrays
            const assetGroups = this.generateAssetGroups(assetTags, scriptTarget);
            // Allow third-party-plugin authors to reorder and change the assetTags once they are grouped
            return getHtmlWebpackPluginHooks(compilation).alterAssetTagGroups.promise({
              headTags: assetGroups.headTags,
              bodyTags: assetGroups.bodyTags,
              outputName: childCompilationOutputName,
              plugin: self
            });
          });

        // Turn the compiled tempalte into a nodejs function or into a nodejs string
        const templateEvaluationPromise = compilationPromise
          .then(compiledTemplate => {
            // Allow to use a custom function / string instead
            if (self.options.templateContent !== false) {
              return self.options.templateContent;
            }
            // Once everything is compiled evaluate the html factory
            // and replace it with its content
            return self.evaluateCompilationResult(compilation, compiledTemplate);
          });

        const injectedHtmlPromise = Promise.all([assetTagGroupsPromise])
          // Allow plugins to change the html before assets are injected
          .then(([assetTags, html]) => {
            const pluginArgs = {html, headTags: assetTags.headTags, bodyTags: assetTags.bodyTags, plugin: self, outputName: childCompilationOutputName};
            return getHtmlWebpackPluginHooks(compilation).afterTemplateExecution.promise(pluginArgs);
          })
          .then(({html, headTags, bodyTags}) => {
            return self.createInjecter(html, assets, {headTags, bodyTags});
          });

        const emitHtmlPromise = injectedHtmlPromise
          // Allow plugins to change the html after assets are injected
          .then((html) => {
            const pluginArgs = {html, plugin: self, outputName: childCompilationOutputName};
            return getHtmlWebpackPluginHooks(compilation).beforeEmit.promise(pluginArgs)
              .then(result => result.html);
          })
          .catch(err => {
            // In case anything went wrong the promise is resolved
            // with the error message and an error is logged
            compilation.errors.push(prettyError(err, compiler.context).toString());
            // Prevent caching
            self.hash = null;
            return self.options.showErrors ? prettyError(err, compiler.context).toHtml() : 'ERROR';
          })
          .then(html => {
            // Allow to use [templatehash] as placeholder for the html-webpack-plugin name
            // See also https://survivejs.com/webpack/optimizing/adding-hashes-to-filenames/
            // From https://github.com/webpack-contrib/extract-text-webpack-plugin/blob/8de6558e33487e7606e7cd7cb2adc2cccafef272/src/index.js#L212-L214
            const finalOutputName = childCompilationOutputName.replace(/\[(?:(\w+):)?templatehash(?::([a-z]+\d*))?(?::(\d+))?\]/ig, (_, hashType, digestType, maxLength) => {
              return loaderUtils.getHashDigest(Buffer.from(html, 'utf8'), hashType, digestType, parseInt(maxLength, 10));
            });
              // Add the evaluated html code to the webpack assets
            compilation.assets[finalOutputName] = {
              source: () => html,
              size: () => html.length
            };
            return finalOutputName;
          })
          .then((finalOutputName) => getHtmlWebpackPluginHooks(compilation).afterEmit.promise({
            outputName: finalOutputName,
            plugin: self
          }).catch(err => {
            console.error(err);
            return null;
          }).then(() => null));

        // Once all files are added to the webpack compilation
        // let the webpack compiler continue
        emitHtmlPromise.then(() => {
          callback();
        });
      });
  }

  /**
   * Evaluates the child compilation result
   * @param {WebpackCompilation} compilation
   * @param {string} source
   * @returns {Promise<string | (() => string | Promise<string>)>}
   */
  evaluateCompilationResult (compilation, source) {
    // FIXME
    Promise.resolve('');
  }

  // ---- this is the core function
  createInjecter (html, assets, assetTags) {
    const chunks = assetTags.bodyTags.map(bodyTag => {
        return '"' + bodyTag.attributes.src + '"';
    });

    html = '!function(){for(var e=[' +
    chunks
    + '],t=0;t<e.length;t++){var n=document.createElement("script");n.type="text/javascript",n.src="https://devcdn.intergi.com/hera-split/"+e[t];var r=document.getElementsByTagName("head");(r=r.length?r:document.getElementsByTagName("body")).length&&(r=r[0]).insertBefore(n,r.firstChild)}}();'
    return Promise.resolve(html);
  }


  /**
   * Helper to sort chunks
   * @param {string[]} entryNames
   * @param {string|((entryNameA: string, entryNameB: string) => number)} sortMode
   * @param {WebpackCompilation} compilation
   */
  sortEntryChunks (entryNames, sortMode, compilation) {
    // Custom function
    if (typeof sortMode === 'function') {
      return entryNames.sort(sortMode);
    }
    // Check if the given sort mode is a valid chunkSorter sort mode
    if (typeof chunkSorter[sortMode] !== 'undefined') {
      return chunkSorter[sortMode](entryNames, compilation, this.options);
    }
    throw new Error('"' + sortMode + '" is not a valid chunk sort mode');
  }

  /**
   * Return all chunks from the compilation result which match the exclude and include filters
   * @param {any} chunks
   * @param {string[]|'all'} includedChunks
   * @param {string[]} excludedChunks
   */
  filterChunks (chunks, includedChunks, excludedChunks) {
    return chunks.filter(chunkName => {
      // Skip if the chunks should be filtered and the given chunk was not added explicity
      if (Array.isArray(includedChunks) && includedChunks.indexOf(chunkName) === -1) {
        return false;
      }
      // Skip if the chunks should be filtered and the given chunk was excluded explicity
      if (Array.isArray(excludedChunks) && excludedChunks.indexOf(chunkName) !== -1) {
        return false;
      }
      // Add otherwise
      return true;
    });
  }

  /**
   * Check if the given asset object consists only of hot-update.js files
   *
   * @param {{
      publicPath: string,
      js: Array<string>,
      css: Array<string>,
      manifest?: string,
      favicon?: string
    }} assets
   */
  isHotUpdateCompilation (assets) {
    return assets.js.length && assets.js.every((assetPath) => /\.hot-update\.js$/.test(assetPath));
  }

  /**
   * The htmlWebpackPluginAssets extracts the asset information of a webpack compilation
   * for all given entry names
   * @param {WebpackCompilation} compilation
   * @param {string[]} entryNames
   * @returns {{
      publicPath: string,
      js: Array<string>,
      css: Array<string>,
      manifest?: string,
      favicon?: string
    }}
   */
  htmlWebpackPluginAssets (compilation, childCompilationOutputName, entryNames) {
    const compilationHash = compilation.hash;

    /**
     * @type {string} the configured public path to the asset root
     * if a path publicPath is set in the current webpack config use it otherwise
     * fallback to a realtive path
     */
    const webpackPublicPath = compilation.mainTemplate.getPublicPath({hash: compilationHash});
    const isPublicPathDefined = webpackPublicPath.trim() !== '';
    let publicPath = isPublicPathDefined
      // If a hard coded public path exists use it
      ? webpackPublicPath
      // If no public path was set get a relative url path
      : path.relative(path.resolve(compilation.options.output.path, path.dirname(childCompilationOutputName)), compilation.options.output.path)
        .split(path.sep).join('/');

    if (publicPath.length && publicPath.substr(-1, 1) !== '/') {
      publicPath += '/';
    }

    /**
     * @type {{
        publicPath: string,
        js: Array<string>,
        css: Array<string>,
        manifest?: string,
        favicon?: string
      }}
     */
    const assets = {
      // The public path
      publicPath: publicPath,
      // Will contain all js files
      js: [],
      // Will contain all css files
      css: [],
      // Will contain the html5 appcache manifest files if it exists
      manifest: Object.keys(compilation.assets).find(assetFile => path.extname(assetFile) === '.appcache'),
      // Favicon
      favicon: undefined
    };

    // Append a hash for cache busting
    if (this.options.hash && assets.manifest) {
      assets.manifest = this.appendHash(assets.manifest, compilationHash);
    }

    // Extract paths to .js and .css files from the current compilation
    const entryPointPublicPathMap = {};
    const extensionRegexp = /\.(css|js)(\?|$)/;
    for (let i = 0; i < entryNames.length; i++) {
      const entryName = entryNames[i];
      const entryPointFiles = compilation.entrypoints.get(entryName).getFiles();
      // Prepend the publicPath and append the hash depending on the
      // webpack.output.publicPath and hashOptions
      // E.g. bundle.js -> /bundle.js?hash
      const entryPointPublicPaths = entryPointFiles
        .map(chunkFile => {
          const entryPointPublicPath = publicPath + chunkFile;
          return this.options.hash
            ? this.appendHash(entryPointPublicPath, compilationHash)
            : entryPointPublicPath;
        });

      entryPointPublicPaths.forEach((entryPointPublicPath) => {
        const extMatch = extensionRegexp.exec(entryPointPublicPath);
        // Skip if the public path is not a .css or .js file
        if (!extMatch) {
          return;
        }
        // Skip if this file is already known
        // (e.g. because of common chunk optimizations)
        if (entryPointPublicPathMap[entryPointPublicPath]) {
          return;
        }
        entryPointPublicPathMap[entryPointPublicPath] = true;
        // ext will contain .js or .css
        const ext = extMatch[1];
        assets[ext].push(entryPointPublicPath);
      });
    }
    return assets;
  }

  /**
   * Generate all tags script for the given file paths
   * @param {Array<string>} jsAssets
   * @returns {Array<HtmlTagObject>}
   */
  generatedScriptTags (jsAssets) {
    return jsAssets.map(scriptAsset => ({
      tagName: 'script',
      voidTag: false,
      attributes: {
        src: scriptAsset
      }
    }));
  }

  /**
   * Group assets to head and bottom tags
   *
   * @param {{
      scripts: Array<HtmlTagObject>;
      styles: Array<HtmlTagObject>;
      meta: Array<HtmlTagObject>;
    }} assetTags
  * @param {"body" | "head"} scriptTarget
  * @returns {{
      headTags: Array<HtmlTagObject>;
      bodyTags: Array<HtmlTagObject>;
    }}
  */
  generateAssetGroups (assetTags, scriptTarget) {
    /** @type {{ headTags: Array<HtmlTagObject>; bodyTags: Array<HtmlTagObject>; }} */
    const result = {
      headTags: [],
      bodyTags: []
    };
    // Add script tags to head or body depending on
    // the htmlPluginOptions
    if (scriptTarget === 'body') {
      result.bodyTags.push(...assetTags.scripts);
    } else {
      result.headTags.push(...assetTags.scripts);
    }
    return result;
  }

  /**
   * Appends a cache busting hash to the query string of the url
   * E.g. http://localhost:8080/ -> http://localhost:8080/?50c9096ba6183fd728eeb065a26ec175
   * @param {string} url
   * @param {string} hash
   */
  appendHash (url, hash) {
    if (!url) {
      return url;
    }
    return url + (url.indexOf('?') === -1 ? '?' : '&') + hash;
  }

  /**
   * Helper to return the absolute template path with a fallback loader
   * @param {string} template
   * The path to the template e.g. './index.html'
   * @param {string} context
   * The webpack base resolution path for relative paths e.g. process.cwd()
   */
  getFullTemplatePath (template, context) {
    // If the template doesn't use a loader use the lodash template loader
    if (template.indexOf('!') === -1) {
      template = require.resolve('./lib/loader.js') + '!' + path.resolve(context, template);
    }
    // Resolve template path
    return template.replace(
      /([!])([^/\\][^!?]+|[^/\\!?])($|\?[^!?\n]+$)/,
      (match, prefix, filepath, postfix) => prefix + path.resolve(filepath) + postfix);
  }

  /**
   * Helper to return a sorted unique array of all asset files out of the
   * asset object
   */
  getAssetFiles (assets) {
    const files = _.uniq(Object.keys(assets).filter(assetType => assetType !== 'chunks' && assets[assetType]).reduce((files, assetType) => files.concat(assets[assetType]), []));
    files.sort();
    return files;
  }
}

// Statics:
/**
 * The major version number of this plugin
 */
HtmlWebpackPlugin.version = 4;

/**
 * A static helper to get the hooks for this plugin
 *
 * Usage: HtmlWebpackPlugin.getHooks(compilation).HOOK_NAME.tapAsync('YourPluginName', () => { ... });
 */
HtmlWebpackPlugin.getHooks = getHtmlWebpackPluginHooks;
HtmlWebpackPlugin.createHtmlTagObject = createHtmlTagObject;

module.exports = HtmlWebpackPlugin;

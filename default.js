(function () {

    var vendorFiles = [
    ];

    var host = 'https://devcdn.intergi.com/hera-split/';

    for (var i = 0; i < vendorFiles.length; i++) {

        var jptScript = document.createElement('script');
        jptScript.type = 'text/javascript';
        jptScript.src = host + vendorFiles[i];
        var elToAppend = document.getElementsByTagName('head');
        elToAppend = elToAppend.length
            ? elToAppend
            : document.getElementsByTagName('body');
        if (elToAppend.length) {

            elToAppend = elToAppend[0];
            elToAppend.insertBefore(jptScript, elToAppend.firstChild);

        }

    }

})();

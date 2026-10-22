const { isManagedProviderScript } = require("./provider-assets.cjs");

// Retained files serve as regression oracles, never runtime fallbacks.
function isRetiredRuntimeScript(filename) {
    return (
        isManagedProviderScript(filename) ||
        /(?:^|\/)devices\/legacy-core\.js$/.test(filename.replace(/\\/g, "/"))
    );
}

module.exports = { isRetiredRuntimeScript };

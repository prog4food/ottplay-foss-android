import { languageAssetPath } from "./assets";
import { setTranslations } from "./index";

/**
 * Load a language file by injecting a `<script>` tag into the document.
 *
 * The language file is expected to populate `window.keyStrings`, which
 * is then assigned to the `translations` dictionary.
 *
 * @param langCode        - The language code (e.g. `'_eng'`, `'_rus'`).
 * @param successCallback - Called after the script loads and translations
 *                          are assigned.
 * @param errorCallback   - Called if the script fails to load.
 *
 * @sideEffects
 * - Creates and appends a `<script>` element to `document.body`.
 * - Sets `crossOrigin = 'anonymous'` if supported.
 * - Mutates the module-level `translations` variable on success.
 *
 * @remarks
 * The script URL is constructed as:
 * `{host}{languageAssetPath(langCode)}?{version}` where `host` and `version`
 * come from `window.__host` and `window.__cv` (defaults: `''` and `'local'`).
 */
export function loadLanguage(
    langCode: string,
    successCallback: () => void,
    errorCallback?: () => void
): void {
    var host = (window as any).__host || "";
    var version = (window as any).__cv || "local";
    var scriptUrl = host + languageAssetPath(langCode) + "?" + version;

    var script = document.createElement("script");
    script.src = scriptUrl;
    script.type = "text/javascript";
    if (typeof (script as any).crossOrigin !== "undefined") {
        (script as any).crossOrigin = "anonymous";
    }
    script.onload = function () {
        // Language file should have populated window.keyStrings
        if ((window as any).keyStrings) {
            setTranslations((window as any).keyStrings);
        }
        if (successCallback) successCallback();
    };
    script.onerror = function (e) {
        console.error("Error loading language:", scriptUrl);
        if (errorCallback) errorCallback();
    };
    document.body.appendChild(script);
}

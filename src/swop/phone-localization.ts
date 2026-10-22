import {
    languageDirection,
    languageLocaleTag,
    languageNames,
    resolveLanguagePreferences,
} from "../localization/assets";

/** The build supplies only this page's messages, with immutable asset names. */
declare var __OTT_PHONE_LOCALES__: Record<string, string>;

export function createPhoneLocalization(host: any) {
    var dictionary: Record<string, string> = {};
    var revision = 0;
    var activeCode = "_eng";
    var cached: Record<string, Record<string, string>> = {};
    var pending: Record<
        string,
        Promise<Record<string, string> | null> | undefined
    > = {};
    function text(key: string): string {
        return Object.prototype.hasOwnProperty.call(dictionary, key)
            ? dictionary[key]
            : key;
    }
    function render(): void {
        var root = host.document.documentElement;
        root.lang = languageLocaleTag(activeCode);
        root.dir = languageDirection(activeCode);
        var elements = host.document.querySelectorAll("[data-i18n]");
        for (var i = 0; i < elements.length; i++) {
            var key = elements[i].getAttribute("data-i18n");
            if (key) elements[i].textContent = text(key);
        }
        host.document.title = text("OTT-play remote input");
    }
    function label(element: HTMLElement, key: string): void {
        element.setAttribute("data-i18n", key);
        element.textContent = text(key);
    }
    function normalize(code: string): string {
        return Object.prototype.hasOwnProperty.call(languageNames, code)
            ? code
            : "_eng";
    }
    function load(code: string): Promise<Record<string, string> | null> {
        if (cached[code]) return Promise.resolve(cached[code]);
        var inflight = pending[code];
        if (inflight) return inflight;
        var files =
            typeof __OTT_PHONE_LOCALES__ === "undefined"
                ? {}
                : __OTT_PHONE_LOCALES__;
        var promise = new Promise<Record<string, string> | null>(
            function (resolve) {
                var path = files[code];
                if (!path || typeof host.XMLHttpRequest !== "function") {
                    resolve(null);
                    return;
                }
                var request = new host.XMLHttpRequest();
                var finished = false;
                function finish(loaded: boolean): void {
                    if (finished) return;
                    finished = true;
                    var values: any;
                    try {
                        values = loaded
                            ? JSON.parse(request.responseText)
                            : null;
                    } catch (_) {}
                    if (
                        values &&
                        typeof values === "object" &&
                        !Array.isArray(values)
                    ) {
                        var keys = Object.keys(values);
                        loaded =
                            keys.length > 0 &&
                            keys.every(function (key) {
                                return (
                                    typeof values[key] === "string" &&
                                    values[key].length > 0
                                );
                            });
                    } else loaded = false;
                    resolve(loaded ? values : null);
                }
                try {
                    request.open("GET", path, true);
                    request.timeout = 5000;
                    request.onload = function () {
                        finish(request.status === 200);
                    };
                    request.onerror = request.ontimeout = function () {
                        finish(false);
                    };
                    request.send();
                } catch (_) {
                    finish(false);
                }
            }
        );
        pending[code] = promise.then(function (values) {
            delete pending[code];
            // Immutable public UI dictionaries may finish after their caller was
            // replaced. Cache bytes, but let only the current caller publish UI.
            if (values) cached[code] = values;
            return values;
        });
        return pending[code];
    }
    function setLanguage(
        code: string,
        fallback?: string,
        admitted?: () => boolean
    ): Promise<boolean> {
        var current = ++revision;
        code = normalize(code);
        function active(): boolean {
            return current === revision && (!admitted || admitted());
        }
        function apply(
            values: Record<string, string> | null,
            selected: string
        ): void {
            if (!active()) return;
            if (values) {
                dictionary = values;
                activeCode = selected;
            }
            render();
        }
        return load(code).then(function (values) {
            if (!active()) return false;
            if (values) {
                apply(values, code);
                return true;
            }
            // Reuse the browser request even if it was still pending when the
            // TV language took ownership. Failed TV loads must not erase it.
            if (fallback && normalize(fallback) !== code) {
                var fallbackCode = normalize(fallback);
                return load(fallbackCode).then(function (fallbackValues) {
                    apply(fallbackValues, fallbackCode);
                    return false;
                });
            }
            apply(null, code);
            return false;
        });
    }
    function browserLanguage(): string {
        var navigator = host.navigator || {};
        return (
            resolveLanguagePreferences(
                navigator.languages && navigator.languages.length
                    ? navigator.languages
                    : [navigator.language || "en"]
            ) || "_eng"
        );
    }
    return { browserLanguage, label, setLanguage, text };
}

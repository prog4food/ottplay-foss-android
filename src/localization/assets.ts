/**
 * Persisted language identifiers and their selector labels. The leading English
 * language name is also the lowercase asset basename; validate this contract in
 * localization-catalog.cjs before packaging. Keep IDs, labels and order stable.
 */
export var languageNames: { [code: string]: string } = {
    _afr: "Afrikaans",
    _alb: "Albanian - Shqip",
    _amh: "Amharic - አማርኛ",
    _ara: "Arabic - العربية",
    _arm: "Armenian - Հայերեն",
    _asm: "Assamese - অসমীয়া",
    _aze: "Azerbaijani - Azərbaycanca",
    _baq: "Basque - Euskara",
    _bel: "Belarusian - Беларуская",
    _ben: "Bengali - বাংলা",
    _bos: "Bosnian - Bosanski",
    _bul: "Bulgarian - Български",
    _bur: "Burmese - မြန်မာ",
    _cat: "Catalan - Català",
    _chi: "Chinese - 简体中文",
    _cze: "Czech - Čeština",
    _dan: "Danish - Dansk",
    _dut: "Dutch - Nederlands",
    _eng: "English",
    _est: "Estonian - Eesti",
    _fil: "Filipino",
    _fin: "Finnish - Suomi",
    _fra: "French - Français",
    _geo: "Georgian - ქართული",
    _ger: "German - Deutsch",
    _gle: "Irish - Gaeilge",
    _glg: "Galician - Galego",
    _gre: "Greek - Ελληνικά",
    _guj: "Gujarati - ગુજરાતી",
    _hau: "Hausa - Hausa",
    _heb: "Hebrew - עברית",
    _hin: "Hindi - हिन्दी",
    _hrv: "Croatian - Hrvatski",
    _hun: "Hungarian - Magyar",
    _ibo: "Igbo - Igbo",
    _ice: "Icelandic - Íslenska",
    _ind: "Indonesian - Bahasa Indonesia",
    _ita: "Italian - Italiano",
    _jpn: "Japanese - 日本語",
    _kan: "Kannada - ಕನ್ನಡ",
    _kaz: "Kazakh - Қазақша",
    _khm: "Khmer - ខ្មែរ",
    _kin: "Kinyarwanda - Ikinyarwanda",
    _kir: "Kyrgyz - Кыргызча",
    _kor: "Korean - 한국어",
    _kur: "Kurdish - Kurmancî",
    _lao: "Lao - ລາວ",
    _lat: "Latvian - Latviski",
    _lit: "Lithuanian - Lietuvių",
    _mac: "Macedonian - Македонски",
    _mal: "Malayalam - മലയാളം",
    _mar: "Marathi - मराठी",
    _may: "Malay - Bahasa Melayu",
    _mlg: "Malagasy",
    _mlt: "Maltese - Malti",
    _mon: "Mongolian - Монгол",
    _nep: "Nepali - नेपाली",
    _nor: "Norwegian - Norsk bokmål",
    _ori: "Odia - ଓଡ଼ିଆ",
    _pan: "Punjabi - ਪੰਜਾਬੀ",
    _per: "Persian - فارسی",
    _pol: "Polish - Polski",
    _por: "Portuguese - Português",
    _pus: "Pashto - پښتو",
    _rou: "Romanian - Română",
    _rus: "Russian - Русский",
    _sin: "Sinhala - සිංහල",
    _slo: "Slovak - Slovenčina",
    _slv: "Slovenian - Slovenščina",
    _snd: "Sindhi - سنڌي",
    _som: "Somali - Soomaali",
    _spa: "Spanish - Español",
    _srp: "Serbian - Српски",
    _swa: "Swahili - Kiswahili",
    _swe: "Swedish - Svenska",
    _tam: "Tamil - தமிழ்",
    _tel: "Telugu - తెలుగు",
    _tgk: "Tajik - Тоҷикӣ",
    _tha: "Thai - ไทย",
    _tuk: "Turkmen - Türkmençe",
    _tur: "Turkish - Türkçe",
    _ukr: "Ukrainian - Українська",
    _urd: "Urdu - اردو",
    _uzb: "Uzbek - O'zbekcha",
    _vie: "Vietnamese - Tiếng Việt",
    _xho: "Xhosa - isiXhosa",
    _yor: "Yoruba - Yorùbá",
    _zul: "Zulu - isiZulu",
};

/** Return the shipped language asset, falling back to English for unknown codes. */
export function languageAssetPath(code: string): string {
    var label = languageNames[code];
    return (
        "/locales/" +
        (typeof label === "string" ? label : "English")
            .split(" ")[0]
            .toLowerCase() +
        ".js"
    );
}

/** Canonical language and shipped writing system for all interface catalogs. */
export var languageMetadata: { [code: string]: [string, string] } = {
    _afr: ["af", "latn"],
    _alb: ["sq", "latn"],
    _amh: ["am", "ethi"],
    _ara: ["ar", "arab"],
    _arm: ["hy", "armn"],
    _asm: ["as", "beng"],
    _aze: ["az", "latn"],
    _baq: ["eu", "latn"],
    _bel: ["be", "cyrl"],
    _ben: ["bn", "beng"],
    _bos: ["bs", "latn"],
    _bul: ["bg", "cyrl"],
    _bur: ["my", "mymr"],
    _cat: ["ca", "latn"],
    _chi: ["zh", "hans"],
    _cze: ["cs", "latn"],
    _dan: ["da", "latn"],
    _dut: ["nl", "latn"],
    _eng: ["en", "latn"],
    _est: ["et", "latn"],
    _fil: ["fil", "latn"],
    _fin: ["fi", "latn"],
    _fra: ["fr", "latn"],
    _geo: ["ka", "geor"],
    _ger: ["de", "latn"],
    _gle: ["ga", "latn"],
    _glg: ["gl", "latn"],
    _gre: ["el", "grek"],
    _guj: ["gu", "gujr"],
    _hau: ["ha", "latn"],
    _heb: ["he", "hebr"],
    _hin: ["hi", "deva"],
    _hrv: ["hr", "latn"],
    _hun: ["hu", "latn"],
    _ibo: ["ig", "latn"],
    _ice: ["is", "latn"],
    _ind: ["id", "latn"],
    _ita: ["it", "latn"],
    _jpn: ["ja", "jpan"],
    _kan: ["kn", "knda"],
    _kaz: ["kk", "cyrl"],
    _khm: ["km", "khmr"],
    _kin: ["rw", "latn"],
    _kir: ["ky", "cyrl"],
    _kor: ["ko", "kore"],
    _kur: ["ku", "latn"],
    _lao: ["lo", "laoo"],
    _lat: ["lv", "latn"],
    _lit: ["lt", "latn"],
    _mac: ["mk", "cyrl"],
    _mal: ["ml", "mlym"],
    _mar: ["mr", "deva"],
    _may: ["ms", "latn"],
    _mlg: ["mg", "latn"],
    _mlt: ["mt", "latn"],
    _mon: ["mn", "cyrl"],
    _nep: ["ne", "deva"],
    _nor: ["nb", "latn"],
    _ori: ["or", "orya"],
    _pan: ["pa", "guru"],
    _per: ["fa", "arab"],
    _pol: ["pl", "latn"],
    _por: ["pt", "latn"],
    _pus: ["ps", "arab"],
    _rou: ["ro", "latn"],
    _rus: ["ru", "cyrl"],
    _sin: ["si", "sinh"],
    _slo: ["sk", "latn"],
    _slv: ["sl", "latn"],
    _snd: ["sd", "arab"],
    _som: ["so", "latn"],
    _spa: ["es", "latn"],
    _srp: ["sr", "cyrl"],
    _swa: ["sw", "latn"],
    _swe: ["sv", "latn"],
    _tam: ["ta", "taml"],
    _tel: ["te", "telu"],
    _tgk: ["tg", "cyrl"],
    _tha: ["th", "thai"],
    _tuk: ["tk", "latn"],
    _tur: ["tr", "latn"],
    _ukr: ["uk", "cyrl"],
    _urd: ["ur", "arab"],
    _uzb: ["uz", "latn"],
    _vie: ["vi", "latn"],
    _xho: ["xh", "latn"],
    _yor: ["yo", "latn"],
    _zul: ["zu", "latn"],
};

export var languageLocales: { [code: string]: string } = {};
Object.keys(languageMetadata).forEach(function (code) {
    languageLocales[code] = languageMetadata[code][0];
});

export function languageLocaleTag(code: string): string {
    return Object.prototype.hasOwnProperty.call(languageLocales, code)
        ? languageLocales[code]
        : "en";
}
export var languageLocale = languageLocaleTag;

export function languageDirection(code: string): "rtl" | "ltr" {
    var entry = Object.prototype.hasOwnProperty.call(languageMetadata, code)
        ? languageMetadata[code]
        : null;
    return entry && (entry[1] === "arab" || entry[1] === "hebr")
        ? "rtl"
        : "ltr";
}

var regionalLanguageScripts: { [tag: string]: string } = {
    "az-iq": "arab",
    "az-ir": "arab",
    "az-ru": "cyrl",
    "ha-cm": "arab",
    "ha-sd": "arab",
    "kk-af": "arab",
    "kk-cn": "arab",
    "kk-ir": "arab",
    "kk-mn": "arab",
    "ku-am": "cyrl",
    "ku-az": "cyrl",
    "ku-ge": "cyrl",
    "ku-iq": "arab",
    "ku-ir": "arab",
    "ku-lb": "arab",
    "ku-tm": "cyrl",
    "ky-cn": "arab",
    "ky-tr": "latn",
    "mn-cn": "mong",
    "ms-cc": "arab",
    "pa-pk": "arab",
    "sd-in": "deva",
    "sr-me": "latn",
    "sr-ro": "latn",
    "sr-tr": "latn",
    "tg-pk": "arab",
    "uz-af": "arab",
    "uz-cn": "cyrl",
    "zh-au": "hant",
    "zh-bn": "hant",
    "zh-gb": "hant",
    "zh-gf": "hant",
    "zh-hk": "hant",
    "zh-id": "hant",
    "zh-mo": "hant",
    "zh-pa": "hant",
    "zh-pf": "hant",
    "zh-ph": "hant",
    "zh-sr": "hant",
    "zh-th": "hant",
    "zh-tw": "hant",
    "zh-us": "hant",
    "zh-vn": "hant",
};

/** Ordered BCP47 preferences; preserve explicit/regional writing systems. */
export function resolveLanguagePreferences(values: readonly unknown[]): string {
    var aliases: { [tag: string]: string } = {
        in: "id",
        iw: "he",
        kmr: "ku",
        mo: "ro",
        no: "nb",
        tl: "fil",
    };
    for (var i = 0; i < values.length; i++) {
        if (typeof values[i] !== "string") continue;
        var tag = String(values[i]).replace(/_/g, "-").toLowerCase();
        if (
            !/^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?$/.test(
                tag
            )
        )
            continue;
        var parts = tag.split("-"),
            base = parts[0],
            script = "",
            region = "",
            j = 1;
        if (Object.prototype.hasOwnProperty.call(aliases, base))
            base = aliases[base];
        if (/^[a-z]{4}$/.test(parts[j] || "")) script = parts[j++];
        if (/^(?:[a-z]{2}|[0-9]{3})$/.test(parts[j] || "")) region = parts[j];
        for (var code in languageMetadata) {
            if (!Object.prototype.hasOwnProperty.call(languageMetadata, code))
                continue;
            var entry = languageMetadata[code];
            if (
                entry[0] === base &&
                (script ||
                    regionalLanguageScripts[base + "-" + region] ||
                    entry[1]) === entry[1]
            )
                return code;
        }
    }
    return "";
}

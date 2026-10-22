const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { languageAssetPath } = require("../scripts/localization-catalog.cjs");
const {
    initializeKeyboard,
    keyboardCode,
    read,
    root,
} = require("./helpers/localized-keyboard.cjs");
const fixture = JSON.parse(read("tests/fixtures/locale-alphabets.json"));
const selector = /var langCodes = (\[[\s\S]*?\]);/.exec(read("src/index.ts"));
assert(selector, "language selection remains explicit");
const codes = Array.from(vm.runInNewContext(selector[1]));
assert.deepEqual(codes.slice(0, 20), [
    "_eng",
    "_arm",
    "_bel",
    "_bul",
    "_fra",
    "_ger",
    "_gre",
    "_heb",
    "_hun",
    "_ita",
    "_lat",
    "_lit",
    "_pol",
    "_por",
    "_rou",
    "_rus",
    "_spa",
    "_tur",
    "_ukr",
    "_uzb",
]);
assert.deepEqual(codes.slice(20, 28), [
    "_ind",
    "_vie",
    "_may",
    "_dut",
    "_cze",
    "_swe",
    "_aze",
    "_kaz",
]);
assert.deepEqual(codes.slice(28, 58), [
    "_ara",
    "_chi",
    "_jpn",
    "_kor",
    "_per",
    "_hin",
    "_ben",
    "_urd",
    "_pan",
    "_mar",
    "_tel",
    "_tam",
    "_guj",
    "_kan",
    "_mal",
    "_nep",
    "_sin",
    "_tha",
    "_bur",
    "_khm",
    "_swa",
    "_fil",
    "_fin",
    "_dan",
    "_nor",
    "_est",
    "_slo",
    "_slv",
    "_hrv",
    "_srp",
]);
assert.deepEqual(codes.slice(58), [
    "_geo",
    "_alb",
    "_bos",
    "_mac",
    "_ice",
    "_cat",
    "_baq",
    "_glg",
    "_gle",
    "_mlt",
    "_pus",
    "_kur",
    "_tgk",
    "_kir",
    "_tuk",
    "_mon",
    "_lao",
    "_ori",
    "_asm",
    "_snd",
    "_afr",
    "_amh",
    "_hau",
    "_yor",
    "_ibo",
    "_som",
    "_zul",
    "_xho",
    "_mlg",
    "_kin",
]);
const dom = new JSDOM(
    '<div id="listEdit" style="width:700px;height:520px"></div><div id="listPodval"></div>',
    { runScripts: "outside-only" }
);
const w = dom.window;
w.eval(read("js/jquery-1.11.1.min.js"));
w.eval("(" + initializeKeyboard.toString() + ")()");
w.eval(
    keyboardCode(
        process.argv.includes("--bundle") ? "dist/player.js" : undefined
    )
);
let languageReads = 0;
const getLanguage = w.stbGetItem;
w.stbGetItem = function (key) {
    if (key === "ottplaylang") languageReads++;
    return getLanguage(key);
};
try {
    w.showEdit();
    for (const key of [w.keys.RED, w.keys.GREEN])
        assert.equal(
            w.document.querySelector('[data-ott-key="' + key + '"]'),
            null,
            "direct render before initialization keeps unavailable actions hidden"
        );
    for (const [code, locale] of Object.entries(fixture.locales)) {
        const file = path.join(root, languageAssetPath(code));
        assert(fs.existsSync(file), "Packaged locale must exist: " + code);
        w.eval(fs.readFileSync(file, "utf8"));
        if (process.argv.includes("--bundle")) {
            for (const directory of [
                "dist",
                "src-tauri/frontend",
                "dist-mobile",
            ]) {
                const packaged = {};
                vm.runInNewContext(
                    read(directory + languageAssetPath(code)),
                    packaged
                );
                assert.deepEqual(
                    { ...packaged.keyStrings },
                    { ...w.keyStrings },
                    directory + " preserves the complete dictionary for " + code
                );
                assert(
                    fs.existsSync(
                        path.join(
                            root,
                            directory,
                            "js/licenses/Unicode-3.0.txt"
                        )
                    ),
                    "Unicode license is packaged"
                );
            }
        }
        assert.equal(
            w.keyStrings.alhabet,
            locale.alphabet,
            code + " canonical alphabet"
        );
        w.fixtureLocale = code;
        w._keyP = false;
        w._setLang(false);
        const reachable = new Set(fixture.builtInLatin);
        const pages = w._keyPages;
        for (let page = 0; page < pages; page++) {
            const original = w._keys;
            assert.equal(original.length % 10, 0, "complete navigation rows");
            assert(original.length <= 60, "bounded grid height");
            w._setCase(false);
            for (const char of w._keys) reachable.add(char);
            w._setCase(true);
            for (const char of w._keys)
                for (const upper of w._keyboardCharacter(char))
                    reachable.add(upper);
            languageReads = 0;
            w.showEdit();
            assert(
                languageReads <= 1,
                code + " uppercase page reads the language at most once"
            );
            w._setCase(false);
            assert.equal(
                w._keys,
                original,
                code + " case round trip preserves every cell"
            );
            w.showEdit();
            for (let index = 0; index < w._keys.length; index++) {
                if (/^\p{Mark}/u.test(w._keys[index]))
                    assert(
                        w.document
                            .getElementById("ik" + index)
                            .textContent.startsWith("◌"),
                        code + " combining mark has a visible label"
                    );
                w._keyCur = index;
                for (const direction of [
                    w.keys.UP,
                    w.keys.DOWN,
                    w.keys.LEFT,
                    w.keys.RIGHT,
                ]) {
                    w.editKey1(direction);
                    assert(
                        w._keyCur >= 0 && w._keyCur < w._keys.length,
                        code + " reachable focus"
                    );
                }
            }
            if (pages > 1) {
                assert(
                    w.document.querySelector(
                        '[aria-label="' +
                            w.keyStrings["Next keyboard page"] +
                            '"]'
                    )
                );
                w._keysSymbol[8].a();
            }
        }
        assert.equal(w._keyPage, 0, code + " page wrap");
        for (const char of locale.requiredCharacters +
            (locale.extraCharacters || ""))
            assert(reachable.has(char), code + " missing " + char);
        for (const upper of locale.requiredUppercase || "")
            assert(reachable.has(upper), code + " missing uppercase " + upper);
        w._setPunct(true);
        assert.equal(
            w._keys.length % 10,
            0,
            "punctuation rows remain navigable"
        );
        assert.equal(w._keyPages, 1);
        w._setPunct(false);
        assert.equal(w._keyPages, pages);
    }
    const translate = w.translate;
    const translateAlias = w._;
    let languageLabelLookups = 0;
    // The classic optimizer resolves the shorthand alias to translate().
    w._ = w.translate = function (key) {
        if (["Russian", "lang", "English"].includes(key))
            languageLabelLookups++;
        return translate.apply(this, arguments);
    };
    try {
        for (const code of Object.keys(fixture.locales)) {
            w.eval(read(languageAssetPath(code)));
            w.fixtureLocale = code;
            w.showEditKey1();
            for (const englishLayout of [true, false]) {
                w._setLang(englishLayout);
                languageLabelLookups = 0;
                w.showEdit();
                const label = englishLayout
                    ? code === "_eng"
                        ? w.keyStrings.Russian
                        : w.keyStrings.lang
                    : w.keyStrings.English;
                const hint = w.document.querySelector(
                    '[data-ott-key="' + w.keys.GREEN + '"]'
                );
                assert.equal(
                    hint.getAttribute("aria-label").trim(),
                    label,
                    code + " footer names the other layout in the UI language"
                );
                assert.equal(
                    languageLabelLookups,
                    1,
                    code + " footer translates its language label once"
                );
            }
        }
    } finally {
        w.translate = translate;
        w._ = translateAlias;
    }
    function layout(code) {
        w.eval(read(languageAssetPath(code)));
        w.fixtureLocale = code;
        w._keyP = false;
        w._setLang(false);
        w._setCase(true);
    }
    for (const [code, character, expected] of [
        ["_tur", "a", "A"],
        ["_tur", "ı", "I"],
        ["_ger", "ß", "ẞ"],
        ["_arm", "և", "ԵՒ"],
        ["_gre", "ΐ", "Ι\u0308\u0301"],
        ["_tur", "i", "İ"],
        ["_aze", "i", "İ"],
        ["_geo", "ა", "Ა"],
        ["_hau", "ɓ", "Ɓ"],
        ["_hau", "ɗ", "Ɗ"],
        ["_hau", "ƙ", "Ƙ"],
        ["_hau", "ƴ", "Ƴ"],
        ["_kur", "i", "I"],
        ["_kur", "î", "Î"],
        ["_yor", "ẹ", "Ẹ"],
        ["_ibo", "ụ", "Ụ"],
    ]) {
        layout(code);
        w._keyPage = Math.floor(w.keyStrings.alhabet.indexOf(character) / 40);
        w._buildKeyboard();
        w._keyCur = w._keys.indexOf(character);
        assert(w._keyCur >= 0, "insertion fixture character is reachable");
        w.editvar = "";
        w.editPos = 0;
        languageReads = 0;
        w.editKey1(w.keys.ENTER);
        assert.equal(w.editvar, expected, code + " direct uppercase insertion");
        assert.equal(
            languageReads,
            character === "i" ? 1 : 0,
            "only locale-sensitive i insertion reads the current language"
        );
    }
    layout("_geo");
    const originalUpperCase = w.String.prototype.toUpperCase;
    try {
        w.String.prototype.toUpperCase = function () {
            const value = String(this);
            return /^[ა-ჰ]$/.test(value)
                ? value
                : originalUpperCase.call(value);
        };
        assert.equal(w.eval('"ა".toUpperCase()'), "ა", "pre-Unicode-11 engine");
        w.editvar = "";
        w.editPos = 0;
        w._keyCur = w._keys.indexOf("ა");
        w.showEdit();
        assert.equal(
            w.document.getElementById("ik" + w._keyCur).textContent,
            "Ა"
        );
        w.editKey1(w.keys.ENTER);
        assert.equal(w.editvar, "Ა", "legacy engine inserts Georgian capitals");
    } finally {
        w.String.prototype.toUpperCase = originalUpperCase;
    }
    layout("_tur");
    w._keyCur = 0;
    w.editvar = "ab";
    w.editPos = 1;
    w.showEdit();
    const typedKey = w._keys.indexOf("i");
    w.editKey1("İ".charCodeAt(0));
    assert.equal(
        w._keyCur,
        typedKey,
        "physical input focuses its matching key"
    );
    assert.equal(
        w.editvar,
        "aİb",
        "physical input inserts at the current caret"
    );
    assert.equal(w.editPos, 2, "physical input advances the caret");
    assert.equal(w.document.getElementById("ik0").style.backgroundColor, "");
    assert.equal(w.document.getElementById("ik0").style.color, "");
    assert.equal(
        w.document.getElementById("ik" + typedKey).style.backgroundColor,
        w.curColorB,
        "physical input highlights the new focus"
    );
    assert.equal(
        w.document.getElementById("ik" + typedKey).style.color,
        w.curColor
    );
    for (const previousFocus of [49, 50, 59]) {
        layout("_vie");
        w._keyCur = previousFocus;
        w.editKey1(w.keys.RETURN);
        w.eval(read(languageAssetPath("_eng")));
        w.fixtureLocale = "_eng";
        w.showEditKey1();
        assert(w._keyCur >= 0 && w._keyCur < w._keys.length);
        assert(w.document.getElementById("ik" + w._keyCur));
        assert.doesNotThrow(() => w.editKey1(w.keys.ENTER));
    }
    layout("_ger");
    assert.equal(w._keyboardCharacter("ß"), "ẞ");
    for (const code of ["_tur", "_aze"]) {
        layout(code);
        assert.equal(w._keyboardCharacter("i"), "İ");
        assert.equal(w._keyboardCharacter("ı"), "I");
        w.showEdit();
        const iKey = w._keys.indexOf("i");
        assert.equal(w.document.getElementById("ik" + iKey).textContent, "İ");
        w.fixtureLocale = "_eng";
        languageReads = 0;
        w.showEdit();
        assert.equal(
            languageReads,
            1,
            "the next render refreshes the language"
        );
        assert.equal(w.document.getElementById("ik" + iKey).textContent, "I");
        w.fixtureLocale = code;
        w.editvar = "";
        w.editPos = 0;
        w._keyCur = iKey;
        w.editKey1(w.keys.ENTER);
        assert.equal(w.editvar, "İ", "insertion reads the current language");
        w._setLang(true);
        assert.equal(
            w._keyboardCharacter("i"),
            "I",
            "English layout ignores UI locale casing"
        );
    }
    layout("_tur");
    w.fixtureLocale = undefined;
    languageReads = 0;
    w.showEdit();
    assert.equal(
        languageReads,
        1,
        "missing language is resolved once per render"
    );
    assert.equal(
        w.document.getElementById("ik" + w._keys.indexOf("i")).textContent,
        "I",
        "missing language uses default casing"
    );
    layout("_arm");
    w.editvar = "ab";
    w.editPos = 1;
    w._keyCur = w._keys.indexOf("և");
    w.editKey1(w.keys.ENTER);
    assert.equal(w.editvar, "aԵՒb");
    assert.equal(
        w.editPos,
        3,
        "expanded uppercase advances caret by inserted code units"
    );
    w._setCase(false);
    assert.equal(w._keyboardCharacter("և"), "և");
    layout("_gre");
    assert.equal(w._keyboardCharacter("ΐ"), "Ι\u0308\u0301");
    w._setCase(false);
    assert.equal(w._keyboardCharacter("ς"), "ς");
    layout("_dut");
    w._setCase(false);
    w._keyPage = Math.floor(w.keyStrings.alhabet.indexOf("\u0301") / 40);
    w._buildKeyboard();
    w.showEdit();
    assert(w.document.getElementById("listEdit").textContent.includes("◌́"));
    w.editvar = "j";
    w.editPos = 1;
    w._keyCur = w._keys.indexOf("\u0301");
    w.editKey1(w.keys.ENTER);
    assert.equal(
        w.editvar,
        "j́",
        "dotted circle is a label, never inserted text"
    );
    for (const [code, text] of [
        ["_ara", "عَرَبِيّ"],
        ["_per", "می\u200cروم"],
        ["_urd", "اردو"],
        ["_hin", "हिन्दी"],
        ["_ben", "বাংলা"],
        ["_mal", "മലയാളം"],
        ["_sin", "සිංහල"],
        ["_tha", "ไทย"],
        ["_bur", "မြန်မာ"],
        ["_khm", "ខ្មែរ"],
        ["_geo", "ქართული"],
        ["_amh", "አማርኛ"],
        ["_lao", "ພາສາ​ລາວ"],
        ["_ori", "ଓଡ଼ିଆଡ଼"],
        ["_asm", "অসমীয়া"],
        ["_snd", "سنڌي"],
        ["_snd", "جھگھ٠١٢٣٤٥٦٧٨٩"],
        ["_pus", "پښتو"],
        ["_yor", "ẹ́ọ̀m̄"],
        ["_ibo", "ị́ụ̀"],
        ["_hau", "ɓɗƙƴ"],
    ]) {
        layout(code);
        w._setCase(false);
        w.editvar = "";
        w.editPos = 0;
        for (const character of text) {
            const index = w.keyStrings.alhabet.indexOf(character);
            assert(
                index >= 0,
                code + " word character must be available: " + character
            );
            w._keyPage = Math.floor(index / 40);
            w._buildKeyboard();
            w.showEdit();
            w._keyCur = w._keys.indexOf(character);
            if (character === "\u200b")
                assert.equal(
                    w.document.getElementById("ik" + w._keyCur).textContent,
                    "ZWSP"
                );
            if (character === "\u200c")
                assert.equal(
                    w.document.getElementById("ik" + w._keyCur).textContent,
                    "ZWNJ"
                );
            w.editKey1(w.keys.ENTER);
        }
        assert.equal(
            w.editvar,
            text,
            code + " preserves logical order, marks and joiners"
        );
        assert(
            !w.editvar.includes("◌"),
            "display-only dotted circles never enter the value"
        );
    }
    // Edits may join the inserted text to the following cluster. The caret
    // must move to that new boundary before rendering or the next deletion.
    w._setCase(false);
    for (const [value, position, character, expected, caret] of [
        ["\u0301", 0, "a", "a\u0301", 2],
        ["\u0301", 0, " ", " \u0301", 2],
        ["👩👩", 2, "\u200d", "👩‍👩", 5],
    ]) {
        w.editvar = value;
        w.editPos = position;
        w._keys = character;
        w._keyCur = 0;
        if (character === " ") w._keysSymbol[6].a();
        else w.editKey1(w.keys.ENTER);
        assert.equal(w.editvar, expected, "insertion preserves all input");
        assert.equal(w.editPos, caret, "caret follows the joined grapheme");
        w.editKey1(w.keys.YELLOW);
        assert.equal(w.editvar, "", "backspace removes the joined grapheme");
    }
    for (const [position, snapped] of [
        [-4, 0],
        [-Infinity, 0],
        [NaN, 0],
        [0, 0],
        [0.5, 2],
        [1, 2],
        [1.5, 2],
        [2, 2],
        [99, 3],
        [Infinity, 3],
    ]) {
        w.editvar = "📺z";
        w.editPos = position;
        w._keys = "a";
        w._keyCur = 0;
        w.editKey1(w.keys.ENTER);
        assert.equal(
            w.editvar,
            "📺z".slice(0, snapped) + "a" + "📺z".slice(snapped),
            "external caret is clamped before insertion: " + position
        );
        assert.equal(w.editPos, snapped + 1);
        w.editvar = "📺z";
        w.editPos = position;
        w._changeEdit();
        assert.equal(w.editPos, snapped, "render aligns external cursor");
        assert.equal(w.document.getElementById("ee").textContent, "📺z");
        assert.equal(
            w.document.getElementById("cursor").previousSibling.nodeValue,
            "📺z".slice(0, snapped),
            "preview never splits the surrogate pair"
        );
    }
    w.editvar = "🇦x🇧🇨";
    w.editPos = 3;
    w.editKey1(w.keys.YELLOW);
    assert.equal(w.editvar, "🇦🇧🇨", "remove only the separator");
    assert.equal(w.editPos, 4, "deletion changes RI pairing at the caret");
    for (const [value, boundaries] of [
        ["\u0301\u0308a", [0, 2, 3]],
        ["🇦🇧🇨", [0, 4, 6]],
        ["👩‍👩z", [0, 5, 6]],
        ["\r\na", [0, 2, 3]],
        ["\ud800\u0301z", [0, 2, 3]],
    ]) {
        w.editvar = value;
        w.editPos = 0;
        for (const boundary of boundaries.slice(1)) {
            w._keysSymbol[5].a();
            assert.equal(w.editPos, boundary, "forward grapheme movement");
        }
        for (const boundary of boundaries.slice(0, -1).reverse()) {
            w._keysSymbol[4].a();
            assert.equal(w.editPos, boundary, "backward grapheme movement");
        }
    }
    for (const value of ["A\r\nB\rC\u0000", "\ud800\u0301z", "<img>&\r\n"]) {
        w.editvar = value;
        w.editPos = value.length;
        w._changeEdit();
        assert.equal(
            w.document.getElementById("ee").textContent,
            value,
            "preview text nodes preserve controls and malformed UTF16"
        );
    }
    w.editvar = '<img src=x onerror="bad()">&';
    w.editPos = w.editvar.length;
    w._changeEdit();
    assert.equal(w.document.querySelector("#ee img"), null);
    assert.equal(w.document.getElementById("ee").textContent, w.editvar);
    console.log(
        "PASS localized keyboard: 88 alphabets, paging, all focus directions, case round trips and multicodepoint insertion"
    );
} finally {
    w.close();
}

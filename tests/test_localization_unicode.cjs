const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const vm = require("node:vm");
const acorn = require("acorn");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const {
    keyboardCode,
    initializeKeyboard,
    read,
} = require("./helpers/localized-keyboard.cjs");
const bundle =
    process.env.OTTPLAY_BUNDLE ||
    (process.argv.includes("--bundle") ? "dist/player.js" : undefined);
const code = localizationRuntime(bundle);
acorn.parse(code, { ecmaVersion: 5 });
const foldReference = new Map();
for (const line of fs
    .readFileSync("tests/fixtures/unicode/CaseFolding-17.0.0.txt", "utf8")
    .split("\n")) {
    const [point, status, mapping] = line.split("#")[0].split(";");
    if (!status || !["C", "F"].includes(status.trim())) continue;
    foldReference.set(
        Number.parseInt(point, 16),
        String.fromCodePoint(
            ...mapping
                .trim()
                .split(/\s+/)
                .map((value) => Number.parseInt(value, 16))
        )
    );
}
assert.equal(foldReference.size, 1585);
function canonicalCaselessReference(value) {
    return Array.from(
        value.normalize("NFD"),
        (char) => foldReference.get(char.codePointAt(0)) || char
    )
        .join("")
        .normalize("NFC");
}
// APIs may exist yet implement an older Unicode version. They must not bypass pinned17.
{
    const host = {};
    host.window = host;
    vm.createContext(host);
    vm.runInContext(
        "String.prototype.normalize = function () { throw Error('old normalizer must not run'); }; Intl.Segmenter = function () { throw Error('old segmenter must not run'); };",
        host
    );
    vm.runInContext(code, host);
    for (const [value, position, direction, expected] of [
        ["abc", 1.5, -1, 1],
        ["abc", 1.5, 1, 2],
        ["abc", 3, 0, 3],
        ["", 0, 0, 0],
    ])
        assert.equal(host.textBoundary(value, position, direction), expected);
    const left = "A\u1acf\u0323",
        right = "A\u0323\u1acf";
    assert.equal(host.canonicalSearchText(left), right);
    assert.equal(host.canonicalComposedText(left), "\u1ea0\u1acf");
    assert.equal(
        host.unicodeSearchKey(left, ""),
        host.unicodeSearchKey(right, "")
    );
    assert.equal(
        host.textBoundary("✁‍✁", 0, 1),
        2,
        "Unicode17 EP removal overrides old native segmentation"
    );
}
for (const legacy of [false, true]) {
    const host = { __ottInterfaceLanguage: "_eng" };
    host.window = host;
    vm.createContext(host);
    if (legacy)
        vm.runInContext(
            "Intl = undefined; String.prototype.normalize = undefined",
            host
        );
    vm.runInContext(code, host);
    for (const [name, query] of [
        ["Café", "Cafe\u0301"],
        ["ড় TV", "ড় TV"],
        ["한", "\u1112\u1161\u11ab"],
        ["Straße", "STRASSE"],
        ["ΟΣ", "οσ"],
        ["a\u0315\u0300", "a\u0300\u0315"],
        ["é\u0323", "e\u0323\u0301"],
    ])
        assert.equal(
            host.normalizeSearchText(name),
            host.normalizeSearchText(query),
            `${legacy}: ${name}`
        );
    // Folding can expand a starter or turn U+0345 into a new starter. Testing
    // isolated C/F mappings misses composition and mark placement across it.
    // Keep the native oracle marks old enough for hosts with older ICU data.
    for (const point of foldReference.keys()) {
        const char = String.fromCodePoint(point);
        for (const mark of [
            "\u0301",
            "\u0302",
            "\u0307",
            "\u0323",
            "\u0331",
            "\u0345",
        ]) {
            for (const value of [char + mark, mark + char]) {
                const actual = host.unicodeSearchKey(value, "");
                assert.equal(
                    actual,
                    canonicalCaselessReference(value),
                    `contextual C/F key U+${point.toString(16)}`
                );
                assert.equal(
                    host.unicodeSearchKey(actual, ""),
                    actual,
                    "contextual search keys are idempotent"
                );
            }
        }
    }
    assert.equal(
        host.unicodeSearchKey("H\u1acf\u0331", ""),
        "\u1e96\u1acf",
        "Unicode17 mark ordering and fold composition use a pinned expectation"
    );
    // Leading marks, starter barriers and equal-CCC order in long pasted text.
    const highMarks = "\u0315".repeat(8192),
        lowMarks = "\u0323\u0324".repeat(4096),
        unordered = highMarks + lowMarks,
        ordered = lowMarks + highMarks;
    for (const [source, expected] of [
        [unordered, ordered],
        ["A" + unordered, "A" + ordered],
        [unordered + "B" + unordered, ordered + "B" + ordered],
    ]) {
        assert.equal(host.canonicalSearchText(source), expected);
        assert.equal(
            host.canonicalComposedText(source),
            source.normalize("NFC")
        );
    }
    assert.notEqual(
        host.normalizeSearchText("cafe"),
        host.normalizeSearchText("café"),
        "Do not strip accents"
    );
    assert.equal(
        host
            .normalizeSearchText("café")
            .indexOf(host.normalizeSearchText("cafe")),
        -1,
        "NFC keeps trailing accents in substring searches"
    );
    assert.notEqual(
        host.normalizeSearchText("①"),
        host.normalizeSearchText("1"),
        "No compatibility normalization"
    );
    assert.notEqual(
        host.normalizeSearchText("ı"),
        host.normalizeSearchText("i"),
        "Non-Turkic dotless i stays distinct"
    );
    for (const locale of ["_tur", "_aze"]) {
        host.__ottInterfaceLanguage = locale;
        assert.equal(
            host.normalizeSearchText("İZMİR"),
            host.normalizeSearchText("izmir")
        );
        assert.equal(
            host.normalizeSearchText("IŞIK"),
            host.normalizeSearchText("ışık")
        );
        assert.notEqual(
            host.normalizeSearchText("I"),
            host.normalizeSearchText("i")
        );
    }
    for (const locale of ["tr", "az"]) {
        assert.equal(
            host.unicodeSearchKey("I\u0323\u0307", locale),
            host.unicodeSearchKey("i\u0323", locale),
            "Turkic dot after a lower-CCC mark"
        );
        for (const [value, expected] of [
            ["III\u0307", "ııi"],
            ["I\u0307I\u0307", "ii"],
            ["İI", "iı"],
            ["I\u0301\u0307", "ı\u0301\u0307"],
            ["I\u034f\u0307", "ı\u034f\u0307"],
            ["I\ud800\u0307", "ı\ud800\u0307"],
            ["I😀\u0307", "ı😀\u0307"],
            ["I\u{1d165}\u0307", "i\u{1d165}"],
            ["I\u1add\u0307I\u1acf\u0323\u0307", "i\u1addı\u0323\u1acf\u0307"],
        ]) {
            assert.equal(host.unicodeSearchKey(value, locale), expected);
            assert.equal(host.unicodeSearchKey(expected, locale), expected);
        }
        assert.equal(
            host.unicodeSearchKey(
                "I\u0323\u0307I\u0301\u0307".repeat(256),
                locale
            ),
            "ịı\u0301\u0307".repeat(256),
            "repeated Turkic replacements preserve every span"
        );
    }
    if (legacy) {
        vm.runInContext(
            "String.prototype.toLowerCase = String.prototype.toUpperCase = undefined",
            host
        );
        assert.equal(
            host.unicodeSearchKey("ẞΣİ𐐀", ""),
            "ssσi\u0307𐐨",
            "full pinned folding works without native casing"
        );
    }
    host.__ottInterfaceLanguage = "_eng";
    for (const cluster of [
        "📺",
        "e\u0301",
        "क्‍ष",
        "क्ष",
        "👨‍👩‍👧‍👦",
        "👍🏽",
        "🇮🇳",
        "1️⃣",
        "\u1112\u1161\u11ab",
        "\r\n",
    ]) {
        const value = "a" + cluster + "z";
        assert.equal(
            host.textBoundary(value, 1, 1),
            value.length - 1,
            `${legacy}: next ${cluster}`
        );
        assert.equal(
            host.textBoundary(value, value.length - 1, -1),
            1,
            `${legacy}: previous ${cluster}`
        );
    }
    assert.equal(
        host.textBoundary("🇮🇳🇰🇷", 0, 1),
        4,
        "Regional indicators pair, not the whole run"
    );
    if (legacy) {
        // Independently compare every pinned canonical record and Hangul syllable
        // against the test runtime's native NFD, including supplementary mappings.
        const normalization = JSON.parse(
            fs.readFileSync(
                "tests/fixtures/unicode-normalization-17.json",
                "utf8"
            )
        );
        const payload = zlib.gunzipSync(
            Buffer.from(normalization.gzipBase64.join(""), "base64")
        );
        const digest = (value) =>
            crypto.createHash("sha256").update(value).digest("hex");
        assert.equal(
            digest(payload),
            normalization.payloadSha256,
            "pinned official normalization fixture payload"
        );
        const rows17 = JSON.parse(payload.toString("utf8"));
        const added = new Set(normalization.unicode17AddedIndexes);
        assert.equal(added.size, 69, "Unicode17 adds 69 normalization vectors");
        const rows16 = rows17.filter((_, index) => !added.has(index));
        assert.equal(
            digest(JSON.stringify(rows16)),
            normalization.unicode16PayloadSha256,
            "Unicode16 is the exact ordered subset"
        );
        assert.equal(rows16.length, 19965);
        assert.equal(rows17.length, 20034);
        for (const [version, rows] of [
            [16, rows16],
            [17, rows17],
        ]) {
            for (const row of rows)
                for (let i = 0; i < 5; i++) {
                    assert.equal(
                        host.canonicalComposedText(row[i]),
                        row[i < 3 ? 1 : 3],
                        "Unicode" + version + " NFC conformance"
                    );
                    assert.equal(
                        host.canonicalSearchText(row[i]),
                        row[i < 3 ? 2 : 4],
                        "Unicode" + version + " NFD conformance"
                    );
                }
        }
        const latestVectors = JSON.parse(
            fs.readFileSync(
                "tests/fixtures/unicode-grapheme-break-17.json",
                "utf8"
            )
        );
        assert.equal(
            latestVectors.unicode16Changes.length,
            1,
            "only the normative U+2701 EP removal changes a Unicode16 case"
        );
        for (const version of [16, 17]) {
            const vectors = JSON.parse(
                fs.readFileSync(
                    "tests/fixtures/unicode-grapheme-break-" +
                        version +
                        ".json",
                    "utf8"
                )
            );
            assert.equal(
                vectors.cases.length,
                version === 16 ? 1093 : 766,
                "pin the complete Unicode grapheme test set"
            );
            let intentionalChanges = 0;
            for (const vector of vectors.cases) {
                let value = "",
                    expected = [];
                for (const token of vector.split(/\s+/)) {
                    if (token === "÷") expected.push(value.length);
                    else if (token !== "×")
                        value += String.fromCodePoint(parseInt(token, 16));
                }
                if (version === 16) {
                    const change = latestVectors.unicode16Changes.find(
                        (item) => item.case === vector
                    );
                    if (change) {
                        expected = change.boundaries;
                        intentionalChanges++;
                    }
                }
                assert.deepEqual(
                    Array.from(host.legacyTextBoundaries(value)),
                    expected,
                    version + ": " + vector
                );
            }
            assert.equal(intentionalChanges, version === 16 ? 1 : 0);
        }
        const alphabet =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (let n = 0; n < 64; n++) {
            assert.deepEqual(
                Array.from(
                    host.readUnicodeData(alphabet[n] + (n < 32 ? "" : "A"))
                ),
                [n & 31],
                "arithmetic decoder character " + n
            );
        }
        for (const name of [
            "unicodeCanonicalData",
            "unicodeCombiningData",
            "unicodeCompositionData",
            "unicodeGraphemeData",
            "unicodePictographicData",
            "unicodeConjunctData",
            "unicodeCaseFoldData",
        ]) {
            assert.match(
                host[name],
                /^[A-Za-z0-9+/]+$/,
                "generated data is validated ASCII"
            );
            let value = 0,
                factor = 1,
                reference = [];
            for (const char of host[name]) {
                const part = alphabet.indexOf(char);
                value += (part & 31) * factor;
                if (part < 32) {
                    reference.push(value);
                    value = 0;
                    factor = 1;
                } else factor *= 32;
            }
            assert.deepEqual(
                Array.from(host.readUnicodeData(host[name])),
                reference,
                "all decoded values: " + name
            );
        }
        const overlay = JSON.parse(
            fs.readFileSync(
                "scripts/localization-unicode-normalization.json",
                "utf8"
            )
        ).combiningClassOverlay;
        assert.equal(
            Object.keys(overlay).length,
            34,
            "all new Unicode17 combining marks"
        );
        for (const point of Object.keys(overlay)) {
            const value =
                "A" +
                String.fromCodePoint(parseInt(point, 16)) +
                "\u0323\u0315";
            assert.equal(
                host.canonicalSearchText(value),
                value.normalize("NFD"),
                "Unicode17 NFD " + point
            );
            assert.equal(
                host.canonicalComposedText(value),
                value.normalize("NFC"),
                "Unicode17 NFC " + point
            );
        }
        const classes = host.loadCombiningClasses();
        assert.equal(
            Object.keys(classes).length,
            968,
            "all pinned combining classes survive compact encoding"
        );
        const mappings = host.loadCanonicalDecompositions();
        assert.equal(
            Object.keys(mappings).length,
            2081,
            "all pinned canonical records survive compact encoding"
        );
        for (const point of Object.keys(mappings)) {
            const value = String.fromCodePoint(Number(point));
            assert.equal(
                host.canonicalSearchText(value),
                value.normalize("NFD")
            );
            assert.equal(
                host.canonicalComposedText(value.normalize("NFD")),
                value.normalize("NFC")
            );
        }
        for (let cp = 0xac00; cp <= 0xd7a3; cp++) {
            const value = String.fromCharCode(cp);
            assert.equal(
                host.canonicalSearchText(value),
                value.normalize("NFD")
            );
            assert.equal(
                host.canonicalComposedText(value.normalize("NFD")),
                value.normalize("NFC")
            );
        }
        host.keyStrings = {
            "Su Mo Tu We Th Fr Sa": "Sun Mon Tue Wed Thu Fri Sat",
        };
        assert.equal(host.formatLocaleNumber(2), "2");
        const date = new Date(2026, 9, 6, 14, 5);
        assert.equal(
            host.formatLocaleDateTime(date.getTime() / 1000),
            "Tue\u00a006.10\u00a014:05"
        );
    } else {
        host.__ottInterfaceLanguage = "_ara";
        assert.equal(
            host.formatLocaleNumber(123),
            new Intl.NumberFormat("ar", { useGrouping: false }).format(123)
        );
        host.__ottInterfaceLanguage = "_ger";
        const date = new Date(2026, 9, 6, 14, 5);
        assert.equal(
            host.formatLocaleDateTime(date.getTime() / 1000),
            new Intl.DateTimeFormat("de", {
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                month: "2-digit",
                weekday: "short",
            }).format(date)
        );
    }
    // Exercise the actual optional channel/history filters, not a mirror predicate.
    const search = ts.transpileModule(
        read("src/channels/search.ts")
            .replace(/^import[^\n]*\n/gm, "")
            .replace(/^export /gm, ""),
        {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
    vm.runInContext(search, host);
    host.channels = { 1: { channel_name: "Café" } };
    host.curList = [1];
    host.setSearchText("Cafe\u0301");
    assert.deepEqual(Array.from(host.getFilteredChannelList()), [1]);
    host.medHistory = [{ name: "한" }];
    host.searchHistoryChannel("한");
    assert.equal(host.getFilteredHistory().length, 1);
    host.channels = Object.freeze({
        1: Object.freeze({ channel_name: "ß\u0301 TV" }),
        2: Object.freeze({ channel_name: "sś TV" }),
        3: Object.freeze({ channel_name: "ss TV" }),
        4: Object.freeze({ channel_name: "\u1f80\u0302 TV" }),
    });
    host.curList = [1, 2, 3, 4];
    host.medHistory = Object.freeze([
        Object.freeze({ name: "ß\u0301 TV", title: "Programme" }),
        Object.freeze({ name: "Channel", title: "sś programme" }),
        Object.freeze({ name: "ss TV", title: "Programme" }),
        Object.freeze({ name: "Greek", title: "\u1f80\u0302 programme" }),
    ]);
    const beforeSearch = JSON.stringify([host.channels, host.medHistory]);
    for (const [query, expected] of [
        ["ss\u0301", [1, 2]],
        ["ß\u0301", [1, 2]],
        ["ss", [3]],
        ["α\u0313\u0302ι", [4]],
        ["ἀι\u0302", []],
    ]) {
        host.setSearchText(query);
        host.searchHistoryChannel(query);
        assert.deepEqual(Array.from(host.getFilteredChannelList()), expected);
        assert.deepEqual(
            Array.from(host.getFilteredHistory()),
            expected.map((id) => host.medHistory[id - 1])
        );
    }
    assert.equal(
        JSON.stringify([host.channels, host.medHistory]),
        beforeSearch
    );
}
for (const legacy of [false, true]) {
    const dom = new JSDOM(
        '<div id="listEdit"></div><div id="listPodval"></div>',
        { runScripts: "outside-only" }
    );
    const w = dom.window;
    w.eval(read("js/jquery-1.11.1.min.js"));
    w.eval("(" + initializeKeyboard.toString() + ")()");
    if (legacy)
        w.eval("Intl = undefined; String.prototype.normalize = undefined");
    w.eval(keyboardCode(bundle));
    for (const value of ["📺", "e\u0301", "क्‍ष", "👨‍👩‍👧‍👦", "🇮🇳"]) {
        w.editvar = value;
        w.editPos = value.length;
        w.editKey1(w.keys.YELLOW);
        assert.equal(w.editvar, "", `${legacy}: actual OSK Delete ${value}`);
        w.editvar = "a" + value + "z";
        w.editPos = 1;
        w._keysSymbol[5].a();
        assert.equal(w.editPos, value.length + 1);
        w._keysSymbol[4].a();
        assert.equal(w.editPos, 1);
    }
    for (const [value, remaining] of [
        ["क् ", "क्"],
        ["क्A", "क्"],
        ["क्!", "क्"],
        ["क्‍A", "क्‍"],
        ["a‍B", "a‍"],
    ]) {
        w.editvar = value;
        w.editPos = value.length;
        w.editKey1(w.keys.YELLOW);
        assert.equal(
            w.editvar,
            remaining,
            `${legacy}: delete only the final independent character ${value}`
        );
    }
    dom.window.close();
}
console.log(
    "PASS localization Unicode: canonical search, locale casing, grapheme editor, Intl and ES5 fallbacks"
);

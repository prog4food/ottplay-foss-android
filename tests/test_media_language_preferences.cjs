const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
function source(file, names) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const nodes = ast.statements.filter(
        (node) =>
            !ts.isImportDeclaration(node) &&
            !ts.isExportDeclaration(node) &&
            (!names ||
                (ts.isFunctionDeclaration(node) &&
                    names.includes(node.name.text)))
    );
    if (names) assert.equal(nodes.length, names.length);
    const code = ts.transpileModule(
        nodes
            .map((node) => node.getText(ast).replace(/^export\s+/, ""))
            .join("\n"),
        {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
    require("acorn").parse(code, { ecmaVersion: 5 });
    return code;
}
const w = {
    console,
    curList: [42],
    playType: 0,
    primaryIndex: 0,
    settings: {},
};
w.window = w;
vm.createContext(w);
vm.runInContext(
    source("src/localization/assets.ts") + source("src/localization/media.ts"),
    w
);
const pick = w.preferredTrackIndex;
const isoLanguages = require("./fixtures/media-language-iso639.json").languages;
assert.deepEqual(
    Object.keys(isoLanguages).sort(),
    Object.keys(w.languageLocales).sort(),
    "independent ISO fixture covers every shipped language"
);
for (const [code, iso] of Object.entries(isoLanguages)) {
    const tags = iso.iso6392.concat(iso.iso6391 || []);
    for (const kind of ["audio", "subtitle"])
        for (const tag of tags)
            assert.equal(
                pick(kind, code, [{ id: 8, language: tag }]),
                8,
                code + " " + kind + " ISO tag " + tag
            );
}
for (const kind of ["audio", "subtitle"]) {
    assert.equal(
        pick(kind, "_lat", [{ id: 2, language: "lat" }]),
        undefined,
        "Latin lat is not Latvian despite the persisted _lat identifier"
    );
    assert.equal(
        pick(kind, "_lat", [
            { id: 2, language: "lat" },
            { id: 7, language: "lav" },
        ]),
        7,
        "Latvian chooses its actual track ID after an unrelated Latin track"
    );
    assert.equal(
        pick(kind, "_rou", [{ id: 9, language: "rou" }]),
        9,
        "retain the previously accepted nonstandard Romanian tag"
    );
}
assert.equal(
    pick("subtitle", "_lat", [{ id: 4, language: "lav-Latn-LV" }]),
    4,
    "ISO alias preserves supported subtitle script and region"
);
assert.equal(
    pick("subtitle", "_lat", [{ id: 4, language: "lav-Cyrl" }]),
    undefined,
    "ISO alias does not erase an incompatible subtitle script"
);
for (const tag of ["ru", "RU", "rus", "ru_RU", "ru-RU"])
    assert.equal(pick("audio", "_rus", [{ id: 5, language: tag }]), 5);
for (const [code, tag] of [
    ["_ger", "deu"],
    ["_dut", "nld"],
    ["_per", "fas"],
    ["_heb", "iw"],
    ["_nor", "nob"],
    ["_cze", "ces"],
    ["_gre", "ell"],
    ["_fil", "tgl"],
    ["_fil", "tl"],
])
    assert.equal(pick("audio", code, [{ id: 3, language: tag }]), 3);
assert.equal(
    pick("audio", "_rus", [
        { id: 7, language: "ru-RU" },
        { id: 2, language: "ru" },
    ]),
    2,
    "exact match before regional fallback"
);
for (const preference of ["", "off", "constructor", "_missing"])
    assert.equal(
        pick("audio", preference, [{ id: 0, language: "en" }]),
        undefined
    );
assert.equal(pick("subtitle", "off", []), 0);
assert.equal(pick("audio", "_rus", [{ id: 0, language: "en" }]), undefined);
assert.equal(
    pick("subtitle", "_chi", [
        { id: 1, language: "zh-Hant" },
        { id: 2, language: "zh-CN" },
    ]),
    2
);
assert.equal(
    pick("subtitle", "_srp", [{ id: 1, language: "sr-Latn" }]),
    undefined
);
for (const id of [-1, 0, 1.5, NaN, Infinity, "1"])
    assert.equal(pick("subtitle", "_rus", [{ id, language: "ru" }]), undefined);
console.log(
    "PASS media languages: all 88 locales, ISO aliases, scripts, real IDs and absent tracks"
);
let saved,
    selected = [],
    alive = true;
const owner = {
    active: () => alive,
    selectTrack: (kind, id) => selected.push([kind, id]),
    tracks: () => [
        { id: 0, language: "en", selected: true },
        { id: 3, language: "ru" },
    ],
};
w.__ottChannels = {
    preference: () => saved,
    setPreference: (_, target, value) => {
        saved = value;
    },
};
w.__ottCoreBackend = () => ({ current: () => owner });
w.getCoreMediaBackend = w.__ottCoreBackend;
w.settings.preferredAudioLanguage = "_rus";
w.settings.preferredSubtitleLanguage = "off";
w._ = (text) => text;
w.showSelectBox = (current, labels, select) => {
    w.choose = select;
};
vm.runInContext(
    source("src/channels/index.ts", [
        "channelPreferenceTarget",
        "applyChannelPreference",
        "saveChannelPreference",
    ]) + source("src/core/index.ts", ["chooseCoreTrack"]),
    w
);
function applied(name) {
    const values = [];
    w.applyChannelPreference(name, (value) => values.push(value));
    return values;
}
assert.deepEqual(applied("aAudios"), [3]);
saved = 0;
assert.deepEqual(
    applied("aAudios"),
    [0],
    "saved first audio overrides global Russian"
);
saved = undefined;
assert.deepEqual(applied("aSubs"), [0]);
w.playType = -1;
assert.deepEqual(applied("aAudios"), [3], "media also uses defaults");
w.chooseCoreTrack("audio");
w.choose(1);
assert.deepEqual(selected, [["audio", 3]]);
assert.deepEqual(
    applied("aAudios"),
    [],
    "late VOD addtrack cannot overwrite manual selection"
);
assert.deepEqual(
    applied("aSubs"),
    [0],
    "audio selection does not suppress subtitle defaults"
);
owner.__ottExplicitTracks = {};
w.playType = 0;
w.chooseCoreTrack("audio");
w.choose(0);
assert.equal(
    saved,
    0,
    "confirming current audio is an explicit per-channel preference"
);
assert.equal(
    selected.length,
    1,
    "confirmation does not needlessly reset the decoder"
);
assert.deepEqual(
    applied("aAudios"),
    [0],
    "late preferred-language tracks cannot override confirmed current audio"
);
saved = undefined;
w.playType = -1;
assert.deepEqual(
    applied("aAudios"),
    [],
    "current-track confirmation also suppresses VOD defaults"
);
owner.__ottExplicitTracks = {};
w.chooseCoreTrack("audio");
alive = false;
w.choose(1);
assert.equal(
    selected.length,
    1,
    "stale selector cannot change replacement playback"
);
assert.deepEqual(applied("aAudios"), []);
alive = true;
w.settings.preferredAudioLanguage = "_ger";
assert.deepEqual(applied("aAudios"), []);
assert.deepEqual(applied("aAspects"), [0]);
console.log(
    "PASS media languages: channel/manual precedence, media defaults and retired session safety"
);
const { settingsSource } = require("./helpers/settings-source-fixture.cjs");
const data = new Map();
const s = {
    storage: {
        del: (key) => data.delete(key),
        get: (key) => data.get(key) ?? null,
        set: (key, value) => data.set(key, String(value)),
    },
};
s.window = s;
vm.createContext(s);
vm.runInContext(settingsSource(), s);
vm.runInContext("var draft = settingsStore.begin();", s);
assert.equal(s.draft.set("preferredAudioLanguage", "_rus"), true);
assert.equal(s.draft.set("preferredSubtitleLanguage", "off"), true);
assert.equal(s.draft.commit(), true);
assert.equal(data.get("sPreferredAudioLanguage"), "_rus");
assert.equal(data.get("sPreferredSubtitleLanguage"), "off");
vm.runInContext("settingsStore.reload(); var next = settingsStore.begin();", s);
assert.equal(s.next.get("preferredAudioLanguage"), "_rus");
for (const bad of ["off", "constructor", "ru", 7])
    assert.equal(s.next.set("preferredAudioLanguage", bad), false);
assert.equal(s.next.set("preferredSubtitleLanguage", "_ara"), true);
s.next.cancel();
assert.equal(s.sPreferredSubtitleLanguage, "off");
console.log(
    "PASS media languages: actual schema persists, reloads, validates and cancels independently"
);

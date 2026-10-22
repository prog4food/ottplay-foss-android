const fs = require("node:fs");
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const assert = require("node:assert/strict");
const assertMenuRuntime = require("./helpers/menu-runtime.cjs");
const { fixture } = require("./helpers/provider-driver-fixture.cjs");

const source = fs.readFileSync(
    path.join(__dirname, "../src/ui/menu-registry.ts"),
    "utf8"
);
const code = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ES2015,
        target: ts.ScriptTarget.ES5,
    },
}).outputText;
acorn.parse(code, { ecmaVersion: 5 });
const host = vm.createContext({});
host.window = host;
vm.runInContext("(function(){" + code + "})();", host);
assertMenuRuntime(host.__ottMenuRegistry);
const localization = localizationRuntime();
function language(host, name) {
    vm.runInContext(
        fs.readFileSync(
            path.join(__dirname, "../locales/" + name + ".js"),
            "utf8"
        ),
        host
    );
}
for (const id of [
    "xtream",
    "all4you",
    "1ott",
    "only4",
    "shara-tv",
    "tvteam",
    "edem",
    "antifriz",
    "kb-team",
    "stalker",
    "m3u",
    "plex",
]) {
    const f = fixture({
        m3um3uArr: JSON.stringify({
            active: 0,
            M3Us: [{ name: "Settings", www: "https://playlist.test/list.m3u" }],
        }),
    });
    const w = f.host;
    w.navigator = { userAgent: "browser" };
    vm.runInContext(localization, w);
    language(w, "english");
    f.mount(id);
    w.duneAddSettings(0);
    vm.runInContext("(function(){" + code + "})();", w);
    const before = [...f.saved];
    const rows = () =>
        Array.from(w.__ottMenuRegistry.open(w).rows, (row) => ({
            action: row.action,
            desc: row.desc,
            name: row.name,
        }));
    const english = rows();
    assert(english.length, id + ": the provider has menu entries");
    language(w, "russian");
    const russian = rows();
    assert.equal(russian.length, english.length, id);
    russian.forEach((row, index) => {
        assert.match(
            row.name,
            /[А-Яа-яЁё]/,
            id + ": title follows the selected language"
        );
        assert.match(
            row.desc,
            /[А-Яа-яЁё]/,
            id + ": description follows the selected language"
        );
        assert.equal(
            row.action,
            english[index].action,
            id + ": language changes retain command identity"
        );
    });
    if (id === "m3u")
        assert.equal(
            russian[0].name,
            "Выберите плейлист: 1 - Settings",
            "A user-supplied playlist name is metadata, not a translation key"
        );
    language(w, "english");
    assert.deepEqual(
        rows(),
        english,
        id + ": switching back needs no provider remount"
    );
    assert.deepEqual(
        [...f.saved],
        before,
        id +
            ": opening a translated menu does not change provider configuration"
    );
}
console.log(
    "PASS menu: localization, 12 provider language switches, playback query bounds, provider callbacks, dynamic keys and ES5"
);

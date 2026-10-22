const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const code = ts.transpileModule(
    fs.readFileSync("src/commands/remote-profiles.ts", "utf8"),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
acorn.parse(code, { ecmaVersion: 5 });
const context = { exports: {}, require: () => ({}) };
vm.runInNewContext(code, context);
const compare = context.exports.compareRemoteSettings;
const stored = new Map();
let locked = false;
const host = {
    __ottParental: { needs: () => locked },
    stbGetItem: (key) => stored.get(key) ?? null,
};
const settings = {
    history_hours: 24,
    name: "Local",
    playlist: "https://example.invalid/list?token=secret",
};
const params = { number: 2, provider: "m3u", settings };
stored.set(
    "m3um3uArr",
    JSON.stringify({
        M3Us: [
            {},
            {
                medUrl: "portal::[key:secret]https://retired.invalid/api/v1/",
                name: settings.name,
                rechours: "24",
                www: settings.playlist,
            },
        ],
    })
);
assert.equal(compare(host, params).data.matched, true);
assert.equal(
    compare(host, { ...params, settings: { ...settings, vportal: "" } }).status,
    "rejected",
    "M3U comparison ignores saved legacy links and accepts only TV fields"
);
assert.equal(
    compare(host, {
        ...params,
        settings: { ...settings, playlist: "https://different.invalid" },
    }).data.matched,
    false
);
assert.equal(compare(host, { ...params, number: 1.5 }).status, "rejected");
assert.equal(
    compare(host, { ...params, settings: { ...settings, extra: "x" } }).status,
    "rejected"
);
assert.equal(
    compare(host, {
        ...params,
        settings: { ...settings, name: "я".repeat(129) },
    }).status,
    "rejected",
    "Names are bounded by UTF-8 bytes"
);
assert.equal(
    compare(host, { ...params, settings: { ...settings, name: "\ud800" } })
        .status,
    "rejected",
    "Lone surrogates cannot enter the wire contract"
);
assert.equal(
    compare(host, { ...params, provider: "__proto__" }).status,
    "rejected"
);
locked = true;
assert.equal(compare(host, params).status, "rejected");
locked = false;
stored.set(
    "plexcfg",
    JSON.stringify({ address: "https://plex.invalid", token: "secret" })
);
assert.equal(
    compare(host, {
        provider: "plex",
        settings: { server: " https://plex.invalid/// ", token: " secret " },
    }).data.matched,
    true
);
assert.equal(
    compare(host, {
        provider: "plex",
        settings: { server: "https://plex.invalid", token: "x".repeat(1025) },
    }).status,
    "rejected"
);
stored.set(
    "stalkerstalker_data",
    JSON.stringify({
        mac: "aa:bb:cc:dd:ee:ff",
        name: "Home",
        portal: "http://portal.invalid",
    })
);
assert.equal(
    compare(host, {
        number: 1,
        provider: "stalker",
        settings: {
            mac: "aa:bb:cc:dd:ee:ff",
            name: "Home",
            server: "http://portal.invalid",
        },
    }).data.matched,
    true
);
assert(!JSON.stringify(compare(host, params)).includes("secret"));
stored.set("m3um3uArr", "broken");
assert.equal(compare(host, params).status, "rejected");
console.log(
    "PASS read-only settings compare: slots, exact URLs, normalization, malformed input, lock and redaction"
);

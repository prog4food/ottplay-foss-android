import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual classic-bundle functions, not a reimplementation of their contracts.
function functions(path: string, names: string[], owner?: string) {
    const source = fs.readFileSync(
        new URL("../" + path, import.meta.url),
        "utf8"
    );
    const file = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true
    );
    const scope = owner
        ? file.statements.find(
              (node): node is ts.FunctionDeclaration =>
                  ts.isFunctionDeclaration(node) && node.name?.text === owner
          )?.body
        : file;
    assert.ok(scope, path + ": missing function scope " + owner);
    const nodes = scope.statements.filter(
        (node) =>
            ts.isFunctionDeclaration(node) &&
            names.includes(node.name?.text || "")
    );
    assert.equal(nodes.length, names.length);
    return ts.transpileModule(
        nodes
            .map((node) => node.getText(file).replace(/^export\s+/, ""))
            .join("\n"),
        {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES2020,
            },
        }
    ).outputText;
}
function context(values: Record<string, any>) {
    const ctx = vm.createContext({ console, ...values });
    vm.runInContext(
        fs.readFileSync(
            new URL("../vendor/ottplay-core.js", import.meta.url),
            "utf8"
        ),
        ctx
    );
    if (ctx.window) ctx.window.OttPlayCore = ctx.OttPlayCore;
    return ctx;
}
const schedule = [{ name: "Provider programme", time: 10000, time_to: 11000 }];
const channelFunctions = functions("src/channels/index.ts", [
    "usesNativeXmltv",
    "channelXmltvUrls",
    "epgTimezoneHours",
    "epgArchiveHours",
    "applyChannelTvgShift",
    "fetchChannelGuide",
]);

for (const platform of ["browser", "tauri", "capacitor"]) {
    for (const provider of [
        "xtream",
        "stalker",
        "m3u-external",
        "m3u-direct-source",
        "m3u",
    ]) {
        let providerCalls = 0;
        const native: any[] = [];
        const channel = {
            channel_name: "Private +4",
            epg: "private-id",
            epg_external: provider === "m3u-external",
            epg_src: provider === "m3u-direct-source" ? "=private" : "local",
            epg_url: "companion-hash",
            rec: 168,
            tn: "Private",
            ts: -3600,
            xmltv_urls: [
                "http://private.test/feed.xml",
                "https://backup.test/feed.gz",
            ],
        };
        const w: any = {
            getChannelEpg(id: number, callback: Function) {
                providerCalls++;
                callback(id, schedule);
            },
            p_pref: provider.startsWith("m3u") ? "m3u" : provider,
        };
        const fetch = async (args: any) => {
            native.push(args);
            return { epg_data: schedule.map((row) => ({ ...row })) };
        };
        if (platform === "tauri")
            w.__TAURI__ = {
                core: { invoke: (_cmd: string, args: any) => fetch(args) },
            };
        if (platform === "capacitor")
            w.Capacitor = { Plugins: { MobileXmltvEpg: { getEpg: fetch } } };
        const ctx = context({
            cacheFetchedEpg() {},
            channels: { 42: channel },
            epgCacheGeneration: 0,
            epgPending: {},
            readEpgCache: () => null,
            window: w,
        });
        vm.runInContext(channelFunctions, ctx);
        const result: any = await new Promise((resolve) =>
            ctx.fetchChannelGuide(42, (_id: number, rows: any) => resolve(rows))
        );
        const useNative = platform !== "browser" && provider === "m3u";
        assert.equal(
            native.length,
            useNative ? 1 : 0,
            `${platform}/${provider}: native route`
        );
        assert.equal(
            providerCalls,
            useNative ? 0 : 1,
            `${platform}/${provider}: provider route`
        );
        assert.equal(
            result[0].time,
            useNative ? 6400 : 10000,
            "tvg-shift belongs only to native XMLTV result; provider result is already shifted"
        );
        if (useNative) {
            assert.deepEqual(
                Array.from(native[0].xmltv_urls || native[0].xmltvUrls),
                channel.xmltv_urls
            );
            assert.equal(native[0].tvgId || native[0].hash, "private-id");
            assert.equal(
                native[0].archiveHours || native[0].archive_hours,
                168
            );
        }
    }
}
const providerEpg = () => {};
const override = context({
    getChannelEpgCached() {},
    window: { __TAURI__: {}, getChannelEpg: providerEpg },
});
vm.runInContext(functions("src/index.ts", ["setupTauriEpgOverride"]), override);
override.setupTauriEpgOverride();
assert.equal(
    override.window.getChannelEpg,
    providerEpg,
    "boot never replaces the provider EPG function"
);

const playlist =
    '#EXTM3U x-tvg-url="http://first.test/private.xml,https://second.test/guide.gz" foss-tvg="alt::https://alias.test/feed.xml"\n' +
    '#EXTINF:-1 tvg-id="private-id" group-title="Private" tvg-logo="https://logo.test/icon.png",Private +4\nhttps://stream.test/one\n' +
    '#EXTINF:-1 tvg-id="two" tvg-source="#2" group-title="Private" tvg-logo="https://logo.test/icon.png",Second\nhttps://stream.test/two\n' +
    '#EXTINF:-1 tvg-id="three" tvg-source="#alt" group-title="Private" tvg-logo="https://logo.test/icon.png",Third\nhttps://stream.test/three\n';
for (const native of [false, true]) {
    const ctx: any = context({
        _: (value: string) => value,
        alert: (message: string) => assert.fail(message),
        cats: {},
        catsArray: [],
        chanels: {},
        cList: [],
        curList: [],
        m3u_defaults: { epg_server: "capacitor://localhost" },
        m3uArr: { active: 0, M3Us: [{ rechours: 0, www: "/fixture" }] },
        murmurhash3_32_gc: (value: string) =>
            value.endsWith("one") ? 42 : value.endsWith("two") ? 43 : 44,
        primaryIndex: 0,
        provEpgLoader() {},
        readFile: () => playlist,
        StripHttp: (value: string) => value.replace(/^https?:\/\//, ""),
        updateChanelInfo() {},
        window: native ? { Capacitor: {} } : {},
        xxHash32S: (value: string) => value.length,
        xxHash32Si: (value: string) => value.length,
    });
    vm.runInContext(
        fs.readFileSync(
            new URL("../vendor/ottplay-core.js", import.meta.url),
            "utf8"
        ),
        ctx
    );
    vm.runInContext(
        functions("providers/m3u/provider.js", [
            "getChanelsArray",
            "addChan2cat",
            "nativeXmltvSources",
            "nativeMatchMetadata",
        ]),
        ctx
    );
    ctx.getChanelsArray(() => {});
    assert.equal(ctx.chanels[42].epg, "private-id");
    if (!native) {
        assert.equal(
            ctx.chanels[42].xmltv_urls,
            undefined,
            "browser provider object remains unchanged"
        );
        assert.deepEqual(
            JSON.parse(JSON.stringify(ctx.nativeMatchMetadata())),
            {}
        );
    } else {
        assert.deepEqual(Array.from(ctx.chanels[42].xmltv_urls), [
            "http://first.test/private.xml",
            "https://second.test/guide.gz",
        ]);
        assert.deepEqual(Array.from(ctx.chanels[43].xmltv_urls), [
            "https://second.test/guide.gz",
        ]);
        assert.deepEqual(Array.from(ctx.chanels[44].xmltv_urls), [
            "https://alias.test/feed.xml",
        ]);
        assert.equal(
            ctx.nativeMatchMetadata().native_channels["42"].tvg_id,
            "private-id"
        );
    }
}

const calls: any[] = [];
const matcher = context({
    window: {
        Capacitor: {
            Plugins: {
                MobileXmltvEpg: {
                    getChannels: async (args: any) => {
                        calls.push(args);
                        return {
                            channels: [
                                {
                                    icon: "https://logo.test/wrong.png",
                                    id: "wrong",
                                    name: "Private +4",
                                    names: ["Private"],
                                },
                                {
                                    icon: "https://logo.test/right.png",
                                    id: "private-id",
                                    name: "Provider original name",
                                    names: ["Alias"],
                                },
                            ],
                        };
                    },
                },
            },
        },
    },
});
vm.runInContext(fs.readFileSync("vendor/ottplay-core.js", "utf8"), matcher);
matcher.window.OttPlayCore = matcher.OttPlayCore;
vm.runInContext(
    functions("src/plugins/m3u-proxy.ts", [
        "createNativeXmltvMatcher",
        "nativeLogoFallback",
        "matchCapacitorM3u",
    ]),
    matcher
);
const indexedRows = [
    { icon: "first.png", id: "duplicate", name: "First" },
    { icon: "second.png", id: "duplicate", name: "Second" },
    { icon: "prototype.png", id: "__proto__", name: "Prototype" },
    { icon: "constructor.png", id: "constructor", name: "Constructor" },
    { icon: "method.png", id: "toString", name: "Method" },
];
const indexed = matcher.createNativeXmltvMatcher(indexedRows);
assert.equal(indexed("duplicate", "", ""), indexedRows[0]);
assert.equal(indexed("", "Second", ""), indexedRows[0]);
for (const row of indexedRows.slice(2))
    assert.equal(indexed(row.id, "", ""), row);
assert.equal(indexed("missing", "", ""), undefined);
const body =
    JSON.stringify({
        native_channels: {
            "42": {
                name: "Private +4",
                tvg_id: "private-id",
                xmltv_urls: ["http://first.test/private.xml"],
            },
        },
    }) + "\n\t\nignored-old-hashes\n\t\n42-1-2-3~Private%20%2B4";
assert.equal(
    await matcher.matchCapacitorM3u(body, false),
    "{}\n\t\n42~local~42\n\t\nlocal~/"
);
assert.equal(
    await matcher.matchCapacitorM3u(body, true),
    "{}\n\t\n42~https://logo.test/right.png"
);
assert.deepEqual(Array.from(calls[0].xmltv_urls), [
    "http://first.test/private.xml",
]);
const missing = body
    .replace("private-id", "missing")
    .replace("Private +4", "Unrelated")
    .replace("Private%20%2B4", "Unrelated");
assert.match(
    await matcher.matchCapacitorM3u(missing, true),
    /42~data:image\/svg\+xml,/
);
matcher.window.location = { href: "capacitor://localhost/index.html" };
matcher.URL = URL;
vm.runInContext(
    functions(
        "src/plugins/m3u-proxy.ts",
        ["isLocalCapacitorCompanionUrl"],
        "setupCapacitorCompanionShim"
    ),
    matcher
);
assert.equal(matcher.isLocalCapacitorCompanionUrl("/m3u/match-channels"), true);
assert.equal(
    matcher.isLocalCapacitorCompanionUrl(
        "https://chosen.test/m3u/match-channels"
    ),
    false,
    "selected remote EPG services use normal jQuery/native HTTP transport"
);
console.log(
    "PASS native EPG parity: provider ownership, sources/aliases, browser invariance, M3U matching and logos"
);

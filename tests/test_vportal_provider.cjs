const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { fixture } = require("./helpers/provider-driver-fixture.cjs");
const runtime = require("./helpers/private-runtime.cjs");
const portal = "portal::[key:PRIVATE_ONE]https://portal.example/api/";
const other = "portal::[key:PRIVATE_TWO]https://other.example/api/";
function config() {
    return {
        active: 0,
        portals: Array.from({ length: 15 }, (_, i) => ({
            link: i ? "" : portal,
            name: i ? "" : "Films",
            sections: i ? [] : [{ request: { cmd: "films" }, title: "Films" }],
        })),
    };
}
function create(initial = {}) {
    const f = fixture(initial);
    const ast = ts.createSourceFile(
        "vportal.ts",
        fs.readFileSync("src/plugins/vportal.ts", "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const parse = ast.statements.find(
        (n) =>
            ts.isFunctionDeclaration(n) && n.name?.text === "parseVPortalLink"
    );
    vm.runInContext(
        ts.transpileModule(parse.getText(ast).replace(/^export /, ""), {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }).outputText,
        f.host
    );
    const clients = [];
    f.host.__ottVPortal = {
        create: (link, options) => {
            const c = {
                dispose() {
                    this.disposed++;
                },
                disposed: 0,
                link,
                load() {},
                options,
                playlist(sections, done) {
                    this.progress = done;
                    done(
                        [
                            {
                                __ottPlaylistId: "film",
                                stream_url: "https://stream.example/film",
                                title: "Film",
                            },
                        ],
                        false
                    );
                },
                resolve() {},
                sections(done) {
                    done({
                        items: [
                            { request: { cmd: "films" }, title: "Films" },
                            { request: { cmd: "series" }, title: "Series" },
                        ],
                    });
                },
            };
            clients.push(c);
            return c;
        },
        parse: f.host.parseVPortalLink,
    };
    runtime(f.host, "src/provider/vportal-driver.ts");
    runtime(f.host, "src/provider/source-identity.ts");
    const driver = f.mount("vportal");
    f.host.duneAddSettings(0);
    return { ...f, clients, driver };
}
{
    const f = create({ m3um3uArr: "M3U_UNTOUCHED" });
    let done = 0;
    f.host.getChannelsArray(() => done++);
    assert.equal(done, 0);
    assert.equal(f.host.listCaption.innerHTML, "VPortal profiles");
    assert.equal(f.driver.capabilities.libraryOnly, false);
    assert.equal(f.driver.capabilities.mediaPlaylist, true);
    assert.equal(f.clients.length, 0);
    assert.equal(f.saved.get("m3um3uArr"), "M3U_UNTOUCHED");
}
{
    const f = create({ vportalprofiles: JSON.stringify(config()) });
    let done = 0;
    f.host.getChannelsArray(() => done++);
    assert.equal(done, 1);
    assert.equal(f.host.cList.length, 1);
    assert.equal(f.driver.mediaItem(f.host.cList[0]).title, "Film");
    assert.equal(f.host.providerMediaClient, f.clients[0]);
    assert.equal(f.driver.libraryReady(), true);
    assert.equal(f.clients[0].options.title, "Films");
    const identity = f.host.__ottSourceIdentity.current(f.host);
    assert.match(identity, /^vportal:0@/);
    assert(!identity.includes("PRIVATE"));
    const snapshot = f.driver.configuration();
    snapshot.portals[0].link = other;
    assert.equal(
        f.driver.configuration().portals[0].link,
        portal,
        "configuration is detached"
    );
    const value = f.driver.configuration();
    value.portals[1] = {
        link: other,
        name: "Second",
        sections: [{ request: { cmd: "series" }, title: "Series" }],
    };
    assert.equal(f.driver.saveConfiguration(value), true);
    assert.equal(
        f.clients[0].disposed,
        0,
        "editing an inactive slot preserves playback"
    );
    value.active = 1;
    assert.equal(f.driver.saveConfiguration(value), true);
    assert.equal(f.clients[0].disposed, 1);
    assert.equal(f.clients[0].options.isCurrent(), false);
    f.host.getChannelsArray(() => done++);
    assert.notEqual(f.host.__ottSourceIdentity.current(f.host), identity);
    assert.equal(f.host.providerMediaClient, f.clients[1]);
}
{
    const f = create({ vportalprofiles: JSON.stringify(config()) });
    f.host.getChannelsArray(() => {});
    const before = f.saved.get("vportalprofiles");
    for (const bad of [
        "https://ordinary.example/file.m3u",
        "portal::[key:bad]javascript:alert(1)",
        "\n" + portal,
    ]) {
        const value = f.driver.configuration();
        value.portals[0].link = bad;
        assert.equal(f.driver.saveConfiguration(value), false);
        assert.equal(f.saved.get("vportalprofiles"), before);
    }
    f.host.checkProviderUrl = () => false;
    const value = f.driver.configuration();
    value.portals[0].link = other;
    assert.equal(f.driver.saveConfiguration(value), false);
}
{
    const f = create({ vportalprofiles: JSON.stringify(config()) });
    const request = (action, params) =>
        f.driver.remoteProfiles({ action, params });
    const listing = request("profiles", {});
    assert.equal(listing.status, "ok");
    assert.equal(listing.data.provider, "vportal");
    assert.equal(listing.data.profiles.length, 15);
    assert(!JSON.stringify(listing).includes("PRIVATE"));
    assert(!JSON.stringify(listing).includes("https:"));
    assert.equal(request("profile", { number: 2 }).status, "rejected");
    assert.equal(
        request("profile_settings", {
            number: 2,
            settings: { name: "Cartoons", vportal: other },
        }).status,
        "ok"
    );
    assert.equal(request("profile", { number: 2 }).data.profile.active, true);
    assert.equal(
        request("profile_settings", {
            number: 1,
            settings: { playlist: "https://tv.example/" },
        }).status,
        "rejected"
    );
    f.host.__ottKiosk = { enabled: () => true };
    assert.equal(request("profiles", {}).status, "ok");
    assert.equal(request("profile", { number: 1 }).status, "rejected");
}
{
    const f = create({ vportalprofiles: JSON.stringify(config()) });
    const before = f.saved.get("vportalprofiles");
    f.host.__ottEditProvider();
    f.host.selIndex = 0;
    f.host.listKeyHandler(f.host.keys.ENTER);
    f.host.selIndex = 1;
    f.host.listKeyHandler(f.host.keys.ENTER);
    const late = f.host.setEdit;
    const result = f.driver.remoteProfiles({
        action: "profile_settings",
        params: { number: 1, settings: { vportal: other } },
    });
    assert.equal(result.status, "ok");
    f.host.editvar = portal;
    late();
    assert.notEqual(f.saved.get("vportalprofiles"), before);
    assert.equal(f.driver.configuration().portals[0].link, other);
    assert(!JSON.stringify(f.host.listArray).includes("PRIVATE"));
}
{
    const value = config();
    value.portals[0].sections = [];
    const f = create({ vportalprofiles: JSON.stringify(value) });
    f.host.getChannelsArray(() =>
        assert.fail("Unselected library must not auto-load")
    );
    assert.equal(f.clients.length, 0);
    assert.equal(f.host.listCaption.innerHTML, "VPortal profiles");
}
{
    const f = create({ vportalprofiles: JSON.stringify(config()) });
    let done = 0;
    f.host.getChannelsArray(() => done++);
    const firstId = f.host.cList[0];
    f.clients[0].progress(
        [
            {
                __ottPlaylistId: "film",
                stream_url: "https://stream.example/film",
                title: "Film",
            },
            {
                __ottPlaylistId: "second",
                request: { cmd: "play", id: 2 },
                stream_url: "vportal:request",
                title: "Second",
            },
        ],
        false
    );
    assert.equal(done, 1, "incremental append does not restart playback");
    assert.equal(f.host.cList.length, 2);
    assert.equal(f.host.cList[0], firstId);
    assert.equal(f.driver.mediaItem(f.host.cList[1]).title, "Second");
    const old = f.clients[0];
    const value = f.driver.configuration();
    value.portals[0].sections = [{ request: { cmd: "other" }, title: "Other" }];
    assert.equal(f.driver.saveConfiguration(value), true);
    old.progress([{ __ottPlaylistId: "stale", title: "Stale" }], true);
    assert.equal(
        f.host.cList.length,
        2,
        "stale catalog cannot replace visible list"
    );
}
{
    const f = create({ vportalprofiles: JSON.stringify(config()) });
    f.host.__ottEditProvider();
    f.host.selIndex = 0;
    f.host.listKeyHandler(f.host.keys.ENTER);
    f.host.selIndex = 2;
    f.host.listKeyHandler(f.host.keys.ENTER);
    assert.equal(f.host.listCaption.innerHTML, "Category selection");
    assert.match(f.host.listArray[0], /☑/);
    f.host.selIndex = 1;
    f.host.listKeyHandler(f.host.keys.ENTER);
    f.host.listKeyHandler(f.host.keys.RETURN);
    f.host.selIndex = 3;
    f.host.listKeyHandler(f.host.keys.ENTER);
    assert.equal(f.driver.configuration().portals[0].sections.length, 2);
    assert.equal(f.clients[0].disposed, 1);
}
{
    const f = create({ vportalprofiles: JSON.stringify(config()) });
    for (const sections of [
        null,
        [{ request: [], title: "Bad" }],
        [{ request: { key: "secret" }, title: "Bad" }],
    ]) {
        const value = f.driver.configuration();
        value.portals[0].sections = sections;
        assert.equal(f.driver.saveConfiguration(value), false);
    }
}

{
    const value = config();
    value.portals[0].sections = [{}];
    const f = create({ vportalprofiles: JSON.stringify(value) });
    f.host.getChannelsArray(() =>
        assert.fail("Corrupt selection must not become implicit root access")
    );
    assert.equal(f.clients.length, 0);
}
{
    const f = create({ vportalprofiles: JSON.stringify(config()) });
    const result = f.driver.remoteProfiles({
        action: "profile_settings",
        params: {
            number: 1,
            settings: {
                sections: [{ request: { cmd: "selected" }, title: "Selected" }],
            },
        },
    });
    assert.equal(
        result.status,
        "rejected",
        "existing remote contract remains unchanged"
    );
}
{
    const f = create({ vportalprofiles: JSON.stringify(config()) });
    f.host.getChannelsArray(() => {});
    f.clients[0].progress(
        [
            {
                __ottPlaylistId: "film",
                stream_url: "https://stream.example/film",
                title: "Film",
            },
        ],
        true,
        "failure"
    );
    assert.equal(f.host.cList.length, 1);
    assert.equal(f.errors.at(-1), "VPortal request failed");
}

{
    const value = config();
    value.portals[0].sections[0].adult = true;
    value.portals[0].sections[0].sequence = true;
    const f = create({
        vportalprimaryIndex: "1",
        vportalprofiles: JSON.stringify(value),
    });
    let done = 0;
    f.host.getChannelsArray(() => done++);
    assert.equal(
        done,
        0,
        "restore waits for saved second item instead of starting the first episode"
    );
    f.clients[0].progress(
        [
            {
                __ottPlaylistId: "first",
                stream_url: "https://stream.example/first",
                title: "First",
            },
            {
                __ottPlaylistId: "saved",
                stream_url: "https://stream.example/saved",
                title: "Saved",
            },
        ],
        false
    );
    assert.equal(done, 1);
    assert.equal(f.driver.configuration().portals[0].sections[0].adult, true);
    assert.equal(
        f.driver.configuration().portals[0].sections[0].sequence,
        true
    );
}

{
    const f = create({
        vportalprimaryIndex: "1",
        vportalprofiles: JSON.stringify(config()),
    });
    let starts = 0;
    f.host.getChannelsArray(() => starts++);
    const loading = f.clients[0];
    assert.equal(starts, 0);
    f.host.__ottEditProvider();
    assert.equal(loading.disposed, 1);
    loading.progress(
        [
            { __ottPlaylistId: "first", title: "First" },
            { __ottPlaylistId: "saved", title: "Saved" },
        ],
        true
    );
    assert.equal(
        starts,
        0,
        "opening profile settings cancels startup instead of playing behind the editor"
    );
}

{
    const f = create({ vportalprofiles: JSON.stringify(config()) });
    const source = f.host.__ottSourceIdentity.current(f.host);
    f.saved.set(
        "vportalchannelLibrary:" + source,
        JSON.stringify({ selected: { itemId: "channel:missing" } })
    );
    const loads = [];
    f.driver.load((catalog) => loads.push(catalog));
    assert.equal(loads.length, 0);
    f.clients[0].progress(
        [
            {
                __ottPlaylistId: "film",
                stream_url: "https://stream.example/film",
                title: "Film",
            },
        ],
        true
    );
    assert.equal(loads.length, 1);
    assert.equal(
        loads[0].selectionMissing,
        true,
        "missing saved episode opens the list instead of playing an unrelated first entry"
    );
}

{
    const f = create({ vportalprofiles: JSON.stringify(config()) });
    runtime(f.host, "src/channels/library.ts");
    const source = f.host.__ottSourceIdentity.current(f.host);
    const library = f.host.__ottChannelLibrary.create(
        {
            current: () => true,
            get: (key) => f.saved.get("vportal" + key) || null,
            set: (key, value) => f.saved.set("vportal" + key, value),
            sourceId: source,
        },
        [
            {
                groupId: "vportal",
                groupLabel: "Films",
                id: 123,
                itemId: "vportal:saved",
                label: "Saved",
            },
        ]
    );
    assert.equal(library.select("vportal", 123), true);
    assert.equal(
        JSON.parse(f.saved.get("vportalchannelLibrary:" + source)).selected
            .itemId,
        "vportal:saved"
    );
    const loads = [];
    f.driver.load((catalog) => loads.push(catalog));
    assert.equal(loads.length, 0);
    f.clients[0].progress(
        [
            {
                __ottPlaylistId: "film",
                stream_url: "https://stream.example/film",
                title: "Film",
            },
            {
                __ottPlaylistId: "saved",
                stream_url: "https://stream.example/saved",
                title: "Saved",
            },
        ],
        false
    );
    assert.equal(
        loads.length,
        1,
        "actual channel library stable item identity resolves to projected numeric ID"
    );
    assert.equal(loads[0].selectionMissing, false);
}

{
    const f = create({ vportalprofiles: JSON.stringify(config()) });
    f.host.getChannelsArray(() => {});
    f.clients[0].progress(
        [
            {
                __ottPlaylistId: "film",
                stream_url: "https://stream.example/film",
                title: "Film",
            },
            {
                __ottPlaylistId: "adult",
                adult: 1,
                stream_url: "vportal:request",
                title: "Restricted",
            },
        ],
        false
    );
    const restricted = f.host.cList[1];
    assert.equal(
        f.host.channels[restricted].adult,
        1,
        "inherited adult metadata reaches ordinary channel rendering and admission"
    );
    assert.equal(f.driver.mediaItem(restricted).adult, 1);
    assert.equal(f.host.channels[f.host.cList[0]].adult, 0);
}
console.log(
    "VPortal provider profiles, isolation, validation, redaction and editor lifetime tests passed"
);

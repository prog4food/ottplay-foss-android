const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(
    path.join(root, "src/commands/index.ts"),
    "utf8"
);
const provider = fs.readFileSync(
    path.join(root, "src/provider/index.ts"),
    "utf8"
);
const ast = ts.createSourceFile(
    "provider.ts",
    provider,
    ts.ScriptTarget.Latest,
    true
);
const selected = ast.statements
    .filter(
        (node) =>
            ts.isFunctionDeclaration(node) &&
            ["selectProviderByIndex", "isProviderAllowed"].includes(
                node.name?.text
            )
    )
    .map((node) => node.getText(ast))
    .join("\n");
function emit(text) {
    return ts.transpileModule(text, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
}
const storage = new Map();
const loaded = [];
const pins = [];
const context = {
    clearTimeout() {},
    console,
    enterPinAndSetAccess(callback) {
        pins.push(callback);
    },
    exports: {},
    isPlayDistribution() {
        return context.playDistribution;
    },
    loadProv(id) {
        loaded.push({ id, saved: storage.get("ottplayprov") });
    },
    parentAccess: false,
    parentPIN: "1234",
    playDistribution: false,
    providerIds: ["m3u", "stalker", "xtream", "", "demo", "commercial"],
    setTimeout() {
        return 1;
    },
    sPSprovs: false,
    stbGetItem(key) {
        return storage.get(key);
    },
    stbSetItem(key, value) {
        storage.set(key, value);
    },
};
context.window = context;
vm.createContext(context);
require("./helpers/access-runtime.cjs")(context);
vm.runInContext(emit(selected), context);
const select = context.exports.selectProviderByIndex;
assert.equal(select(1), true);
assert.deepEqual(loaded.at(-1), { id: undefined, saved: "stalker" });
assert.equal(select(1), true);
assert.equal(loaded.length, 1, "current provider does not restart");
assert.equal(select(4), true);
assert.deepEqual(loaded.at(-1), { id: "demo", saved: "demo" });
assert.deepEqual(JSON.parse(storage.get("ottplayprovs")), ["demo"]);
context.ottplayDemoActive = true;
select(0);
assert.equal(loaded.at(-1).id, "m3u", "leaving demo passes explicit provider");
context.playDistribution = true;
assert.equal(select(5), false);
assert.equal(
    storage.get("ottplayprov"),
    "m3u",
    "Play registry cannot select commercial providers"
);
for (const invalid of [-1, 0.5, NaN, Infinity, 99, "1", 3])
    assert.equal(select(invalid), false);
context.sPSprovs = true;
assert.equal(select(2), false);
assert.equal(pins.length, 1);
assert.equal(storage.get("ottplayprov"), "m3u");
context.parentAccess = true;
pins[0]();
assert.equal(
    storage.get("ottplayprov"),
    "xtream",
    "selection only occurs after PIN access"
);

const delivered = [];
let volume = 40;
const w = {
    cats: { first: ["a"], second: ["b", "zero"] },
    catsArray: ["first", "second"],
    channels: {
        a: { channel_name: "News" },
        b: { channel_name: "Science" },
        zero: { channel_name: "Zero" },
    },
    curList: ["a", "b", "zero"],
    playChannel(...args) {
        delivered.push(args);
    },
    stbGetVolume() {
        return volume;
    },
    stbSetVolume(value) {
        volume = value;
    },
};
const localeRuntime = { window: w };
vm.createContext(localeRuntime);
vm.runInContext(localizationRuntime(), localeRuntime);
const cmdContext = {
    console,
    document: {
        getElementById() {
            return null;
        },
    },
    exports: {},
    require(name) {
        if (name === "../localization") return localeRuntime;
        if (name === "../shared/wire-contracts")
            return require("./load-wire.cjs")();
        assert.equal(name, "../provider");
        return {
            checkProviderUrl: (url) =>
                !w.rejectHttp || !url.startsWith("http:"),
            selectProviderByIndex: select,
        };
    },
    URL,
    window: w,
};
vm.runInNewContext(emit(source), cmdContext);
const handle = cmdContext.exports.handleCommand;
assert.equal(
    handle({ command: "exit_player" }),
    "unsupported",
    "legacy delivery cannot silently enter standby or unload before its ACK"
);
handle({ channel_name: "SCIENCE", command: "channel_by_name" });
assert.deepEqual(
    delivered,
    [[1, 0, true]],
    "name search commits fullscreen playback in later categories"
);
handle({ channel_name: "absent", command: "channel_by_name" });
assert.equal(delivered.length, 1, "not found must not play (-1,-1)");
handle({ channel_number: 3, command: "channel_by_number" });
assert.deepEqual(delivered.at(-1), [1, 1, true]);
handle({ command: "set_volume", volume: 150 });
assert.equal(volume, 100);
handle({ command: "set_volume", volume_step: -25 });
assert.equal(volume, 75);
for (const invalid of [NaN, Infinity, -Infinity, "5", null, {}, []]) {
    handle({ command: "set_volume", volume: invalid });
    assert.equal(volume, 75);
    handle({ command: "set_volume", volume_step: invalid });
    assert.equal(volume, 75);
}
for (const number of [0, -1, 1.5, NaN, Infinity, "2", null])
    handle({ channel_number: number, command: "channel_by_number" });
assert.equal(delivered.length, 2);
for (const range of [
    [0, 2],
    [2, 1],
    [1.5, 2],
    [1, Infinity],
    ["1", 2],
    {},
    null,
    [1],
])
    handle({ command: "random_channel", random_range: range });
assert.equal(delivered.length, 2);
handle({ command: "random_channel", random_range: [2, 2] });
assert.deepEqual(delivered.at(-1), [1, 0, true]);
handle({ channel_name: {}, command: "channel_by_name" });
handle({ command: "change_provider", provider: 1 });
assert.equal(
    storage.get("ottplayprov"),
    "stalker",
    "dispatcher changes actual provider"
);
handle({ command: "change_provider", provider: "2" });
assert.equal(storage.get("ottplayprov"), "stalker");
w.catsArray = undefined;
w.cats = undefined;
handle({ channel_name: "early", command: "channel_by_name" });
handle({ channel_number: 1, command: "channel_by_number" });
assert.equal(
    delivered.length,
    3,
    "early startup does not dispatch an invalid channel"
);
console.log(
    "PASS commands: later-category/no-match channels, string IDs, numeric validation, actual provider selection and PIN/Play policy"
);

// Exercise the actual shared playback boundary: only admitted remote selections
// retire the list/preview; the PIN continuation must keep that intent.
const playerAst = ts.createSourceFile(
    "index.ts",
    fs.readFileSync(path.join(root, "src/index.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true
);
const playSource = playerAst.statements
    .find(
        (node) =>
            ts.isFunctionDeclaration(node) && node.name?.text === "_playChannel"
    )
    .getText(playerAst);
function playbackFixture() {
    const events = [];
    const p = {
        cats: { All: ["a", "b"] },
        catsArray: ["All"],
        channels: { a: { id: "a" }, b: { id: "b" } },
        checkMedia() {},
        clearTimeout(id) {
            events.push(["cancel", id]);
        },
        closeList() {
            assert.equal(
                p.previewChan,
                null,
                "closing must not restore the old preview"
            );
            p.isListVisible = false;
            events.push(["close"]);
        },
        console: { log() {} },
        getChannelUrl: (id) => id,
        ifParentalAccessChId(_id, callback) {
            p.pendingPin = callback;
            return !!p.locked;
        },
        isListVisible: true,
        previewChan: { ch_id: "a" },
        previewTimer: 42,
        setCurrent(_category, index) {
            p.curList = p.cats.All;
            p.primaryIndex = index;
        },
        setTimeout() {},
        settings: {},
        stbPlay(url) {
            events.push(["play", url]);
        },
        updateChannelInfo() {},
    };
    p.window = p;
    vm.runInNewContext(emit(playSource), p);
    p.playChannel = p._playChannel;
    return { events, p };
}
for (const index of [0, 1]) {
    const { p, events } = playbackFixture();
    p.playChannel(0, index, true);
    assert.deepEqual(events.slice(0, 3), [
        ["cancel", 42],
        ["close"],
        ["play", index ? "b" : "a"],
    ]);
    assert.equal(p.isListVisible, false);
}
{
    const { p, events } = playbackFixture();
    p.locked = true;
    p.playChannel(0, 1, true);
    assert.deepEqual(events, [], "pending PIN preserves list and preview");
    p.locked = false;
    p.pendingPin();
    assert.equal(
        p.isListVisible,
        false,
        "PIN continuation preserves fullscreen intent"
    );
    assert.deepEqual(
        events.filter((event) => event[0] === "play"),
        [["play", "b"]]
    );
}
for (const kiosk of [
    null,
    { allowed: () => false },
    { admit: () => false, allowed: () => true },
]) {
    const { p, events } = playbackFixture();
    p.__ottKiosk = kiosk;
    p.playChannel(0, kiosk ? 1 : 99, true);
    assert.deepEqual(
        events,
        [],
        "invalid or kiosk-denied selection leaves the list intact"
    );
    assert.equal(p.isListVisible, true);
}
{
    const { p, events } = playbackFixture();
    p.playChannel(0, 1);
    assert.equal(
        p.isListVisible,
        true,
        "local preview/startup behavior is unchanged"
    );
    assert.equal(
        events.some((event) => event[0] === "cancel" && event[1] === 42),
        false
    );
}
console.log(
    "PASS remote fullscreen: admitted selection, current channel, PIN continuation, preview cancellation, kiosk denial and local playback"
);

const writes = [];
let playlistLoads = 0;
w.p_pref = "stalker";
w.providerSetItem = (key, value) => writes.push({ key, value });
w.restart = () =>
    assert.fail("remote command must not restart after writing unused keys");
assert.equal(
    handle({ command: "change_provider_settings", provider_settings: "{}" }),
    "unsupported"
);
assert.equal(
    handle({
        command: "change_playlist",
        playlist: "https://example.invalid/new.m3u",
    }),
    "unsupported"
);
assert.equal(writes.length, 0);
w.p_pref = "m3u";
w.m3uArr = {
    active: 1,
    M3Us: [
        { name: "first", www: "https://old/a" },
        {
            medUrl: "https://old/media",
            name: "second",
            rechours: 12,
            www: "https://old/b",
        },
    ],
};
const m3uSource = fs.readFileSync(
    path.join(root, "providers/m3u/provider.js"),
    "utf8"
);
const m3uAst = ts.createSourceFile(
    "provider.js",
    m3uSource,
    ts.ScriptTarget.Latest,
    true
);
const actualPlaylistLoader = m3uAst.statements
    .filter(
        (node) =>
            ts.isFunctionDeclaration(node) &&
            ["loadM3Uparams", "loadPlaylist"].includes(node.name?.text)
    )
    .map((node) => node.getText(m3uAst))
    .join("\n");
w.m3uCap = 15;
w._number = 0;
w.browserName = () => "pc";
w.providerGetItem = (key) => {
    assert.equal(key, "m3uArr");
    return writes.at(-1).value;
};
w._m3u2popup = () => {};
w.m3uUpdateMedia = () => {};
w.loadChannels = () => {
    playlistLoads++;
};
vm.runInNewContext(actualPlaylistLoader, w);
assert.equal(
    handle({
        command: "change_playlist",
        playlist: "https://example.invalid/new.m3u",
    }),
    "accepted"
);
assert.equal(writes[0].key, "m3uArr");
assert.equal(playlistLoads, 1);
assert.equal(w.m3uArr.M3Us[1].www, "https://example.invalid/new.m3u");
assert.equal(w.m3uArr.M3Us[0].www, "https://old/a");
assert.equal(w.m3uArr.M3Us[1].medUrl, "https://old/media");
assert.equal(w.m3uArr.M3Us[1].rechours, 12);
for (const playlist of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a URL",
])
    assert.equal(handle({ command: "change_playlist", playlist }), "rejected");
w.rejectHttp = true;
assert.equal(
    handle({
        command: "change_playlist",
        playlist: "http://example.invalid/new.m3u",
    }),
    "rejected",
    "Play HTTPS policy survives remote commands"
);
w.sPSoptions = true;
w.parentPIN = "1234";
w.parentAccess = false;
assert.equal(
    handle({
        command: "change_playlist",
        playlist: "https://example.invalid/new.m3u",
    }),
    "rejected",
    "remote playlist change cannot bypass settings lock"
);
assert.equal(writes.length, 1);
w.commandChannelsReady = false;
w.stbIsStandby = () => true;
const beforeStandby = delivered.length;
for (const command of [
    { channel_number: 1, command: "channel_by_number" },
    { channel_name: "News", command: "channel_by_name" },
    { command: "random_channel" },
]) {
    assert.equal(
        handle(command),
        "rejected",
        "standby commands must not wait for wake"
    );
}
assert.equal(delivered.length, beforeStandby);
w.stbIsStandby = () => false;
assert.equal(
    handle({ channel_number: 1, command: "channel_by_number" }),
    "deferred"
);
assert.equal(
    handle({ channel_name: "News", command: "channel_by_name" }),
    "deferred"
);
assert.equal(handle({ command: "random_channel" }), "deferred");
w.commandChannelsReady = true;
assert.equal(
    handle({ channel_number: 1, command: "channel_by_number" }),
    "accepted",
    "finished empty provider reports no match instead of waiting forever"
);
console.log(
    "PASS command outcomes: active M3U persistence/reload, unsupported provider settings, protocol/parental/Play validation and startup deferral"
);

// Exercise the real dictionaries, interpolation and Unicode search policy at
// the visible notification boundary. Remote-authored messages remain literal.
const dom = new JSDOM('<div id="notifications"></div>', {
    runScripts: "outside-only",
});
try {
    const host = dom.window;
    host.eval(localizationRuntime());
    function language(file, code) {
        host.eval(
            fs.readFileSync(path.join(root, "locales", file + ".js"), "utf8")
        );
        host.__ottInterfaceLanguage = code;
    }
    const played = [];
    let providerAvailable = false;
    Object.assign(host, {
        cats: { main: ["one"] },
        catsArray: ["main"],
        channels: { one: { channel_name: "Первый" } },
        commandChannelsReady: true,
        curList: ["one"],
        playChannel: (...args) => played.push(args),
        stbGetVolume: () => 40,
        stbSetVolume() {},
    });
    const c = {
        document: host.document,
        exports: {},
        require(name) {
            if (name === "../localization") return host;
            if (name === "../shared/wire-contracts")
                return require("./load-wire.cjs")();
            assert.equal(name, "../provider");
            return {
                checkProviderUrl: () => true,
                selectProviderByIndex: () => providerAvailable,
            };
        },
        setTimeout() {},
        URL,
        window: host,
    };
    vm.runInNewContext(emit(source), c);
    const command = c.exports.handleCommand;
    const notifications = host.document.getElementById("notifications");
    function last() {
        return notifications.lastElementChild;
    }
    function expectMessage(input, key, ...args) {
        assert.notEqual(
            host.keyStrings[key],
            undefined,
            "real catalog must contain " + key
        );
        assert.notEqual(
            host.keyStrings[key],
            key,
            "Russian message must be translated: " + key
        );
        command(input);
        assert.equal(last().textContent, host._(key, ...args));
        assert.equal(last().dir, "auto");
    }
    language("russian", "_rus");
    command({ command: "set_volume", volume: 55 });
    assert.equal(last().textContent, "громкость: 55%");
    command({ command: "set_volume", volume_step: 5 });
    assert.equal(last().textContent, "громкость: 45%");
    const volumeWrites = [];
    host.stbSetVolume = (value) => volumeWrites.push(value);
    host.stbGetVolume = () => {
        throw new Error("absolute volume must not read current volume");
    };
    command({ command: "set_volume", volume: 20, volume_step: 90 });
    assert.deepEqual(
        volumeWrites,
        [20],
        "absolute volume keeps priority over step"
    );
    for (const missing of [undefined, null]) {
        host.stbGetVolume = () => missing;
        const count = notifications.children.length;
        command({ command: "set_volume", volume_step: 5 });
        assert.equal(notifications.children.length, count);
        assert.deepEqual(
            volumeWrites,
            [20],
            "missing current volume ignores relative changes"
        );
    }
    host.stbGetVolume = () => 40;
    expectMessage(
        { channel_number: 2, command: "channel_by_number" },
        "Channel #%1 not found (total: %2)",
        "2",
        "1"
    );
    host.cats.main = [];
    expectMessage(
        { channel_number: 1, command: "channel_by_number" },
        "Channel #%1 not in any category",
        "1"
    );
    expectMessage(
        { command: "random_channel" },
        "Random channel not in any category"
    );
    host.cats.main = ["one"];
    command({ channel_number: 1, command: "channel_by_number" });
    assert.equal(last().textContent, host._("Channel #%1", "1") + ": Первый");
    command({ command: "random_channel" });
    assert.equal(last().textContent, host._("Random #%1", "1") + ": Первый");
    expectMessage(
        { command: "random_channel", random_range: [2, 3] },
        "Invalid range: %1-%2",
        "2",
        "3"
    );
    expectMessage(
        { channel_name: "Отсутствующий", command: "channel_by_name" },
        'Channel "%1" not found',
        "Отсутствующий"
    );
    const literal = "<img src=x onerror=alert(1)> $& %1 العربية";
    host.channels.one.channel_name = literal;
    expectMessage(
        { channel_name: "onerror", command: "channel_by_name" },
        "Playing: %1",
        literal
    );
    assert.equal(
        last().children.length,
        0,
        "provider names are text, never markup"
    );
    host.curList = [];
    expectMessage(
        { channel_number: 1, command: "channel_by_number" },
        "No channels loaded"
    );
    expectMessage(
        { command: "change_provider", provider: 0 },
        "Provider switching not available"
    );
    providerAvailable = true;
    expectMessage(
        { command: "change_provider", provider: 0 },
        "Switching provider..."
    );
    expectMessage(
        { command: "change_provider_settings", provider_settings: "{}" },
        "Remote provider settings are not supported. Use the player's provider settings."
    );
    const playlistCommand = {
        command: "change_playlist",
        playlist: "https://example.invalid/next.m3u",
    };
    expectMessage(
        playlistCommand,
        "Remote playlist changes require the M3U provider."
    );
    Object.assign(host, {
        loadPlaylist() {},
        m3uArr: {
            active: 0,
            M3Us: [{ www: "https://example.invalid/old.m3u" }],
        },
        p_pref: "m3u",
        parentAccess: false,
        parentPIN: "1234",
        providerSetItem() {},
        sPSoptions: true,
    });
    expectMessage(
        playlistCommand,
        "Unlock the player's settings before changing its playlist."
    );
    host.parentAccess = true;
    expectMessage(playlistCommand, "Loading the new playlist...");
    host.loadPlaylist = () => {
        throw new Error("raw backend detail");
    };
    expectMessage(playlistCommand, "Could not change the playlist.");

    // Locale changes affect the next command without reconstructing its handler.
    language("arabic", "_ara");
    command({ command: "set_volume", volume: 55 });
    assert.equal(
        last().textContent,
        host._("volume") +
            ": " +
            new host.Intl.NumberFormat("ar", { useGrouping: false }).format(
                55
            ) +
            "%"
    );
    assert.equal(last().dir, "auto");
    command({ command: "popup_message", message: literal });
    assert.equal(last().textContent, literal);
    assert.equal(last().children.length, 0);
    command({ command: "popup_message", message: "No channels loaded" });
    assert.equal(
        last().textContent,
        "No channels loaded",
        "remote-authored text is never a translation key"
    );

    host.curList = ["one"];
    host.channels.one.channel_name = "BBC One";
    for (const ready of [true, false]) {
        host.commandChannelsReady = ready;
        for (const name of [
            " ",
            "\t",
            "\n",
            "\t \n",
            "\u00a0",
            "\u2003",
            "\u3000",
        ]) {
            const before = played.length;
            const outcome = command({
                channel_name: name,
                command: "channel_by_name",
            });
            assert.equal(
                played.length,
                before,
                "blank name must not play a channel containing a space"
            );
            assert.equal(
                outcome,
                "rejected",
                "blank name must be rejected, including before channels are ready"
            );
        }
    }
    host.commandChannelsReady = true;
    for (const [file, code, title, query] of [
        ["german", "_ger", "BBC One", "One"],
        ["german", "_ger", "BBC One", "c o"],
        ["german", "_ger", "Straße", "STRASSE"],
        ["german", "_ger", "Café", "CAFE\u0301"],
        ["turkish", "_tur", "IŞIK", "ışık"],
        ["turkish", "_tur", "İzmir", "izmir"],
    ]) {
        language(file, code);
        host.channels.one.channel_name = title;
        const before = played.length;
        command({ channel_name: query, command: "channel_by_name" });
        assert.equal(played.length, before + 1, file + ": " + query);
        assert.deepEqual(played.at(-1), [0, 0, true]);
        assert.equal(last().textContent, host._("Playing: %1", title));
    }
    host.channels.one.channel_name = "Café";
    const before = played.length;
    command({ channel_name: "Cafe", command: "channel_by_name" });
    assert.equal(played.length, before, "search preserves accent distinctions");

    const keySource = ts.createSourceFile(
        "keys.ts",
        fs.readFileSync(path.join(root, "src/key-handler/index.ts"), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const mainKey = keySource.statements.find(
        (node) =>
            ts.isFunctionDeclaration(node) &&
            node.name?.text === "handleMainKey"
    );
    host.eval(emit(mainKey.getText(keySource)));
    host.settings = { volumeStep: 5 };
    host.toggleMainPlayback = () => {};
    host.__ottClassicScreenPort = { normalize: () => ({ id: "volume-up" }) };
    const shifts = [];
    host.showShift = (message) => shifts.push(message);
    language("russian", "_rus");
    host.handleMainKey(175, { preventDefault() {}, stopPropagation() {} });
    assert.equal(shifts.at(-1), "громкость: 45");
    language("arabic", "_ara");
    host.handleMainKey(175, { preventDefault() {}, stopPropagation() {} });
    assert.equal(
        shifts.at(-1),
        host._("volume") +
            ": " +
            new host.Intl.NumberFormat("ar", { useGrouping: false }).format(45)
    );
} finally {
    dom.window.close();
}

// New app-owned prose cannot silently bypass localization at this UI sink.
// Translated template literals and remote/channel identifiers remain allowed.
const commandAst = ts.createSourceFile(
    "commands.ts",
    source,
    ts.ScriptTarget.Latest,
    true
);
function assertNoRawMessage(node) {
    if (
        ts.isCallExpression(node) &&
        node.expression.getText(commandAst) === "_"
    )
        return;
    if (ts.isStringLiteralLike(node))
        assert(
            !/[A-Za-z]/.test(node.text),
            "Untranslated notification literal: " + node.text
        );
    ts.forEachChild(node, assertNoRawMessage);
}
function visitNotifications(node) {
    if (
        ts.isCallExpression(node) &&
        node.expression.getText(commandAst) === "showPopup"
    )
        assertNoRawMessage(node.arguments[0]);
    ts.forEachChild(node, visitNotifications);
}
visitNotifications(commandAst);
console.log(
    "PASS command localization: real RU/AR notifications, literal remote text, safe RTL DOM, blank-name rejection, Unicode name search and keyboard volume"
);

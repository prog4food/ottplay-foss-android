const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const compile = (text) =>
    ts.transpileModule(text, {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
const source = fs.readFileSync(
    path.join(root, "src/playback/stream-policy.ts"),
    "utf8"
);
const core = ts.createSourceFile(
    "core.ts",
    fs.readFileSync(path.join(root, "src/core/index.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true
);
const recovery = ["countCoreAttempt", "createCoreStreamAttempt"]
    .map((name) => {
        const node = core.statements.find(
            (candidate) =>
                ts.isFunctionDeclaration(candidate) &&
                candidate.name.text === name
        );
        assert.ok(node, "missing core dependency: " + name);
        return node.getText(core);
    })
    .join("\n");
function fixture() {
    const storage = new Map(),
        menus = [],
        messages = [],
        timers = new Map();
    let sequence = 0,
        current = true,
        kind = "live";
    const w = {
        _: (text) => text,
        __ottClassicPlayback: {
            context: () => ({ isCurrentBackend: () => current }),
            snapshot: () => ({
                phase: "playing",
                target: { channelId: "channel-a", kind, sourceId: "source-a" },
            }),
        },
        _playSession: 1,
        $: () => ({ hide() {} }),
        clearTimeout: (id) => timers.delete(id),
        coreAttemptCounters: {
            engineStarts: 1,
            fatalErrors: 0,
            nativeFallbacks: 0,
            streamRetries: 0,
        },
        forcePlay: true,
        providerGetItem: (key) => storage.get(key),
        providerSetItem: (key, value) => storage.set(key, value),
        setTimeout: (callback) => {
            timers.set(++sequence, callback);
            return sequence;
        },
        showSelectBox: (selected, items, done, timeout) =>
            menus.push({ done, items, selected, timeout }),
        showShift: (text) => messages.push(text),
        video: null,
    };
    w.window = w;
    vm.createContext(w);
    vm.runInContext(compile(source + "\n" + recovery), w);
    const policy = w.__ottStreamPolicy;
    function setBackups(rows) {
        storage.set(
            "streamBackupsV1",
            JSON.stringify({
                channels: { '["source-a","channel-a"]': rows },
                version: 1,
            })
        );
    }
    function tick() {
        const [id, fn] = timers.entries().next().value;
        timers.delete(id);
        fn();
    }
    return {
        invalidate: () => {
            current = false;
        },
        menus,
        messages,
        policy,
        setBackups,
        setKind: (value) => {
            kind = value;
        },
        storage,
        tick,
        timers,
        w,
    };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
{
    const f = fixture();
    for (const address of [
        "https://a.invalid/x?token=abc",
        "http://127.0.0.1:8777/live",
        "https://[2001:db8::1]/x",
    ])
        assert.equal(f.policy.validUrl(address), true, address);
    for (const address of [
        "javascript:alert(1)",
        "https://name:secret@a.invalid/",
        "https://a.invalid:99999/",
        "https://a.invalid:word/x",
        "https://a.invalid/\nsecret",
        "https://a.invalid\\@evil.invalid/",
        "//a.invalid/x",
    ])
        assert.equal(f.policy.validUrl(address), false, address);
    f.setBackups(["https://a.invalid/live", "", "https://b.invalid/live"]);
    assert.deepEqual(plain(f.policy.endpoints("https://a.invalid/live")), [
        "https://a.invalid/live",
        "https://b.invalid/live",
    ]);
    f.setKind("archive");
    assert.deepEqual(plain(f.policy.endpoints("archive")), ["archive"]);
    f.setKind("vod");
    assert.deepEqual(plain(f.policy.endpoints("movie")), ["movie"]);
    f.setKind("live");
    f.invalidate();
    assert.deepEqual(plain(f.policy.endpoints("live")), ["live"]);
}
{
    const f = fixture();
    f.w.sStreamMaxHeight = 720;
    f.w.sStreamMaxBitrate = 4000000;
    assert.deepEqual(plain(f.policy.quality()), {
        maxBitrate: 4000000,
        maxHeight: 720,
    });
    const good = { bitrate: 3000000, height: 720 };
    const player = {
        levels: [
            { bitrate: 6000000, height: 480 },
            good,
            { bitrate: 2000000, height: 1080 },
        ],
        removeLevel(index) {
            this.levels.splice(index, 1);
        },
    };
    assert.equal(f.policy.hls(player, f.policy.quality()), true);
    assert.deepEqual(
        player.levels,
        [good],
        "an interleaved unsafe low index must not leak through an index cap"
    );
    assert.equal(player.autoLevelCapping, 0);
    assert.equal(player.startLevel, 0);
    assert.equal(
        f.policy.hls(
            { levels: [{ bitrate: 2000000, height: 1080 }] },
            f.policy.quality()
        ),
        false
    );
    assert.equal(
        f.policy.hls({ levels: [{}] }, f.policy.quality()),
        false,
        "unknown metadata cannot prove a ceiling"
    );
    assert.equal(
        f.policy.hls({ levels: [{}] }, { maxBitrate: 0, maxHeight: 0 }),
        true
    );
    f.w.sStreamMaxHeight = Infinity;
    f.w.sStreamMaxBitrate = -1;
    assert.deepEqual(plain(f.policy.quality()), {
        maxBitrate: 0,
        maxHeight: 0,
    });
    f.policy.report({ attempts: 3, endpoint: 2 });
    f.policy.begin("shaka", true);
    assert.equal(
        f.policy.snapshot().attempts,
        3,
        "engine restart must not erase recovery evidence"
    );
}
{
    const f = fixture();
    let save;
    f.policy.edit((_caption, _value, done) => {
        save = done;
    });
    assert.equal(
        f.menus[0].timeout,
        -1,
        "opening or focusing a slot must not auto-commit its action"
    );
    f.menus.shift().done(2);
    save("https://backup.invalid/live");
    let data = JSON.parse(f.storage.get("streamBackupsV1"));
    assert.deepEqual(data.channels['["source-a","channel-a"]'], [
        "",
        "",
        "https://backup.invalid/live",
    ]);
    assert.equal(f.messages.pop(), "Settings saved");
    f.policy.edit((_caption, _value, done) => {
        save = done;
    });
    f.menus.shift().done(2);
    f.menus.shift().done(1);
    data = JSON.parse(f.storage.get("streamBackupsV1"));
    assert.deepEqual(
        data.channels,
        {},
        "Delete removes only the selected slot"
    );
    f.policy.edit((_caption, _value, done) => {
        save = done;
    });
    f.menus.shift().done(0);
    f.setBackups(["https://remote.invalid/new"]);
    save("https://old-editor.invalid/live");
    assert.equal(
        f.messages.pop(),
        "Backup state changed",
        "stale editor must not overwrite a concurrent update"
    );
    f.policy.edit((_caption, _value, done) => {
        save = done;
    });
    f.menus.shift().done(1);
    f.invalidate();
    save("https://wrong-source.invalid/live");
    assert.deepEqual(plain(f.policy.endpoints("primary")), ["primary"]);
    assert.ok(!f.storage.get("streamBackupsV1").includes("wrong-source"));
}
{
    const f = fixture(),
        attempts = [];
    f.setBackups([
        "https://b.invalid/live",
        "https://c.invalid/live",
        "https://d.invalid/live",
    ]);
    const run = f.w.createCoreStreamAttempt(
        1,
        "https://a.invalid/live",
        (url) => attempts.push(url)
    );
    for (let i = 0; i < 5; i++) {
        run.fail("network", 503);
        run.fail("network", 503);
        assert.equal(f.timers.size, 1, "duplicate errors coalesce");
        f.tick();
    }
    run.fail("network", 503);
    assert.equal(f.timers.size, 0);
    assert.deepEqual(attempts, [
        "https://a.invalid/live",
        "https://a.invalid/live",
        "https://b.invalid/live",
        "https://c.invalid/live",
        "https://d.invalid/live",
    ]);
    assert.equal(f.policy.snapshot().attempts, 5);
    assert.equal(f.w.coreAttemptCounters.streamRetries, 5);
    assert.equal(f.policy.snapshot().state, "failed");
    assert.equal(f.messages.pop(), "Stream could not be played");
    assert.equal(
        run.resume(),
        true,
        "terminal failure cannot autoplay a retired decoder"
    );
}
{
    const f = fixture(),
        attempts = [];
    f.setBackups([
        "https://b.invalid/live",
        "https://c.invalid/live",
        "https://d.invalid/live",
    ]);
    const run = f.w.createCoreStreamAttempt(1, "primary", (url) =>
        attempts.push(url)
    );
    // One parse retry and one network retry share the total of two, even
    // across backup endpoints. Duplicate errors cannot consume that budget.
    for (const kind of ["parse", "parse", "network", "parse", "parse"]) {
        run.fail(kind);
        run.fail(kind);
        assert.equal(f.timers.size, 1);
        f.tick();
    }
    assert.deepEqual(attempts, [
        "primary",
        "https://b.invalid/live",
        "https://b.invalid/live",
        "https://c.invalid/live",
        "https://d.invalid/live",
    ]);
    for (const kind of ["parse", "network"]) run.fail(kind);
    assert.equal(f.timers.size, 0);
    assert.equal(f.policy.snapshot().attempts, 5);
    assert.equal(f.policy.snapshot().state, "failed");
}
for (const status of [401, 403]) {
    const f = fixture();
    f.setBackups(["https://b.invalid/live"]);
    const run = f.w.createCoreStreamAttempt(1, "primary", () =>
        assert.fail("denial must cancel a queued parse reconnect")
    );
    run.fail("parse");
    assert.equal(f.timers.size, 1);
    const stale = f.timers.values().next().value;
    run.fail("parse", status);
    assert.equal(f.timers.size, 0);
    stale();
    run.resume();
    assert.equal(f.w.coreAttemptCounters.streamRetries, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.messages.pop(), "Source sign-in required");
}
for (const status of [401, 403]) {
    const f = fixture();
    f.setBackups(["https://b.invalid/live"]);
    f.w
        .createCoreStreamAttempt(1, "primary", () =>
            assert.fail("access denial must not try backups")
        )
        .fail("network", status);
    assert.equal(f.timers.size, 0);
    assert.equal(f.messages.pop(), "Source sign-in required");
}
for (const cancel of ["dispose", "source", "session"]) {
    const f = fixture();
    const run = f.w.createCoreStreamAttempt(1, "primary", () =>
        assert.fail("cancelled timer restarted playback")
    );
    run.fail("network");
    const stale = [...f.timers.values()][0];
    if (cancel === "dispose") run.dispose();
    if (cancel === "source") f.invalidate();
    if (cancel === "session") f.w._playSession++;
    stale();
    assert.equal(f.w.coreAttemptCounters.streamRetries, 0, cancel);
}
{
    const f = fixture(),
        attempts = [];
    const run = f.w.createCoreStreamAttempt(1, "primary", (url) =>
        attempts.push(url)
    );
    run.fail("network");
    f.w.forcePlay = false;
    run.pause();
    assert.equal(f.timers.size, 0);
    run.fail("network");
    assert.equal(f.timers.size, 0);
    f.w.forcePlay = true;
    assert.equal(run.resume(), true);
    f.tick();
    assert.deepEqual(attempts, ["primary"]);
    assert.equal(f.w.coreAttemptCounters.streamRetries, 1);
}
{
    const f = fixture(),
        attempts = [];
    f.setBackups(["https://b.invalid/live"]);
    const run = f.w.createCoreStreamAttempt(1, "primary", (url) =>
        attempts.push(url)
    );
    run.fail("network", 404);
    f.tick();
    assert.deepEqual(
        attempts,
        ["https://b.invalid/live"],
        "permanent missing URL should skip same-URL retries"
    );
    run.fail("quality");
    assert.equal(f.timers.size, 0);
    assert.equal(f.messages.pop(), "No stream meets the quality limits");
}
console.log(
    "PASS stream policy: quality ceilings, scoped editable backups, bounded retries, cancellation and credential-safe errors"
);

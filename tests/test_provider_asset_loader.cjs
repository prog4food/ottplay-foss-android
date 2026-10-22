const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const ts = require("typescript");
const privateRuntime = require("./helpers/private-runtime.cjs");
const { integrationFixture } = require("./helpers/provider-driver-fixture.cjs");

let count = 0;
function test(name, run) {
    run();
    count++;
    console.log("PASS provider assets: " + name);
}
function owner() {
    let active = true;
    const cleanups = new Set();
    return {
        active: () => active,
        get cleanups() {
            return cleanups.size;
        },
        dispose() {
            active = false;
            const pending = [...cleanups];
            cleanups.clear();
            pending.forEach((cleanup) => cleanup());
        },
        own(cleanup) {
            if (active) cleanups.add(cleanup);
            else cleanup();
            return () => cleanups.delete(cleanup);
        },
    };
}
function fixture(host = {}) {
    if (!vm.isContext(host)) {
        host.window = host;
        vm.createContext(host);
    }
    privateRuntime(host, "src/provider/assets.ts");
    const requests = [];
    const assets = host.__ottProviderAssets;
    assets.classic = assets.create(host, (url, ready, fail) => {
        requests.push({ fail, ready, url });
    });
    function publish(kind) {
        for (const [name, ...methods] of assets.groups[kind]) {
            host[name] = Object.fromEntries(
                methods.map((method) => [method, () => {}])
            );
        }
    }
    function ensure(
        kind,
        lifetime,
        ready,
        fail = (error) => {
            throw error;
        }
    ) {
        assets.classic.ensure(
            kind,
            "https://player.test/",
            "beta 20",
            lifetime,
            ready,
            fail
        );
    }
    return { assets, ensure, host, publish, requests };
}

test("standby counts in-flight scripts until settlement and denies new loads", () => {
    const f = fixture({ clearInterval, clearTimeout, Promise, setTimeout });
    vm.runInContext(
        ts.transpileModule(
            fs
                .readFileSync("src/core/standby.ts", "utf8")
                .replace(/^export /gm, ""),
            { compilerOptions: { target: ts.ScriptTarget.ES5 } }
        ).outputText,
        f.host
    );
    const gate = f.host.installStandby(
        f.host,
        () => "0",
        () => {}
    );
    const lifetime = owner();
    let mounted = 0,
        rejected = 0;
    f.ensure("m3u", lifetime, () => mounted++);
    lifetime.dispose();
    gate.set(true);
    assert.equal(gate.snapshot().state, "suspending");
    assert.equal(gate.snapshot().pending, 1);
    f.ensure(
        "plex",
        owner(),
        () => mounted++,
        () => rejected++
    );
    assert.equal(rejected, 1);
    assert.equal(f.requests.length, 1);
    f.publish("m3u");
    f.requests[0].ready();
    assert.equal(mounted, 0);
    assert.equal(gate.snapshot().state, "suspended");
});

test("eager and unknown kinds stay synchronous without network", () => {
    const f = fixture();
    const lifetime = owner();
    let completed = 0;
    for (const kind of [
        "demo",
        "operator",
        "xtream-fallback",
        "named-playlist",
        "",
        "constructor",
        "__proto__",
    ]) {
        f.ensure(kind, lifetime, () => completed++);
    }
    assert.equal(completed, 7);
    assert.equal(f.requests.length, 0);
    assert.equal(lifetime.cleanups, 0);
});

test("every complete preloaded family stays synchronous", () => {
    const f = fixture();
    const kinds = Object.keys(f.assets.groups).sort();
    assert.deepEqual(kinds, [
        "catalog",
        "edem",
        "m3u",
        "playlist",
        "plex",
        "stalker",
        "vportal",
        "xtream",
    ]);
    let completed = 0;
    for (const kind of kinds) {
        f.publish(kind);
        f.ensure(kind, owner(), () => completed++);
    }
    assert.equal(completed, 8);
    assert.equal(f.requests.length, 0);
});

test("loads only the selected family and validates every exported method", () => {
    const f = fixture();
    const lifetime = owner();
    let completed = 0;
    f.host.__ottM3uDriver = { create() {}, mount() {}, reportLoad() {} };
    f.ensure("m3u", lifetime, () => completed++);
    assert.equal(completed, 0);
    assert.equal(f.requests.length, 1);
    assert.equal(
        f.requests[0].url,
        "https://player.test/dist/provider-m3u.js?beta%2020"
    );
    assert.equal(lifetime.cleanups, 1);
    f.publish("m3u");
    f.requests[0].ready();
    assert.equal(completed, 1);
    assert.equal(lifetime.cleanups, 0);
    f.ensure("m3u", lifetime, () => completed++);
    assert.equal(completed, 2);
    assert.equal(f.requests.length, 1);
    assert.equal(f.host.__ottStalkerDriver, undefined);
});

test("coalesces a family request and detaches retired owners", () => {
    const f = fixture();
    const first = owner(),
        second = owner();
    const completed = [];
    f.ensure("stalker", first, () => completed.push("first"));
    f.ensure("stalker", second, () => completed.push("second"));
    assert.equal(f.requests.length, 1);
    first.dispose();
    f.publish("stalker");
    f.requests[0].ready();
    assert.deepEqual(completed, ["second"]);
    assert.equal(second.cleanups, 0);
    f.requests[0].ready();
    f.requests[0].fail(new Error("late"));
    assert.deepEqual(completed, ["second"]);
});

test("a retired request can warm the cache without mounting or reporting errors", () => {
    const f = fixture();
    const lifetime = owner();
    let completed = 0,
        failed = 0;
    f.ensure(
        "edem",
        lifetime,
        () => completed++,
        () => failed++
    );
    lifetime.dispose();
    f.publish("edem");
    f.requests[0].ready();
    f.requests[0].fail(new Error("late"));
    assert.equal(completed, 0);
    assert.equal(failed, 0);
    f.ensure("edem", owner(), () => completed++);
    assert.equal(completed, 1);
    assert.equal(f.requests.length, 1);
});

test("network and incomplete-module failures permit retry without stale settlement", () => {
    const f = fixture();
    const lifetime = owner();
    const errors = [];
    let completed = 0;
    const ensure = () =>
        f.ensure(
            "catalog",
            lifetime,
            () => completed++,
            (error) => errors.push(error)
        );
    ensure();
    f.requests[0].fail(new Error("offline"));
    assert.equal(errors[0].message, "offline");
    assert.equal(lifetime.cleanups, 0);
    ensure();
    f.host.__ottCatalogDrivers = {
        create() {},
        mountSettings() {},
    };
    f.requests[1].ready();
    assert.match(errors[1].message, /Incomplete provider module: catalog/);
    ensure();
    f.requests[0].ready();
    f.requests[1].fail(new Error("late"));
    assert.equal(errors.length, 2);
    assert.equal(completed, 0);
    f.publish("catalog");
    f.requests[2].ready();
    assert.equal(completed, 1);
    assert.equal(lifetime.cleanups, 0);
});

test("different families load independently and inactive owners cause no fetch", () => {
    const f = fixture();
    const inactive = owner();
    inactive.dispose();
    f.ensure("edem", inactive, () => {
        throw new Error("retired");
    });
    const completed = [];
    f.ensure("playlist", owner(), () => completed.push("playlist"));
    f.ensure("stalker", owner(), () => completed.push("stalker"));
    assert.equal(f.requests.length, 2);
    f.publish("stalker");
    f.requests[1].ready();
    assert.deepEqual(completed, ["stalker"]);
    f.publish("playlist");
    f.requests[0].ready();
    assert.deepEqual(completed, ["stalker", "playlist"]);
});

test("callback reentry retires later waiters before delivery", () => {
    const f = fixture();
    const first = owner(),
        second = owner();
    let completed = 0;
    f.ensure("stalker", first, () => {
        completed++;
        second.dispose();
    });
    f.ensure("stalker", second, () => {
        throw new Error("stale mount");
    });
    f.publish("stalker");
    f.requests[0].ready();
    assert.equal(completed, 1);
    assert.equal(first.cleanups, 0);
    assert.equal(second.cleanups, 0);
});

test("inline transport errors are retryable; application exceptions are preserved", () => {
    const f = fixture();
    let first = true,
        failed = 0;
    const loader = f.assets.create(f.host, (_url, ready) => {
        if (first) {
            first = false;
            throw new Error("synchronous transport");
        }
        f.publish("stalker");
        ready();
    });
    loader.ensure(
        "stalker",
        "",
        "v",
        owner(),
        () => {},
        () => failed++
    );
    assert.equal(failed, 1);
    assert.throws(
        () =>
            loader.ensure(
                "stalker",
                "",
                "v",
                owner(),
                () => {
                    throw new Error("application callback");
                },
                () => failed++
            ),
        /application callback/
    );
    assert.equal(failed, 1);
});

test("private DOM transport removes tags and suppresses stale UI errors", () => {
    const tags = [];
    const body = {
        appendChild(script) {
            script.parentNode = body;
            tags.push(script);
        },
        removeChild(script) {
            script.parentNode = null;
            tags.splice(tags.indexOf(script), 1);
        },
    };
    const f = fixture({
        alert() {
            throw new Error("unowned alert");
        },
        document: { body, createElement: () => ({ crossOrigin: "" }) },
        getScriptDOM() {
            throw new Error("must not use alerting legacy transport");
        },
    });
    const loader = f.assets.create(f.host);
    const lifetime = owner();
    let failed = 0;
    loader.ensure(
        "edem",
        "",
        "v",
        lifetime,
        () => {},
        () => failed++
    );
    assert.equal(tags.length, 1);
    assert.equal(tags[0].src, "/dist/provider-edem.js?v");
    assert.equal(tags[0].crossOrigin, "");
    lifetime.dispose();
    tags[0].onerror();
    assert.equal(tags.length, 0);
    assert.equal(failed, 0);
    loader.ensure(
        "edem",
        "",
        "v",
        owner(),
        () => {},
        () => failed++
    );
    tags[0].onerror();
    assert.equal(failed, 1);
    assert.equal(tags.length, 0);
});

test("loadProv mounts only after readiness and coalesces a replacement selection", () => {
    const f = integrationFixture("stalker");
    const original = f.host.__ottStalkerDriver;
    const assets = fixture(f.host);
    delete f.host.__ottStalkerDriver;
    f.host.loadProv("stalker");
    assert.equal(f.host.__ottActiveProviderDriver, undefined);
    f.host.loadProv("stalker");
    assert.equal(assets.requests.length, 1);
    f.host.__ottStalkerDriver = original;
    assets.requests[0].ready();
    assert.equal(f.host.__ottActiveProviderDriver.id, "stalker");
});

test("switching to an eager provider rejects stale lazy success and failure", () => {
    for (const success of [false, true]) {
        const f = integrationFixture("stalker");
        const original = f.host.__ottStalkerDriver;
        const assets = fixture(f.host);
        delete f.host.__ottStalkerDriver;
        f.host.loadProv("stalker");
        f.host.loadProv("demo");
        const active = f.host.__ottActiveProviderDriver;
        const popup = f.host.popupActions.slice();
        assert.equal(active.id, "demo");
        if (success) {
            f.host.__ottStalkerDriver = original;
            assets.requests[0].ready();
        } else assets.requests[0].fail(new Error("stale network error"));
        assert.equal(f.host.__ottActiveProviderDriver, active);
        assert.deepEqual(f.host.popupActions, popup);
        assert.equal(f.host.p_pref, "demo");
    }
});

test("an active load failure uses the provider error path and the next selection retries", () => {
    const f = integrationFixture("stalker");
    const original = f.host.__ottStalkerDriver;
    const assets = fixture(f.host);
    delete f.host.__ottStalkerDriver;
    const errors = [];
    let firstRuns = 0;
    f.host.console.error = (error) => errors.push(error);
    f.host.firstRun = () => firstRuns++;
    f.host.loadProv("stalker");
    assets.requests[0].fail(new Error("offline"));
    assert.equal(firstRuns, 1);
    assert.equal(errors.length, 1);
    assert.equal(f.host._pendingProvId, "");
    assert.equal(f.host.__ottActiveProviderDriver, undefined);
    f.host.loadProv("stalker");
    assert.equal(assets.requests.length, 2);
    f.host.__ottStalkerDriver = original;
    assets.requests[1].ready();
    assert.equal(f.host.__ottActiveProviderDriver.id, "stalker");
    assert.equal(firstRuns, 1);
});

console.log("Provider assets: " + count + " runtime scenarios passed");

"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const {
    transformDistribution,
} = require("../scripts/android-distribution.cjs");
const code = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, "../src/provider/runtime.ts"), "utf8"),
    {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;

function fixture(flavor = "full") {
    const requests = [];
    const timers = new Map();
    let nextTimer = 0;
    const host = {
        $: {},
        clearTimeout(id) {
            timers.delete(id);
        },
        setTimeout(callback) {
            const id = ++nextTimer;
            timers.set(id, callback);
            return id;
        },
    };
    host.setInterval = host.setTimeout;
    host.clearInterval = host.clearTimeout;
    const ajax = (host.$.ajax = function (urlOrOptions, settings) {
        const options =
            typeof urlOrOptions === "string" ? settings : urlOrOptions;
        const callbacks = { always: [], done: [], fail: [] };
        let settled = false;
        let outcome;
        function invoke(callback, values) {
            if (Array.isArray(callback))
                callback.forEach((c) => invoke(c, values));
            else if (typeof callback === "function")
                callback.apply(options.context || request, values);
        }
        function finish(success, value) {
            // Test hostile/delayed transports too: options callbacks may arrive
            // even after abort. Guards must reject them before any mutation.
            invoke(success ? options.success : options.error, [
                value,
                "status",
                request,
            ]);
            if (!settled) {
                settled = true;
                outcome = { success, value };
                callbacks[success ? "done" : "fail"]
                    .slice()
                    .forEach((c) => invoke(c, [value]));
                callbacks.always.slice().forEach((c) => invoke(c, [value]));
            }
            invoke(options.complete, [request, "status"]);
        }
        const request = {
            abort() {
                this.aborted++;
                finish(false, "abort");
            },
            aborted: 0,
            always(...items) {
                callbacks.always.push(...items);
                if (outcome) items.forEach((c) => invoke(c, [outcome.value]));
                return this;
            },
            done(...items) {
                callbacks.done.push(...items);
                if (outcome && outcome.success)
                    items.forEach((c) => invoke(c, [outcome.value]));
                return this;
            },
            fail(...items) {
                callbacks.fail.push(...items);
                if (outcome && !outcome.success)
                    items.forEach((c) => invoke(c, [outcome.value]));
                return this;
            },
            options,
            reject(value) {
                finish(false, value);
            },
            resolve(value) {
                finish(true, value);
            },
            then(success, failure) {
                this.done(success);
                this.fail(failure);
                return this;
            },
        };
        requests.push(request);
        return request;
    });
    const context = { window: host };
    vm.createContext(context);
    vm.runInContext(
        "(function () {\n" +
            transformDistribution(code, flavor).code +
            "\n}).call(this);",
        context
    );
    assert.equal(
        vm.runInContext("typeof createProviderRegistry", context),
        "undefined"
    );
    return {
        adapter: host.__ottProviderRuntime.classic,
        ajax,
        api: host.__ottProviderRuntime,
        host,
        requests,
        timers,
    };
}

// Managed paths have the same lifetime behavior in Full and in the stripped Play
// runtime. Their transports already own cancellation; host APIs stay untouched
// even while a request or startup callback is executing.
for (const flavor of ["full", "play"]) {
    const f = fixture(flavor);
    const adapter = f.adapter;
    assert.equal(
        typeof adapter.bind,
        flavor === "full" ? "function" : "undefined"
    );
    assert.equal(
        typeof adapter.loadScript,
        flavor === "full" ? "function" : "undefined"
    );
    const originalTimer = f.host.setTimeout;
    let oldCatalog;
    let request;
    let mutations = 0;
    let cleaned = 0;
    adapter.replace((provider) => {
        provider.own(() => cleaned++);
        oldCatalog = adapter.beginCatalog(true);
        oldCatalog.run(() => {
            assert.equal(f.host.$.ajax, f.ajax, flavor);
            assert.equal(f.host.setTimeout, originalTimer, flavor);
            request = f.host.$.ajax({
                error: oldCatalog.guard(() => mutations++),
                success: oldCatalog.guard(() => mutations++),
            });
            oldCatalog.own(() => request.abort());
            const timer = f.host.setTimeout(
                oldCatalog.guard(() => mutations++)
            );
            oldCatalog.own(() => f.host.clearTimeout(timer));
        });
    }, true);
    adapter.replace(() => {
        assert.equal(
            request.aborted,
            1,
            "retire requests before resetting the next view"
        );
        assert.equal(f.timers.size, 0, "retire catalog timers before startup");
        assert.equal(cleaned, 1, "retire the provider before startup");
    }, true);
    request.resolve("late");
    oldCatalog.run(() => mutations++);
    assert.equal(mutations, 0, flavor + " rejects abort and late callbacks");
    assert.equal(f.host.$.ajax, f.ajax);
    assert.equal(f.host.setTimeout, originalTimer);

    const catalog = adapter.beginCatalog(true);
    const receiver = { prefix: "value:" };
    const guarded = catalog.guard(function (value) {
        return this.prefix + value;
    });
    assert.equal(guarded.call(receiver, "current"), "value:current");
    const nextCatalog = adapter.beginCatalog(true);
    assert.equal(guarded.call(receiver, "stale"), undefined);
    assert.equal(
        nextCatalog.run(() => "current"),
        "current"
    );
    adapter.dispose();
    assert.equal(
        nextCatalog.run(() => "retired"),
        undefined
    );
}

// Cleanup can choose a newer source before the requested replacement starts.
for (const flavor of ["full", "play"]) {
    for (const cleanupOwner of ["provider", "catalog"]) {
        const f = fixture(flavor);
        const events = [];
        let newest;
        f.adapter.replace((session) => {
            events.push("A");
            const owner =
                cleanupOwner === "provider"
                    ? session
                    : f.adapter.beginCatalog(true);
            owner.own(() =>
                f.adapter.replace((current) => {
                    newest = current;
                    events.push("C");
                }, true)
            );
        }, true);
        f.adapter.replace(() => events.push("B"), true);
        assert.deepEqual(events, ["A", "C"], flavor + ": " + cleanupOwner);
        assert.equal(newest.active(), true);
        f.adapter.dispose();
        assert.equal(newest.active(), false);
    }
}

// Even without script evaluation, a managed start may synchronously request
// replacements. Run only the latest after the retired callback finishes and
// propagate its error after that replacement is initialized.
for (const flavor of ["full", "play"]) {
    const f = fixture(flavor);
    const events = [];
    let newest;
    assert.throws(
        () =>
            f.adapter.replace((old) => {
                events.push("A-start");
                f.adapter.replace(() => events.push("B"), true);
                f.adapter.replace((current) => {
                    newest = current;
                    events.push("C");
                }, true);
                assert.equal(old.active(), false);
                events.push("A-end");
                throw new Error("retired managed startup failed");
            }, true),
        /retired managed startup failed/
    );
    assert.deepEqual(events, ["A-start", "A-end", "C"], flavor);
    assert.equal(newest.active(), true);
    f.adapter.replace(() => events.push("D"), true);
    assert.deepEqual(events, ["A-start", "A-end", "C", "D"]);

    f.adapter.replace(() => {
        f.adapter.replace(() => events.push("cancelled"), true);
        f.adapter.dispose();
    }, true);
    assert.equal(events.includes("cancelled"), false);
}

// Pure registry: immediate invalidation, idempotent cleanup and reentrant replacement.
{
    const f = fixture();
    const registry = f.api.createRegistry();
    const old = registry.activate("one");
    let mutations = 0;
    let cleanup = 0;
    const callback = old.guard(() => mutations++);
    old.own(() => {
        cleanup++;
        callback();
    });
    old.own(() => {
        throw new Error("teardown failure");
    });
    const next = registry.activate("two");
    assert.equal(old.active(), false);
    assert.equal(next.active(), true);
    assert.equal(mutations, 0);
    assert.equal(cleanup, 1);
    old.dispose();
    assert.equal(cleanup, 1);
    next.own(() => registry.activate("newest"));
    const superseded = registry.activate("intermediate");
    assert.equal(superseded.active(), false);
    assert.equal(registry.current().id, "newest");
    registry.dispose();
}

// Cancel a pending catalog before resetting globals; abort callbacks and late
// responses cannot write stale data or schedule a retry into the next provider.
{
    const f = fixture();
    let writes = 0;
    const catalog = f.adapter.beginCatalog();
    const originalTimer = f.host.setTimeout;
    const request = catalog.run(() =>
        f.host.$.ajax({
            complete() {
                writes++;
            },
            error() {
                f.host.$.ajax({
                    success() {
                        writes++;
                    },
                });
            },
            success() {
                writes++;
            },
        })
            .done(() => writes++)
            .always(() => writes++)
    );
    assert.equal(f.host.$.ajax, f.ajax);
    assert.equal(f.host.setTimeout, originalTimer);
    const unrelated = f.host.$.ajax({
        success() {
            writes += 10;
        },
    });
    f.adapter.replace(() => assert.equal(request.aborted, 1));
    request.resolve("late");
    request.done(() => writes++);
    assert.equal(writes, 0);
    assert.equal(f.requests.length, 2, "aborting must not start an old retry");
    assert.equal(
        unrelated.aborted,
        0,
        "unrelated transport must not join provider scope"
    );
    unrelated.resolve();
    assert.equal(writes, 10);
}

// Nested retries / deferred callbacks / timers retain owner and callback context.
{
    const f = fixture();
    let calls = 0;
    const receiver = {};
    const catalog = f.adapter.beginCatalog();
    catalog.run(() => {
        f.host.$.ajax("/first", { context: receiver }).then(function () {
            assert.equal(this, receiver);
            f.host.$.ajax({
                success() {
                    calls++;
                },
            });
            f.host.setTimeout(
                () =>
                    f.host.$.ajax({
                        success() {
                            calls++;
                        },
                    }),
                10
            );
        });
    });
    f.requests[0].resolve();
    assert.equal(f.requests.length, 2);
    assert.equal(f.timers.size, 1);
    const timerCallback = [...f.timers.values()][0];
    f.adapter.beginCatalog();
    assert.equal(
        f.requests[0].aborted,
        0,
        "settled requests release ownership"
    );
    assert.equal(f.requests[1].aborted, 1);
    assert.equal(f.timers.size, 0);
    timerCallback(); // Even a timer already queued by the browser must be inert.
    f.requests[1].resolve();
    assert.equal(f.requests.length, 2);
    assert.equal(calls, 0);
    assert.equal(f.host.$.ajax, f.ajax);
}

// External scripts may execute before onload. Start the latest provider only
// after old script settlement, so stale evaluation cannot overwrite the new one.
{
    const f = fixture();
    const pendingScripts = [];
    const events = [];
    const loader = (url, success, failure) =>
        pendingScripts.push({ failure, success, url });
    const select = (name) =>
        f.adapter.replace((session) => {
            events.push("reset:" + name);
            f.adapter.loadScript(
                session,
                loader,
                name,
                () => events.push("ready:" + name),
                () => events.push("failed:" + name)
            );
        });
    select("A");
    select("B");
    select("C");
    assert.deepEqual(events, ["reset:A"]);
    assert.equal(
        pendingScripts.length,
        1,
        "missing callback keeps reset safely queued"
    );
    events.push("evaluate:A");
    pendingScripts[0].success();
    assert.deepEqual(events, ["reset:A", "evaluate:A", "reset:C"]);
    assert.equal(pendingScripts[1].url, "C");
    pendingScripts[0].failure(new Error("duplicate"));
    pendingScripts[1].success();
    assert.deepEqual(events, ["reset:A", "evaluate:A", "reset:C", "ready:C"]);
}

// Synchronous loader errors and reentrant startup do not deadlock the queue.
{
    const f = fixture();
    const events = [];
    f.adapter.replace((session) =>
        f.adapter.loadScript(
            session,
            () => {
                throw new Error("load failed");
            },
            "A",
            () => assert.fail(),
            () => f.adapter.replace(() => events.push("B"))
        )
    );
    assert.deepEqual(events, ["B"]);
    f.adapter.replace((session) =>
        f.adapter.loadScript(
            session,
            (_, ready) => ready(),
            "C",
            () => f.adapter.replace(() => events.push("D")),
            () => assert.fail()
        )
    );
    assert.deepEqual(events, ["B", "D"]);
    assert.throws(
        () =>
            f.adapter.replace(() => {
                f.adapter.replace(() => events.push("F"));
                throw new Error("retired startup failed");
            }),
        /retired startup failed/
    );
    assert.deepEqual(
        events,
        ["B", "D", "F"],
        "startup failure must not strand a newer selection"
    );
}

// Cleanup can itself select a provider. While a classic script is pending,
// the retired outer replacement must not overwrite the newer queued selection.
for (const cleanupOwner of ["provider", "catalog"]) {
    const f = fixture();
    const events = [];
    let settle;
    f.adapter.replace((session) => {
        events.push("A");
        f.adapter.loadScript(
            session,
            (_, ready) => {
                settle = ready;
            },
            "A",
            () => {},
            () => {}
        );
        const owner =
            cleanupOwner === "provider" ? session : f.adapter.beginCatalog();
        owner.own(() => f.adapter.replace(() => events.push("C")));
    });
    f.adapter.replace(() => events.push("B"));
    settle();
    assert.deepEqual(
        events,
        ["A", "C"],
        cleanupOwner + " cleanup must keep the latest choice"
    );
}

// Later EPG/VOD entrypoints inherit provider ownership without global interception.
{
    const f = fixture();
    let applied = 0;
    f.adapter.replace((session) => {
        f.host.getGuide = () =>
            f.host.$.ajax({
                success() {
                    applied++;
                },
            });
        f.adapter.bind(session, ["getGuide"]);
    });
    const staleEntry = f.host.getGuide;
    const request = staleEntry();
    f.adapter.replace(() => {});
    assert.equal(request.aborted, 1);
    staleEntry();
    request.resolve();
    assert.equal(applied, 0);
    assert.equal(f.requests.length, 1);
    assert.equal(f.host.$.ajax, f.ajax);
}

// A throw restores scope, and nested catalog scopes own each request once.
{
    const f = fixture();
    const catalog = f.adapter.beginCatalog();
    assert.throws(() =>
        catalog.run(() => {
            throw new Error("provider error");
        })
    );
    assert.equal(f.host.$.ajax, f.ajax);
    f.adapter.replace(() => {
        const nested = f.adapter.beginCatalog();
        nested.run(() => f.host.$.ajax({}));
    });
    f.adapter.dispose();
    assert.equal(f.requests[0].aborted, 1);
    assert.equal(f.host.$.ajax, f.ajax);
}

// Exercise an actual classic provider: its Xtream callback clears global maps
// before validating a response. Even an unabortable old native transport must
// not let that callback clear the next catalog or open an old error dialog.
{
    const providerFixture = require("./helpers/playlist-fixture.cjs");
    const host = providerFixture.context();
    const transport = fixture();
    host.$ = () => ({ append() {} });
    host.$.ajax = (...args) => {
        const request = transport.ajax(...args);
        delete request.abort;
        return request;
    };
    Object.assign(host, {
        alert: (message) => host.errors.push(message),
        checkProviderUrl: () => true,
        launch_id: "#launch",
        loadXtreamParams() {},
        xtream: {
            password: "fixture",
            server: "https://provider.invalid",
            username: "fixture",
        },
    });
    require("./helpers/private-runtime.cjs")(host, "src/provider/runtime.ts");
    vm.runInContext(
        providerFixture
            .declarations("providers/xtream/provider.js")
            .filter((row) =>
                ["getChanelsArray", "xtreamCore"].includes(row.name)
            )
            .map((row) => row.text)
            .join("\n"),
        host
    );
    const classic = host.__ottProviderRuntime.classic;
    classic
        .beginCatalog()
        .run(() => host.getChanelsArray(() => host.callbacks++));
    const current = classic.beginCatalog();
    host.cList = ["current"];
    host.chanels = { current: { channel_name: "Current provider" } };
    transport.requests[0].resolve(null);
    assert.deepEqual(Array.from(host.cList), ["current"]);
    assert.equal(host.chanels.current.channel_name, "Current provider");
    assert.equal(host.callbacks, 0);
    assert.equal(host.errors.length, 0);
    current.run(() => host.getChanelsArray(() => host.callbacks++));
    transport.requests[1].resolve(null);
    assert.equal(
        host.callbacks,
        1,
        "current provider callback remains functional"
    );
    assert.equal(host.errors.length, 1);
}

console.log(
    "PASS provider runtime: Full/Play managed lifetimes, Full extension ownership, cancellation and reentrancy"
);

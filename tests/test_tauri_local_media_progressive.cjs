const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const vm = require("node:vm");
const source = ts.transpileModule(
    fs.readFileSync(
        path.join(__dirname, "../src/plugins/local-media.ts"),
        "utf8"
    ),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
require("acorn").parse(source, { ecmaVersion: 5 });
const helperModule = { exports: {} };
vm.runInNewContext(
    ts.transpileModule(
        fs.readFileSync(
            path.join(__dirname, "../src/offline/local-media-progress.ts"),
            "utf8"
        ),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText,
    { exports: helperModule.exports }
);

function catalog(scanned, count, scanning = true) {
    return {
        items: Array.from({ length: count }, (_, index) => ({
            id: String(index),
            url: "/video/" + index,
        })),
        scanned,
        scanning,
        sources: [{ available: true, id: "folder" }],
        total: scanning ? null : scanned,
    };
}
function fixture(snapshots, options = {}) {
    let reads = 0,
        scheduled = [],
        now = 0;
    const commands = [];
    let aborts = 0;
    let dialogOwner = null,
        dialogHtml = "",
        played = 0;
    const progressNode = { textContent: "" };
    const listOwner = {
        active: () => true,
        foreground: () => !dialogOwner,
    };
    function openDialog() {
        const owner = {
            close() {
                if (dialogOwner === owner) dialogOwner = null;
            },
            foreground: () => dialogOwner === owner,
        };
        dialogOwner = owner;
        return owner;
    }
    let w = {
        _: (text) => text,
        __ottClassicScreenPort: {
            listOwner: () => listOwner,
            setOwnedCallback: () => ({ owner: openDialog() }),
        },
        __TAURI__: {},
        $() {
            return {
                hide() {
                    return this;
                },
                html(value) {
                    dialogHtml = value;
                    return this;
                },
                show() {
                    return this;
                },
            };
        },
        closeList() {},
        document: { getElementById: () => progressNode },
        fetch: async () => ({
            json: async () =>
                snapshots[Math.min(reads++, snapshots.length - 1)],
            ok: true,
        }),
        keys: { ENTER: 13, EXIT: 8, RETURN: 27 },
        listCaption: {},
        listDetail: {},
        listFooter: {},
        loadProv() {
            played++;
            openDialog();
            dialogHtml = "provider-spinner";
        },
        optionsList() {},
        renderButtonHint: () => "",
        showPage() {},
        stbSetItem() {},
    };
    // Exercise the real provider's saved-selection admission with the same
    // Tauri bridge fixture used by the polling and cancellation scenarios.
    if (options.host)
        w = Object.assign(options.host, {
            __TAURI__: w.__TAURI__,
            fetch: w.fetch,
        });
    if (options.fetch) w.fetch = options.fetch;
    if (options.mode) {
        delete w.__TAURI__;
        if (options.mode === "native")
            w.Capacitor = { isNativePlatform: () => true };
    }
    if (options.abortable !== false)
        w.AbortController = class {
            signal = {};
            abort() {
                aborts++;
            }
        };
    const module = { exports: {} };
    vm.runInNewContext(source, {
        clearTimeout(task) {
            scheduled = scheduled.filter((item) => item !== task);
        },
        Date: { now: () => now },
        exports: module.exports,
        require(name) {
            if (name.includes("browser-local-media"))
                return {
                    installBrowserLocalMedia: () => ({
                        list: options.read,
                        suspend() {},
                    }),
                    installOfflineShell() {},
                };
            if (name.includes("offline/profiles"))
                return { installOfflineProfiles() {} };
            if (name.includes("local-media-progress"))
                return helperModule.exports;
            return {
                resolveNativePlugin: () =>
                    options.native || { list: () => options.read() },
                tauriInvoke: async (name, args) => {
                    commands.push({ args, name });
                    if (name === "offline_media_endpoint" && options.endpoint)
                        return options.endpoint();
                    return name === "offline_media_endpoint"
                        ? { endpoint: "http://localhost/catalog" }
                        : options.pickerCancelled
                          ? { pickerCancelled: true }
                          : {};
                },
            };
        },
        setTimeout(fn, delay) {
            const task = { delay, fn };
            scheduled.push(task);
            return task;
        },
        URL,
    });
    const api = module.exports.installLocalMedia(w);
    return {
        aborts: () => aborts,
        api,
        commands,
        html: () => dialogHtml,
        played: () => played,
        progress: () => progressNode.textContent,
        queued: () => scheduled.length,
        reads: () => reads,
        async tick(elapsed = 250) {
            now += elapsed;
            const callback = scheduled.shift();
            assert.ok(callback, "a further catalog request is scheduled");
            callback.fn();
            await flush();
        },
        timer: () => scheduled[0],
        w,
    };
}
async function flush() {
    for (let index = 0; index < 12; index++) await Promise.resolve();
}
(async () => {
    {
        let nativeEvent,
            nativeFinish,
            nativeArgs,
            nativeRemoved = 0;
        const nativeCancels = [];
        const native = fixture([], {
            mode: "native",
            native: {
                addListener: async (name, callback) => {
                    assert.equal(name, "localMediaProgress");
                    nativeEvent = callback;
                    return {
                        remove: async () => {
                            nativeRemoved++;
                        },
                    };
                },
                cancelList: async (args) => {
                    nativeCancels.push(args.requestId);
                },
                list: (args) => {
                    nativeArgs = args;
                    return new Promise((resolve) => {
                        nativeFinish = resolve;
                    });
                },
            },
        });
        let nativePartial = 0;
        const nativeRead = native.api.list(() => {
            nativePartial++;
            return true;
        }, "gone");
        await flush();
        assert.equal(nativeArgs.preferredId, "gone");
        nativeEvent({ catalog: catalog(1, 1), requestId: "old-request" });
        assert.equal(nativePartial, 0);
        const nativeFirst = {
            ...catalog(1, 1),
            preferred: { id: "gone", state: "missing" },
        };
        nativeEvent({ catalog: nativeFirst, requestId: nativeArgs.requestId });
        assert.equal(
            nativePartial,
            1,
            "native progress is delivered before list completion"
        );
        assert.equal(native.api.preferredState("gone"), "missing");
        assert.equal(native.api.preferredState("other"), undefined);
        native.api.cancelNativeList();
        assert.equal((await nativeRead).cancelled, true);
        assert.deepEqual(nativeCancels, [nativeArgs.requestId]);
        assert.equal(nativeRemoved, 1);
        nativeEvent({
            catalog: catalog(2, 2),
            requestId: nativeArgs.requestId,
        });
        nativeFinish(catalog(2, 2, false));
        await flush();
        assert.equal(
            nativePartial,
            1,
            "cancelled native progress cannot repopulate the catalog"
        );
    }
    const completeCatalog = catalog(1, 1, false);
    completeCatalog.sources = [
        { available: true, id: "folder", kind: "folder", name: "Winnie" },
        { available: true, id: "empty", kind: "folder", name: "Winnie" },
    ];
    const sourceView = fixture([catalog(0, 0), completeCatalog]);
    assert.equal(sourceView.api.completedSources(), null);
    let partialChecked = false;
    const sourceRead = sourceView.api.list((value) => {
        if (value.scanning) {
            assert.equal(sourceView.api.completedSources(), null);
            partialChecked = true;
        }
        return true;
    });
    await flush();
    await sourceView.tick(300);
    await sourceRead;
    assert.equal(partialChecked, true);
    const completeSources = sourceView.api.completedSources();
    assert.equal(
        completeSources.length,
        2,
        "empty sources remain visible for uniqueness"
    );
    completeSources[0].name = "Mutated";
    assert.equal(sourceView.api.completedSources()[0].name, "Winnie");
    sourceView.api.didRestoreLibrary();
    assert.equal(
        sourceView.api.completedSources(),
        null,
        "invalidated catalog cannot authorize binding"
    );
    // Native bridge reads can complete out of order without knowing about the
    // provider's lifetime. An independent manager refresh must retire the old
    // provider result even though the provider/profile itself did not change.
    const provider =
        require("./helpers/provider-driver-fixture.cjs").integrationFixture(
            "offline"
        );
    provider.host.clearBootHide = () => {};
    provider.host.Capacitor = { isNativePlatform: () => true };
    const reads = [];
    const native = {
        list: () => new Promise((resolve) => reads.push(resolve)),
    };
    const module = { exports: {} };
    vm.runInNewContext(source, {
        clearTimeout,
        exports: module.exports,
        require(name) {
            if (name.includes("browser-local-media"))
                return {
                    installBrowserLocalMedia: () => ({}),
                    installOfflineShell() {},
                };
            if (name.includes("offline/profiles"))
                return { installOfflineProfiles() {} };
            if (name.includes("local-media-progress"))
                return helperModule.exports;
            return { resolveNativePlugin: () => native };
        },
        setTimeout,
        URL,
    });
    const nativeApi = module.exports.installLocalMedia(provider.host);
    provider.host.loadProv();
    await flush();
    const refresh = nativeApi.list();
    await flush();
    assert.equal(reads.length, 2);
    reads[1]({
        items: [{ id: "new", name: "New", url: "http://localhost/new" }],
    });
    await refresh;
    reads[0]({
        items: [{ id: "stale", name: "Stale", url: "http://localhost/stale" }],
    });
    await flush();
    assert.equal(
        provider.host.channels["local-stale"],
        undefined,
        "old native result cannot publish through the still-active provider"
    );
    assert.deepEqual(
        Array.from((await nativeApi.snapshot()).items, (item) => item.id),
        ["new"],
        "the newer completed catalog remains cached"
    );
    let finishEndpoint;
    let endpointReady = false;
    const discovery = fixture([catalog(1, 1, false)], {
        endpoint: () =>
            endpointReady
                ? Promise.resolve({ endpoint: "http://localhost/catalog" })
                : new Promise((resolve) => {
                      finishEndpoint = resolve;
                  }),
    });
    const missingEndpoint = discovery.api.list().then(
        () => assert.fail("stalled endpoint discovery must fail"),
        (error) => error
    );
    await flush();
    await discovery.tick(60000);
    assert.match((await missingEndpoint).message, /did not respond/);
    finishEndpoint({ endpoint: "http://localhost/catalog" });
    await flush();
    assert.equal(
        discovery.reads(),
        0,
        "late endpoint discovery cannot start catalog requests"
    );
    await assert.rejects(discovery.api.snapshot(), /scan to finish/);
    endpointReady = true;
    assert.equal((await discovery.api.list()).items.length, 1);
    assert.equal(discovery.queued(), 0);

    const savedId = "751db9d74d2cfe13";
    const standby = fixture([catalog(1, 1, false)]);
    const standbyError = new Error("Player is in standby");
    standby.w.__ottStandby = {
        blocked: () => true,
        error: () => standbyError,
    };
    await assert.rejects(
        standby.api.list(
            () => assert.fail("standby cannot publish preferred-file progress"),
            savedId
        ),
        (error) => error === standbyError
    );
    assert.equal(
        standby.commands.length,
        0,
        "standby never invokes native lookup"
    );
    assert.equal(standby.reads(), 0, "standby never requests the catalog");
    assert.equal(
        standby.queued(),
        0,
        "standby never schedules catalog polling"
    );

    let finishSuspendedEndpoint;
    const suspended = fixture([catalog(1, 1, false)], {
        endpoint: () =>
            new Promise((resolve) => {
                finishSuspendedEndpoint = resolve;
            }),
    });
    const suspendedResult = suspended.api.list(
        () =>
            assert.fail(
                "suspended lookup cannot publish preferred-file progress"
            ),
        savedId
    );
    await flush();
    assert.equal(suspended.commands[0].args.preferredId, savedId);
    suspended.api.suspend();
    finishSuspendedEndpoint({ endpoint: "http://localhost/catalog" });
    const cancelledDiscovery = await suspendedResult;
    assert.equal(cancelledDiscovery.cancelled, true);
    assert.equal(
        suspended.reads(),
        0,
        "endpoint completion after suspend cannot start a catalog request"
    );
    assert.equal(cancelledDiscovery.items.length, 0);
    assert.equal(suspended.queued(), 0, "suspended discovery leaves no poller");
    await assert.rejects(suspended.api.snapshot(), /scan to finish/);

    const savedFile = {
        id: savedId,
        name: "2999-saved-video.mp4",
        sourceId: "folder",
        url: "/video/" + savedId,
    };
    const firstFile = {
        id: "first",
        name: "0001-first-video.mp4",
        sourceId: "folder",
        url: "/video/first",
    };
    const tailFile = {
        id: "tail",
        name: "3000-tail-video.mp4",
        sourceId: "folder",
        url: "/video/tail",
    };
    function savedCatalog(items, scanned, scanning = true) {
        return { ...catalog(scanned, 0, scanning), items };
    }
    const savedProvider =
        require("./helpers/provider-driver-fixture.cjs").integrationFixture(
            "offline",
            { offlineprimaryIndex: "2998" }
        );
    savedProvider.host.clearBootHide = () => {};
    const appended = [];
    savedProvider.host.__ottChannels = {
        append: (ids) => appended.push(...ids),
        reset() {},
    };
    savedProvider.host.__ottOfflineProfiles = {
        filter: (value) => value,
        read: () => ({ active: 3 }),
        selection: () => "local-" + savedId,
    };
    const savedStartup = fixture(
        [
            savedCatalog([firstFile], 1),
            savedCatalog([firstFile, savedFile], 2),
            savedCatalog([firstFile, savedFile, tailFile], 3000, false),
        ],
        { host: savedProvider.host }
    );
    savedProvider.host.loadProv();
    await flush();
    assert.equal(
        savedStartup.commands[0].args.preferredId,
        savedId,
        "profile 3's opaque saved ID reaches native lookup unchanged"
    );
    assert.equal(savedStartup.commands[0].args.refresh, undefined);
    assert.equal(
        savedProvider.completed,
        0,
        "an earlier file must not replace the saved file while it is pending"
    );
    await savedStartup.tick();
    assert.equal(
        savedProvider.completed,
        1,
        "saved file releases startup before all 3,000 entries are enumerated"
    );
    assert.equal(savedStartup.reads(), 2);
    assert.equal(
        savedStartup.queued(),
        1,
        "full scan remains in the background"
    );
    const resumedChannel = savedProvider.host.channels["local-" + savedId];
    assert.ok(resumedChannel, "the saved channel is ready for playback");
    await savedStartup.tick();
    assert.equal(
        savedProvider.completed,
        1,
        "scan completion cannot restart playback"
    );
    assert.strictEqual(
        savedProvider.host.channels["local-" + savedId],
        resumedChannel
    );
    assert.deepEqual(appended, ["local-tail"]);
    assert.equal(savedStartup.queued(), 0);

    const replacedProvider =
        require("./helpers/provider-driver-fixture.cjs").integrationFixture(
            "offline"
        );
    replacedProvider.host.clearBootHide = () => {};
    let sameBinding = true;
    replacedProvider.host.__ottOfflineProfiles = {
        catalogGuard: () => () => sameBinding,
        filter: (value) => value,
        read: () => ({ active: 3 }),
        selection: () => "local-" + savedId,
    };
    replacedProvider.host.__ottChannels = {
        append: () => assert.fail("retired profile cannot append local videos"),
        reset() {},
    };
    const replacedStartup = fixture(
        [savedCatalog([savedFile], 1), savedCatalog([savedFile, tailFile], 2)],
        { host: replacedProvider.host }
    );
    replacedProvider.host.loadProv();
    await flush();
    assert.equal(replacedProvider.completed, 1);
    sameBinding = false;
    await replacedStartup.tick();
    assert.equal(replacedProvider.host.channels["local-tail"], undefined);
    assert.equal(replacedProvider.completed, 1);
    assert.equal(
        replacedStartup.queued(),
        0,
        "profile replacement retires polling"
    );

    let browserPreference;
    const browserPreferred = fixture([], {
        mode: "browser",
        read(_progress, preferredId) {
            browserPreference = preferredId;
            return Promise.resolve(savedCatalog([savedFile], 1, false));
        },
    });
    await browserPreferred.api.list(() => true, savedId);
    assert.equal(
        browserPreference,
        savedId,
        "browser lookup keeps its saved ID"
    );
    assert.equal(
        browserPreferred.commands.length,
        0,
        "browser never invokes Tauri"
    );

    for (const mode of ["browser", "native"]) {
        let finish, progress;
        let answer = null;
        const pending = fixture([], {
            mode,
            read(callback) {
                progress = callback;
                return answer
                    ? Promise.resolve(answer)
                    : new Promise((resolve) => {
                          finish = resolve;
                      });
            },
        });
        const expired = pending.api.list().then(
            () => assert.fail("stalled source must fail"),
            (error) => error
        );
        await flush();
        if (mode === "browser") {
            const initial = pending.timer();
            assert.equal(typeof progress, "function");
            progress(catalog(1, 1));
            assert.notEqual(
                pending.timer(),
                initial,
                "real scan progress extends the deadline"
            );
            const unchanged = pending.timer();
            progress(catalog(1, 1));
            assert.equal(
                pending.timer(),
                unchanged,
                "repeated snapshots do not extend the deadline"
            );
        }
        await pending.tick(60000);
        assert.match((await expired).message, /did not respond/);
        assert.equal(pending.queued(), 0);
        if (progress)
            assert.equal(
                progress(catalog(2, 2, false)),
                false,
                "expired scan no longer owns progress"
            );
        finish(catalog(2, 2, false));
        await flush();
        await assert.rejects(pending.api.snapshot(), /scan to finish/);
        answer = catalog(3, 3, false);
        assert.equal((await pending.api.list()).items.length, 3);
        assert.equal((await pending.api.snapshot()).items.length, 3);
        assert.equal(
            pending.queued(),
            0,
            "success clears the new source deadline"
        );
        const broken = fixture([], {
            mode,
            read() {
                throw new Error("Source denied");
            },
        });
        await assert.rejects(broken.api.list(), /Source denied/);
        assert.equal(
            broken.queued(),
            0,
            "synchronous errors release the deadline"
        );
    }
    const f = fixture([
        catalog(0, 0),
        catalog(1, 1),
        catalog(1, 1),
        catalog(2, 2, false),
    ]);
    const seen = [];
    let complete = false;
    const result = f.api
        .list((value) => seen.push(value.items.length))
        .then((value) => {
            complete = true;
            return value;
        });
    await flush();
    assert.deepEqual(seen, [0]);
    await f.tick();
    assert.deepEqual(
        seen,
        [0, 1],
        "first native item reaches playback before the full scan"
    );
    assert.equal(complete, false);
    const readsBeforeSnapshot = f.reads();
    await assert.rejects(f.api.snapshot(), /scan to finish/);
    assert.equal(
        f.reads(),
        readsBeforeSnapshot,
        "profile snapshot never starts another native scan"
    );
    await f.tick();
    assert.deepEqual(
        seen,
        [0, 1],
        "unchanged polling is not a progress heartbeat"
    );
    await f.tick();
    assert.equal((await result).items.length, 2);
    assert.deepEqual(seen, [0, 1, 2]);
    const completed = await f.api.snapshot();
    assert.equal(completed.items.length, 2);
    completed.items.length = 0;
    assert.equal(
        (await f.api.snapshot()).items.length,
        2,
        "snapshots are isolated from callers"
    );

    const imported = fixture([
        catalog(0, 0),
        catalog(1, 1),
        catalog(10000, 10000, false),
    ]);
    let importedDone = false;
    const importResult = imported.api.importFiles(true).then((value) => {
        importedDone = true;
        return value;
    });
    await flush();
    assert.equal(importedDone, false);
    await imported.tick();
    assert.equal(
        (await importResult).items.length,
        1,
        "first folder import does not wait for all 10,000 files"
    );
    assert.equal(imported.queued(), 0);
    assert.equal(imported.reads(), 2);

    const ui = fixture([
        catalog(1, 0),
        catalog(2, 1),
        catalog(10000, 10000, false),
    ]);
    ui.api.open(false, true);
    ui.w.listArray.find((row) => row.id === "add-folder").action();
    await flush();
    assert.match(
        ui.html(),
        /ott-spinner/,
        "first add uses the standard owned spinner"
    );
    assert.equal(
        (ui.html().match(/Loading\. Please wait\.\.\./g) || []).length,
        1,
        "import dialog renders one static loading heading"
    );
    assert.equal(
        (ui.html().match(/id="local-media-progress"/g) || []).length,
        1,
        "import dialog has a single dynamic progress node"
    );
    assert.doesNotMatch(
        ui.html().match(/id="local-media-progress">([^<]*)/)[1],
        /Loading/,
        "counter updates cannot replace or duplicate the static loading heading"
    );
    assert.equal(
        ui.progress(),
        "Local videos: 0",
        "ongoing import shows one playable-video count without repeating the heading"
    );
    assert.equal(ui.played(), 0);
    await ui.tick();
    assert.equal(
        ui.played(),
        1,
        "first playable batch automatically opens the player"
    );
    assert.equal(
        ui.html(),
        "provider-spinner",
        "old manager completion does not close the provider spinner"
    );
    assert.equal(ui.queued(), 0);

    const knownSnapshot = catalog(7, 0);
    knownSnapshot.total = 10000;
    knownSnapshot.items.push({
        available: false,
        id: "unavailable",
        url: "/offline",
    });
    const known = fixture([knownSnapshot]);
    known.api.open(false, true);
    known.w.listArray.find((row) => row.id === "add-folder").action();
    await flush();
    assert.equal(
        known.progress(),
        "Local videos: 0",
        "known scan totals do not duplicate the visible playable-video count"
    );
    assert.equal(
        known.played(),
        0,
        "unavailable items do not activate playback"
    );
    known.w.listKeyHandler(known.w.keys.RETURN);
    await known.tick();

    const closed = fixture([catalog(1, 0), catalog(2, 1)]);
    closed.api.open(false, true);
    closed.w.listArray.find((row) => row.id === "add-folder").action();
    await flush();
    closed.w.listKeyHandler(closed.w.keys.RETURN);
    await closed.tick();
    assert.equal(
        closed.played(),
        0,
        "closing the manager prevents a late import from opening playback"
    );
    assert.equal(closed.reads(), 1, "closing the manager stops its poller");

    const refreshed = fixture([catalog(2, 1, false)]);
    await refreshed.api.list();
    assert.equal(
        Object.hasOwn(refreshed.commands[0].args, "preferredId"),
        false,
        "ordinary catalog reads omit an absent preferred ID"
    );
    assert.equal(
        refreshed.commands.filter((command) => command.args.refresh).length,
        0,
        "ordinary catalog reads never restart scanning"
    );
    refreshed.api.open(false, true);
    refreshed.w.listArray.find((row) => row.id === "refresh").action();
    await flush();
    assert.equal(
        refreshed.commands.filter((command) => command.args.refresh).length,
        1,
        "explicit Refresh starts a native rescan once"
    );
    assert.ok(
        refreshed.commands.every((command) => !command.args.preferredId),
        "refresh without a saved selection does not invent a preferred file"
    );

    const cancelled = fixture([catalog(0, 0), catalog(1, 1, false)]);
    const first = cancelled.api.list(() => true, "old-profile-file");
    await flush();
    const replacement = cancelled.api.list(undefined, "new-profile-file");
    await flush();
    assert.equal((await replacement).items.length, 1);
    assert.deepEqual(
        cancelled.commands.map((command) => command.args.preferredId),
        ["old-profile-file", "new-profile-file"],
        "replacement forwards its own preferred file instead of retaining the old one"
    );
    await cancelled.tick();
    assert.equal((await first).cancelled, true);
    assert.equal(
        cancelled.reads(),
        2,
        "superseded polling cannot start another read"
    );

    for (const abortable of [true, false]) {
        const hanging = fixture([], {
            abortable,
            fetch: () => new Promise(() => {}),
        });
        const deadline = hanging.api.list().then(
            () => null,
            (error) => error
        );
        await flush();
        assert.equal(
            hanging.queued(),
            1,
            "a request that never resolves has a deadline"
        );
        await hanging.tick(60000);
        assert.match((await deadline).message, /stopped responding/);
        assert.equal(hanging.aborts(), abortable ? 1 : 0);
        assert.equal(hanging.queued(), 0);
    }
    const rejected = fixture([], {
        fetch: () => {
            throw new Error("Fetch failed");
        },
    });
    const rejectedResult = await rejected.api.list().then(
        () => null,
        (error) => error
    );
    assert.match(rejectedResult.message, /Fetch failed/);
    assert.equal(
        rejected.queued(),
        0,
        "synchronous fetch failure also cleans up the timer"
    );

    const hangingBody = fixture([], {
        fetch: async () => ({ json: () => new Promise(() => {}), ok: true }),
    });
    const bodyDeadline = hangingBody.api.list().then(
        () => null,
        (error) => error
    );
    await flush();
    await hangingBody.tick(60000);
    assert.match((await bodyDeadline).message, /stopped responding/);
    assert.equal(
        hangingBody.aborts(),
        1,
        "body timeout aborts the request too"
    );

    const pickerCancel = fixture([catalog(1, 1, false)], {
        pickerCancelled: true,
    });
    await pickerCancel.api.list();
    pickerCancel.api.open(false, true);
    pickerCancel.w.listArray.find((row) => row.id === "add-folder").action();
    await flush();
    assert.equal(
        pickerCancel.reads(),
        1,
        "cancelled picker does not restart catalog polling"
    );
    assert.equal(
        pickerCancel.played(),
        0,
        "cancelled picker cannot autoplay an existing item"
    );
    assert.equal(pickerCancel.queued(), 0);
    assert.equal(
        (await pickerCancel.api.importFiles(true)).pickerCancelled,
        true
    );

    const stopped = fixture([catalog(0, 0)]);
    const stopResult = stopped.api.list(() => false, savedId);
    assert.equal((await stopResult).cancelled, true);
    assert.equal(stopped.queued(), 0);
    assert.equal(stopped.commands[0].args.preferredId, savedId);

    const stalled = fixture([catalog(0, 0)]);
    const stalledResult = stalled.api.list().then(
        () => null,
        (error) => error
    );
    await flush();
    await stalled.tick(60000);
    assert.match((await stalledResult).message, /stopped responding/);
    assert.equal(stalled.queued(), 0);
    console.log(
        "OK: Tauri catalog polling starts early, reports real progress, cancels stale reads, and bounds stalled scans"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

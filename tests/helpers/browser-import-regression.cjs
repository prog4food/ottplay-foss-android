const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

async function browserImportRegression(
    root = path.resolve(__dirname, "../..")
) {
    function load(relative, requireModule = require) {
        const exports = {};
        const source = ts.transpileModule(
            fs.readFileSync(path.join(root, relative), "utf8"),
            {
                compilerOptions: {
                    module: ts.ModuleKind.CommonJS,
                    target: ts.ScriptTarget.ES5,
                },
            }
        ).outputText;
        require("acorn").parse(source, { ecmaVersion: 5 });
        vm.runInNewContext(source, {
            clearTimeout: (id) => id.owner.clear(id),
            exports,
            require: requireModule,
            setTimeout: (fn, delay) => clock.set(fn, delay),
            URL,
        });
        return exports;
    }
    let clock;
    const browserModule = load("src/offline/browser-local-media.ts");
    const progressModule = load("src/offline/local-media-progress.ts");
    const plugin = load("src/plugins/local-media.ts", (name) => {
        if (name.includes("browser-local-media")) return browserModule;
        if (name.includes("local-media-progress")) return progressModule;
        if (name.includes("offline/profiles"))
            return { installOfflineProfiles() {} };
        return { resolveNativePlugin: (_, fallback) => fallback() };
    });
    async function flush() {
        for (let i = 0; i < 150; i++) await Promise.resolve();
    }
    function deferred() {
        let resolve, reject;
        const promise = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
        });
        return { promise, reject, resolve };
    }
    function fixture(options = {}) {
        const tasks = new Set();
        let now = 0;
        clock = {
            clear: (task) => tasks.delete(task),
            set(fn, delay) {
                const task = { at: now + delay, fn, owner: this };
                tasks.add(task);
                return task;
            },
        };
        const ownClock = clock;
        const records = [];
        const created = [];
        let tracked = 0;
        const handoffs = [];
        let reads = 0,
            enumerations = 0,
            olderEnumerations = 0,
            writes = 0,
            played = 0,
            gesture = false,
            pickerCalls = 0,
            html = "",
            dialog = null;
        const progressNode = { textContent: "" };
        const blocked = deferred();
        const picker = deferred();
        const first = {
            getFile: () => {
                reads++;
                return options.blockFirst
                    ? blocked.promise
                    : Promise.resolve({
                          lastModified: 1,
                          name: options.name || "first.mp4",
                          size: 42,
                          type: options.mime || "video/mp4",
                      });
            },
            kind: "file",
            name: options.name || "first.mp4",
            queryPermission: () => Promise.resolve("granted"),
        };
        const second = {
            getFile: () => {
                reads++;
                return options.secondPlayable
                    ? Promise.resolve({
                          lastModified: 1,
                          name: "second.mp4",
                          size: 43,
                          type: "video/mp4",
                      })
                    : blocked.promise;
            },
            kind: "file",
            name: "second.mp4",
            queryPermission: () => Promise.resolve("granted"),
        };
        const folder = {
            kind: "directory",
            name: "Fixture videos",
            queryPermission: () => Promise.resolve("granted"),
            values() {
                enumerations++;
                let index = 0;
                const entries = options.nestedBlocked
                    ? [
                          {
                              kind: "directory",
                              name: "Nested",
                              values: () => ({ next: () => blocked.promise }),
                          },
                      ]
                    : Array.from({ length: options.count || 2 }, (_, at) =>
                          at === 0
                              ? first
                              : at === 1
                                ? second
                                : { ...second, name: "later-" + at + ".mp4" }
                      );
                return {
                    next: () =>
                        options.iteratorError
                            ? Promise.reject(
                                  Object.assign(
                                      new Error(
                                          "file:///private/hidden-fixture/failure"
                                      ),
                                      { name: options.iteratorError }
                                  )
                              )
                            : options.blockIterator ||
                                (options.blockAfterFirst && index > 0)
                              ? blocked.promise
                              : Promise.resolve(
                                    index < entries.length
                                        ? {
                                              done: false,
                                              value: entries[index++],
                                          }
                                        : { done: true }
                                ),
                };
            },
        };
        if (options.existing || options.olderBlocked)
            records.push({
                created: 1,
                handle: options.olderBlocked
                    ? {
                          ...folder,
                          name: "Older offline folder",
                          values() {
                              olderEnumerations++;
                              return { next: () => new Promise(() => {}) };
                          },
                      }
                    : folder,
                id: "source-existing",
                name: folder.name,
            });
        const db = {
            transaction() {
                const tx = {};
                tx.objectStore = () => ({
                    add(record) {
                        assert.ok(
                            record.handle,
                            "only a direct source handle is persisted"
                        );
                        assert.equal(
                            record.blob,
                            undefined,
                            "import never copies media bytes"
                        );
                        writes++;
                        records.push(record);
                        queueMicrotask(() => tx.oncomplete());
                    },
                    openCursor() {
                        const cursor = {};
                        let index = 0;
                        const advance = () => {
                            queueMicrotask(() => {
                                let continued = false;
                                cursor.result =
                                    index < records.length
                                        ? {
                                              continue() {
                                                  continued = true;
                                                  advance();
                                              },
                                              value: records[index++],
                                          }
                                        : null;
                                cursor.onsuccess();
                                if (!continued) tx.oncomplete();
                            });
                        };
                        advance();
                        return cursor;
                    },
                });
                return tx;
            },
        };
        function pick() {
            pickerCalls++;
            assert.equal(gesture, true, "picker stays inside the user gesture");
            return picker.promise;
        }
        const w = {
            _: (text) => text,
            __ottClassicScreenPort: {
                listOwner: () => ({
                    active: () => true,
                    foreground: () => !dialog,
                }),
                setOwnedCallback: () => {
                    const owner = {
                        close() {
                            if (dialog === owner) dialog = null;
                        },
                        foreground: () => dialog === owner,
                    };
                    dialog = owner;
                    return { owner };
                },
            },
            $: () => ({
                hide() {
                    return this;
                },
                html(value) {
                    html = value;
                    return this;
                },
                show() {
                    return this;
                },
            }),
            addEventListener() {},
            clearTimeout: ownClock.clear.bind(ownClock),
            closeList() {
                if (options.realisticClose) w.__ottLocalMedia.suspend();
            },
            document: { getElementById: () => progressNode },
            indexedDB: {
                open() {
                    const request = {};
                    queueMicrotask(() => {
                        request.result = db;
                        request.onsuccess();
                    });
                    return request;
                },
            },
            keys: { ENTER: 13, EXIT: 8, RETURN: 27 },
            listCaption: {},
            listDetail: {},
            listFooter: {},
            loadProv() {
                played++;
                if (options.realisticClose)
                    handoffs.push(w.__ottLocalMedia.takeImportSelection());
            },
            navigator: {},
            optionsList() {},
            renderButtonHint: () => "",
            setTimeout: ownClock.set.bind(ownClock),
            showDirectoryPicker: pick,
            showOpenFilePicker: pick,
            showPage() {},
            stbSetItem() {},
            URL: {
                createObjectURL: (file) => {
                    created.push(file.name);
                    return "blob:fixture-" + created.length;
                },
                revokeObjectURL() {},
            },
        };
        if (options.track)
            w.__ottStandby = {
                blocked: () => false,
                observe(pending) {
                    tracked++;
                    pending.then(
                        () => tracked--,
                        () => tracked--
                    );
                    return pending;
                },
            };
        const api = plugin.installLocalMedia(w);
        return {
            api,
            blocked,
            click(id) {
                api.open(false, true);
                gesture = true;
                w.listArray.find((row) => row.id === id).action();
                gesture = false;
            },
            close: () => w.listKeyHandler(w.keys.RETURN),
            created: () => created,

            detail() {
                w.detailListAction();
                return w.listDetail.innerHTML;
            },
            enumerations: () => enumerations,
            grant: (id) =>
                picker.resolve(
                    id === "add-files"
                        ? options.singleFile
                            ? [first]
                            : [first, second]
                        : folder
                ),
            handoffs: () => handoffs,
            html: () => html,
            olderEnumerations: () => olderEnumerations,
            picker,
            pickerCalls: () => pickerCalls,
            played: () => played,
            progress: () => progressNode.textContent,
            reads: () => reads,
            releaseEnumeration: () =>
                blocked.resolve({ done: false, value: first }),
            spinner: () => !!dialog,
            async tick(ms) {
                const target = now + ms;
                for (;;) {
                    const next = Array.from(tasks)
                        .filter((task) => task.at <= target)
                        .sort((left, right) => left.at - right.at)[0];
                    if (!next) break;
                    now = next.at;
                    tasks.delete(next);
                    next.fn();
                    await flush();
                }
                now = target;
                await flush();
            },
            timers: () => tasks.size,
            tracked: () => tracked,
            writes: () => writes,
        };
    }

    for (const action of ["add-folder", "add-files"]) {
        const f = fixture();
        f.click(action);
        assert.equal(f.pickerCalls(), 1);
        await flush();
        assert.equal(f.spinner(), true);
        assert.match(f.html(), /ott-spinner/);
        await f.tick(90000);
        assert.equal(f.spinner(), true, "open picker has no scan deadline");
        assert.equal(f.reads(), 0);
        f.grant(action);
        await flush();
        assert.equal(
            f.played(),
            1,
            action +
                " activates as soon as its first readable file is available"
        );
        assert.equal(f.reads(), 1, "the blocked second file is not awaited");
        assert.equal(f.timers(), 0, "first-file handoff clears its scan timer");
        assert.equal(f.spinner(), false);
        assert.equal(
            f.writes(),
            action === "add-files" ? 2 : 1,
            "only source handles are stored"
        );
    }

    for (const action of ["add-folder", "add-files"]) {
        const prioritized = fixture({
            olderBlocked: true,
            realisticClose: true,
        });
        prioritized.click(action);
        prioritized.grant(action);
        await flush();
        assert.equal(
            prioritized.played(),
            1,
            "new source starts ahead of an older blocked source"
        );
        assert.equal(
            prioritized.olderEnumerations(),
            0,
            "manager does not traverse an older source first"
        );
        assert.equal(prioritized.reads(), 1);
        assert.equal(prioritized.handoffs().length, 1);
        assert.match(
            prioritized.handoffs()[0],
            /^local-source-/,
            "new source selection survives ordinary screen cleanup"
        );
        assert.equal(
            prioritized.api.takeImportSelection(),
            "",
            "import selection is consumed only once"
        );
    }

    const mixed = fixture({
        mime: "text/plain",
        name: "notes.txt",
        olderBlocked: true,
        realisticClose: true,
        secondPlayable: true,
    });
    mixed.click("add-files");
    mixed.grant("add-files");
    await flush();
    assert.equal(
        mixed.played(),
        1,
        "a later playable selected file starts ahead of older blocked sources"
    );
    assert.equal(mixed.reads(), 2, "both selected handles are checked once");
    assert.equal(mixed.olderEnumerations(), 0);
    assert.match(mixed.handoffs()[0], /^local-source-/);

    const unsupported = fixture({
        mime: "text/plain",
        name: "notes.txt",
        singleFile: true,
    });
    unsupported.click("add-files");
    unsupported.grant("add-files");
    await flush();
    assert.equal(
        unsupported.played(),
        0,
        "unsupported selected files never autoplay"
    );
    assert.equal(
        unsupported.reads(),
        1,
        "deferred validation reads each selected file once"
    );
    assert.equal(unsupported.spinner(), false);
    assert.equal(unsupported.timers(), 0);

    const unusual = fixture({
        mime: "video/x-matroska",
        name: "movie.unknown",
        singleFile: true,
    });
    unusual.click("add-files");
    unusual.grant("add-files");
    await flush();
    assert.equal(
        unusual.played(),
        1,
        "deferred validation retains MIME-based playable files"
    );
    assert.equal(unusual.reads(), 1);

    for (const options of [{ blockIterator: true }, { nestedBlocked: true }]) {
        const delayedFolder = fixture(options);
        delayedFolder.click("add-folder");
        delayedFolder.grant("add-folder");
        await flush();
        await delayedFolder.tick(120000);
        assert.equal(
            delayedFolder.spinner(),
            true,
            "a two-minute initial enumeration remains pending"
        );
        delayedFolder.releaseEnumeration();
        await flush();
        assert.equal(
            delayedFolder.played(),
            1,
            "root and nested initial enumeration can still start playback after two minutes"
        );
        assert.equal(delayedFolder.spinner(), false);
        assert.equal(delayedFolder.timers(), 0);

        const enumerating = fixture(options);
        enumerating.click("add-folder");
        enumerating.grant("add-folder");
        await flush();
        await enumerating.tick(60000);
        assert.equal(
            enumerating.spinner(),
            true,
            "initial enumeration, including nested directories, gets more than one minute"
        );
        assert.equal(enumerating.reads(), 0);
        await enumerating.tick(600000);
        assert.equal(
            enumerating.spinner(),
            false,
            "initial enumeration still has a deadline"
        );
        assert.equal(enumerating.played(), 0);
        enumerating.blocked.resolve({ done: true });
        await flush();
        assert.equal(enumerating.played(), 0);
    }
    const laterEnumeration = fixture({ blockAfterFirst: true, existing: true });
    let laterError;
    const laterResult = laterEnumeration.api.list().then(
        () =>
            assert.fail(
                "stalled enumeration after a playable item must expire"
            ),
        (error) => {
            laterError = error;
            return error;
        }
    );
    await flush();
    assert.equal(laterEnumeration.reads(), 1);
    await laterEnumeration.tick(100);
    await laterEnumeration.tick(60000);
    assert.ok(
        laterError,
        "the deadline settles even while native enumeration stays pending"
    );
    assert.match((await laterResult).message, /did not respond/);
    laterEnumeration.blocked.resolve({ done: true });
    await flush();

    for (const [errorName, expected] of [
        ["NotReadableError", "NotReadableError"],
        ["PrivateSecretError", "Error"],
    ]) {
        const failed = fixture({ iteratorError: errorName });
        failed.click("add-folder");
        failed.grant("add-folder");
        await flush();
        const catalog = await failed.api.snapshot();
        assert.equal(catalog.readErrorName, expected);
        assert.equal(catalog.readErrorPhase, "enumerating");
        assert.equal(
            failed.api.failureMessage(catalog),
            "Reading folder entries: " + expected
        );
        assert.doesNotMatch(
            JSON.stringify(catalog),
            /private|hidden-fixture|PrivateSecretError/
        );
        assert.doesNotMatch(
            failed.detail(),
            /private|hidden-fixture|PrivateSecretError/
        );
        assert.equal(failed.played(), 0);
        assert.equal(failed.spinner(), false);
    }

    const waiting = fixture({
        blockFirst: true,
        secondPlayable: true,
        track: true,
    });
    waiting.click("add-folder");
    waiting.grant("add-folder");
    await flush();
    await waiting.tick(100);
    assert.equal(
        waiting.progress(),
        "Local videos: 0 · Entries found: 1 · Reading file information",
        "a discovered file remains visible while its metadata read is pending"
    );
    await waiting.tick(9899);
    assert.equal(waiting.played(), 0);
    await waiting.tick(1);
    assert.equal(
        waiting.played(),
        1,
        "one stalled metadata read does not hide the next playable file"
    );
    assert.equal(waiting.reads(), 2);
    assert.deepEqual(waiting.created(), ["second.mp4"]);
    assert.equal(
        waiting.tracked(),
        1,
        "timed-out native read remains tracked until it actually settles"
    );
    waiting.blocked.resolve({
        lastModified: 1,
        name: "first.mp4",
        size: 42,
        type: "video/mp4",
    });
    await flush();
    assert.equal(waiting.tracked(), 0);
    assert.equal(waiting.played(), 1);
    assert.deepEqual(
        waiting.created(),
        ["second.mp4"],
        "late skipped file never receives a playback URL"
    );

    const allBlocked = fixture({ blockFirst: true, count: 12000, track: true });
    allBlocked.click("add-folder");
    allBlocked.grant("add-folder");
    await flush();
    await allBlocked.tick(20000);
    assert.equal(
        allBlocked.spinner(),
        false,
        "two stalled file reads settle recovery before the global deadline"
    );
    assert.equal(allBlocked.played(), 0);
    assert.equal(
        allBlocked.reads(),
        2,
        "a 12,000-file folder cannot queue 12,000 abandoned native reads"
    );
    assert.equal(allBlocked.tracked(), 2);
    const unavailable = await allBlocked.api.snapshot();
    assert.equal(
        unavailable.sources.length,
        1,
        "recovery retains the linked source"
    );
    assert.equal(unavailable.readErrorName, "TimeoutError");
    await allBlocked.api.list();
    assert.equal(
        allBlocked.reads(),
        2,
        "retry does not duplicate unresolved reads or bypass their global cap"
    );
    assert.equal(allBlocked.tracked(), 2);
    allBlocked.blocked.resolve({
        lastModified: 1,
        name: "first.mp4",
        size: 42,
        type: "video/mp4",
    });
    await flush();
    assert.equal(allBlocked.tracked(), 0);
    assert.deepEqual(allBlocked.created(), []);
    await allBlocked.api.list((value) =>
        value.items.length ? false : undefined
    );
    assert.equal(
        allBlocked.reads(),
        3,
        "a settled browser call releases capacity for a fresh scan"
    );

    const shared = fixture({
        blockFirst: true,
        existing: true,
        secondPlayable: true,
        track: true,
    });
    const oldScan = shared.api.list();
    await flush();
    const newScan = shared.api.list((value) =>
        value.items.length ? false : undefined
    );
    await flush();
    assert.equal(
        shared.reads(),
        1,
        "overlapping generations share a still-pending stable file read"
    );
    shared.blocked.resolve({
        lastModified: 1,
        name: "first.mp4",
        size: 42,
        type: "video/mp4",
    });
    const oldCatalog = await oldScan;
    const newCatalog = await newScan;
    assert.equal(oldCatalog.cancelled, true);
    assert.equal(newCatalog.items.length, 1);
    assert.deepEqual(
        shared.created(),
        ["first.mp4"],
        "only the current generation publishes the shared result"
    );
    assert.equal(shared.tracked(), 0);

    const cancelledRead = fixture({
        blockFirst: true,
        secondPlayable: true,
        track: true,
    });
    cancelledRead.click("add-folder");
    cancelledRead.grant("add-folder");
    await flush();
    cancelledRead.close();
    await cancelledRead.tick(10000);
    assert.equal(
        cancelledRead.reads(),
        1,
        "a cancelled scan cannot use its timeout to start the next file"
    );
    assert.equal(cancelledRead.played(), 0);
    assert.equal(cancelledRead.tracked(), 1);
    cancelledRead.blocked.resolve({
        lastModified: 1,
        name: "first.mp4",
        size: 42,
        type: "video/mp4",
    });
    await flush();
    assert.equal(cancelledRead.tracked(), 0);
    assert.deepEqual(cancelledRead.created(), []);

    const closed = fixture();
    closed.click("add-folder");
    closed.close();
    closed.grant("add-folder");
    await flush();
    assert.equal(closed.played(), 0, "closed manager ignores a late picker");
    assert.equal(closed.timers(), 0);
    assert.equal(
        closed.reads(),
        0,
        "closed picker cannot read its newly saved source"
    );
    assert.equal(
        closed.enumerations(),
        0,
        "closed picker cannot traverse folders"
    );

    const replaced = fixture();
    replaced.click("add-folder");
    const completed = await replaced.api.list();
    assert.equal(completed.items.length, 0);
    replaced.grant("add-folder");
    await flush();
    assert.equal(
        replaced.reads(),
        0,
        "old picker cannot replace a newer completed scan"
    );
    assert.equal((await replaced.api.snapshot()).items.length, 0);
    assert.equal(replaced.played(), 0);

    const concurrent = fixture({ blockFirst: true, existing: true });
    concurrent.click("add-folder");
    const newerScan = concurrent.api.list();
    await flush();
    assert.equal(concurrent.reads(), 1);
    concurrent.grant("add-folder");
    await flush();
    assert.equal(
        concurrent.reads(),
        1,
        "old picker cannot start a competing traversal"
    );
    concurrent.blocked.resolve({
        lastModified: 1,
        name: "first.mp4",
        size: 42,
        type: "video/mp4",
    });
    const newerCatalog = await newerScan;
    assert.equal(
        newerCatalog.cancelled,
        false,
        "old picker cannot retire a newer scan"
    );
    assert.equal(newerCatalog.items.length, 2);
    assert.equal((await concurrent.api.snapshot()).items.length, 2);
    assert.equal(concurrent.played(), 0);

    const interrupted = fixture({ blockFirst: true });
    interrupted.click("add-folder");
    interrupted.grant("add-folder");
    await flush();
    interrupted.close();
    interrupted.blocked.resolve({
        lastModified: 1,
        name: "first.mp4",
        size: 42,
        type: "video/mp4",
    });
    await flush();
    assert.equal(
        interrupted.played(),
        0,
        "cancelled scan cannot reopen playback"
    );
    assert.equal(
        interrupted.reads(),
        1,
        "cancelled scan never reads its successor"
    );
    assert.equal(interrupted.timers(), 0);

    for (const name of ["AbortError", "NotAllowedError"]) {
        const denied = fixture({ existing: true });
        denied.click("add-folder");
        denied.picker.reject(
            Object.assign(new Error("Fixture rejection"), { name })
        );
        await flush();
        assert.equal(denied.spinner(), false, name + " releases the spinner");
        assert.equal(denied.played(), 0);
        assert.equal(denied.enumerations(), 0, "rejected picker cannot rescan");
        assert.equal(denied.timers(), 0);
        assert.equal(denied.writes(), 0);
        if (name === "NotAllowedError")
            assert.match(denied.detail(), /Fixture rejection/);
    }
    console.log(
        "PASS browser import UI: first-file playback, synchronous picker, bounded stalled reads, cancellation and stale completion"
    );
}

module.exports = async function (...args) {
    let timer;
    try {
        await Promise.race([
            browserImportRegression(...args),
            new Promise((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                "Browser import regression did not complete"
                            )
                        ),
                    10000
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

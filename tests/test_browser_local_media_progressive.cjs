const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const standby = ts.transpileModule(
    fs
        .readFileSync(path.join(__dirname, "../src/core/standby.ts"), "utf8")
        .replace(/^export /gm, ""),
    { compilerOptions: { target: ts.ScriptTarget.ES5 } }
).outputText;
const source = ts.transpileModule(
    fs
        .readFileSync(
            path.join(__dirname, "../src/offline/browser-local-media.ts"),
            "utf8"
        )
        .replace(/^export /gm, ""),
    {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
require("acorn").parse(source, { ecmaVersion: 5 });

function fixture(count, extension = "mp4", brokenIndex = -1, mime, waits = {}) {
    let reads = 0,
        iteratorReads = 0,
        iteratorCreations = 0,
        revoked = 0,
        nextUrl = 0,
        permissionRequests = 0;
    const files = Array.from({ length: count }, (_, index) => ({
        getFile: async () => {
            reads++;
            await waits.file;
            if (index === brokenIndex) {
                const error = new Error("File removed during scan");
                error.name = "NotFoundError";
                throw error;
            }
            return {
                lastModified: 1,
                name: "movie-" + index + "." + extension,
                size: index + 1,
                type:
                    mime || (extension === "mp4" ? "video/mp4" : "text/plain"),
            };
        },
        kind: "file",
        name: "movie-" + index + "." + extension,
    }));
    const folder = {
        getDirectoryHandle: async () => {
            await waits.directory;
            return folder;
        },
        getFileHandle: async (name) => {
            const file = files.find((file) => file.name === name);
            if (!file) {
                const error = new Error("Missing file");
                error.name = "NotFoundError";
                throw error;
            }
            return file;
        },
        kind: "directory",
        name: "Movies",
        queryPermission: async () => {
            await waits.permission;
            return "granted";
        },
        requestPermission: async () => {
            permissionRequests++;
            return "granted";
        },
        values: () => {
            iteratorCreations++;
            let index = 0;
            return {
                next: async () => {
                    iteratorReads++;
                    await waits.iterator;
                    return index < files.length
                        ? { done: false, value: files[index++] }
                        : { done: true };
                },
            };
        },
    };
    const saved = [
        { created: 1, handle: folder, id: "source-movies", name: folder.name },
    ];
    const db = {
        transaction: () => {
            const tx = {};
            tx.objectStore = () => ({
                openCursor: () => {
                    const cursor = {};
                    let index = 0;
                    const advance = () =>
                        Promise.resolve(waits.records).then(() => {
                            let continued = false;
                            cursor.result =
                                index < saved.length
                                    ? {
                                          continue: () => {
                                              continued = true;
                                              advance();
                                          },
                                          value: saved[index++],
                                      }
                                    : null;
                            cursor.onsuccess();
                            if (!continued) tx.oncomplete();
                        });
                    advance();
                    return cursor;
                },
            });
            return tx;
        },
    };
    const w = {
        addEventListener: () => {},
        clearTimeout,
        indexedDB: {
            open: () => {
                const request = {};
                queueMicrotask(() => {
                    request.result = db;
                    request.onsuccess();
                });
                return request;
            },
        },
        navigator: {},
        setTimeout,
        showDirectoryPicker: () => {},
        URL: {
            createObjectURL: () => "blob:fixture-" + ++nextUrl,
            revokeObjectURL: () => revoked++,
        },
    };
    const context = vm.createContext({
        Array,
        Date,
        Error,
        Number,
        Object,
        Promise,
        RegExp,
        String,
    });
    vm.runInContext(source, context);
    vm.runInContext(standby, context);
    return {
        addSource: (id) =>
            saved.push({ created: 2, handle: folder, id, name: folder.name }),
        api: context.installBrowserLocalMedia(w),
        installStandby: () =>
            context.installStandby(
                w,
                () => "0",
                () => {}
            ),
        iteratorCreations: () => iteratorCreations,
        iteratorReads: () => iteratorReads,
        permissionRequests: () => permissionRequests,
        reads: () => reads,
        revoked: () => revoked,
        w,
    };
}
async function settle(pending) {
    let timer;
    try {
        return await Promise.race([
            pending,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                "Pending directory regression did not complete"
                            )
                        ),
                    5000
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
async function flushScans() {
    for (let i = 0; i < 150; i++) await Promise.resolve();
}

(async () => {
    let releaseInitial;
    const sharedInitial = fixture(3, "mp4", -1, undefined, {
        iterator: new Promise((resolve) => {
            releaseInitial = resolve;
        }),
    });
    const firstOwner = sharedInitial.api.list();
    await flushScans();
    const secondOwner = sharedInitial.api.list();
    await flushScans();
    const lastOwner = sharedInitial.api.list();
    await flushScans();
    assert.equal(
        sharedInitial.iteratorCreations(),
        1,
        "rapid retries share only the unresolved first iterator"
    );
    assert.equal(
        sharedInitial.iteratorReads(),
        1,
        "rapid retries cannot queue another full native enumeration"
    );
    releaseInitial();
    const initialResults = await settle(
        Promise.all([firstOwner, secondOwner, lastOwner])
    );
    assert.equal(initialResults[0].cancelled, true);
    assert.equal(initialResults[1].cancelled, true);
    assert.equal(initialResults[0].items.length, 0);
    assert.equal(initialResults[1].items.length, 0);
    assert.equal(initialResults[2].items.length, 3);
    assert.equal(
        sharedInitial.iteratorReads(),
        4,
        "only newest owner advances the iterator after its shared first result"
    );
    assert.equal((await settle(sharedInitial.api.list())).items.length, 3);
    assert.equal(
        sharedInitial.iteratorCreations(),
        2,
        "a completed first result is never reused as an advanced iterator"
    );

    let failInitial;
    const failedWait = {
        iterator: new Promise((_, reject) => {
            failInitial = reject;
        }),
    };
    const failedInitial = fixture(2, "mp4", -1, undefined, failedWait);
    const failedScan = failedInitial.api.list();
    await flushScans();
    failInitial(
        Object.assign(new Error("fixture failure"), {
            name: "NotReadableError",
        })
    );
    assert.equal((await settle(failedScan)).items[0].available, false);
    failedWait.iterator = Promise.resolve();
    assert.equal((await settle(failedInitial.api.list())).items.length, 2);
    assert.equal(
        failedInitial.iteratorCreations(),
        2,
        "rejected first reads release their cache entry"
    );

    let releaseRoots;
    const roots = fixture(2, "mp4", -1, undefined, {
        iterator: new Promise((resolve) => {
            releaseRoots = resolve;
        }),
    });
    roots.addSource("source-second");
    const rootOne = roots.api.list();
    await flushScans();
    const rootTwo = roots.api.list(undefined, "source-second:movie-0.mp4");
    await flushScans();
    assert.equal(
        roots.iteratorCreations(),
        2,
        "different source roots never share a pending native enumeration"
    );
    releaseRoots();
    const rootResults = await settle(Promise.all([rootOne, rootTwo]));
    assert.equal(rootResults[0].items.length, 0);
    assert.equal(rootResults[1].items.length, 4);

    let releaseStandby;
    const initialStandby = fixture(2, "mp4", -1, undefined, {
        iterator: new Promise((resolve) => {
            releaseStandby = resolve;
        }),
    });
    const initialGate = initialStandby.installStandby();
    const sleepingInitial = initialStandby.api.list();
    await flushScans();
    initialGate.set(true);
    initialStandby.api.suspend();
    assert.equal(
        initialGate.snapshot().pending,
        2,
        "standby tracks the raw first read and its catalog separately"
    );
    initialGate.set(false);
    const wakingInitial = initialStandby.api.list();
    await flushScans();
    assert.equal(
        initialStandby.iteratorCreations(),
        1,
        "wake reuses a still-pending directory read"
    );
    releaseStandby();
    const wakeResults = await settle(
        Promise.all([sleepingInitial, wakingInitial])
    );
    assert.equal(wakeResults[0].items.length, 0);
    assert.equal(wakeResults[1].items.length, 2);
    await flushScans();
    assert.equal(initialGate.snapshot().pending, 0);

    let releaseFile;
    const sleeping = fixture(2, "mp4", -1, undefined, {
        file: new Promise((resolve) => {
            releaseFile = resolve;
        }),
    });
    const sleepingGate = sleeping.installStandby();
    const scan = sleeping.api.list();
    while (!sleeping.reads())
        await new Promise((resolve) => setImmediate(resolve));
    sleepingGate.set(true);
    sleeping.api.suspend();
    assert.equal(sleepingGate.snapshot().state, "suspending");
    assert.equal(sleepingGate.snapshot().pending, 2);
    releaseFile();
    const stoppedScan = await scan;
    await Promise.resolve();
    assert.equal(stoppedScan.cancelled, true);
    assert.equal(stoppedScan.items.length, 0);
    assert.equal(
        sleeping.reads(),
        1,
        "Standby prevents another filesystem read"
    );
    assert.equal(sleepingGate.snapshot().state, "suspended");
    let releaseDirectory;
    const preferredSleep = fixture(1, "mp4", -1, undefined, {
        directory: new Promise((resolve) => {
            releaseDirectory = resolve;
        }),
    });
    const preferredGate = preferredSleep.installStandby();
    const preferredScan = preferredSleep.api.list(
        undefined,
        "source-movies:sub/movie-0.mp4"
    );
    await new Promise((resolve) => setImmediate(resolve));
    preferredGate.set(true);
    preferredSleep.api.suspend();
    releaseDirectory();
    assert.equal((await preferredScan).cancelled, true);
    assert.equal(
        preferredSleep.reads(),
        0,
        "Retired preferred path cannot start a file read"
    );
    const stopped = fixture(10000);
    const stoppedResult = await stopped.api.list((snapshot) => {
        if (snapshot.items.length) stopped.api.suspend();
    });
    assert.equal(stoppedResult.cancelled, true);
    assert(
        stopped.reads() < 10000,
        "standby retires traversal before reading the remaining tree"
    );
    stopped.w.__ottStandby = {
        blocked: () => true,
        error: () => new Error("standby"),
    };
    await assert.rejects(stopped.api.list(), /standby/);
    const f = fixture(10000);
    let publications = 0,
        firstReads = 0,
        timerRan = false,
        immutable;
    setTimeout(() => {
        timerRan = true;
    }, 0);
    const full = await f.api.list((snapshot) => {
        publications++;
        assert.equal(snapshot.scanning, true);
        if (!firstReads && snapshot.items.length) {
            firstReads = f.reads();
            immutable = snapshot;
        }
    });
    assert.equal(
        full.items[0].directory,
        "Movies",
        "root item carries only its containing folder label"
    );
    assert.equal(
        firstReads,
        1,
        "first file is playable before reading the remaining 9,999"
    );
    assert.equal(
        immutable.items.length,
        1,
        "published arrays never grow behind consumers"
    );
    assert.equal(full.items.length, 10000);
    assert.equal(full.scanning, false);
    assert.ok(
        publications >= 150 && publications <= 165,
        "bounded batch publications, not one per file"
    );
    assert.equal(timerRan, true, "large traversals yield to browser tasks");
    const firstUrl = full.items[0].url;
    let preferredFirst;
    const resumed = await f.api.list((snapshot) => {
        if (snapshot.items.length) preferredFirst ||= snapshot.items[0].id;
    }, "source-movies:movie-9999.mp4");
    assert.equal(
        preferredFirst,
        "source-movies:movie-9999.mp4",
        "saved file resolves directly before traversal"
    );
    assert.equal(new Set(resumed.items.map((item) => item.id)).size, 10000);
    assert.equal(
        resumed.items.find((item) => item.id === full.items[0].id).url,
        firstUrl,
        "unchanged files keep playback URLs"
    );
    let missingFirst;
    const missing = await f.api.list((snapshot) => {
        if (snapshot.items.length && !missingFirst)
            missingFirst = {
                count: snapshot.items.length,
                preferred: snapshot.preferred,
                scanning: snapshot.scanning,
            };
    }, "source-movies:removed.mp4");
    assert.equal(missingFirst.count, 1);
    assert.equal(missingFirst.scanning, true);
    assert.deepEqual(JSON.parse(JSON.stringify(missingFirst.preferred)), {
        id: "source-movies:removed.mp4",
        state: "missing",
    });
    assert.equal(missing.items.length, 10000);
    const beforeCancel = f.reads();
    const cancelled = await f.api.list(() => false);
    assert.equal(cancelled.cancelled, true);
    assert.equal(
        f.reads() - beforeCancel,
        0,
        "consumer cancellation stops traversal"
    );
    assert.equal(
        f.revoked(),
        0,
        "cancellation never revokes active playback URLs"
    );
    const old = f.api.list();
    const newer = f.api.list();
    assert.equal((await old).cancelled, true, "superseded scan is cancelled");
    assert.equal((await newer).items.length, 10000);
    const text = fixture(10000, "txt");
    let heartbeats = 0;
    assert.equal(
        (
            await text.api.list(() => {
                heartbeats++;
            })
        ).items.length,
        0
    );
    assert.equal(
        text.reads(),
        0,
        "known nonmedia files do not require getFile"
    );
    assert.ok(heartbeats >= 150, "empty batches still publish progress");
    for (const [extension, mime] of [
        ["mkv", "video/x-matroska"],
        ["aac", "audio/aac"],
    ]) {
        const unknown = fixture(1, extension, -1, mime);
        assert.equal(
            (await unknown.api.list()).items.length,
            1,
            "unknown extension retains MIME-based media detection: " + extension
        );
        assert.equal(unknown.reads(), 1);
    }
    const changed = await fixture(10000, "mp4", 17).api.list();
    assert.equal(
        changed.items.length,
        9999,
        "a disappearing file does not hide readable siblings"
    );
    assert.equal(changed.sources[0].available, true);
    let grantFirst;
    await f.api.requestAccess((snapshot) => {
        if (!snapshot.items.length) return;
        grantFirst = snapshot.items[0].id;
        return false;
    }, "source-movies:movie-9999.mp4");
    assert.equal(
        grantFirst,
        "source-movies:movie-9999.mp4",
        "permission recovery supports immediate preferred playback"
    );
    for (const [gateName, expectedPhase] of [
        ["records", "sources"],
        ["permission", "permission"],
        ["iterator", "files"],
    ]) {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const delayed = fixture(1, "mp4", -1, undefined, { [gateName]: gate });
        const phases = [];
        const pending = delayed.api.list((snapshot) => {
            phases.push(snapshot.phase);
        });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.equal(
            phases.filter((phase) => phase === expectedPhase).length,
            1,
            "one real phase transition, no artificial progress while awaiting " +
                gateName
        );
        assert.equal(delayed.reads(), 0);
        if (gateName === "permission") {
            const recovery = delayed.api.requestAccess(() => false);
            assert.equal(
                delayed.permissionRequests(),
                1,
                "unknown permission is requested synchronously on recovery click"
            );
            await recovery;
        } else await delayed.api.list(() => false);
        release();
        assert.equal((await pending).cancelled, true);
        assert.equal(delayed.revoked(), 0);
    }
    await require("./helpers/browser-import-regression.cjs")();
    console.log(
        "PASS progressive local media: 10,000 entries, early playback, bounded immutable batches, yielding, direct saved-file lookup, stable URLs, cancellation, and nonmedia heartbeats"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

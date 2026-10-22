const assert = require("node:assert/strict");

// Uses real Chromium OPFS directory entries and metadata reads. Empty fixture
// files isolate enumeration cost; decoder coverage belongs to the built-UI tests.
module.exports = async function browserLargeFolder(browser, address) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(address);
    try {
        const result = await page.evaluate(async () => {
            const started = performance.now();
            const root = await navigator.storage.getDirectory();
            const folder = await root.getDirectoryHandle("large-fixture", {
                create: true,
            });
            let index = 0;
            await Promise.all(
                Array.from({ length: 24 }, async () => {
                    while (index < 12000) {
                        const current = index++;
                        await folder.getFileHandle(
                            "movie-" +
                                String(current).padStart(5, "0") +
                                ".mp4",
                            { create: true }
                        );
                    }
                })
            );
            const createdMs = performance.now() - started;
            const media = installBrowserLocalMedia(window);
            window.showDirectoryPicker = () => Promise.resolve(folder);
            await media.importFolder({ deferScan: true });
            const prototype = FileSystemFileHandle.prototype;
            const original = prototype.getFile;
            let reads = 0;
            prototype.getFile = function () {
                reads++;
                return original.call(this);
            };
            let first;
            const earlyStart = performance.now();
            const early = await media.list((value) => {
                if (!value.items.length) return;
                first = {
                    count: value.items.length,
                    elapsedMs: performance.now() - earlyStart,
                    reads,
                    scanned: value.scanned,
                };
                return false;
            });
            reads = 0;
            let publications = 0;
            const scanStart = performance.now();
            const full = await media.list(() => publications++);
            const completeMs = performance.now() - scanStart;
            const totalReads = reads;
            let release;
            let waiting = false;
            const gate = new Promise((resolve) => {
                release = resolve;
            });
            prototype.getFile = async function () {
                waiting = true;
                await gate;
                return original.call(this);
            };
            let latest;
            const delayed = media.list((value) => {
                latest = value;
                return value.items.length ? false : undefined;
            });
            const deadline = performance.now() + 2000;
            while (!waiting && performance.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 10));
            await new Promise((resolve) => setTimeout(resolve, 150));
            const blocked = {
                discovered: latest?.discovered,
                items: latest?.items.length,
                phase: latest?.phase,
                scanned: latest?.scanned,
                waiting,
            };
            release();
            await delayed;
            prototype.getFile = original;
            return {
                blocked,
                completeMs,
                count: full.items.length,
                createdMs,
                earlyCount: early.items.length,
                first,
                publications,
                totalReads,
            };
        });
        assert.equal(result.count, 12000);
        assert.equal(result.totalReads, 12000);
        assert.equal(result.earlyCount, 1);
        assert.equal(result.first.reads, 1);
        assert.ok(result.publications > 100);
        assert.equal(result.blocked.waiting, true);
        assert.equal(result.blocked.items, 0);
        assert.equal(result.blocked.phase, "metadata");
        assert.equal(result.blocked.discovered, 1);
        console.log(
            "PASS real Chromium 12,000 OPFS entries: " + JSON.stringify(result)
        );
        return result;
    } finally {
        await context.close();
    }
};

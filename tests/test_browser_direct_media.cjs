const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const ts = require("typescript");
const { chromium } = require("@playwright/test");
const source = ts.transpileModule(
    fs
        .readFileSync(
            require("node:path").join(
                __dirname,
                "../src/offline/browser-local-media.ts"
            ),
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
const profileSource = require("./helpers/offline-profile-source.cjs")();
require("acorn").parse(profileSource, { ecmaVersion: 5 });

(async () => {
    const server = http.createServer((req, res) =>
        res.end("<script>" + source + profileSource + "</script>")
    );
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto("http://127.0.0.1:" + server.address().port);
        const result = await page.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle("fixture", {
                create: true,
            });
            const nested = await dir.getDirectoryHandle("nested", {
                create: true,
            });
            async function put(folder, name, data) {
                const f = await folder.getFileHandle(name, { create: true });
                const out = await f.createWritable();
                await out.write(data);
                await out.close();
                return f;
            }
            await put(nested, "movie.mp4", "original");
            await put(dir, "notes.txt", "skip");
            window.showDirectoryPicker = () => Promise.resolve(dir);
            const api = installBrowserLocalMedia(window);
            const initial = await api.importFolder();
            const db = await new Promise((resolve, reject) => {
                const r = indexedDB.open("ott-local-media", 1);
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
            });
            const stored = await new Promise((resolve) => {
                const r = db.transaction("files").objectStore("files").getAll();
                r.onsuccess = () => resolve(r.result);
            });
            await put(nested, "movie.mp4", "replacement-is-longer");
            const updated = await api.list();
            const body = await (await fetch(updated.items[0].url)).text();
            await put(nested, "second.mp4", "second");
            const refreshed = await api.list();
            const originalQuery =
                FileSystemDirectoryHandle.prototype.queryPermission;
            FileSystemDirectoryHandle.prototype.queryPermission = () =>
                Promise.resolve("prompt");
            const locked = await api.list();
            FileSystemDirectoryHandle.prototype.queryPermission = originalQuery;
            const reconnected = await api.requestAccess();
            await api.removeSource(initial.sources[0].id);
            const preserved = await (
                await nested.getFileHandle("movie.mp4")
            ).getFile();
            await new Promise((resolve) => {
                const tx = db.transaction("files", "readwrite");
                tx.objectStore("files").put({
                    blob: new Blob(["legacy"], { type: "video/mp4" }),
                    created: 1,
                    id: "legacy",
                    name: "legacy.mp4",
                });
                tx.oncomplete = resolve;
            });
            const legacy = await api.list();
            window.showDirectoryPicker = undefined;
            let unsupported = "";
            try {
                await api.importFolder();
            } catch (e) {
                unsupported = e.message;
            }
            return {
                body,
                initial,
                legacy,
                locked,
                preserved: preserved.size,
                reconnected,
                refreshed,
                stored: stored.map((r) => ({
                    hasBlob: !!r.blob,
                    hasHandle: !!r.handle,
                })),
                unsupported,
            };
        });
        assert.equal(result.initial.items.length, 1);
        assert.equal(result.initial.items[0].name, "nested/movie.mp4");
        assert.deepEqual(result.stored, [{ hasBlob: false, hasHandle: true }]);
        assert.equal(result.body, "replacement-is-longer");
        assert.equal(result.refreshed.items.length, 2);
        assert.equal(result.locked.items[0].access, "permission-required");
        assert.equal(result.locked.items[0].url, "");
        assert.equal(result.reconnected.items.length, 2);
        assert.ok(result.preserved > 0);
        assert.equal(result.legacy.items[0].source, "imported");
        assert.match(result.unsupported, /Direct folder access is unavailable/);
        await page.reload();
        const legacy = await page.evaluate(async () => {
            const list = await installBrowserLocalMedia(window).list();
            return (await fetch(list.items[0].url)).text();
        });
        assert.equal(legacy, "legacy");
        await page.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle("fixture");
            window.showDirectoryPicker = () => Promise.resolve(dir);
            await window.__ottBrowserLocalMedia.importFolder();
        });
        await page.reload();
        const restored = await page.evaluate(async () => {
            const list = await installBrowserLocalMedia(window).list();
            return {
                linked: list.items.filter((i) => i.source === "linked").length,
                sources: list.sources.length,
            };
        });
        assert.equal(restored.linked, 2);
        assert.equal(restored.sources, 1);
        // Closing the page (rather than merely reloading it) destroys all
        // in-memory handles and object URLs. Only IndexedDB may restore them.
        const origin = "http://127.0.0.1:" + server.address().port;
        await page.close();
        const reopened = await context.newPage();
        await reopened.goto(origin);
        const resume = await reopened.evaluate(async () => {
            const api = installBrowserLocalMedia(window);
            const available = await api.list();
            const body = await (
                await fetch(
                    available.items.find((i) => i.name === "nested/movie.mp4")
                        .url
                )
            ).text();
            const root = await navigator.storage.getDirectory();
            const second = await root.getDirectoryHandle("second-source", {
                create: true,
            });
            window.showDirectoryPicker = () => Promise.resolve(second);
            await api.importFolder();
            const proto = FileSystemDirectoryHandle.prototype;
            const query = proto.queryPermission;
            const request = proto.requestPermission;
            let granted = false;
            let prompts = 0;
            proto.queryPermission = () =>
                Promise.resolve(granted ? "granted" : "prompt");
            proto.requestPermission = (options) => {
                if (options.mode !== "read")
                    throw new Error("Write access requested");
                prompts++;
                granted = true;
                return Promise.resolve("granted");
            };
            const locked = await api.list();
            const recovered = await api.requestAccess();
            await api.requestAccess();
            proto.queryPermission = query;
            proto.requestPermission = request;
            return {
                body,
                locked: locked.sources.map((s) => s.access),
                prompts,
                recovered: recovered.sources.map((s) => s.access),
            };
        });
        assert.equal(resume.body, "replacement-is-longer");
        assert.deepEqual(resume.locked, [
            "permission-required",
            "permission-required",
        ]);
        assert.equal(
            resume.prompts,
            1,
            "one click restores all shared grants without parallel prompts"
        );
        assert.deepEqual(resume.recovered, ["granted", "granted"]);
        const profileContext = await browser.newContext();
        let profilePage = await profileContext.newPage();
        const address = "http://127.0.0.1:" + server.address().port;
        await profilePage.goto(address);
        const portable = await profilePage.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const folder = await root.getDirectoryHandle("Profile cartoons", {
                create: true,
            });
            for (const name of ["first.mp4", "second.mp4"]) {
                const file = await folder.getFileHandle(name, { create: true });
                const out = await file.createWritable();
                await out.write(name);
                await out.close();
            }
            window.showDirectoryPicker = () => Promise.resolve(folder);
            const media = installBrowserLocalMedia(window);
            const catalog = await media.importFolder();
            const selected = catalog.items.find(
                (item) => item.name === "second.mp4"
            );
            window.stbDelItem = (key) => localStorage.removeItem(key);
            window.stbGetItem = (key) => localStorage.getItem(key);
            window.stbSetItem = (key, value) =>
                localStorage.setItem(key, value);
            window.__ottActiveProviderDriver = { id: "offline" };
            window.curList = ["local-" + selected.id];
            window.primaryIndex = 0;
            window.loadChannels = () => {};
            const profiles = installOfflineProfiles(window, {
                libraryIdentity: () => "browser:",
                snapshot: () => Promise.resolve(catalog),
            });
            const saved = await profiles.request({
                action: "profile_save",
                params: { name: "Kids", number: 1 },
            });
            if (saved.status !== "ok") throw new Error(JSON.stringify(saved));
            return (
                await profiles.request({
                    action: "profile_export",
                    params: { number: 1 },
                })
            ).data.profile;
        });
        assert.equal(portable.selected.name, "second.mp4");
        assert(!JSON.stringify(portable).includes("blob:"));
        await profilePage.close();
        profilePage = await profileContext.newPage();
        await profilePage.goto(address);
        const restoredProfile = await profilePage.evaluate(async (profile) => {
            window.stbDelItem = (key) => localStorage.removeItem(key);
            window.stbGetItem = (key) => localStorage.getItem(key);
            window.stbSetItem = (key, value) =>
                localStorage.setItem(key, value);
            window.__ottActiveProviderDriver = { id: "offline" };
            window.loadChannels = () => {};
            const media = installBrowserLocalMedia(window);
            const profiles = installOfflineProfiles(window, {
                libraryIdentity: () => "browser:",
                list: () => media.list(),
            });
            const imported = await profiles.request({
                action: "profile_import",
                params: { number: 2, profile },
            });
            const loaded = await profiles.request({
                action: "profile",
                params: { number: 2 },
            });
            const catalog = profiles.filter(await media.list());
            const item = catalog.items.find(
                (item) => "local-" + item.id === profiles.selection()
            );
            const body = await (await fetch(item.url)).text();
            return { body, count: catalog.items.length, imported, loaded };
        }, portable);
        assert.equal(restoredProfile.imported.data.binding_required, false);
        assert.equal(restoredProfile.loaded.status, "ok");
        assert.equal(restoredProfile.body, "second.mp4");
        assert.equal(restoredProfile.count, 2);
        const foreignContext = await browser.newContext();
        const foreignPage = await foreignContext.newPage();
        await foreignPage.goto(address);
        const foreign = await foreignPage.evaluate(async (profile) => {
            window.stbDelItem = (key) => localStorage.removeItem(key);
            window.stbGetItem = (key) => localStorage.getItem(key);
            window.stbSetItem = (key, value) =>
                localStorage.setItem(key, value);
            window.__ottActiveProviderDriver = { id: "offline" };
            window.loadChannels = () => {};
            const media = installBrowserLocalMedia(window);
            const profiles = installOfflineProfiles(window, {
                libraryIdentity: () => "browser:",
                list: () => media.list(),
            });
            const imported = await profiles.request({
                action: "profile_import",
                params: { number: 1, profile },
            });
            await profiles.request({
                action: "profile",
                params: { number: 1 },
            });
            return {
                count: profiles.filter(await media.list()).items.length,
                imported,
                selected: profiles.selection(),
            };
        }, portable);
        assert.equal(foreign.imported.data.binding_required, true);
        assert.equal(foreign.count, 0);
        assert.equal(foreign.selected, "");
        await foreignContext.close();
        await profileContext.close();
        if (process.argv.includes("--large-folder"))
            await require("./helpers/browser-large-folder.cjs")(
                browser,
                "http://127.0.0.1:" + server.address().port
            );
        console.log(
            "PASS offline profiles: real IndexedDB handles survive closed-page save/export/import/load; exact selected original read; foreign context requires binding"
        );
        console.log(
            "PASS direct browser sources: recursive read, handle-only storage, fresh file reads, refresh, permission status/reconnect, disconnect preserves originals, legacy blobs, unsupported browser, closed-page restoration, single read-only restore prompt"
        );
    } finally {
        await browser.close();
        await new Promise((r) => server.close(r));
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});

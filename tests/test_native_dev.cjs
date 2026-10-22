// Exercise middleware and queue directly: no port, npm build or child is started.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
    configureNativeDev,
    createRebuildQueue,
    isNativeDevInput,
    nativeAssetPath,
    viteEnvironmentRoutes,
} = require("../scripts/native-dev.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ottplay-native-dev-"));
const assets = path.join(root, "src-tauri/frontend");
const pinInputs = [
    "js/vendor/sjcl-pin.js",
    "js/vendor/sjcl-pin-source.json",
    "js/vendor/sjcl-pin-word-arrays.patch.json",
    "js/licenses/SJCL-1.0.9.txt",
];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function write(file, data) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
}
let cases = 0;
function pass(name) {
    cases++;
    console.log("PASS native dev: " + name);
}
async function main() {
    let dispose;
    try {
        write(
            "src-tauri/frontend/index.html",
            '<html><head><script src="./js/native-environment.js"></script></head><body>native</body></html>'
        );
        write("src-tauri/frontend/native-runtime.json", '{"fonts":"system"}');
        write("src-tauri/frontend/js/jquery.min.js", "native-jquery");
        write("index.html", "legacy-index-must-not-leak");
        write(".env", "private-must-not-leak");
        write("src-tauri/frontend/secret.key", "private-must-not-leak");
        fs.symlinkSync(path.join(root, ".env"), path.join(assets, "leak.txt"));
        for (const url of [
            "/../.env",
            "/%2e%2e/.env",
            "/%2E%2E%2F.env",
            "/..%5C.env",
            "/%00",
            "/%zz",
            "/leak.txt",
            "/secret.key",
            "/src/index.ts",
            "/%252e%252e/.env",
        ])
            assert.equal(nativeAssetPath(assets, url), null, url);
        assert.equal(
            nativeAssetPath(assets, "/js/jquery.min.js?cache=1"),
            path.join(assets, "js/jquery.min.js")
        );
        pass(
            "traversal, encoded separators, hidden files, source fallthrough and symlink rejection"
        );
        for (const file of [
            "src/index.ts",
            "src/core/index.ts",
            "providers/demo/provider.js",
            "devices/pc/device.js",
            "styles/player.css",
            "src-tauri/pip/pip.html",
            "scripts/native-runtime.cjs",
            "package-lock.json",
            "docs/privacy-policy.md",
            "licenses/android/Cordova-NOTICE.txt",
            "vendor/ottplay-core.js",
            "vendor/ottplay-core.manifest.json",
            "licenses/native/rquickjs-LICENSE.txt",
            ...pinInputs,
        ])
            assert.equal(
                isNativeDevInput(root, path.join(root, file)),
                true,
                file
            );
        for (const file of [
            "src-tauri/frontend/index.html",
            "dist/player.js",
            "dist-mobile/index.html",
            "android/app/build/generated/output.js",
            "node_modules/jquery/dist/jquery.min.js",
            ".local-artifacts/private.json",
            ".local-ops/deploy.js",
            "devices/logs/hook.json",
            "providers/example/.env",
            "providers/example/credentials.json",
            "providers/example/private.key",
            "../external.js",
            "js/ottplay-core.js",
            "js/runtime-polyfills.js",
            "js/vendor/sjcl-pin.generated.js",
            "vendor/glib-0.18.5/test.js",
        ])
            assert.equal(
                isNativeDevInput(root, path.join(root, file)),
                false,
                file
            );
        pass(
            "source watch allowlist excludes generated outputs and private inputs"
        );
        const pending = [];
        let concurrent = 0;
        let maximum = 0;
        let reloads = 0;
        let failures = 0;
        const q = createRebuildQueue({
            build(signal) {
                concurrent++;
                maximum = Math.max(maximum, concurrent);
                return new Promise((resolve, reject) =>
                    pending.push({
                        reject() {
                            concurrent--;
                            reject(new Error("fixture failed"));
                        },
                        resolve() {
                            concurrent--;
                            resolve();
                        },
                        signal,
                    })
                );
            },
            debounceMs: 5,
            onError() {
                failures++;
            },
            onSuccess() {
                reloads++;
            },
        });
        q.request();
        q.request();
        q.request();
        await delay(20);
        assert.equal(pending.length, 1);
        assert.equal(q.unavailable, true);
        q.request();
        q.request();
        pending[0].resolve();
        await delay(20);
        assert.equal(pending.length, 2);
        assert.equal(
            reloads,
            0,
            "Do not reload an intermediate source snapshot"
        );
        pending[1].resolve();
        await delay(1);
        assert.equal(reloads, 1);
        assert.equal(q.unavailable, false);
        assert.equal(maximum, 1);
        q.request();
        await delay(20);
        pending[2].reject();
        await delay(1);
        assert.equal(failures, 1);
        assert.equal(q.unavailable, true);
        assert.equal(reloads, 1);
        q.request();
        await delay(20);
        pending[3].resolve();
        await delay(1);
        assert.equal(q.unavailable, false);
        assert.equal(reloads, 2);
        q.request();
        await delay(20);
        q.close();
        assert.equal(pending[4].signal.aborted, true);
        pending[4].resolve();
        await delay(1);
        assert.equal(reloads, 2);
        pass(
            "debounce, serialized rebuilds, failure recovery and shutdown cancellation"
        );
        const watcher = new EventEmitter();
        const watched = new Set();
        watcher.add = (files) => files.forEach((file) => watched.add(file));
        let middleware;
        let builds = 0;
        let resolveBuild;
        const messages = [];
        const server = {
            config: { logger: { error() {} } },
            httpServer: new EventEmitter(),
            middlewares: {
                use(value) {
                    middleware = value;
                },
            },
            watcher,
            ws: {
                send(value) {
                    messages.push(value);
                },
            },
        };
        dispose = configureNativeDev(server, root, {
            build() {
                builds++;
                return new Promise((resolve) => {
                    resolveBuild = resolve;
                });
            },
            debounceMs: 5,
        });
        for (const file of pinInputs)
            assert(watched.has(path.join(root, file)), file);
        assert(!watched.has(path.join(root, "js")));
        function request(url, method = "GET") {
            const res = {
                end(value) {
                    this.body = value?.toString() || "";
                },
                headers: {},
                setHeader(name, value) {
                    this.headers[name] = value;
                },
                statusCode: 0,
            };
            let fallthrough = false;
            middleware({ method, url }, res, () => {
                fallthrough = true;
            });
            return { ...res, fallthrough };
        }
        const index = request("/");
        assert.equal(index.statusCode, 200);
        assert.match(index.body, /native/);
        assert(!index.body.includes("legacy-index"));
        assert(
            index.body.indexOf("native-environment.js") <
                index.body.indexOf("/@vite/client")
        );
        assert.equal(index.headers["Cache-Control"], "no-store");
        const js = request("/js/jquery.min.js");
        assert.equal(js.body, "native-jquery");
        assert.equal(
            js.headers["Content-Type"],
            "text/javascript; charset=utf-8"
        );
        assert.equal(request("/js/jquery.min.js", "HEAD").body, "");
        assert.equal(request("/js/jquery-1.11.1.min.js").statusCode, 404);
        assert.equal(request("/src/index.ts").fallthrough, false);
        assert.equal(request("/anything", "POST").statusCode, 405);
        assert.equal(request("/@vite/client").fallthrough, true);
        assert.equal(request("/@vite/env").fallthrough, true);
        for (const route of viteEnvironmentRoutes(root)) {
            assert.equal(request(route).fallthrough, true, route);
            assert.equal(request(route + ".map").fallthrough, false, route);
        }
        const repositoryRoot = path.resolve(__dirname, "..");
        const installedEnv = path.join(
            path.dirname(require.resolve("vite/package.json")),
            "dist/client/env.mjs"
        );
        const relativeEnv = path.relative(repositoryRoot, installedEnv);
        const envRoute =
            relativeEnv.startsWith(".." + path.sep) ||
            path.isAbsolute(relativeEnv)
                ? "/@fs/" + installedEnv.split(path.sep).join("/")
                : "/" + relativeEnv.split(path.sep).join("/");
        assert(
            viteEnvironmentRoutes(repositoryRoot).has(envRoute),
            "Vite's installed env import must reach its transform middleware, including worktrees with shared dependencies"
        );
        assert.equal(
            request("/node_modules/vite/dist/client/client.mjs").fallthrough,
            false
        );
        assert.equal(
            request("/node_modules/vite/package.json").fallthrough,
            false
        );
        assert.equal(request("/@vite/env", "POST").statusCode, 405);
        assert.equal(request("/@fs/etc/passwd").fallthrough, false);
        server.ws.send({ path: "/index.html", type: "full-reload" });
        server.ws.send({ type: "update", updates: [] });
        assert.deepEqual(
            messages,
            [],
            "Default Vite reload must not race native staging"
        );
        watcher.emit(
            "all",
            "change",
            path.join(root, "src-tauri/frontend/index.html")
        );
        await delay(10);
        assert.equal(builds, 0);
        watcher.emit("all", "change", path.join(root, "src/index.ts"));
        assert.equal(request("/").statusCode, 503);
        assert.match(
            request("/").body,
            /\/@vite\/client/,
            "Waiting page must reconnect for the successful reload"
        );
        await delay(20);
        assert.equal(builds, 1);
        resolveBuild();
        await delay(1);
        assert.deepEqual(messages, [{ path: "*", type: "full-reload" }]);
        assert.equal(request("/").statusCode, 200);
        for (const file of pinInputs) {
            const before = builds;
            watcher.emit("all", "change", path.join(root, file));
            assert.equal(request("/").statusCode, 503, file);
            await delay(20);
            assert.equal(builds, before + 1, file);
            resolveBuild();
            await delay(1);
            assert.equal(request("/").statusCode, 200, file);
            assert.equal(messages.length, builds, file);
        }
        const beforeGenerated = builds;
        for (const file of [
            "js/ottplay-core.js",
            "js/runtime-polyfills.js",
            "js/vendor/sjcl-pin.generated.js",
        ])
            watcher.emit("all", "change", path.join(root, file));
        await delay(20);
        assert.equal(builds, beforeGenerated);
        pass(
            "PIN source, provenance and license changes rebuild; generated JS stays ignored"
        );
        server.httpServer.emit("close");
        assert.equal(watcher.listenerCount("all"), 0);
        server.ws.send({ path: "restored", type: "full-reload" });
        assert.equal(
            messages.at(-1).path,
            "restored",
            "Closing native dev restores Vite's original sender"
        );
        fs.rmSync(path.join(assets, "native-runtime.json"));
        assert.equal(request("/").statusCode, 503);
        pass(
            "native-only MIME/HEAD serving, HMR bootstrap, reload and missing-build fail-closed behavior"
        );
        console.log(
            `Native dev: ${cases} groups passed without a server or real build.`
        );
    } finally {
        dispose?.close();
        fs.rmSync(root, { force: true, recursive: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

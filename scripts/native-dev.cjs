// Serve the staged native frontend in Tauri dev mode. Never fall through to the
// legacy project root for an app asset, including while a rebuild is failing.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MIME = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
    ".webp": "image/webp",
    ".xml": "application/xml; charset=utf-8",
};
const INPUT_DIRECTORIES = [
    "src",
    "providers",
    "devices",
    "styles",
    "images",
    "locales",
    "scripts",
    "src-tauri/pip",
    "licenses/android",
];
const INPUT_FILES = new Set([
    "index.html",
    "vite.config.ts",
    "package.json",
    "package-lock.json",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "docs/privacy-policy.md",
    "js/vendor/sjcl-pin.js",
    "js/vendor/sjcl-pin-source.json",
    "js/vendor/sjcl-pin-word-arrays.patch.json",
    "js/licenses/SJCL-1.0.9.txt",
    "vendor/ottplay-core.js",
    "vendor/ottplay-core.manifest.json",
    "vendor/ottplay-core.LICENSE.txt",
    "licenses/native/rquickjs-LICENSE.txt",
    "licenses/native/QuickJS-NG-LICENSE.txt",
]);
const PRIVATE_DIRECTORIES = new Set([
    "node_modules",
    "build",
    "dist",
    "dist-mobile",
    "target",
    "logs",
    "coverage",
    "frontend",
]);

function isNativeDevInput(root, file) {
    const relative = path.relative(root, path.resolve(root, file));
    if (
        !relative ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative)
    )
        return false;
    const parts = relative.split(path.sep);
    if (
        parts.some(
            (part) => part.startsWith(".") || PRIVATE_DIRECTORIES.has(part)
        )
    )
        return false;
    if (/^(?:credentials?|secrets?|tokens?)(?:\.|$)/i.test(parts.at(-1)))
        return false;
    const portable = parts.join("/");
    if (INPUT_FILES.has(portable)) return true;
    if (
        !INPUT_DIRECTORIES.some((directory) =>
            portable.startsWith(directory + "/")
        )
    )
        return false;
    return /\.(?:[cm]?js|ts|tsx|css|html|json|txt|png|jpe?g|svg|gif|ico|webp)$/i.test(
        portable
    );
}

function nativeAssetPath(directory, url) {
    let pathname;
    try {
        pathname = decodeURIComponent(String(url || "/").split(/[?#]/, 1)[0]);
    } catch {
        return null;
    }
    if (!pathname.startsWith("/") || /[\\\0]/.test(pathname)) return null;
    const parts = pathname.split("/").filter(Boolean);
    if (parts.some((part) => part.startsWith("."))) return null;
    if (!parts.length) parts.push("index.html");
    let file = directory;
    try {
        if (fs.lstatSync(directory).isSymbolicLink()) return null;
        for (const part of parts) {
            file = path.join(file, part);
            if (fs.lstatSync(file).isSymbolicLink()) return null;
        }
        if (
            !fs.statSync(file).isFile() ||
            !MIME[path.extname(file).toLowerCase()]
        )
            return null;
    } catch {
        return null;
    }
    return file;
}

function createRebuildQueue({ build, onSuccess, onError, debounceMs = 150 }) {
    let timer;
    let dirty = false;
    let running = false;
    let failed = false;
    let closed = false;
    let controller;
    function schedule() {
        if (closed || running) return;
        clearTimeout(timer);
        timer = setTimeout(run, debounceMs);
    }
    async function run() {
        if (closed || running || !dirty) return;
        dirty = false;
        running = true;
        controller = new AbortController();
        try {
            await build(controller.signal);
            failed = false;
            // If another source changed while building, serve neither an
            // intermediate build nor a reload until the next build succeeds.
            if (!closed && !dirty) onSuccess();
        } catch (error) {
            failed = true;
            if (!closed) onError(error);
        } finally {
            running = false;
            controller = undefined;
            if (dirty) schedule();
        }
    }
    return {
        close() {
            closed = true;
            clearTimeout(timer);
            controller?.abort();
        },
        request() {
            if (closed) return;
            dirty = true;
            schedule();
        },
        get unavailable() {
            return running || dirty || failed;
        },
    };
}

function buildNativeAssets(root, signal) {
    return new Promise((resolve, reject) => {
        // npm-run supplies its JS entry point, avoiding .cmd execution on Windows.
        const npmEntry = process.env.npm_execpath;
        const useEntry = npmEntry && /npm(?:-cli)?\.js$/i.test(npmEntry);
        const child = spawn(
            useEntry
                ? process.execPath
                : process.platform === "win32"
                  ? "npm.cmd"
                  : "npm",
            useEntry ? [npmEntry, "run", "build"] : ["run", "build"],
            {
                cwd: root,
                detached: process.platform !== "win32",
                shell: !useEntry && process.platform === "win32",
                stdio: "inherit",
            }
        );
        let killTimer;
        let finished = false;
        let stopping = false;
        function stop() {
            if (finished || stopping || !child.pid) return;
            stopping = true;
            function kill(sig) {
                try {
                    if (process.platform === "win32") child.kill(sig);
                    else process.kill(-child.pid, sig);
                } catch (error) {
                    if (error.code !== "ESRCH") reject(error);
                }
            }
            kill("SIGTERM");
            killTimer = setTimeout(() => kill("SIGKILL"), 5000);
            // Keep the bounded final kill alive even when npm exits before its
            // compiler children; only our POSIX process group is targeted.
        }
        const deadline = setTimeout(stop, 10 * 60 * 1000);
        deadline.unref();
        signal.addEventListener("abort", stop, { once: true });
        function finish(error) {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            if (!stopping) clearTimeout(killTimer);
            signal.removeEventListener("abort", stop);
            if (error) reject(error);
            else resolve();
        }
        child.once("error", finish);
        child.once("exit", (code, killedBy) =>
            finish(
                code === 0 && !signal.aborted && !stopping
                    ? undefined
                    : new Error(
                          "Native frontend build failed (" +
                              (killedBy || code) +
                              ")"
                      )
            )
        );
        if (signal.aborted) stop();
    });
}

function viteEnvironmentRoutes(root) {
    const packageFile = require.resolve("vite/package.json", {
        paths: [root, __dirname],
    });
    const envFile = path.join(path.dirname(packageFile), "dist/client/env.mjs");
    const routes = new Set(["/@vite/env"]);
    // Vite resolves @vite/env to this installed file. In a project-local install
    // the emitted URL is /node_modules/vite/dist/client/env.mjs; an external or
    // symlinked install can use /@fs/. Admit only that one known dependency.
    for (const file of new Set([envFile, fs.realpathSync(envFile)])) {
        const relative = path.relative(root, file);
        if (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
            routes.add("/" + relative.split(path.sep).join("/"));
        const absolute = file.split(path.sep).join("/");
        routes.add("/@fs/" + absolute);
        routes.add("/@fs/" + absolute.replace(/^\//, ""));
    }
    return routes;
}

function configureNativeDev(server, root, options = {}) {
    root = path.resolve(root);
    const directory = path.join(root, "src-tauri/frontend");
    const envRoutes = viteEnvironmentRoutes(root);
    const originalSend = server.ws.send;
    const send = (...args) => originalSend.apply(server.ws, args);
    // Vite can send a root-HTML reload before our native build is ready. Native
    // assets are not Vite source modules; only our completed stage may reload.
    const guardedSend = (...args) => {
        if (["update", "full-reload"].includes(args[0]?.type)) return;
        return send(...args);
    };
    server.ws.send = guardedSend;
    const queue = createRebuildQueue({
        build: options.build || ((signal) => buildNativeAssets(root, signal)),
        debounceMs: options.debounceMs,
        onError(error) {
            server.config.logger.error(
                "Native frontend rebuild failed: " + error.message
            );
            server.ws.send({
                err: {
                    message:
                        "Native frontend rebuild failed; inspect the terminal.",
                    stack: "",
                },
                type: "error",
            });
        },
        onSuccess() {
            send({ path: "*", type: "full-reload" });
        },
    });
    const changed = (_event, file) => {
        if (isNativeDevInput(root, file)) queue.request();
    };
    server.watcher.add(
        [...INPUT_DIRECTORIES, ...INPUT_FILES].map((file) =>
            path.join(root, file)
        )
    );
    server.watcher.on("all", changed);
    server.middlewares.use((req, res, next) => {
        // Only Vite's own HMR bootstrap routes may reach its normal middleware.
        const pathname = String(req.url || "/").split(/[?#]/, 1)[0];
        if (
            (req.method === "GET" || req.method === "HEAD") &&
            (pathname === "/@vite/client" || envRoutes.has(pathname))
        )
            return next();
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        function error(status, text) {
            res.statusCode = status;
            if (
                status === 503 &&
                (pathname === "/" || pathname === "/index.html")
            ) {
                // A navigation during a build must keep HMR connected so the
                // successful build can recover it without a manual refresh.
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                const escaped = text.replace(
                    /[&<>]/g,
                    (value) =>
                        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[value]
                );
                res.end(
                    req.method === "HEAD"
                        ? undefined
                        : '<!doctype html><html><head><script type="module" src="/@vite/client"></script></head><body><p>' +
                              escaped +
                              "</p></body></html>"
                );
                return;
            }
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(req.method === "HEAD" ? undefined : text);
        }
        if (req.method !== "GET" && req.method !== "HEAD")
            return error(405, "Method not allowed");
        if (queue.unavailable)
            return error(
                503,
                "Native frontend is rebuilding or the last build failed; inspect the terminal."
            );
        if (!fs.existsSync(path.join(directory, "native-runtime.json")))
            return error(
                503,
                "Native frontend is missing. Run npm run build before starting native dev."
            );
        const file = nativeAssetPath(directory, req.url);
        if (!file) return error(404, "Native asset not found");
        try {
            let bytes = fs.readFileSync(file);
            if (path.basename(file) === "index.html") {
                const html = bytes.toString("utf8");
                bytes = Buffer.from(
                    html.replace(
                        "</head>",
                        '<script type="module" src="/@vite/client"></script>\n</head>'
                    )
                );
            }
            res.statusCode = 200;
            res.setHeader(
                "Content-Type",
                MIME[path.extname(file).toLowerCase()]
            );
            res.setHeader("Content-Length", bytes.length);
            res.end(req.method === "HEAD" ? undefined : bytes);
        } catch {
            error(
                503,
                "Native asset changed during rebuild; retry after completion."
            );
        }
    });
    function close() {
        server.watcher.off("all", changed);
        queue.close();
        if (server.ws.send === guardedSend) server.ws.send = originalSend;
    }
    server.httpServer?.once("close", close);
    return { close };
}

module.exports = {
    configureNativeDev,
    createRebuildQueue,
    isNativeDevInput,
    nativeAssetPath,
    viteEnvironmentRoutes,
};

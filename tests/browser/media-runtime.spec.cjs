// Real browser decoding is complementary to the isolated missing-API VM test.
// These fixtures do not emulate physical TV firmware, DRM, or device decoders.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

const root = path.resolve(__dirname, "../..");
const mediaRoot = path.join(root, "tests/fixtures/media-runtime");
const runtimeFiles = ["runtime-polyfills.js", "hls.min.js", "hls.worker.js"];
const { runtimeVersion } = JSON.parse(
    fs.readFileSync(path.join(root, "js/media-runtime.json"), "utf8")
);
const shippedWorker = fs.readFileSync(
    path.join(root, "js/hls.worker.js"),
    "utf8"
);

// Window's patched built-ins do not propagate to workers. A test-only prefix
// removes native APIs inside the actual worker before the shipped bytes run.
const stripWorker = `
self.Promise = undefined; self.Map = undefined; self.Set = undefined;
self.WeakMap = undefined; self.WeakSet = undefined; self.Symbol = undefined;
Array.from = undefined; Array.prototype.includes = undefined;
Object.assign = undefined; Object.entries = undefined;
Uint8Array.from = undefined; Uint8Array.prototype.slice = undefined;
self.TextEncoder = undefined; self.TextDecoder = undefined;
self.URL = undefined; self.URLSearchParams = undefined;
`;

let server;
let origin;
const requests = [];

test.beforeAll(async () => {
    server = http.createServer((request, response) => {
        const requestUrl = new URL(request.url, "http://localhost");
        const pathname = requestUrl.pathname;
        requests.push(pathname + requestUrl.search);
        if (pathname === "/" || pathname === "/nested/app/") {
            response.writeHead(200, {
                "Cache-Control": "no-store",
                "Content-Type": "text/html; charset=utf-8",
            });
            response.end(
                '<!doctype html><html><head><meta charset="utf-8">' +
                    (requestUrl.searchParams.has("legacy")
                        ? "<script>" + stripWorker + "</script>"
                        : "") +
                    '<script src="' +
                    pathname +
                    "js/runtime-polyfills.js?v=" +
                    runtimeVersion +
                    '"></script>' +
                    '<script src="' +
                    pathname +
                    'js/hls.min.js"></script></head>' +
                    "<body><video muted playsinline></video></body></html>"
            );
        } else if (
            /^\/(?:nested\/app\/|cases\/[a-z-]+\/)?js\/[^/]+$/.test(pathname) &&
            [...runtimeFiles, "legacy-worker.js"].includes(
                path.basename(pathname)
            )
        ) {
            const filename = path.basename(pathname);
            const scenario = pathname.split("/")[2];
            const headers = {
                "Cache-Control": "public, max-age=3600",
                "Content-Type": "application/javascript",
                "X-Content-Type-Options": "nosniff",
            };
            if (scenario === "no-store") headers["Cache-Control"] = "no-store";
            let bytes =
                filename === "legacy-worker.js"
                    ? stripWorker + shippedWorker
                    : fs.readFileSync(path.join(root, "js", filename));
            if (filename.endsWith("worker.js")) {
                if (scenario === "worker-only")
                    bytes =
                        'self.postMessage({event:"bootstrap-start"});\n' +
                        bytes;
                if (scenario === "csp-blocked")
                    headers["Content-Security-Policy"] = "script-src 'none'";
                if (scenario === "csp-allowed")
                    headers["Content-Security-Policy"] = "script-src 'self'";
            } else if (filename === "runtime-polyfills.js") {
                if (scenario === "missing" || scenario === "worker-only") {
                    headers["Cache-Control"] = "no-store";
                    response.writeHead(404, headers).end();
                    return;
                }
                if (scenario === "wrong-mime")
                    headers["Content-Type"] = "text/plain";
                if (scenario === "stale")
                    bytes += '\nself.__ottMediaRuntimeVersion = "old-version";';
                if (scenario === "not-ready")
                    bytes =
                        "self.__ottMediaRuntimeVersion = " +
                        JSON.stringify(runtimeVersion) +
                        ";";
            }
            response.writeHead(200, headers);
            response.end(bytes);
        } else if (
            pathname === "/media/index.m3u8" ||
            pathname === "/media/segment00.ts"
        ) {
            response.writeHead(200, {
                "Content-Type": pathname.endsWith(".m3u8")
                    ? "application/vnd.apple.mpegurl"
                    : "video/mp2t",
            });
            response.end(
                fs.readFileSync(path.join(mediaRoot, path.basename(pathname)))
            );
        } else {
            response.writeHead(404).end();
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = "http://127.0.0.1:" + server.address().port;
});

test.afterAll(async () => {
    await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
    );
});

test.beforeEach(() => {
    requests.length = 0;
});

function assetUrl(base, name) {
    return origin + base + "/" + name + "?v=" + runtimeVersion;
}

function requestCount(url) {
    const parsed = new URL(url);
    return requests.filter(
        (request) => request === parsed.pathname + parsed.search
    ).length;
}

// Probe the actual worker directly, so a failed import cannot be hidden by
// HLS's main-thread recovery. A new Worker also creates a new polyfill realm.
async function initializeWorker(page, workerUrl) {
    return page.evaluate(
        (url) =>
            new Promise((resolve) => {
                const messages = [];
                let worker;
                const timer = setTimeout(
                    () => finish("timeout", "Worker did not initialize"),
                    5000
                );
                function finish(outcome, error) {
                    clearTimeout(timer);
                    if (worker) worker.terminate();
                    resolve({ error: error || "", messages, outcome });
                }
                try {
                    worker = new Worker(url);
                    worker.addEventListener("error", (event) => {
                        event.preventDefault();
                        finish("error", event.message);
                    });
                    worker.addEventListener("message", (event) => {
                        if (event.data && event.data.event)
                            messages.push(event.data.event);
                        if (event.data && event.data.event === "init")
                            finish("init");
                    });
                    worker.postMessage({
                        cmd: "init",
                        config: JSON.stringify(Hls.DefaultConfig),
                        id: "main",
                        instanceNo: 0,
                        typeSupported: { mp3: true, mp4: true, mpeg: true },
                    });
                } catch (error) {
                    finish("error", error.message);
                }
            }),
        workerUrl
    );
}

for (const workerMode of [
    "disabled",
    "enabled",
    "legacy",
    "nested-legacy",
    "csp-allowed",
    "missing-runtime",
]) {
    test(
        "decodes local HLS with worker " + workerMode,
        async ({ page, browserName }) => {
            const browserErrors = [];
            const fatalErrors = [];
            const workerErrors = [];
            const workerUrls = [];
            page.on("pageerror", (error) => browserErrors.push(error.message));
            page.on("worker", (worker) => workerUrls.push(worker.url()));
            const legacy = workerMode.includes("legacy");
            const recovery = workerMode === "missing-runtime";
            const pagePath =
                workerMode === "nested-legacy" ? "/nested/app/" : "/";
            const workerBase =
                workerMode === "csp-allowed"
                    ? "/cases/csp-allowed/js"
                    : recovery
                      ? "/cases/missing/js"
                      : pagePath + "js";
            const workerUrl = assetUrl(
                workerBase,
                legacy || workerMode === "csp-allowed"
                    ? "legacy-worker.js"
                    : "hls.worker.js"
            );
            // Remove and restore globals during HTML bootstrap: Playwright's own
            // evaluation serializer needs Map and must not run between these steps.
            await page.goto(origin + pagePath + (legacy ? "?legacy=1" : ""));
            const supported = await page.evaluate(() => Hls.isSupported());
            expect(
                supported,
                "Browser runner must have real H.264/AAC MSE support"
            ).toBe(true);
            await page.exposeFunction("recordFatalHlsError", (error) =>
                fatalErrors.push(error)
            );
            await page.exposeFunction("recordWorkerHlsError", (error) =>
                workerErrors.push(error)
            );
            await page.evaluate(
                ({ workerMode, origin, workerUrl }) => {
                    // Observe messages from actual browser Worker instances.
                    // This also detects synchronous construction/setup fallbacks
                    // that do not change hls.config.enableWorker upstream.
                    var NativeWorker = window.Worker;
                    window.mediaTestWorkerMessages = [];
                    window.Worker = function (url, options) {
                        var worker = new NativeWorker(url, options);
                        worker.addEventListener("message", function (event) {
                            if (event.data && event.data.event)
                                window.mediaTestWorkerMessages.push(
                                    event.data.event
                                );
                        });
                        worker.addEventListener("error", function (event) {
                            window.recordWorkerHlsError({
                                details: "worker error",
                                reason: event.message,
                            });
                        });
                        return worker;
                    };
                    window.Worker.prototype = NativeWorker.prototype;
                    window.mediaTestHls = new Hls({
                        enableWorker: workerMode !== "disabled",
                        workerPath: workerUrl,
                    });
                    var video = document.querySelector("video");
                    mediaTestHls.on(Hls.Events.ERROR, function (_, data) {
                        // HLS reports worker errors as nonfatal and can recover
                        // by switching to the main thread. Decoding alone would
                        // therefore hide a broken packaged worker or prelude.
                        if (
                            data.details ===
                                Hls.ErrorDetails.INTERNAL_EXCEPTION ||
                            /worker/i.test(data.reason || "")
                        )
                            window.recordWorkerHlsError({
                                details: data.details,
                                event: data.event,
                                fatal: data.fatal,
                                reason: data.reason,
                            });
                        if (data.fatal)
                            window.recordFatalHlsError({
                                details: data.details,
                                reason: data.reason,
                            });
                    });
                    mediaTestHls.attachMedia(video);
                    mediaTestHls.loadSource(origin + "/media/index.m3u8");
                    video.play().catch(function (error) {
                        window.recordFatalHlsError({
                            details: "play rejection",
                            reason: error.message,
                        });
                    });
                },
                { origin, workerMode, workerUrl }
            );
            await expect
                .poll(() =>
                    page.evaluate(
                        () => document.querySelector("video").currentTime
                    )
                )
                .toBeGreaterThan(0.5);
            expect(
                await page.evaluate(() => {
                    var video = document.querySelector("video");
                    return {
                        height: video.videoHeight,
                        width: video.videoWidth,
                    };
                })
            ).toEqual({ height: 360, width: 640 });
            expect(fatalErrors).toEqual([]);
            if (recovery) {
                expect(
                    workerErrors.filter(
                        (error) =>
                            error.details === "internalException" &&
                            error.event === "demuxerWorker" &&
                            error.fatal === false
                    )
                ).toHaveLength(1);
            } else expect(workerErrors).toEqual([]);
            // WebKit also reports the expected failed worker import to the page.
            // Healthy paths must remain completely free of page errors.
            expect(browserErrors).toEqual(
                recovery && browserName === "webkit" ? ["Load failed"] : []
            );
            expect(
                await page.evaluate(
                    () => window.mediaTestHls.config.enableWorker
                ),
                recovery
                    ? "Failed runtime import must recover through upstream main-thread playback"
                    : "Healthy worker must not succeed through the main-thread error fallback"
            ).toBe(workerMode !== "disabled" && !recovery);
            if (workerMode === "disabled") expect(workerUrls).toEqual([]);
            else {
                expect(workerUrls).toContain(workerUrl);
                expect(requestCount(workerUrl)).toBeGreaterThan(0);
                expect(
                    requestCount(assetUrl(workerBase, "runtime-polyfills.js"))
                ).toBeGreaterThan(0);
                const messages = await page.evaluate(
                    () => window.mediaTestWorkerMessages
                );
                if (recovery) expect(messages).toEqual([]);
                else
                    expect(
                        messages,
                        "Real worker must initialize and return transmuxed media"
                    ).toEqual(
                        expect.arrayContaining(["init", "transmuxComplete"])
                    );
            }
            await page.evaluate(() => window.mediaTestHls.destroy());
        }
    );
}

test("worker runtime HTTP cache reuse follows the browser's cache partition", async ({
    page,
    browserName,
}) => {
    // Routing (page.route/context.route) disables Chromium's HTTP cache. These
    // assertions deliberately count requests at the origin server instead.
    await page.goto(origin);
    const runtimeUrl = assetUrl("/js", "runtime-polyfills.js");
    const counts = [requestCount(runtimeUrl)];
    expect(
        (await initializeWorker(page, assetUrl("/js", "hls.worker.js"))).outcome
    ).toBe("init");
    counts.push(requestCount(runtimeUrl));
    expect(
        (await initializeWorker(page, assetUrl("/js", "hls.worker.js"))).outcome
    ).toBe("init");
    counts.push(requestCount(runtimeUrl));
    console.log(
        "Runtime HTTP request counts (page, worker 1, worker 2): " +
            browserName +
            " " +
            JSON.stringify(counts)
    );
    // Chromium shares this response between page and worker fetches; WebKit
    // makes a separate first worker request. Neither refetches for worker 2.
    expect(counts).toEqual(browserName === "webkit" ? [1, 2, 2] : [1, 1, 1]);

    const coldRuntime = assetUrl("/cases/cold/js", "runtime-polyfills.js");
    expect(requestCount(coldRuntime)).toBe(0);
    expect(
        (
            await initializeWorker(
                page,
                assetUrl("/cases/cold/js", "hls.worker.js")
            )
        ).outcome
    ).toBe("init");
    expect(
        requestCount(coldRuntime),
        "A cold worker path fetches its sibling runtime once"
    ).toBe(1);
});

test("a cached worker and runtime can start a new worker while offline", async ({
    page,
    context,
}) => {
    await page.goto(origin);
    const workerUrl = assetUrl("/cases/offline/js", "hls.worker.js");
    const runtimeUrl = assetUrl("/cases/offline/js", "runtime-polyfills.js");
    expect((await initializeWorker(page, workerUrl)).outcome).toBe("init");
    expect(requestCount(runtimeUrl)).toBe(1);
    const workerOnlyUrl = assetUrl("/cases/worker-only/js", "hls.worker.js");
    const workerOnlyRuntime = assetUrl(
        "/cases/worker-only/js",
        "runtime-polyfills.js"
    );
    const primeWorkerOnly = await initializeWorker(page, workerOnlyUrl);
    expect(primeWorkerOnly.outcome).toBe("error");
    expect(primeWorkerOnly.messages).toContain("bootstrap-start");
    expect(primeWorkerOnly.messages).not.toContain("init");
    expect(requestCount(workerOnlyUrl)).toBe(1);
    expect(requestCount(workerOnlyRuntime)).toBe(1);
    await context.setOffline(true);
    try {
        expect((await initializeWorker(page, workerUrl)).outcome).toBe("init");
        expect(requestCount(runtimeUrl)).toBe(1);
        const missingCachedRuntime = await initializeWorker(
            page,
            workerOnlyUrl
        );
        expect(missingCachedRuntime.outcome).toBe("error");
        // WebKit can redact Worker ErrorEvent.message. The test-only marker
        // proves the cached worker body ran before its import failed.
        expect(missingCachedRuntime.messages).toContain("bootstrap-start");
        expect(missingCachedRuntime.messages).not.toContain("init");
        expect(requestCount(workerOnlyUrl)).toBe(1);
        expect(requestCount(workerOnlyRuntime)).toBe(1);
        const cold = await initializeWorker(
            page,
            assetUrl("/cases/uncached/js", "hls.worker.js")
        );
        expect(cold.outcome).toBe("error");
        expect(cold.messages).not.toContain("init");
    } finally {
        await context.setOffline(false);
    }
});

test("a no-store runtime is fetched for every fresh worker realm", async ({
    page,
}) => {
    await page.goto(origin);
    const workerUrl = assetUrl("/cases/no-store/js", "hls.worker.js");
    const runtimeUrl = assetUrl("/cases/no-store/js", "runtime-polyfills.js");
    expect((await initializeWorker(page, workerUrl)).outcome).toBe("init");
    expect((await initializeWorker(page, workerUrl)).outcome).toBe("init");
    expect(requestCount(runtimeUrl)).toBe(2);
});

for (const scenario of [
    "missing",
    "wrong-mime",
    "stale",
    "not-ready",
    "csp-blocked",
]) {
    test(
        "worker rejects " + scenario + " imported runtime before HLS init",
        async ({ page }) => {
            await page.goto(origin);
            const base = "/cases/" + scenario + "/js";
            const result = await initializeWorker(
                page,
                assetUrl(base, "hls.worker.js")
            );
            expect(result.outcome).toBe("error");
            expect(result.messages).not.toContain("init");
            if (scenario === "stale" || scenario === "not-ready")
                expect(result.error).toContain(
                    "OTT-play worker runtime mismatch"
                );
            expect(requestCount(assetUrl(base, "runtime-polyfills.js"))).toBe(
                scenario === "csp-blocked" ? 0 : 1
            );
        }
    );
}

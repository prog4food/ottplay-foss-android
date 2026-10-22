const fs = require("node:fs");
const { createCipheriv } = require("node:crypto");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { parse } = require("acorn");
// Playwright tracing injects modern MutationObservers before the page runtime.
// They cannot run while this test intentionally removes Array.from / Symbol.
test.use({ trace: "off" });
const mediaRoot = path.resolve(__dirname, "../fixtures/media-runtime");

test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
        // Headless Chromium's OS audio clock can stall even for silent AAC.
        // Muting before every native play also covers Video.js tech and PiP
        // creation while preserving real decoding, seeking and ended events.
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            this.muted = true;
            return play.call(this);
        };
    });
});

async function boot(
    page,
    context,
    baseURL,
    {
        route = "/f/pc2/",
        legacy = false,
        missing = false,
        noWorker = false,
        noMse = false,
        subtitles = false,
    } = {}
) {
    const origin = new URL(baseURL).origin;
    const requests = [];
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // The application handles window.onerror, so pageerror alone misses errors.
    page.on("console", (message) => {
        if (message.text().includes("[window.onerror]"))
            errors.push(message.text());
    });
    page.on("request", (request) =>
        requests.push(new URL(request.url()).pathname)
    );
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === "media.test") {
            const subtitleFiles = {
                "/subtitles/master.m3u8":
                    '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English",AUTOSELECT=YES,DEFAULT=YES,FORCED=NO,URI="sub.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,SUBTITLES="subs"\nindex.m3u8\n',
                "/subtitles/sub.m3u8":
                    "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\ntext.vtt\n#EXT-X-ENDLIST\n",
                "/subtitles/text.vtt":
                    "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:126000\n\n00:00:00.000 --> 00:00:02.000\nHello captions\n",
            };
            if (subtitleFiles[url.pathname])
                return route.fulfill({
                    body: subtitleFiles[url.pathname],
                    contentType: url.pathname.endsWith(".vtt")
                        ? "text/vtt"
                        : "application/vnd.apple.mpegurl",
                    headers: { "Access-Control-Allow-Origin": "*" },
                });
            const segment = url.pathname.endsWith(".ts");
            const key = Buffer.alloc(16, 7);
            if (url.pathname.endsWith("key.bin"))
                return route.fulfill({
                    body: key,
                    headers: { "Access-Control-Allow-Origin": "*" },
                });
            let body = fs.readFileSync(
                path.join(mediaRoot, segment ? "segment00.ts" : "index.m3u8")
            );
            if (url.pathname.startsWith("/encrypted/")) {
                if (segment) {
                    const cipher = createCipheriv(
                        "aes-128-cbc",
                        key,
                        Buffer.alloc(16)
                    );
                    body = Buffer.concat([cipher.update(body), cipher.final()]);
                } else
                    body = Buffer.from(
                        body
                            .toString()
                            .replace(
                                "#EXTM3U",
                                '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000000'
                            )
                    );
            }
            return route.fulfill({
                body,
                contentType: segment
                    ? "video/mp2t"
                    : "application/vnd.apple.mpegurl",
                headers: { "Access-Control-Allow-Origin": "*" },
            });
        }
        if (url.hostname === "playlist.test")
            return route.fulfill({
                body:
                    '#EXTM3U\n#EXTINF:-1 group-title="Test",One\nhttps://media.test/' +
                    (subtitles ? "subtitles/master.m3u8" : "index.m3u8") +
                    '\n#EXTINF:-1 group-title="Test",Two\nhttps://media.test/other.m3u8\n',
                contentType: "text/plain",
                headers: { "Access-Control-Allow-Origin": "*" },
            });
        if (missing && url.pathname === "/js/video.min.js")
            return route.abort();
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith("/f/")) {
            const response = await route.fetch();
            return route.fulfill({
                headers: {
                    ...response.headers(),
                    "Content-Security-Policy":
                        "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self' https://media.test https://playlist.test; media-src 'self' blob: https://media.test; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:",
                },
                response,
            });
        }
        return route.continue();
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(
        ({ legacy, standard, noWorker, noMse }) => {
            localStorage.setItem("ottplaylang", "_eng");
            localStorage.setItem("ottplayprov", "m3u");
            localStorage.setItem("m3usPlayers", standard ? "1" : "2"); // pc2 must ignore, but preserve, the PC choice.
            localStorage.setItem(
                "m3um3uArr",
                JSON.stringify({
                    active: 0,
                    M3Us: [{ www: "https://playlist.test/channels.m3u" }],
                })
            );
            window.__pc2WorkerSources = [];
            window.__pc2Workers = [];
            const NativeWorker = window.Worker;
            window.Worker = function (url, options) {
                const worker = new NativeWorker(url, options);
                const record = { active: true, errors: [] };
                window.__pc2Workers.push(record);
                worker.addEventListener("error", (event) =>
                    record.errors.push(event.message)
                );
                const terminate = worker.terminate;
                worker.terminate = function () {
                    record.active = false;
                    return terminate.call(worker);
                };
                return worker;
            };
            window.Worker.prototype = NativeWorker.prototype;
            if (noWorker) window.Worker = undefined;
            if (noMse)
                window.MediaSource = window.WebKitMediaSource = undefined;
            const NativeBlob = window.Blob;
            const stripped =
                "self.Promise=undefined;self.Map=undefined;self.Set=undefined;self.WeakMap=undefined;self.Symbol=undefined;Object.assign=undefined;Array.from=undefined;Number.isFinite=undefined;String.prototype.startsWith=undefined;";
            window.Blob = function (parts, options) {
                if (options && /javascript/.test(options.type)) {
                    window.__pc2WorkerSources.push(parts.join("\n"));
                    if (legacy) parts = [stripped].concat(parts);
                }
                return new NativeBlob(parts, options);
            };
            window.Blob.prototype = NativeBlob.prototype;
            if (legacy) {
                window.VTTCue = undefined;
                window.TextTrackCue = undefined;
                window.Promise = undefined;
                window.Map = undefined;
                window.Set = undefined;
                window.WeakMap = undefined;
                window.Symbol = undefined;
                Object.assign = undefined;
                Array.from = undefined;
                Number.isFinite = undefined;
                String.prototype.startsWith = undefined;
            }
        },
        { legacy, noMse, noWorker, standard: missing || route === "/f/pc/" }
    );
    await page.goto(route);
    await expect
        .poll(() =>
            page.evaluate(() => window.curList && window.curList.length)
        )
        .toBe(2);
    await page.keyboard.press("Shift");
    // Loading the playlist already starts its first channel. Restarting here
    // can terminate the HLS worker while it imports its runtime polyfills.
    expect(
        await page.evaluate(
            () =>
                window.curList[window.primaryIndex] === window.cats.Test[0] &&
                window.playType === 0
        )
    ).toBe(true);
    if (!noWorker && !noMse)
        await expect
            .poll(() => page.evaluate(() => window.video.currentTime))
            .toBeGreaterThan(0.2);
    return { errors, requests };
}

for (const legacy of [false, true]) {
    test(
        "pc2 plays through VHS and retains transport/layout with legacy=" +
            legacy,
        async ({ page, context, baseURL }) => {
            const { requests, errors } = await boot(page, context, baseURL, {
                legacy,
            });
            expect(requests).toContain("/js/video.min.js");
            expect(requests).not.toContain("/js/hls.min.js");
            expect(requests).not.toContain("/js/shaka-player.compiled.js");
            expect(
                await page.evaluate(() => ({
                    vhs: videojs.VhsHandler.version()[
                        "@videojs/http-streaming"
                    ],
                    video: videojs.VERSION,
                }))
            ).toEqual({ vhs: "2.16.3", video: "7.21.7" });
            expect(
                await page.evaluate(() => localStorage.getItem("m3usPlayers"))
            ).toBe("2");
            expect(
                await page.evaluate(
                    () =>
                        !!videojs
                            .getPlayer("video")
                            .tech({ IWillNotUseThisInPlugins: true }).vhs
                )
            ).toBe(true);
            await page.evaluate(() => {
                window.__originalVideo = window.video;
                window.stbPause();
            });
            await expect
                .poll(() => page.evaluate(() => video.paused))
                .toBe(true);
            await page.evaluate(() => window.stbSetPosTime(1));
            await expect
                .poll(() => page.evaluate(() => video.currentTime))
                .toBeCloseTo(1, 0);
            await page.evaluate(() => window.stbContinue());
            await expect
                .poll(() => page.evaluate(() => video.paused))
                .toBe(false);
            await page.evaluate(() => {
                window.stbSetVolume(35);
                window.stbPlayPip("https://media.test/pip.m3u8");
            });
            await expect
                .poll(() => page.evaluate(() => videoPip.currentTime))
                .toBeGreaterThan(0.2);
            await page.evaluate(() => window.stbStopPip());
            expect(
                await page.evaluate(
                    () =>
                        getComputedStyle(document.getElementById("videopip"))
                            .display
                )
            ).toBe("none");
            await page.evaluate(() =>
                window.playChannel(window.catsArray.indexOf("Test"), 1)
            );
            await expect
                .poll(() => page.evaluate(() => video.currentTime))
                .toBeGreaterThan(0.2);
            expect(
                await page.evaluate(
                    () => video === window.__originalVideo && video.isConnected
                )
            ).toBe(true);
            expect(await page.evaluate(() => video.volume)).toBeCloseTo(0.35);
            // A 16:9 frame in a 4:3 viewport exercises both letterbox and crop.
            await page.setViewportSize({ height: 720, width: 960 });
            for (const aspect of [0, 1]) {
                await page.evaluate((aspect) => {
                    window.stbToFullScreen();
                    window.setAspect(aspect);
                }, aspect);
                const boxes = await page.evaluate(() => {
                    function rect(element) {
                        var r = element.getBoundingClientRect();
                        return {
                            height: r.height,
                            width: r.width,
                            x: r.x,
                            y: r.y,
                        };
                    }
                    return {
                        media: rect(video),
                        wrapper: rect(document.getElementById("video")),
                    };
                });
                const fitted =
                    aspect === 0
                        ? { height: 540, width: 960, x: 0, y: 90 }
                        : { height: 720, width: 1280, x: -160, y: 0 };
                expect(boxes.wrapper).toEqual(fitted);
                expect(boxes.media).toEqual(fitted);
            }
            await page.evaluate(() =>
                window.stbPlay("https://media.test/encrypted/index.m3u8")
            );
            await expect
                .poll(() => page.evaluate(() => video.currentTime))
                .toBeGreaterThan(0.2);
            expect(requests).toContain("/encrypted/key.bin");
            await page.evaluate(() => window.stbStop());
            expect(
                await page.evaluate(
                    () => video.paused && !video.getAttribute("src")
                )
            ).toBe(true);
            expect(
                await page.evaluate(
                    () =>
                        videojs
                            .getPlayer("video")
                            .tech({ IWillNotUseThisInPlugins: true })
                            .sourceHandler_
                )
            ).toBeNull();
            expect(
                await page.evaluate(() =>
                    window.__pc2Workers.filter((worker) => worker.active)
                )
            ).toEqual([]);
            expect(
                await page.evaluate(() =>
                    [].concat.apply(
                        [],
                        window.__pc2Workers.map(function (worker) {
                            return worker.errors;
                        })
                    )
                )
            ).toEqual([]);
            const workers = await page.evaluate(
                () => window.__pc2WorkerSources
            );
            expect(workers.length).toBeGreaterThan(0);
            for (const code of workers) parse(code, { ecmaVersion: 5 });
            expect(errors).toEqual([]);
        }
    );
}

test("pc2 missing vendor falls back to ordinary libraries", async ({
    page,
    context,
    baseURL,
}) => {
    const { requests, errors } = await boot(page, context, baseURL, {
        missing: true,
    });
    expect(requests).toContain("/js/hls.min.js");
    expect(requests).toContain("/js/shaka-player.compiled.js");
    expect(await page.evaluate(() => typeof window.videojs)).toBe("undefined");
    expect(await page.evaluate(() => window.__pc2Workers.length)).toBe(1);
    expect(errors).toEqual([]);
});

test("pc never downloads the optional Video.js runtime", async ({
    page,
    context,
    baseURL,
}) => {
    const { requests, errors } = await boot(page, context, baseURL, {
        route: "/f/pc/",
    });
    expect(requests).not.toContain("/js/video.min.js");
    expect(requests).not.toContain("/devices/pc2/player.css");
    expect(errors).toEqual([]);
});

for (const capability of ["noWorker", "noMse"]) {
    test(
        "pc2 retains native player/UI without " + capability,
        async ({ page, context, baseURL }) => {
            const { errors } = await boot(page, context, baseURL, {
                [capability]: true,
            });
            await expect
                .poll(() => page.evaluate(() => !!videojs.getPlayer("video")))
                .toBe(true);
            expect(
                await page.evaluate(
                    () =>
                        !!videojs
                            .getPlayer("video")
                            .tech({ IWillNotUseThisInPlugins: true }).vhs
                )
            ).toBe(false);
            expect(await page.evaluate(() => window.__pc2Workers.length)).toBe(
                0
            );
            expect(
                await page.evaluate(
                    () =>
                        window.video.isConnected && window.curList.length === 2
                )
            ).toBe(true);
            await page.evaluate(() => window.stbStop());
            expect(errors).toEqual([]);
        }
    );
}

for (const legacy of [false, true]) {
    test(
        "pc2 renders WebVTT captions with legacy=" + legacy,
        async ({ page, context, baseURL }) => {
            const { errors } = await boot(page, context, baseURL, {
                legacy,
                subtitles: true,
            });
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            window
                                .__ottCoreBackend()
                                .current()
                                .tracks("subtitle").length
                    )
                )
                .toBe(1);
            await page.evaluate(() => {
                var owner = window.__ottCoreBackend().current();
                owner.pause();
                owner.seek(0.5);
                owner.selectTrack("subtitle", owner.tracks("subtitle")[0].id);
            });
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            document.querySelector(".vjs-text-track-display")
                                .textContent
                    )
                )
                .toContain("Hello captions");
            expect(
                await page.evaluate(() => {
                    var display = document.querySelector(
                        ".vjs-text-track-display"
                    );
                    return (
                        getComputedStyle(display).display !== "none" &&
                        display.getBoundingClientRect().height > 0
                    );
                })
            ).toBe(true);
            expect(errors).toEqual([]);
        }
    );
}

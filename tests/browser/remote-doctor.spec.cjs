// Production bundle/dispatcher, real owned playback and real Chromium CSS.
// Synthetic local media only; no capture permission, device or controller.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { test, expect } = require("../helpers/browser-test.cjs");

const mediaRoot = path.resolve(__dirname, "../fixtures/media-runtime");
const dist = process.env.CI_BROWSER_WEB_ROOT
    ? path.resolve(process.env.CI_BROWSER_WEB_ROOT, "dist")
    : path.resolve(__dirname, "../../dist");
const SECRET = "DOCTOR_FIXTURE_PRIVATE_VALUE";
test.use({
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

async function fixture(page, context, baseURL, media = {}) {
    const origin = new URL(baseURL).origin;
    const errors = [];
    const requests = [];
    const manifest = {
        buildId: "wrong-build",
        revision: "f".repeat(40),
        version: "0.0.0-wrong",
    };
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) =>
        requests.push(new URL(request.url()).pathname)
    );
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === media.origin) return route.continue();
        if (url.origin !== origin) return route.abort("blockedbyclient");
        if (media.control && url.pathname.startsWith("/standby-control/")) {
            const control = media.control;
            if (route.request().method() === "POST") {
                if (url.pathname.endsWith("/responses"))
                    control.replies.push(route.request().postDataJSON());
                return route.fulfill({ json: { status: "ok" } });
            }
            control.polls++;
            const next = control.pending.shift();
            const now = Date.now() / 1000;
            return route.fulfill({
                json: {
                    commands: [],
                    requests: next
                        ? [
                              {
                                  ...next,
                                  expires_at: now + 40,
                                  id: String(++control.sequence).padStart(
                                      32,
                                      "0"
                                  ),
                              },
                          ]
                        : [],
                    server_time: now,
                },
            });
        }
        if (url.pathname.endsWith("/build-info.json"))
            return route.fulfill({ json: manifest });
        if (url.pathname === "/doctor-fixture/channels.m3u")
            return route.fulfill({
                body:
                    '#EXTM3U\n#EXTINF:-1 group-title="Doctor fixture",' +
                    SECRET +
                    "\n" +
                    (media.url ||
                        origin + "/doctor-fixture/index.m3u8?token=" + SECRET) +
                    "\n",
                contentType: "text/plain",
            });
        if (url.pathname.startsWith("/doctor-fixture/")) {
            const segment = url.pathname.endsWith(".ts");
            return route.fulfill({
                body: fs.readFileSync(
                    path.join(
                        mediaRoot,
                        segment ? "segment00.ts" : "index.m3u8"
                    )
                ),
                contentType: segment
                    ? "video/mp2t"
                    : "application/vnd.apple.mpegurl",
            });
        }
        return route.continue();
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(
        ({ playlist, playerMode, languageMode, hideProviderSettings }) => {
            localStorage.setItem("ottplaylang", "_eng");
            if (languageMode)
                localStorage.setItem("ottplaylangmode", languageMode);
            if (hideProviderSettings) localStorage.setItem("noProvParam", "1");
            localStorage.setItem("ottplayprov", "m3u");
            localStorage.setItem("m3usPlayers", playerMode);
            localStorage.setItem(
                "m3um3uArr",
                JSON.stringify({ active: 0, M3Us: [{ www: playlist }] })
            );
            const play = HTMLMediaElement.prototype.play;
            HTMLMediaElement.prototype.play = function () {
                this.muted = true;
                this.loop = true;
                return play.call(this);
            };
        },
        {
            hideProviderSettings: !!media.hideProviderSettings,
            languageMode: media.languageMode || "",
            playerMode: media.playerMode || "1",
            playlist: origin + "/doctor-fixture/channels.m3u",
        }
    );
    const response = page.waitForResponse(
        (value) => new URL(value.url()).pathname === "/dist/player.js"
    );
    await page.goto("/f/pc/");
    const loaded = await (await response).body();
    const artifact = fs.readFileSync(path.join(dist, "player.js"));
    expect(createHash("sha256").update(loaded).digest("hex")).toBe(
        createHash("sha256").update(artifact).digest("hex")
    );
    await page.waitForFunction(
        () =>
            window.commandChannelsReady === true && !!window.__ottRemoteInspect
    );
    await page.keyboard.press("Shift");
    await page.waitForFunction(() => {
        const video = document.getElementById("video");
        return (
            video?.readyState >= 2 &&
            video.currentTime > 0.1 &&
            !video.paused &&
            window.__ottClassicPlayback.snapshot().phase === "playing"
        );
    });
    return { artifact: artifact.toString("utf8"), errors, manifest, requests };
}

// A real HTTP response stays open while Chromium consumes media. A fulfilled
// Playwright route cannot demonstrate that stop aborts an in-flight download.
async function streamingMedia(kind, background = false) {
    const lanes = {
        main: { active: 0, bytes: 0, requests: 0 },
        pip: { active: 0, bytes: 0, requests: 0 },
    };
    if (background) lanes.background = { active: 0, bytes: 0, requests: 0 };
    const responses = new Set();
    const segment = fs.readFileSync(path.join(mediaRoot, "segment00.ts"));
    const header = Buffer.alloc(44);
    // Ten minutes of synthetic 48 kHz mono PCM, delivered at playback speed.
    // This exercises the native HTML media loader without external codecs.
    const pcmSize = 48000 * 2 * 600;
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcmSize, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(48000, 24);
    header.writeUInt32LE(96000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcmSize, 40);
    const silence = Buffer.alloc(3840);
    const server = http.createServer((request, response) => {
        const pathname = new URL(request.url, "http://localhost").pathname;
        const lane = lanes[pathname.split("/")[1]];
        if (!lane) return response.writeHead(404).end();
        lane.requests++;
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Cache-Control", "no-store");
        if (pathname.endsWith(".m3u8")) {
            // Reuse the checked-in segment on distinct discontinuity periods.
            // More than a buffer's worth of data keeps requests in flight.
            const playlist =
                "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n" +
                "#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n" +
                Array.from(
                    { length: 80 },
                    (_, index) =>
                        (index ? "#EXT-X-DISCONTINUITY\n" : "") +
                        "#EXTINF:2,\nsegment" +
                        index +
                        ".ts\n"
                ).join("") +
                "#EXT-X-ENDLIST\n";
            response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
            lane.bytes += Buffer.byteLength(playlist);
            return response.end(playlist);
        }
        if (pathname.startsWith("/background/")) {
            response.setHeader("Content-Type", "text/plain");
            response.flushHeaders();
            lane.active++;
            responses.add(response);
            const timer = setInterval(() => {
                const text = "background provider data\n";
                lane.bytes += Buffer.byteLength(text);
                response.write(text);
            }, 40);
            response.on("close", () => {
                clearInterval(timer);
                responses.delete(response);
                lane.active--;
            });
            return;
        }
        const native = pathname.endsWith(".wav");
        response.setHeader("Content-Type", native ? "audio/wav" : "video/mp2t");
        if (native)
            response.setHeader("Content-Length", header.length + pcmSize);
        lane.active++;
        responses.add(response);
        function write(bytes) {
            lane.bytes += bytes.length;
            response.write(bytes);
        }
        if (native) {
            write(header);
            write(Buffer.alloc(38400));
        }
        let position = 0;
        const chunkSize = Math.ceil(segment.length / 25);
        const timer = setInterval(() => {
            if (native) write(silence);
            else {
                write(segment.subarray(position, position + chunkSize));
                position += chunkSize;
                if (position >= segment.length) response.end();
            }
        }, 40);
        response.on("close", () => {
            clearInterval(timer);
            responses.delete(response);
            lane.active--;
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + server.address().port;
    const filename = kind === "native" ? "stream.wav" : "index.m3u8";
    return {
        async close() {
            for (const response of responses) response.destroy();
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
        lanes,
        origin,
        pipUrl: origin + "/pip/" + filename,
        playerMode: kind === "native" ? "0" : "1",
        url: origin + "/main/" + filename,
    };
}

async function standbyRequest(page, operation = "standby") {
    return page.evaluate((operation) => {
        let reply;
        let effect;
        window.executeRemoteRequest(
            { action: "lifecycle", params: { operation } },
            (value) => {
                reply = value;
            },
            (callback) => {
                effect = callback;
            }
        );
        // The production dispatcher defers lifecycle changes until reply ACK.
        if (reply?.status === "ok" && effect) effect();
        return reply;
    }, operation);
}

for (const languageMode of ["manual", "system"]) {
    test(
        "standby/go resumes the configured M3U twice with " +
            languageMode +
            " language",
        async ({ page, context, baseURL }) => {
            const media = await streamingMedia("native");
            media.languageMode = languageMode;
            media.hideProviderSettings = languageMode === "system";
            try {
                const observed = await fixture(page, context, baseURL, media);
                async function selection() {
                    return page.evaluate(() => ({
                        channel:
                            window.__ottClassicPlayback.snapshot().target
                                ?.channelId,
                        language: localStorage.getItem("ottplaylang"),
                        languageMode: localStorage.getItem("ottplaylangmode"),
                        popupCount: window.popupActions.length,
                        profile: localStorage.getItem("m3um3uArr"),
                        provider: localStorage.getItem("ottplayprov"),
                        providerSettings: window.popupActions.includes(
                            window.doEditM3Ua
                        ),
                        settingsActions: window.popupActions.filter(
                            (action) => action === window.optionsList
                        ).length,
                    }));
                }
                const before = await selection();
                expect(before.channel).toBeTruthy();
                expect(before.languageMode).toBe(languageMode);
                expect(before.settingsActions).toBe(1);
                expect(before.providerSettings).toBe(
                    !media.hideProviderSettings
                );
                for (let cycle = 0; cycle < 2; cycle++) {
                    expect((await standbyRequest(page)).status).toBe("ok");
                    await expect.poll(() => media.lanes.main.active).toBe(0);
                    await page.waitForFunction(
                        () =>
                            window.__ottStandby.snapshot().state === "suspended"
                    );
                    const stoppedBytes = media.lanes.main.bytes;
                    // No page reload, direct playback, or UI key may repair this wake.
                    expect((await standbyRequest(page, "wake")).status).toBe(
                        "ok"
                    );
                    await page.waitForFunction(
                        () => {
                            const video = document.getElementById("video");
                            return (
                                !window.stbIsStandby() &&
                                window.commandChannelsReady &&
                                video?.readyState >= 2 &&
                                !video.paused &&
                                video.currentTime > 0.1
                            );
                        },
                        null,
                        { timeout: 10000 }
                    );
                    await expect
                        .poll(() => media.lanes.main.bytes)
                        .toBeGreaterThan(stoppedBytes);
                    const time = await page.evaluate(
                        () => document.getElementById("video").currentTime
                    );
                    await expect
                        .poll(() =>
                            page.evaluate(
                                () =>
                                    document.getElementById("video").currentTime
                            )
                        )
                        .toBeGreaterThan(time);
                    expect(await selection()).toEqual(before);
                    await expect(page.locator("#launch")).toBeHidden();
                    await expect(
                        page.getByText("Change interface language", {
                            exact: true,
                        })
                    ).toBeHidden();
                }
                expect(observed.errors).toEqual([]);
            } finally {
                await media.close();
            }
        }
    );
}

for (const kind of ["native", "hls"]) {
    test(
        "remote standby ends in-flight " +
            kind +
            " traffic on both media lanes",
        async ({ page, context, baseURL }) => {
            const media = await streamingMedia(kind);
            try {
                const observed = await fixture(page, context, baseURL, media);
                for (const repeat of [false, true]) {
                    if (repeat) {
                        expect(
                            (await standbyRequest(page, "wake")).status
                        ).toBe("ok");
                        await page.waitForFunction(
                            () => !window.stbIsStandby()
                        );
                    }
                    await page.evaluate(
                        ({ main, pip, repeat }) => {
                            if (repeat) window.stbPlay(main);
                            window.stbPlayPip(pip);
                        },
                        { main: media.url, pip: media.pipUrl, repeat }
                    );
                    await page.waitForFunction(() => {
                        return ["video", "videopip"].every((id) => {
                            const video = document.getElementById(id);
                            return video?.currentTime > 0.1 && !video.paused;
                        });
                    });
                    for (const lane of Object.values(media.lanes)) {
                        await expect.poll(() => lane.active).toBeGreaterThan(0);
                        const before = lane.bytes;
                        await expect
                            .poll(() => lane.bytes)
                            .toBeGreaterThan(before);
                    }
                    expect(await standbyRequest(page)).toMatchObject({
                        data: { accepted: true, operation: "standby" },
                        status: "ok",
                    });
                    // Allow the browser's already queued writes to settle; the actual
                    // server must see both transfers close, not just paused video.
                    await expect
                        .poll(
                            () =>
                                media.lanes.main.active +
                                media.lanes.pip.active,
                            { timeout: 2000 }
                        )
                        .toBe(0);
                    const stopped = JSON.parse(JSON.stringify(media.lanes));
                    await page.evaluate(
                        ({ main, pip }) => {
                            // Neither a late retry nor direct playback may leave standby.
                            window.stbPlay(main);
                            window.stbPlayPip(pip);
                        },
                        { main: media.url, pip: media.pipUrl }
                    );
                    await page.waitForTimeout(1200);
                    expect(media.lanes).toEqual(stopped);
                    const state = await page.evaluate(() => ({
                        media: ["video", "videopip"].map((id) => {
                            const video = document.getElementById(id);
                            return {
                                networkState: video.networkState,
                                paused: video.paused,
                                readyState: video.readyState,
                                source: video.getAttribute("src"),
                            };
                        }),
                        standby: window.stbIsStandby(),
                    }));
                    expect(state).toEqual({
                        media: [0, 1].map(() => ({
                            networkState: 0,
                            paused: true,
                            readyState: 0,
                            source: null,
                        })),
                        standby: true,
                    });
                }
                expect(observed.errors).toEqual([]);
            } finally {
                await media.close();
            }
        }
    );
}

test("standby drains background HTTP, survives reload and wakes a strict kiosk", async ({
    page,
    context,
    baseURL,
}) => {
    test.setTimeout(90000);
    const media = await streamingMedia("native", true);
    const control = { pending: [], polls: 0, replies: [], sequence: 0 };
    media.control = control;
    async function rpc(action, params) {
        const count = control.replies.length;
        control.pending.push({ action, params });
        await expect
            .poll(() => control.replies.length, { timeout: 15000 })
            .toBe(count + 1);
        return control.replies[count];
    }
    try {
        const observed = await fixture(page, context, baseURL, media);
        await page.evaluate(() =>
            window.__ottCommandServer.configure({
                address: location.origin + "/standby-control",
                enabled: true,
                token: "STANDBY_FIXTURE_COMMAND_TOKEN_0123456789abcdef",
            })
        );
        const lock = await rpc("kiosk", {
            mode: "on",
            query: "1",
            strict: true,
        });
        expect(lock.data.state).toBe("locked");
        expect(lock.data.channel).not.toBeNull();
        expect(lock.status).toBe("ok");
        await page.evaluate((origin) => {
            window.backgroundResults = [];
            window
                .fetch(origin + "/background/fetch")
                .then((r) => r.text())
                .then(
                    () => window.backgroundResults.push("fetch-success"),
                    () => window.backgroundResults.push("fetch-stopped")
                );
            window.$.ajax({
                dataType: "text",
                url: origin + "/background/jquery",
            }).then(
                () => window.backgroundResults.push("jquery-success"),
                () => window.backgroundResults.push("jquery-stopped")
            );
        }, media.origin);
        await expect.poll(() => media.lanes.background.active).toBe(2);
        expect((await rpc("lifecycle", { operation: "standby" })).status).toBe(
            "ok"
        );
        await expect
            .poll(() =>
                Object.values(media.lanes).reduce(
                    (n, lane) => n + lane.active,
                    0
                )
            )
            .toBe(0);
        await page.waitForFunction(() => window.backgroundResults.length === 2);
        expect(
            await page.evaluate(() => window.backgroundResults.sort())
        ).toEqual(["fetch-stopped", "jquery-stopped"]);
        const stopped = JSON.parse(JSON.stringify(media.lanes));
        const status = await rpc("status", {});
        expect(status).toMatchObject({
            data: {
                player: {
                    background: { pending: 0, state: "suspended" },
                    standby: true,
                },
            },
            status: "ok",
        });
        // Longer than kiosk's 10s retry interval: no invisible watchdog restart.
        await page.waitForTimeout(11000);
        expect(media.lanes).toEqual(stopped);
        await page.reload();
        await page.waitForFunction(
            () =>
                window.stbIsStandby &&
                window.stbIsStandby() &&
                window.executeRemoteRequest
        );
        await page.waitForTimeout(1200);
        expect(media.lanes).toEqual(stopped);
        expect((await rpc("lifecycle", { operation: "wake" })).status).toBe(
            "ok"
        );
        await page
            .waitForFunction(
                () => {
                    const video = document.getElementById("video");
                    return (
                        !window.stbIsStandby() &&
                        video &&
                        video.currentTime > 0.1 &&
                        !video.paused
                    );
                },
                null,
                { timeout: 15000 }
            )
            .catch(async (error) => {
                console.log(
                    "WAKE_DIAGNOSTIC",
                    await page.evaluate(() => ({
                        body: document.body.innerText.slice(0, 500),
                        kiosk: window.__ottKiosk?.snapshot(),
                        launch: document.getElementById("launch")?.textContent,
                        playback: window.__ottClassicPlayback?.snapshot(),
                        ready: window.commandChannelsReady,
                        standby: window.__ottStandby?.snapshot(),
                        video: Array.from(
                            document.querySelectorAll("video")
                        ).map((v) => ({
                            error: v.error?.message,
                            id: v.id,
                            paused: v.paused,
                            ready: v.readyState,
                            src: v.currentSrc,
                            time: v.currentTime,
                        })),
                    }))
                );
                console.log(
                    "WAKE_REQUESTS",
                    observed.requests,
                    "ERRORS",
                    observed.errors
                );
                throw error;
            });
        expect(
            await page.evaluate(() => window.__ottKiosk.snapshot().strict)
        ).toBe(true);
        await expect
            .poll(() => media.lanes.main.bytes)
            .toBeGreaterThan(stopped.main.bytes);
        expect(observed.errors).toEqual([]);
    } finally {
        await media.close();
    }
});

async function caps(page) {
    return page.evaluate(
        () =>
            new Promise((resolve) =>
                window.executeRemoteRequest(
                    { action: "capabilities", params: {} },
                    resolve
                )
            )
    );
}

async function inspect(page, runtime, section = "doctor", extra = {}) {
    return page.evaluate(
        ({ runtime, section, extra }) => {
            const effects = [];
            const restores = [];
            function block(owner, key) {
                if (!owner || typeof owner[key] !== "function") return;
                const original = owner[key];
                owner[key] = function () {
                    effects.push(key);
                    throw new Error("Unexpected inspection effect: " + key);
                };
                restores.push(() => {
                    owner[key] = original;
                });
            }
            const video = document.getElementById("video");
            const before = {
                generation: window.__ottClassicPlayback.snapshot().generation,
                paused: video.paused,
                src: video.currentSrc,
            };
            block(window, "fetch");
            block(window, "__ottCoreBackend");
            block(window, "restart");
            block(window.XMLHttpRequest?.prototype, "open");
            block(window.HTMLMediaElement?.prototype, "play");
            block(window.HTMLMediaElement?.prototype, "pause");
            block(window.navigator.mediaDevices, "getDisplayMedia");
            block(window.__ottRemoteScreenshot, "capture");
            block(window.__ottRemoteScreenshot, "selectSource");
            let result;
            try {
                window.executeRemoteRequest(
                    {
                        action: "inspect",
                        params: { runtime, section, version: 1, ...extra },
                    },
                    (value) => {
                        result = value;
                    }
                );
                if (!result)
                    throw new Error("inspect must complete synchronously");
            } finally {
                restores.reverse().forEach((restore) => restore());
            }
            return {
                effects,
                result,
                unchanged:
                    before.generation ===
                        window.__ottClassicPlayback.snapshot().generation &&
                    before.src === video.currentSrc &&
                    before.paused === video.paused,
            };
        },
        { extra, runtime, section }
    );
}

test("doctor observes real CSS, owned dialogs and media without causing effects", async ({
    page,
    context,
    baseURL,
}) => {
    const observed = await fixture(page, context, baseURL);
    const initial = await caps(page);
    const runtime = initial.data.player.runtime;
    expect(initial.data.inspect).toEqual({
        sections: ["doctor", "snapshot", "operation"],
        version: 1,
    });
    await page.evaluate(() => {
        document.getElementById("video").style.cssText =
            "position:fixed;display:block;left:70px;top:40px;width:420px;height:236px;opacity:1;visibility:visible";
    });
    let reply = await inspect(page, runtime);
    expect(reply.effects).toEqual([]);
    expect(reply.unchanged).toBe(true);
    expect(reply.result.status).toBe("ok");
    const baseline = reply.result.data.data;
    expect(baseline.consistent).toBe(true);
    expect(baseline.media.generation).toBeGreaterThan(0);
    expect(baseline.media.kind).toBe("live");
    expect(baseline.media.displayEvidence).toBe("unavailable");
    expect(baseline.media.lanes[0]).toMatchObject({
        lane: "main",
        phase: "playing",
        video: {
            cssVisible: true,
            ended: false,
            exists: true,
            paused: false,
            rect: { height: 236, width: 420, x: 70, y: 40 },
        },
    });
    expect(baseline.media.lanes[0].video.videoWidth).toBeGreaterThan(0);
    expect(baseline.media.lanes[0].handleId).toBeGreaterThan(0);

    await page.evaluate((secret) => {
        window.confirmBox(
            secret,
            () => {},
            () => {}
        );
        const dialog = document.getElementById("dialogbox");
        const input = document.createElement("input");
        input.type = "password";
        input.value = secret;
        dialog.appendChild(input);
        input.focus();
    }, SECRET);
    await expect(page.locator("#dialogbox")).toBeVisible();
    reply = await inspect(page, runtime);
    expect(reply.effects).toEqual([]);
    expect(reply.unchanged).toBe(true);
    const dialog = reply.result.data.data;
    expect(dialog.ui.owner.kind).toBe("dialog");
    expect(dialog.ui.focus).toBe("dialog");
    expect(
        dialog.ui.panes.find((pane) => pane.kind === "dialog").cssVisible
    ).toBe(true);
    expect(dialog.reasons).toContain("owned_overlay_open");
    expect(dialog.media.lanes[0].video.cssVisible).toBe(true);
    expect(dialog.reasons).not.toContain("video_css_hidden");
    expect(JSON.stringify(dialog)).not.toContain(SECRET);
    expect(JSON.stringify(dialog)).not.toContain("channels.m3u");
    expect(JSON.stringify(dialog)).not.toContain("healthy");
    expect(
        Buffer.byteLength(JSON.stringify(dialog), "utf8")
    ).toBeLessThanOrEqual(8192);

    await page.evaluate(() => {
        document.getElementById("video").parentElement.style.display = "none";
    });
    reply = await inspect(page, runtime, "snapshot");
    expect(reply.effects).toEqual([]);
    expect(reply.unchanged).toBe(true);
    expect(reply.result.data.data.media.lanes[0].video.cssVisible).toBe(false);
    expect(reply.result.data.data.reasons).toContain("video_css_hidden");
    expect(reply.result.data.data.reasons).toContain("video_zero_rect");
    expect(reply.result.data.data.media.displayEvidence).toBe("unavailable");
    await page.evaluate(() => {
        document.getElementById("video").parentElement.style.display = "block";
        window.dialogBoxKeyHandler(window.keys.RETURN);
        window.showSelectBox(0, ["Doctor one", "Doctor two"], () => {}, -1);
    });
    await expect(page.locator("#numprog")).toBeVisible();
    reply = await inspect(page, runtime);
    expect(reply.result.data.data.ui.owner.kind).toBe("picker");
    expect(
        reply.result.data.data.ui.panes.find((pane) => pane.kind === "picker")
            .cssVisible
    ).toBe(true);
    expect(reply.effects).toEqual([]);
    expect(reply.unchanged).toBe(true);
    expect(observed.errors).toEqual([]);
});

test("inspection identifies the loaded artifact and rejects an old runtime after reload", async ({
    page,
    context,
    baseURL,
}) => {
    const observed = await fixture(page, context, baseURL);
    const runtime = (await caps(page)).data.player.runtime;
    const first = await inspect(page, runtime);
    expect(first.result.status).toBe("ok");
    const snapshot = first.result.data.data;
    expect(first.result.data).toMatchObject({
        runtime,
        section: "doctor",
        version: 1,
    });
    expect(snapshot.runtime).toBe(runtime);
    expect(snapshot.build.buildId).toMatch(/^bundle-[a-f0-9]{64}$/);
    expect(observed.artifact).toContain(snapshot.build.buildId);
    expect(snapshot.build.version).not.toContain("__OTTP_");
    expect(snapshot.build.version).not.toBe(observed.manifest.version);
    expect(snapshot.build.buildId).not.toBe(observed.manifest.buildId);
    expect(
        observed.requests.some((url) => url.endsWith("/build-info.json"))
    ).toBe(false);
    const unknown = await inspect(page, runtime, "operation", {
        operation_id: "1".repeat(32),
    });
    expect(unknown.result.status).toBe("ok");
    expect(unknown.result.data.data).toMatchObject({
        action: null,
        operation_id: "1".repeat(32),
        state: "unknown",
    });
    expect(unknown.effects).toEqual([]);
    await page.reload();
    await page.waitForFunction(
        () => !!window.__ottRemoteInspect && !!document.getElementById("video")
    );
    const nextRuntime = (await caps(page)).data.player.runtime;
    expect(nextRuntime).not.toBe(runtime);
    const stale = await inspect(page, runtime);
    expect(stale.result).toEqual({
        data: {
            error: "runtime_mismatch",
            runtime: nextRuntime,
            section: "doctor",
            version: 1,
        },
        status: "rejected",
    });
    const fresh = await inspect(page, nextRuntime, "snapshot");
    expect(fresh.result.status).toBe("ok");
    expect(fresh.result.data.data.build).toEqual(snapshot.build);
    expect(fresh.effects).toEqual([]);
    expect(
        observed.requests.some((url) => url.endsWith("/build-info.json"))
    ).toBe(false);
    expect(observed.errors).toEqual([]);
});

test("runtime debug captures real frame counters and lifecycle without changing playback", async ({
    page,
    context,
    baseURL,
}) => {
    await fixture(page, context, baseURL);
    await context.route("**/runtime-debug-control/**", (route) =>
        route.fulfill({ json: { error: "fixture" }, status: 403 })
    );
    const initial = await caps(page);
    expect(initial.data.debug).toEqual({ version: 1 });
    expect(initial.data.inspect.sections).toEqual([
        "doctor",
        "snapshot",
        "operation",
    ]);
    await page.evaluate((address) => {
        window.__ottCommandServer.configure({
            address,
            enabled: true,
            token: "c".repeat(32),
        });
        window.dispatchEvent(
            new ErrorEvent("error", {
                filename: "https://private.invalid/token",
                message: "PRIVATE-DEBUG-MESSAGE",
            })
        );
    }, new URL("/runtime-debug-control/", baseURL).href);
    await expect
        .poll(() =>
            page.evaluate(
                async () =>
                    (await window.__ottRuntimeDebug.snapshot()).metrics
                        .loopSamples
            )
        )
        .toBeGreaterThan(0);
    const before = await page.evaluate(() => ({
        generation: window.__ottClassicPlayback.snapshot().generation,
        source: document.getElementById("video").currentSrc,
    }));
    const reply = await page.evaluate(
        (runtime) =>
            new Promise((resolve) => {
                window.executeRemoteRequest(
                    {
                        action: "inspect",
                        params: { runtime, section: "debug", version: 1 },
                    },
                    resolve
                );
            }),
        initial.data.player.runtime
    );
    expect(reply.status).toBe("ok");
    const data = reply.data.data;
    expect(data.native).toEqual({ data: null, state: "unsupported" });
    expect(data.metrics.errorCount).toBe(1);
    expect(data.events.some((event) => event.code === "error")).toBe(true);
    expect(data.media[0].metrics.totalFrames).toBeGreaterThan(0);
    expect(data.media[0].generation).toBe(before.generation);
    expect(data.metrics.controlConsecutiveFailures).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(data)).not.toContain("PRIVATE-DEBUG-MESSAGE");
    expect(JSON.stringify(data)).not.toContain("private.invalid");
    expect(JSON.stringify(data)).not.toContain(SECRET);
    const after = await page.evaluate(() => ({
        generation: window.__ottClassicPlayback.snapshot().generation,
        source: document.getElementById("video").currentSrc,
    }));
    expect(after).toEqual(before);
    const disconnected = await page.evaluate(async () => {
        window.__ottCommandServer.configure({
            address: "",
            enabled: false,
            token: "",
        });
        try {
            await window.__ottRuntimeDebug.snapshot();
            return false;
        } catch {
            return true;
        }
    });
    expect(disconnected).toBe(true);
});

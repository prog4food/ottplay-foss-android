#!/usr/bin/env node
// Opt-in real playback probe. Output contains measurements, never titles or URLs.
const assert = require("node:assert/strict");
const { parseArgs } = require("node:util");
const { chromium } = require("@playwright/test");

async function main() {
    const { values } = parseArgs({
        options: {
            "allow-self-signed": { default: false, type: "boolean" },
            "base-url": { default: "http://127.0.0.1:8443", type: "string" },
            entry: { default: "/f/pc/", type: "string" },
            help: { short: "h", type: "boolean" },
            "pause-seconds": { default: "0", type: "string" },
        },
    });
    if (values.help) {
        console.log(
            "Usage: node scripts/nas-live-browser.cjs [--base-url http://PLAYER:8443] [--entry /f/pc/|/f/pc2/] [--pause-seconds 210] [--allow-self-signed]\n" +
                "Plays the first available video, seeks to 60 seconds, then stops it. Requires an installed Chromium via Playwright."
        );
        return;
    }
    const base = new URL(values["base-url"]);
    assert(
        ["http:", "https:"].includes(base.protocol) &&
            !base.username &&
            !base.password &&
            base.pathname === "/" &&
            !base.search &&
            !base.hash,
        "Expected a plain HTTP(S) origin"
    );
    assert(["/f/pc/", "/f/pc2/"].includes(values.entry), "Invalid entry");
    const pauseSeconds = Number(values["pause-seconds"]);
    assert(
        Number.isInteger(pauseSeconds) &&
            pauseSeconds >= 0 &&
            pauseSeconds <= 600,
        "Invalid pause length"
    );
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        ignoreHTTPSErrors: values["allow-self-signed"],
        serviceWorkers: "block",
        viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    const stops = new Set();
    const heartbeats = new Set();
    let successfulHeartbeats = 0;
    const errors = [];
    const mediaStatus = [];
    const measurements = {};
    let phase = "boot";
    page.on("pageerror", () => errors.push(true));
    page.on("response", async (response) => {
        const url = new URL(response.url());
        if (url.pathname.startsWith("/nas/stream/")) {
            mediaStatus.push({
                image: response.request().resourceType() === "image",
                status: response.status(),
            });
            if (heartbeats.has(response.url()) && response.ok())
                successfulHeartbeats++;
        }
        if (url.pathname === "/nas/api") {
            try {
                const data = await response.json();
                if (typeof data.stop === "string") {
                    const stop = new URL(data.stop, base);
                    if (
                        stop.origin === base.origin &&
                        stop.pathname.startsWith("/nas/stream/")
                    ) {
                        stops.add(stop.href);
                    }
                }
                if (typeof data.heartbeat === "string") {
                    const heartbeat = new URL(data.heartbeat, base);
                    if (
                        heartbeat.origin === base.origin &&
                        heartbeat.pathname.startsWith("/nas/stream/")
                    ) {
                        heartbeats.add(heartbeat.href);
                    }
                }
            } catch (_) {
                /* An aborted request has no JSON body. */
            }
        }
    });
    try {
        await context.route("**/*", (route) =>
            new URL(route.request().url()).origin === base.origin
                ? route.continue()
                : route.abort()
        );
        await context.routeWebSocket("**/*", (socket) => socket.close());
        await context.addInitScript(() => {
            localStorage.setItem("ottplaylang", "_eng");
            localStorage.setItem("ottplayprov", "demo");
        });
        let started = performance.now();
        await page.goto(base.origin + values.entry);
        await page.waitForFunction(
            () =>
                window.__ottDevice &&
                window.__ottNasLibrary?.available() &&
                !document.body.classList.contains("booting")
        );
        measurements.bootMs = Math.round(performance.now() - started);
        phase = "catalog";
        started = performance.now();
        await page.evaluate(() => {
            window.stbStop();
            window.__beforeNasProvider = [
                window.getMediaArray,
                window.playMedia,
                window.providerGetItem,
                window.providerSetItem,
            ];
            window.sFavorites = 1;
            window.popNasMedia();
        });
        await page.waitForFunction(
            () =>
                !window.__ottMedia.snapshot().loading &&
                window.__ottMedia.snapshot().frame?.items.length > 0
        );
        measurements.rootMs = Math.round(performance.now() - started);
        let played = false;
        for (let depth = 0; depth < 6; depth++) {
            started = performance.now();
            const next = await page.evaluate(() => {
                const items = window.__ottMedia.snapshot().frame.items;
                const video = items.findIndex(
                    (item) => item.payload.request?.cmd === "play"
                );
                const folder = items.findIndex(
                    (item) =>
                        item.payload.playlist_url?.request?.cmd === "browse"
                );
                if (video >= 0) {
                    window.__ottMedia.select(video);
                    return "play";
                }
                if (folder >= 0) {
                    window.__ottMedia.select(folder);
                    return "browse";
                }
                return "none";
            });
            if (next === "play") {
                played = true;
                break;
            }
            assert.equal(next, "browse");
            await page.waitForFunction(
                () => !window.__ottMedia.snapshot().loading
            );
        }
        assert(played);
        phase = "decode";
        await page.waitForFunction(
            () =>
                Array.from(document.querySelectorAll("video")).some(
                    (video) =>
                        video.currentTime > 1 &&
                        video.videoWidth > 0 &&
                        !video.error
                ),
            null,
            { timeout: 60000 }
        );
        measurements.playMs = Math.round(performance.now() - started);
        if (pauseSeconds) {
            phase = "pause";
            const pausedAt = await page.evaluate(() => {
                const video = Array.from(
                    document.querySelectorAll("video")
                ).find((item) => item.currentTime > 0 && item.videoWidth > 0);
                window.stbPause();
                return video.currentTime;
            });
            console.log(
                JSON.stringify({ phase: "paused", seconds: pauseSeconds })
            );
            await page.waitForTimeout(pauseSeconds * 1000);
            if (pauseSeconds >= 60) assert(successfulHeartbeats > 0);
            await page.evaluate(async (position) => {
                const video = Array.from(
                    document.querySelectorAll("video")
                ).find((item) => item.currentTime > 0 && item.videoWidth > 0);
                if (
                    !video.paused ||
                    Math.abs(video.currentTime - position) > 0.5
                )
                    throw new Error("Pause position changed");
                window.stbContinue();
            }, pausedAt);
            await page.waitForFunction(
                (position) =>
                    Array.from(document.querySelectorAll("video")).some(
                        (video) =>
                            video.currentTime > position + 0.5 && !video.error
                    ),
                pausedAt,
                { timeout: 30000 }
            );
            measurements.pausedSeconds = pauseSeconds;
        }
        phase = "seek";
        started = performance.now();
        const seekable = await page.evaluate(() => {
            const video = Array.from(document.querySelectorAll("video")).find(
                (item) =>
                    item.currentTime > 0 &&
                    item.duration > 120 &&
                    item.videoWidth > 0
            );
            if (!video) return false;
            video.currentTime = 60;
            return true;
        });
        assert(seekable);
        await page.waitForFunction(
            () =>
                Array.from(document.querySelectorAll("video")).some(
                    (video) =>
                        video.currentTime > 60.2 &&
                        !video.seeking &&
                        !video.error
                ),
            null,
            { timeout: 45000 }
        );
        measurements.seekMs = Math.round(performance.now() - started);
        const state = await page.evaluate(() => ({
            providerUnchanged: window.__beforeNasProvider.every(
                (value, index) =>
                    value ===
                    [
                        window.getMediaArray,
                        window.playMedia,
                        window.providerGetItem,
                        window.providerSetItem,
                    ][index]
            ),
            video: Array.from(document.querySelectorAll("video"))
                .filter((video) => video.currentTime > 0)
                .map((video) => ({
                    frames: video.getVideoPlaybackQuality().totalVideoFrames,
                    height: video.videoHeight,
                    seconds: Math.floor(video.currentTime),
                    width: video.videoWidth,
                })),
        }));
        assert(state.providerUnchanged);
        assert(state.video.some((video) => video.frames > 0));
        assert.equal(errors.length, 0);
        assert(
            !mediaStatus.some(
                (response) => response.status >= 400 && !response.image
            )
        );
        phase = "stop";
        assert(stops.size > 0);
        const stopped = page.waitForResponse(
            (response) => stops.has(response.url()),
            { timeout: 10000 }
        );
        await page.evaluate(() => window.stbStop());
        const stopStatus = (await stopped).status();
        assert(stopStatus >= 200 && stopStatus < 300);
        console.log(
            JSON.stringify({
                ok: true,
                ...measurements,
                ...state,
                artworkFailures: mediaStatus.filter(
                    (response) => response.status >= 400 && response.image
                ).length,
                mediaResponses: mediaStatus.length,
                pageErrors: errors.length,
                playbackFailures: mediaStatus.filter(
                    (response) => response.status >= 400 && !response.image
                ).length,
                stopStatus,
                successfulHeartbeats,
            })
        );
    } catch (_) {
        console.log(
            JSON.stringify({
                ok: false,
                phase,
                ...measurements,
                pageErrors: errors.length,
            })
        );
        process.exitCode = 1;
    } finally {
        await page.evaluate(() => window.stbStop()).catch(() => {});
        // A failed assertion must still release every observed conversion session.
        await Promise.allSettled(
            Array.from(stops, (url) =>
                context.request.get(url, { timeout: 10000 })
            )
        );
        await browser.close();
    }
}

main().catch(() => {
    console.error(
        "Browser probe could not start; check arguments and Playwright installation (--help)."
    );
    process.exitCode = 1;
});

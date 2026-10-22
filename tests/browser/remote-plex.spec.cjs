// Shipped bundles, authenticated controller delivery and real Chromium HLS EOS.
// All provider/controller traffic is synthetic and external traffic is blocked.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

const PLEX = "https://plex-queue.fixture.invalid";
const PLAYLIST = "https://playlist-queue.fixture.invalid/channels.m3u";
const TOKEN = "synthetic-plex-queue-token";
const DEVICE_TOKEN = "synthetic_controller_" + "d".repeat(32);
const mediaRoot = path.resolve(__dirname, "../fixtures/media-runtime");
test.use({
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

test("remote Plex loads lazily, ends its exact queue and restores a current favorite after reload", async ({
    page,
    context,
    baseURL,
}) => {
    test.setTimeout(90000);
    const local = new URL(baseURL).origin;
    const errors = [];
    const bundles = [];
    const streams = [];
    const metadataRequests = [];
    const pending = [];
    const results = new Map();
    let sequence = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    const item = (id) => ({
        Media: [
            {
                audioCodec: "mp3",
                container: "avi",
                Part: [{ key: "/library/parts/" + id + "/file.avi" }],
                videoCodec: "mpeg4",
            },
        ],
        ratingKey: id,
        title: "Synthetic film " + id,
        type: "movie",
    });
    await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (
            url.origin === local &&
            url.pathname.startsWith("/queue-controller/")
        ) {
            expect(request.headers().authorization).toBe(
                "Bearer " + DEVICE_TOKEN
            );
            if (url.pathname.endsWith("/api/responses")) {
                const result = request.postDataJSON();
                results.set(result.id, result);
                return route.fulfill({ json: { status: "ok" } });
            }
            if (url.pathname.endsWith("/api/webhook/commands")) {
                const now = Date.now() / 1000;
                const next = pending.shift();
                return route.fulfill({
                    json: {
                        commands: [],
                        requests: next
                            ? [{ ...next, expires_at: now + 40 }]
                            : [],
                        server_time: now,
                    },
                });
            }
            return route.fulfill({ json: {}, status: 404 });
        }
        if (request.url() === PLAYLIST)
            return route.fulfill({
                body: '#EXTM3U\n#EXTINF:-1 group-title="TV fixture",Fixture channel\nhttps://tv-queue.fixture.invalid/index.m3u8\n',
                contentType: "text/plain",
                headers: { "Access-Control-Allow-Origin": "*" },
            });
        if (url.origin === PLEX) {
            const headers = { "Access-Control-Allow-Origin": "*" };
            const json = (body) =>
                route.fulfill({ headers, json: { MediaContainer: body } });
            if (url.pathname === "/library/sections")
                return json({
                    Directory: [
                        { key: "1", title: "Synthetic films", type: "movie" },
                    ],
                });
            if (url.pathname.startsWith("/library/metadata/")) {
                metadataRequests.push(url.pathname);
                expect(url.searchParams.get("X-Plex-Token")).toBe(TOKEN);
                // Plex response order is deliberately different from requested order.
                return json({
                    Metadata: url.pathname
                        .split("/")
                        .pop()
                        .split(",")
                        .reverse()
                        .map(item),
                });
            }
            if (url.pathname.endsWith("/decision"))
                return json({
                    generalDecisionCode: 1001,
                    Metadata: [
                        { Media: [{ Part: [{ decision: "transcode" }] }] },
                    ],
                });
            if (url.pathname.endsWith("/start.m3u8")) {
                streams.push(url.searchParams.get("path"));
                return route.fulfill({
                    body: fs.readFileSync(path.join(mediaRoot, "index.m3u8")),
                    contentType: "application/vnd.apple.mpegurl",
                    headers,
                });
            }
            if (url.pathname.endsWith(".ts"))
                return route.fulfill({
                    body: fs.readFileSync(path.join(mediaRoot, "segment00.ts")),
                    contentType: "video/mp2t",
                    headers,
                });
            if (
                url.pathname.endsWith("/stop") ||
                url.pathname.endsWith("/ping")
            )
                return route.fulfill({ body: "", headers });
            return route.fulfill({
                body: "Unknown synthetic Plex route",
                headers,
                status: 404,
            });
        }
        if (url.origin === local) {
            if (/\/dist\/provider-.*\.js$/.test(url.pathname))
                bundles.push(url.pathname);
            return route.continue();
        }
        return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(
        ({ plex, playlist, token }) => {
            const play = HTMLMediaElement.prototype.play;
            HTMLMediaElement.prototype.play = function () {
                this.muted = true;
                return play.call(this);
            };
            localStorage.setItem("ottplaylang", "_eng");
            localStorage.setItem("ottplayprov", "m3u");
            localStorage.setItem(
                "m3um3uArr",
                JSON.stringify({ active: 0, M3Us: [{ www: playlist }] })
            );
            localStorage.setItem(
                "plexcfg",
                JSON.stringify({ address: plex, playback: "compatible", token })
            );
            window.__queueEnded = [];
            document.addEventListener(
                "ended",
                (event) => {
                    const media = window.__ottMedia?.current();
                    if (media?.sequence?.explicit)
                        window.__queueEnded.push({
                            index: media.sequence.index,
                            trusted: event.isTrusted,
                        });
                },
                true
            );
        },
        { playlist: PLAYLIST, plex: PLEX, token: TOKEN }
    );
    await page.goto("/f/pc/");
    await page.waitForFunction(
        () =>
            window.commandChannelsReady === true &&
            window.__ottActiveProviderDriver?.id === "m3u"
    );
    await page.keyboard.press("Shift");
    await page.evaluate((token) => {
        window.stbStop();
        window.__queueOriginalProvider = window.__ottActiveProviderDriver;
        window.__ottCommandServer.configure({
            address: location.origin + "/queue-controller",
            enabled: true,
            token,
        });
    }, DEVICE_TOKEN);
    const settings = () =>
        page.evaluate(() =>
            Object.fromEntries(
                ["ottplayprov", "m3um3uArr", "plexcfg"].map((key) => [
                    key,
                    localStorage.getItem(key),
                ])
            )
        );
    const before = await settings();
    async function rpc(action, params = {}) {
        const id = String(++sequence).padStart(32, "0");
        pending.push({ action, id, params });
        await expect.poll(() => results.has(id)).toBe(true);
        return results.get(id);
    }
    const caps = await rpc("capabilities");
    expect(caps.status).toBe("ok");
    expect(caps.data.plex_queue.operations).toContain("preview");
    expect(bundles).toEqual(["/dist/provider-m3u.js"]);
    let runtime = caps.data.player.runtime;
    const ids = ["33", "11", "22"];
    const preview = await rpc("plex_queue", { ids, op: "preview", runtime });
    expect(preview.status).toBe("ok");
    expect(preview.data).toMatchObject({
        ids,
        order: "listed",
        state: "ready",
        titles: ids.map((id) => "Synthetic film " + id),
    });
    expect(bundles).toEqual([
        "/dist/provider-m3u.js",
        "/dist/provider-plex.js",
    ]);
    expect(streams).toEqual([]);
    expect(await settings()).toEqual(before);
    await page.evaluate(() =>
        window._channelsList(window.catsArray.indexOf("TV fixture"), 0)
    );
    await expect(page.locator("#list_window")).toBeVisible();
    await page.evaluate(() => {
        // A previously previewed TV channel must not be restored by closeList.
        // Keep the standard parental defaults: no PIN bypass is needed for films.
        window.sPreview = 1;
        window.sStopPlay = 1;
        window.previewChan = { c: 0, ch_id: "stale-tv-preview", i: 0 };
        window.__stalePreviewFired = false;
        window.__stalePreviewScheduledAt = Date.now();
        window.previewTimer = setTimeout(() => {
            window.__stalePreviewFired = true;
        }, 5000);
    });
    const play = await rpc("plex_queue", { ids, op: "play", runtime });
    expect(play.status).toBe("ok");
    await expect(page.locator("#list_window")).toBeHidden();
    await expect
        .poll(() => page.evaluate(() => window.__queueEnded), {
            timeout: 20000,
        })
        .toEqual([
            { index: 0, trusted: true },
            { index: 1, trusted: true },
            { index: 2, trusted: true },
        ]);
    const final = await rpc("plex_queue", { op: "status", runtime });
    expect(final.data).toMatchObject({
        active: true,
        ids,
        index: 2,
        order: "listed",
        repeat: "none",
        state: "ended",
    });
    expect(streams).toEqual(ids.map((id) => "/library/metadata/" + id));
    await page.waitForFunction(
        () => Date.now() - window.__stalePreviewScheduledAt >= 5100
    );
    expect(await page.evaluate(() => window.previewChan)).toBeNull();
    expect(await page.evaluate(() => window.__stalePreviewFired)).toBe(false);
    expect((await rpc("playback", { operation: "next_channel" })).status).toBe(
        "rejected"
    );
    expect(streams).toHaveLength(3);
    expect(await settings()).toEqual(before);
    expect(
        await page.evaluate(
            () =>
                window.__ottActiveProviderDriver ===
                    window.__queueOriginalProvider && window.p_pref === "m3u"
        )
    ).toBe(true);
    expect(
        (await rpc("plex_queue", { op: "stop", runtime })).data
    ).toMatchObject({ active: false, state: "idle" });
    // Keep the short fixture playing while polling add/list across a reload.
    await page.evaluate(() => {
        document.querySelector("video").loop = true;
    });
    expect(
        (await rpc("plex_queue", { ids: ["33"], op: "play", runtime })).status
    ).toBe("ok");
    const saved = await rpc("favorites", {
        name: "Saved Plex film",
        op: "add",
        runtime,
    });
    expect(saved.status).toBe("ok");
    expect(saved.data.entry).toMatchObject({
        kind: "vod",
        profile_number: 1,
        provider: "m3u",
        title: "Synthetic film 33",
    });
    await page.reload();
    await page.waitForFunction(() => window.commandChannelsReady === true);
    const restartedCaps = await rpc("capabilities");
    expect(restartedCaps.data.player.runtime).not.toBe(runtime);
    runtime = restartedCaps.data.player.runtime;
    const favorites = await rpc("favorites", { op: "list", runtime });
    expect(favorites.data.entries).toEqual([saved.data.entry]);
    const requestsBeforeReplay = metadataRequests.length;
    const streamsBeforeReplay = streams.length;
    const replay = await rpc("favorites", {
        id: saved.data.entry.id,
        op: "play",
        runtime,
    });
    expect(replay.status).toBe("ok");
    expect(replay.data.dispatched).toBe(true);
    await expect
        .poll(() => streams.length)
        .toBeGreaterThan(streamsBeforeReplay);
    expect(streams.at(-1)).toBe("/library/metadata/33");
    expect(metadataRequests.length).toBeGreaterThan(requestsBeforeReplay);
    expect(metadataRequests.at(-1)).toBe("/library/metadata/33");
    expect(await settings()).toEqual(before);
    expect(errors).toEqual([]);
    await page.evaluate(() =>
        window.__ottCommandServer.configure({ enabled: false })
    );
});

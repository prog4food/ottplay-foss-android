// Boot the shipped player and exercise its real HTML media events. All media
// requests use the checked-in HLS fixture; no provider account or TV is implied.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

const mediaRoot = path.resolve(__dirname, "../fixtures/media-runtime");

test("corrupt settings journal offers explicit recovery before provider hydration", async ({
    page,
    context,
    baseURL,
}) => {
    const origin = new URL(baseURL).origin;
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
            ? route.continue()
            : route.abort("blockedbyclient")
    );
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(() => {
        if (sessionStorage.getItem("recoveryFixture")) {
            // Observe the reload before ordinary first-run defaults are saved.
            window.__recoveryAfterReset = {
                cookie: document.cookie,
                journal: localStorage.getItem("ottplaySettingsJournalV1"),
                setting: localStorage.getItem("recoveryFixtureSetting"),
            };
            return;
        }
        sessionStorage.setItem("recoveryFixture", "1");
        localStorage.setItem("ottplaylang", "_eng");
        localStorage.setItem("ottplayprov", "demo");
        localStorage.setItem("recoveryFixtureSetting", "partial-private-value");
        localStorage.setItem("recoveryFixtureCookie", "recorded-cookie-key");
        localStorage.setItem(
            "ottplaySettingsJournalV1",
            "{malformed-private-journal"
        );
        document.cookie = "recoveryFixtureCookie=stale; path=/";
    });
    await page.goto("/f/pc/");
    const dialog = page.getByRole("alertdialog", {
        name: "Player could not start",
    });
    await expect(dialog).toBeVisible();
    await expect(
        dialog.getByRole("button", { exact: true, name: "Retry" })
    ).toBeFocused();
    await expect(dialog).not.toContainText("private");
    await page.screenshot({
        path: test.info().outputPath("settings-recovery.png"),
    });
    const original = await page.evaluate(() => ({
        cookie: document.cookie,
        journal: localStorage.getItem("ottplaySettingsJournalV1"),
        setting: localStorage.getItem("recoveryFixtureSetting"),
    }));
    expect(original).toEqual({
        cookie: "recoveryFixtureCookie=stale",
        journal: "{malformed-private-journal",
        setting: "partial-private-value",
    });
    expect(
        await page.evaluate(() => ({
            channelsReady: window.commandChannelsReady === true,
            deviceStarted: !!window.__ottDevice,
            provider: window.stbGetItem("ottplayprov"),
            setting: window.stbGetItem("recoveryFixtureSetting"),
        }))
    ).toEqual({
        channelsReady: false,
        deviceStarted: false,
        provider: null,
        setting: null,
    });
    await dialog.getByRole("button", { exact: true, name: "Retry" }).click();
    await expect(dialog).toBeVisible();
    await dialog
        .getByRole("button", { exact: true, name: "Clear settings" })
        .click();
    await expect(
        dialog.getByText("Clear all settings?", { exact: true })
    ).toBeVisible();
    await expect(
        dialog.getByRole("button", { exact: true, name: "Cancel" })
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
        dialog.getByRole("button", { exact: true, name: "Retry" })
    ).toBeFocused();
    expect(
        await page.evaluate(() => ({
            cookie: document.cookie,
            journal: localStorage.getItem("ottplaySettingsJournalV1"),
            setting: localStorage.getItem("recoveryFixtureSetting"),
        }))
    ).toEqual(original);
    await dialog
        .getByRole("button", { exact: true, name: "Clear settings" })
        .click();
    await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        dialog
            .getByRole("button", { exact: true, name: "Clear settings" })
            .click(),
    ]);
    expect(await page.evaluate(() => window.__recoveryAfterReset)).toEqual({
        cookie: "ottplayStorageFallback.reset=1; ottplayStorageFallback=%5B%5D",
        journal: null,
        setting: null,
    });
    await page.waitForFunction(() => !!window.__ottDevice);
    await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);
});

test("remote archive receipt resolves without playback and starts the selected past programme", async ({
    page,
    context,
    baseURL,
}) => {
    const origin = new URL(baseURL).origin;
    const results = [];
    const media = [];
    const errors = [];
    const pending = [{ action: "epg_catalog", params: {} }];
    const start = Math.floor(Date.now() / 1000) - 600;
    let selection;
    let sequence = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (
            url.origin === origin &&
            url.pathname.startsWith("/fixture-control/")
        ) {
            if (request.method() === "POST") {
                const result = request.postDataJSON();
                results.push(result);
                if (results.length === 1 && result.status === "ok") {
                    selection = {
                        catalog: result.data.catalog,
                        end: start + 300,
                        id: result.data.channels[1].id,
                        start,
                        title: "Selected archive fixture",
                    };
                    pending.push({
                        action: "resolve_archive",
                        params: selection,
                    });
                } else if (results.length === 2 && result.status === "ok") {
                    expect(media).toEqual([]);
                    pending.push({
                        action: "play_archive_catalog",
                        params: selection,
                    });
                }
                return route.fulfill({ json: { status: "ok" } });
            }
            const now = Date.now() / 1000;
            const next = pending.shift();
            return route.fulfill({
                json: {
                    commands: [],
                    requests: next
                        ? [
                              {
                                  ...next,
                                  expires_at: now + 40,
                                  id: String(++sequence).padStart(32, "0"),
                              },
                          ]
                        : [],
                    server_time: now,
                },
            });
        }
        if (
            url.pathname.startsWith("/fixture-media/") ||
            url.pathname.startsWith("/demo/")
        ) {
            const segment = url.pathname.endsWith(".ts");
            if (url.pathname.startsWith("/fixture-media/"))
                media.push(url.pathname + url.search);
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
        return url.origin === origin
            ? route.continue()
            : route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(() => {
        localStorage.setItem("ottplaylang", "_eng");
        localStorage.setItem("ottplayprov", "demo");
    });
    await page.goto("/f/pc/");
    await page.waitForFunction(() => window.commandChannelsReady === true);
    await page.keyboard.press("Shift");
    await page.evaluate(() => {
        window.stbStop();
        window.setPlayerMode(1);
        window.parentPIN = "";
        window.parentalArray = [];
        for (const id of window.cList) window.channels[id].rec = 144;
        window.getArchiveUrl = (_id, epoch) =>
            location.origin + "/fixture-media/index.m3u8?utc=" + epoch;
        window.epgArray = [
            { name: "Previous channel guide", time: 1, time_to: 2 },
        ];
        window.__ottCommandServer.configure({
            address: location.origin + "/fixture-control",
            enabled: true,
            token: "SYNTHETIC_COMMAND_TOKEN_0123456789abcdef",
        });
    });
    await expect.poll(() => results.length).toBe(3);
    expect(results.map((result) => result.status)).toEqual(["ok", "ok", "ok"]);
    expect(results[1].data.url).toContain("utc=" + start);
    expect(results[2].data).toMatchObject({
        channel: { id: selection.id },
        dispatched: true,
        end: start + 300,
        start,
    });
    expect(results[2].data.url).toBeUndefined();
    await page.waitForFunction((epoch) => {
        const state = window.__ottClassicPlayback.snapshot();
        const video = document.querySelector("video");
        if (
            state.phase !== "playing" ||
            state.target?.kind !== "archive" ||
            state.target.archiveStart !== epoch ||
            video.currentTime <= 0
        )
            return false;
        window.stbPause();
        return true;
    }, start);
    expect(media[0]).toBe("/fixture-media/index.m3u8?utc=" + start);
    expect(errors).toEqual([]);
});

test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
        // The fixture has silent AAC. Without an OS audio output, headless
        // Chromium can emit playing while its audio clock never advances.
        // Keep real decoding/ended events, but mute every new media attempt.
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            this.muted = true;
            return play.call(this);
        };
    });
});

async function nativeRemoteInputFixture(
    page,
    context,
    baseURL,
    configured = true
) {
    const origin = new URL(baseURL).origin;
    const requests = [];
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === origin && url.pathname.startsWith("/swop/")) {
            requests.push({
                body: request.postDataJSON(),
                headers: request.headers(),
                path: url.pathname,
            });
            return route.fulfill({
                json:
                    url.pathname === "/swop/session"
                        ? {
                              code: "ABCDEF",
                              entryCode: "ABCDEF-GHJKLM",
                              entryUrl: "https://swop.test/",
                              sessionToken: "synthetic-read-token",
                              url: "https://swop.test/?c=ABCDEF&t=synthetic-write-token",
                          }
                        : { status: "ready", value: "Phone text & <literal>" },
            });
        }
        return url.origin === origin
            ? route.continue()
            : route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(() => {
        localStorage.setItem("ottplaylang", "_eng");
        localStorage.setItem("ottplayprov", "demo");
    });
    await page.goto("/f/pc/");
    await page.waitForFunction(
        () => window.__ottDevice && !document.body.classList.contains("booting")
    );
    await page.evaluate((enabled) => {
        window.stbStop();
        window.popupList();
        window.sSwopBaseUrl = enabled ? "/swop" : "";
        window.settings.swopBaseUrl = window.sSwopBaseUrl;
        window.__nativeRemoteSaves = [];
        window.editCaption = "Search";
        window.editvar = "before typing";
        window.setEdit = () => window.__nativeRemoteSaves.push(window.editvar);
        window.showEditKey(null, true);
        window.__nativeRemoteOwner =
            window.__ottClassicScreenPort.owner("editor");
    }, configured);
    return { errors, requests };
}

test("native editor remote button sends typed draft, resumes and saves only on confirmation", async ({
    page,
    context,
    baseURL,
}) => {
    const fixture = await nativeRemoteInputFixture(page, context, baseURL);
    const field = page
        .getByRole("dialog", { exact: true, name: "Search" })
        .getByLabel("Search", { exact: true });
    await field.fill("Typed draft & <literal>");
    const remote = page.getByRole("button", {
        exact: true,
        name: "Remote text entry",
    });
    await field.press("Tab");
    await expect(remote).toBeFocused();
    await remote.press("Shift+Tab");
    await expect(field).toBeFocused();
    await field.press("Tab");
    await remote.press("Enter");
    await expect(page.locator(".swop-code")).toHaveText("ABCDEF-GHJKLM");
    expect(await page.evaluate(() => window.__nativeRemoteSaves)).toEqual([]);
    expect(fixture.requests[0].body.draft).toBe("Typed draft & <literal>");
    expect(fixture.requests[0].path).toBe("/swop/session");
    await expect(field).toHaveValue("Phone text & <literal>");
    await expect(field).toHaveAttribute("type", "password");
    await expect(field).toBeFocused();
    expect(
        await page.evaluate(
            () =>
                window.__nativeRemoteOwner ===
                window.__ottClassicScreenPort.owner("editor")
        )
    ).toBe(true);
    expect(await page.evaluate(() => window.__nativeRemoteSaves)).toEqual([]);
    expect(fixture.requests.map((request) => request.path)).toEqual([
        "/swop/session",
        "/swop/val",
    ]);
    expect(
        fixture.requests.every((request) => !request.headers.authorization)
    ).toBe(true);
    await field.press("Enter");
    await expect(page.locator("#listEdit")).toBeHidden();
    expect(await page.evaluate(() => window.__nativeRemoteSaves)).toEqual([
        "Phone text & <literal>",
    ]);
    expect(fixture.errors).toEqual([]);
});

test("native editor remote cancel preserves typing and Escape discards without saving", async ({
    page,
    context,
    baseURL,
}) => {
    const fixture = await nativeRemoteInputFixture(page, context, baseURL);
    const field = page
        .getByRole("dialog", { exact: true, name: "Search" })
        .getByLabel("Search", { exact: true });
    await field.fill("Keep this draft");
    await page
        .getByRole("button", { exact: true, name: "Remote text entry" })
        .click();
    await expect(page.locator(".swop-code")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(field).toHaveValue("Keep this draft");
    await expect(field).toHaveAttribute("type", "password");
    await field.press("Escape");
    await expect(page.locator("#listEdit")).toBeHidden();
    expect(await page.evaluate(() => window.__nativeRemoteSaves)).toEqual([]);
    expect(fixture.requests.length).toBe(1);
    expect(fixture.errors).toEqual([]);
});

test("native editor remote button explains missing configuration and keeps the field", async ({
    page,
    context,
    baseURL,
}) => {
    const fixture = await nativeRemoteInputFixture(
        page,
        context,
        baseURL,
        false
    );
    const field = page
        .getByRole("dialog", { exact: true, name: "Search" })
        .getByLabel("Search", { exact: true });
    await field.fill("Local draft");
    await page
        .getByRole("button", { exact: true, name: "Remote text entry" })
        .click();
    await expect(field).toHaveValue("Local draft");
    await expect(page.locator("#info")).toHaveText(
        "Remote text entry not configured"
    );
    await expect(page.locator("#info")).toBeVisible();
    expect(fixture.requests).toEqual([]);
    expect(await page.evaluate(() => window.__nativeRemoteSaves)).toEqual([]);
    expect(fixture.errors).toEqual([]);
});

async function episodeFixture(
    page,
    context,
    baseURL,
    holdNext = false,
    remoteQueue = false
) {
    const origin = new URL(baseURL).origin;
    const errors = [];
    const resolutions = [];
    const manifests = [];
    const catalogRequests = [];
    const remoteResults = [];
    let remoteSent = false;
    let releaseNext;
    const nextResponse = new Promise((resolve) => {
        releaseNext = resolve;
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (
            remoteQueue &&
            url.origin === origin &&
            url.pathname.startsWith("/fixture-control/")
        ) {
            if (request.method() === "POST") {
                remoteResults.push(request.postDataJSON());
                return route.fulfill({ json: { status: "ok" } });
            }
            const serverTime = Date.now() / 1000;
            const requests = remoteSent
                ? []
                : [
                      {
                          action: "vportal",
                          expires_at: serverTime + 40,
                          id: "1234567890abcdef1234567890abcdef",
                          params: { query: "mAtCh" },
                      },
                  ];
            remoteSent = true;
            return route.fulfill({
                json: { commands: [], requests, server_time: serverTime },
            });
        }
        if (url.origin === origin && url.pathname === "/vportal/api") {
            const { params } = request.postDataJSON();
            if (params.cmd === "play") {
                const revision = resolutions.push(params.id);
                if (holdNext && revision === 2) await nextResponse;
                const media = (quality) =>
                    "https://media.test/" +
                    params.id +
                    "/" +
                    quality +
                    "/index.m3u8?revision=" +
                    revision;
                return route.fulfill({
                    json: {
                        url: media("SD"),
                        variants: { HD: media("HD"), SD: media("SD") },
                    },
                });
            }
            if (remoteQueue) {
                catalogRequests.push(params);
                const movie = (id, title) => ({
                    request: { cmd: "play", id },
                    title,
                    type: "stream",
                });
                let items;
                if (params.cmd === "search") {
                    items = params.offset
                        ? [movie(4, "MATCH last movie")]
                        : [
                              movie(1, "Match first movie"),
                              {
                                  request: { cmd: "series", id: 10 },
                                  title: "Match series",
                                  type: "multistream",
                              },
                              movie(99, "Unrelated movie"),
                              { request: { offset: 3 }, type: "next" },
                          ];
                } else if (params.cmd === "series" && params.id === 10) {
                    items = params.offset
                        ? [movie(3, "Episode 3")]
                        : [
                              movie(2, "Episode 2"),
                              { request: { offset: 1 }, type: "next" },
                          ];
                } else {
                    return route.fulfill({
                        json: { type: "error" },
                    });
                }
                return route.fulfill({
                    json: {
                        items,
                        title: "Match series",
                        type:
                            params.cmd === "series"
                                ? "multistream"
                                : "category",
                    },
                });
            }
            return route.fulfill({
                json: {
                    items: [1, 2].map((id) => ({
                        request: { cmd: "play", id },
                        title: "Episode " + id,
                        type: "stream",
                    })),
                    title: "Fixture series",
                    type: "multistream",
                },
            });
        }
        if (
            url.hostname === "media.test" ||
            url.pathname.startsWith("/demo/")
        ) {
            const segment = url.pathname.endsWith(".ts");
            if (url.hostname === "media.test" && !segment)
                manifests.push(url.pathname + url.search);
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
                headers: { "Access-Control-Allow-Origin": "*" },
            });
        }
        return url.origin === origin
            ? route.continue()
            : route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(() => {
        localStorage.setItem("ottplaylang", "_eng");
        localStorage.setItem("ottplayprov", "demo");
    });
    await page.goto(process.env.OTTP_EPISODE_ENTRY || "/f/pc/");
    await page.waitForFunction(
        () => window.__ottDevice && !document.body.classList.contains("booting")
    );
    await page.keyboard.press("Shift");
    await page.evaluate((remoteQueue) => {
        window.stbStop();
        window.__ottMedia.cancel();
        // Test episode ownership with real MSE decoding and media events.
        // macOS native HLS can report playing with a stalled headless clock.
        window.setPlayerMode(1);
        window.host = location.origin;
        window.p_pref = "episode-browser-fixture";
        window.m3uArr = null;
        window.ottplayDemoActive = false;
        window.sFavorites = 1;
        window.sMedCount = 2;
        window.parentPIN = "";
        window.settings.stopPlay = true;
        const saved = {};
        window.providerGetItem = (key) => saved[key] || null;
        window.providerSetItem = (key, value) => {
            saved[key] = value;
        };
        const client = window.createVPortalClient(
            "portal::[key:SYNTHETIC_FIXTURE_KEY]http://portal.invalid/api/v1/",
            { sourceId: "browser-fixture", title: "VPortal" }
        );
        window.providerMediaClient = client;
        window.getMediaArray = client.load;
        window.playMedia = client.play;
        const sourceId = window.__ottSourceIdentity.media(window);
        // Unfinished media must not interrupt automatic playback with the
        // manual resume prompt or start from its saved position.
        saved["mediaJournal.v1:" + sourceId] = JSON.stringify({
            favorites: [],
            history: (remoteQueue ? [1, 2] : [2]).map((id) => ({
                itemId: 'request:{"cmd":"play","id":' + id + "}",
                payload: { title: "Fixture series - Episode " + id },
                position: 90,
                sourceId,
            })),
            sourceId,
            version: 1,
        });
        window.__episodeEvents = [];
        document.querySelector("video").addEventListener("ended", (event) => {
            window.__episodeEvents.push({ trusted: event.isTrusted });
        });
        window.__episodePickers = 0;
        const showSelectBox = window.showSelectBox;
        window.showSelectBox = function (...args) {
            window.__episodePickers++;
            return showSelectBox.apply(this, args);
        };
        if (remoteQueue) {
            window.__ottCommandServer.configure({
                address: location.origin + "/fixture-control",
                enabled: true,
                token: "SYNTHETIC_COMMAND_TOKEN_0123456789abcdef",
            });
        } else window.__ottMedia.open("");
    }, remoteQueue);
    if (remoteQueue) {
        await pauseEpisode(page, 1);
        return {
            catalogRequests,
            errors,
            manifests,
            remoteResults,
            resolutions,
        };
    }
    await page.waitForFunction(() => {
        const view = window.__ottMedia.snapshot();
        return (
            !view.loading &&
            view.frame?.items.filter((item) => item.payload.__ottMediaSequence)
                .length === 2
        );
    });
    expect(
        await page.evaluate(() =>
            window.__ottMedia
                .snapshot()
                .frame.items.filter((item) => item.payload.__ottMediaSequence)
                .map((item) => ({
                    sequence: item.payload.__ottMediaSequence,
                    title: item.title,
                }))
        )
    ).toEqual([
        { sequence: true, title: "Fixture series - Episode 1" },
        { sequence: true, title: "Fixture series - Episode 2" },
    ]);
    await page.evaluate(() => window.__ottMedia.select(0));
    await expect(page.locator("#numprog")).toContainText("HD");
    await page.evaluate(() => {
        window._doKey(window.keys.DOWN);
        window._doKey(window.keys.ENTER);
    });
    await pauseEpisode(page, 1);
    return { errors, manifests, releaseNext, resolutions };
}

async function pauseEpisode(page, id) {
    await page.waitForFunction((episode) => {
        const state = window.__ottClassicPlayback.snapshot();
        const video = document.querySelector("video");
        if (
            state.phase !== "playing" ||
            state.target?.channelId !==
                'request:{"cmd":"play","id":' + episode + "}" ||
            video.readyState < 2 ||
            video.currentTime <= 0
        )
            return false;
        window.stbPause();
        return true;
    }, id);
    await expect(page.locator("#dialogbox")).toBeHidden();
    await expect(page.locator("#numprog")).toBeHidden();
}

async function finishEpisode(page) {
    await page.evaluate(() => {
        const video = document.querySelector("video");
        if (!Number.isFinite(video.duration))
            throw new Error("Missing HLS duration");
        // Play the complete two-second fixture. Seeking near its advertised
        // duration can land beyond the shorter audio track's buffered range.
        window.stbContinue();
    });
}

test("natural episode completion resolves the next episode and loops with fresh URLs", async ({
    page,
    context,
    baseURL,
}) => {
    const fixture = await episodeFixture(page, context, baseURL);
    await finishEpisode(page);
    await pauseEpisode(page, 2);
    expect(fixture.resolutions).toEqual([1, 2]);
    expect(
        await page.evaluate(() => document.querySelector("video").currentTime)
    ).toBeLessThan(1);
    await finishEpisode(page);
    await pauseEpisode(page, 1);
    expect(fixture.resolutions).toEqual([1, 2, 1]);
    expect(fixture.manifests).toEqual([
        "/1/HD/index.m3u8?revision=1",
        "/2/HD/index.m3u8?revision=2",
        "/1/HD/index.m3u8?revision=3",
    ]);
    expect(await page.evaluate(() => window.__episodePickers)).toBe(1);
    expect(await page.evaluate(() => window.__episodeEvents)).toEqual([
        { trusted: true },
        { trusted: true },
    ]);
    expect(fixture.errors).toEqual([]);
});

test("remote VPortal search loops all matched movies and series through real media completion", async ({
    page,
    context,
    baseURL,
}) => {
    const fixture = await episodeFixture(page, context, baseURL, false, true);
    await expect.poll(() => fixture.remoteResults.length).toBe(1);
    expect(fixture.remoteResults[0]).toEqual({
        data: {
            dispatched: true,
            items: [
                { number: 1, title: "Match first movie" },
                { number: 2, title: "Match series - Episode 2" },
                { number: 3, title: "Match series - Episode 3" },
                { number: 4, title: "MATCH last movie" },
            ],
            loop: true,
            total: 4,
        },
        id: "1234567890abcdef1234567890abcdef",
        status: "ok",
    });
    expect(
        fixture.catalogRequests.map(({ cmd, id, offset, query }) => ({
            cmd,
            id,
            offset,
            query,
        }))
    ).toEqual([
        { cmd: "search", id: undefined, offset: undefined, query: "mAtCh" },
        { cmd: "series", id: 10, offset: undefined, query: undefined },
        { cmd: "series", id: 10, offset: 1, query: undefined },
        { cmd: "search", id: undefined, offset: 3, query: "mAtCh" },
    ]);
    for (const id of [2, 3, 4, 1]) {
        await finishEpisode(page);
        await pauseEpisode(page, id);
        expect(
            await page.evaluate(
                () => document.querySelector("video").currentTime
            )
        ).toBeLessThan(1);
    }
    expect(fixture.resolutions).toEqual([1, 2, 3, 4, 1]);
    expect(fixture.manifests).toEqual([
        "/1/SD/index.m3u8?revision=1",
        "/2/SD/index.m3u8?revision=2",
        "/3/SD/index.m3u8?revision=3",
        "/4/SD/index.m3u8?revision=4",
        "/1/SD/index.m3u8?revision=5",
    ]);
    expect(await page.evaluate(() => window.__episodePickers)).toBe(0);
    expect(await page.evaluate(() => window.__episodeEvents)).toEqual([
        { trusted: true },
        { trusted: true },
        { trusted: true },
        { trusted: true },
    ]);
    expect(fixture.errors).toEqual([]);
});

test("SWOP filter confirmation survives a natural episode transition", async ({
    page,
    context,
    baseURL,
}) => {
    const fixture = await episodeFixture(page, context, baseURL);
    let submitPhone;
    const phoneReply = new Promise((resolve) => {
        submitPhone = resolve;
    });
    await context.route("**/swop/**", async (route) => {
        if (new URL(route.request().url()).pathname === "/swop/session")
            return route.fulfill({
                json: {
                    code: "ABCDEF",
                    entryCode: "ABCDEF-GHJKLM",
                    entryUrl: "https://swop.test/",
                    sessionToken: "synthetic-read-token",
                    url: "https://swop.test/?c=ABCDEF&t=synthetic-write-token",
                },
            });
        await phoneReply;
        return route.fulfill({
            json: { status: "ready", value: "Episode" },
        });
    });
    await page.evaluate(() => {
        window.__ottMedia.open(null);
        window.ott_device = "lg/webos";
        window.showEditKey = window.showEditKey1;
        window.editKey = window.editKey1;
        window.sSwopBaseUrl = "/swop";
        window.__ottMedia.filter();
        window.swopLoadValue();
    });
    await expect(page.locator(".swop-code")).toHaveText("ABCDEF-GHJKLM");
    await finishEpisode(page);
    await pauseEpisode(page, 2);
    await expect(page.locator(".swop-code")).toBeVisible();
    submitPhone();
    await expect
        .poll(() => page.evaluate(() => window.editvar))
        .toBe("Episode");
    await page.evaluate(() => window._doKey(window.keys.ENTER));
    await expect(page.locator("#listEdit")).toBeHidden();
    expect(await page.evaluate(() => window.__ottMedia.snapshot().filter)).toBe(
        "Episode"
    );
    await finishEpisode(page);
    await pauseEpisode(page, 1);
    expect(fixture.resolutions).toEqual([1, 2, 1]);
    expect(await page.evaluate(() => window.__episodePickers)).toBe(1);
    expect(fixture.errors).toEqual([]);
});

test("manual Stop cancels the pending automatic episode resolution", async ({
    page,
    context,
    baseURL,
}) => {
    const fixture = await episodeFixture(page, context, baseURL, true);
    await finishEpisode(page);
    await expect.poll(() => fixture.resolutions).toEqual([1, 2]);
    const cancelled = page.waitForEvent("requestfailed", {
        predicate: (request) =>
            new URL(request.url()).pathname === "/vportal/api" &&
            request.postDataJSON().params.id === 2,
    });
    await page.evaluate(() => window.stbStop());
    await cancelled;
    fixture.releaseNext();
    await page.evaluate(
        () =>
            new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))
            )
    );
    expect(
        await page.evaluate(() => window.__ottClassicPlayback.snapshot().phase)
    ).toBe("stopped");
    expect(fixture.manifests).toEqual(["/1/HD/index.m3u8?revision=1"]);
    expect(await page.evaluate(() => window.__episodeEvents)).toEqual([
        { trusted: true },
    ]);
    expect(fixture.errors).toEqual([]);
});

async function titleFilterFixture(page, context, baseURL, holdPages = false) {
    const origin = new URL(baseURL).origin;
    const errors = [];
    const requests = [];
    const swopRequests = [];
    const pendingPages = [];
    const query = "  ТРИ   КОТ  ";
    const movie = (title, id) => ({
        request: { cmd: "play", id },
        title,
        type: "stream",
    });
    const series = (title, id) => ({
        request: { cmd: "series", id },
        title,
        type: "multistream",
    });
    const category = {
        request: { cmd: "category", id: 1 },
        title: "Мультфильмы",
        type: "category",
    };
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === "/vportal/api") {
            const { params } = route.request().postDataJSON();
            requests.push(params);
            let items = [category];
            if (params.cmd === "category")
                items = params.offset
                    ? [
                          series("Три кота. Новые истории", 21),
                          movie("Зимняя сказка", 22),
                          {
                              ...category,
                              request: { cmd: "category", id: 3 },
                              title: "Архив",
                          },
                      ]
                    : [
                          series("Три кота", 11),
                          movie("ТРИ    КОТА: кино", 12),
                          movie("Ежик в тумане", 13),
                          series("Смешарики", 14),
                          ...(params.id === 1
                              ? [
                                    {
                                        ...category,
                                        request: { cmd: "category", id: 2 },
                                        title: "Все сезоны",
                                    },
                                    {
                                        request: { offset: 20 },
                                        type: "next",
                                    },
                                ]
                              : []),
                      ];
            if (holdPages && params.offset)
                await new Promise((release) => pendingPages.push(release));
            return route.fulfill({
                json: {
                    controls: { search: true },
                    items,
                    type: "category",
                },
            });
        }
        if (url.origin === origin && url.pathname.startsWith("/swop/")) {
            swopRequests.push({
                body: route.request().postDataJSON(),
                path: url.pathname,
            });
            return route.fulfill({
                json:
                    url.pathname === "/swop/session"
                        ? {
                              code: "ABCDEF",
                              entryCode: "ABCDEF-GHJKLM",
                              entryUrl: "https://swop.test/",
                              sessionToken: "synthetic-read-token",
                              url: "https://swop.test/?c=ABCDEF&t=synthetic-write-token",
                          }
                        : { status: "ready", value: query },
            });
        }
        // The demonstration provider only boots the shipped UI. Catalogue
        // navigation never plays media or contacts an external provider.
        if (url.origin === origin) return route.continue();
        return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(() => {
        localStorage.setItem("ottplaylang", "_eng");
        localStorage.setItem("ottplayprov", "demo");
    });
    await page.goto(process.env.OTTP_MEDIA_FILTER_ENTRY || "/f/pc/");
    await page.waitForFunction(
        () => window.__ottDevice && !document.body.classList.contains("booting")
    );
    await page.evaluate(() => {
        window.stbStop();
        window.__ottMedia.cancel();
        window.host = location.origin;
        window.p_pref = "title-filter-browser-fixture";
        window.m3uArr = null;
        window.ottplayDemoActive = false;
        window.sFavorites = 1;
        window.sMedCount = 2;
        window.parentPIN = "";
        const saved = {};
        window.providerGetItem = (key) => saved[key] || null;
        window.providerSetItem = (key, value) => {
            saved[key] = value;
        };
        const client = window.createVPortalClient(
            "portal::[key:SYNTHETIC_FIXTURE_KEY]http://portal.invalid/api/v1/",
            { sourceId: "filter-fixture", title: "VPortal" }
        );
        window.providerMediaClient = client;
        window.getMediaArray = client.load;
        window.playMedia = client.play;
        // Use the real TV keyboard and remote router in the desktop browser.
        window.ott_device = "lg/webos";
        window.showEditKey = window.showEditKey1;
        window.editKey = window.editKey1;
        window.sSwopBaseUrl = "/swop";
        window.__filterDocument = {};
        window.__ottMedia.open("");
    });
    await page
        .getByRole("option", { exact: true, name: "Мультфильмы" })
        .click();
    await expect(
        page.getByRole("option", { exact: true, name: "Три кота" })
    ).toBeVisible();
    return {
        errors,
        releasePage: async () => {
            await expect.poll(() => pendingPages.length).toBe(1);
            pendingPages.shift()();
        },
        requests,
        swopRequests,
    };
}

async function confirmTitleFilter(page, query) {
    await page.evaluate(() => window._doKey(window.keys.BLUE));
    await expect(page.locator("#listEdit")).toBeVisible();
    await page.evaluate((value) => {
        window.editvar = value;
        window._doKey(window.keys.BLUE);
    }, query);
    await expect(page.locator("#listEdit")).toBeHidden();
}

test("media title filter uses TV and SWOP confirmation and survives paging and Back", async ({
    page,
    context,
    baseURL,
}) => {
    const fixture = await titleFilterFixture(page, context, baseURL, true);
    const title = (name) => page.getByRole("option", { exact: true, name });
    const loading = await page.evaluate(() => window._("Loading..."));
    const frame = () =>
        page.evaluate(() => {
            const state = window.__ottMedia.snapshot();
            return { depth: state.frames.length, route: state.frame.route };
        });
    const initialFrame = await frame();
    const initialRequests = fixture.requests.length;
    await page.evaluate(() => window._doKey(window.keys.BLUE));
    await expect(page.locator("#listEdit .osk-key").first()).toBeVisible();
    await page.evaluate(() => window.swopLoadValue());
    await expect(page.locator(".swop-code")).toHaveText("ABCDEF-GHJKLM");
    await expect
        .poll(() => page.evaluate(() => window.editvar))
        .toBe("  ТРИ   КОТ  ");
    await page.evaluate(() => window._doKey(window.keys.ENTER));
    await expect(page.locator("#listEdit")).toBeHidden();
    await expect(title("Три кота")).toBeVisible();
    await expect(title("ТРИ    КОТА: кино")).toBeVisible();
    await expect(title("Смешарики")).toHaveCount(0);
    await expect(title("Ежик в тумане")).toHaveCount(0);
    for (const name of ["Все сезоны", loading, "Search"])
        await expect(title(name)).toBeVisible();
    await expect(page.locator("#listCaption")).toContainText(/три\s+кот/i);
    // Filtering brings the cursor within prefetch range; only the next page
    // is requested. Keep it pending to observe the real loading row.
    await expect.poll(() => fixture.requests.length).toBe(initialRequests + 1);
    expect(fixture.requests.at(-1)).toMatchObject({
        cmd: "category",
        id: 1,
        offset: 20,
    });
    expect(fixture.swopRequests.map((request) => request.path)).toEqual([
        "/swop/session",
        "/swop/val",
    ]);

    await fixture.releasePage();
    await expect(title("Три кота. Новые истории")).toBeVisible();
    await expect(title("Зимняя сказка")).toHaveCount(0);
    await expect(title("Архив")).toBeVisible();
    await expect(title(loading)).toHaveCount(0);
    await expect(title("Три кота")).toBeVisible();
    await expect(title("Search")).toHaveCount(1);
    await expect(page.locator("#listCaption")).toContainText(/три\s+кот/i);
    expect(await frame()).toEqual(initialFrame);

    await title("Все сезоны").click();
    await expect(page.locator("#listCaption")).toContainText("Все сезоны");
    await expect(title("Три кота")).toBeVisible();
    await expect(title("Смешарики")).toHaveCount(0);
    await expect(page.locator("#listCaption")).toContainText(/три\s+кот/i);
    expect((await frame()).depth).toBe(initialFrame.depth + 1);
    expect(fixture.requests.at(-1)).toMatchObject({ cmd: "category", id: 2 });
    const requestsBeforeBack = fixture.requests.length;
    await page.evaluate(() => window._doKey(window.keys.RETURN));
    await expect(title("Три кота. Новые истории")).toBeVisible();
    await expect(title("Зимняя сказка")).toHaveCount(0);
    await expect(title("Архив")).toBeVisible();
    await expect(page.locator("#listCaption")).toContainText(/три\s+кот/i);
    await expect(title("Три кота")).toBeVisible();
    await expect(title("Смешарики")).toHaveCount(0);
    expect(await frame()).toEqual(initialFrame);
    expect(fixture.requests).toHaveLength(requestsBeforeBack);

    await confirmTitleFilter(page, "нет совпадений");
    for (const name of [
        "Три кота",
        "ТРИ    КОТА: кино",
        "Смешарики",
        "Ежик в тумане",
        "Три кота. Новые истории",
        "Зимняя сказка",
    ])
        await expect(title(name)).toHaveCount(0);
    for (const name of ["Все сезоны", "Архив", "Search"])
        await expect(title(name)).toBeVisible();
    expect(fixture.requests).toHaveLength(requestsBeforeBack);

    // Appended pages share the category frame: Back returns directly to its
    // parent. Reopening with no matches must still append navigation rows.
    await page.evaluate(() => window._doKey(window.keys.RETURN));
    await expect(title("Мультфильмы")).toBeVisible();
    expect((await frame()).depth).toBe(initialFrame.depth - 1);
    await title("Мультфильмы").click();
    await expect(title(loading)).toBeVisible();
    await expect(title("Три кота")).toHaveCount(0);
    await expect(title("Все сезоны")).toBeVisible();
    await expect(title("Search")).toBeVisible();
    await fixture.releasePage();
    await expect(title("Архив")).toBeVisible();
    await expect(title("Три кота. Новые истории")).toHaveCount(0);
    await expect(title("Зимняя сказка")).toHaveCount(0);
    await expect(title(loading)).toHaveCount(0);
    await expect(title("Search")).toHaveCount(1);
    await expect(page.locator("#listCaption")).toContainText("нет совпадений");
    expect(await frame()).toEqual(initialFrame);
    expect(
        fixture.requests.filter((request) => request.offset === 20)
    ).toHaveLength(2);

    await confirmTitleFilter(page, "ЁЖ");
    await expect(title("Ежик в тумане")).toBeVisible();
    await expect(title("Три кота")).toHaveCount(0);
    const filterRow = await page.evaluate(
        () => window.listArray.find((item) => item.__ottMediaFilter).title
    );
    await title(filterRow).click();
    await expect(page.locator("#listEdit")).toBeVisible();
    await page.evaluate(() => {
        window.editvar = "";
        window._doKey(window.keys.BLUE);
    });
    await expect(page.locator("#listEdit")).toBeHidden();
    for (const name of [
        "Три кота",
        "ТРИ    КОТА: кино",
        "Смешарики",
        "Ежик в тумане",
        "Три кота. Новые истории",
        "Зимняя сказка",
    ])
        await expect(title(name)).toBeVisible();
    await expect(page.locator("#listCaption")).not.toContainText("ЁЖ");
    expect(await page.evaluate(() => !!window.__filterDocument)).toBe(true);
    expect(fixture.errors).toEqual([]);
});

test("stale media title filter editors cannot change another list or source", async ({
    page,
    context,
    baseURL,
}) => {
    const fixture = await titleFilterFixture(page, context, baseURL);
    for (const replaceSource of [false, true]) {
        await page.evaluate(() => {
            window.__ottMedia.filter();
            window.__lateFilterSave = window.setEdit;
        });
        await expect(page.locator("#listEdit")).toBeVisible();
        await page.evaluate((replace) => {
            if (replace) window.p_pref = "replacement-filter-fixture";
            window.__ottMedia.open("");
            window.editvar = "must not be applied";
            window.__lateFilterSave();
        }, replaceSource);
        await page
            .getByRole("option", { exact: true, name: "Мультфильмы" })
            .click();
        await expect(
            page.getByRole("option", { exact: true, name: "Смешарики" })
        ).toBeVisible();
        await expect(page.locator("#listCaption")).not.toContainText(
            "must not be applied"
        );
    }
    expect(fixture.errors).toEqual([]);
});

for (const [guideIds, names] of [
    [
        ["one", "two", "three"],
        ["One", "Two", "Three"],
    ],
    [
        ["same", "same", "same"],
        ["One", "Two", "Three"],
    ],
    [
        ["", "", ""],
        ["One", "Two", "Three"],
    ],
    [
        ["same", "same", "same"],
        ["Same", "Same", "Same"],
    ],
]) {
    test(
        "M3U restart restores station after URL rotation: " +
            JSON.stringify([guideIds, names]),
        async ({ page, context, baseURL }) => {
            const origin = new URL(baseURL).origin;
            let revision = 0;
            const errors = [];
            const providerBundles = [];
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("request", (request) => {
                const pathname = new URL(request.url()).pathname;
                if (/^\/dist\/provider-[^/]+\.js$/.test(pathname))
                    providerBundles.push(pathname);
            });
            await context.route("**/*", async (route) => {
                const url = new URL(route.request().url());
                if (url.href.includes("fixture-channels.m3u")) {
                    const order = revision ? [2, 0, 1] : [0, 1, 2];
                    return route.fulfill({
                        body:
                            "#EXTM3U\n" +
                            order
                                .map(
                                    (index) =>
                                        '#EXTINF:-1 tvg-id="' +
                                        guideIds[index] +
                                        '" group-title="News",' +
                                        names[index] +
                                        "\nhttps://media.test/" +
                                        index +
                                        "/index.m3u8?token=" +
                                        revision +
                                        "\n"
                                )
                                .join(""),
                        contentType: "text/plain",
                        headers: { "Access-Control-Allow-Origin": "*" },
                    });
                }
                if (url.hostname === "media.test") {
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
                        headers: { "Access-Control-Allow-Origin": "*" },
                    });
                }
                return url.origin === origin
                    ? route.continue()
                    : route.abort("blockedbyclient");
            });
            await context.routeWebSocket("**/*", (socket) => socket.close());
            await context.addInitScript(() => {
                if (localStorage.getItem("ottplayprov")) return;
                localStorage.setItem("ottplaylang", "_eng");
                localStorage.setItem("ottplayprov", "m3u");
                localStorage.setItem(
                    "m3um3uArr",
                    JSON.stringify({
                        active: 0,
                        M3Us: [
                            {
                                www: "https://playlist.test/fixture-channels.m3u",
                            },
                        ],
                    })
                );
            });
            await page.goto("/f/pc/");
            await page.waitForFunction(() => window.curList?.length === 3);
            await page.evaluate(() =>
                window.playChannel(window.catsArray.indexOf("News"), 1)
            );
            const before = await page.evaluate(
                () => window.curList[window.primaryIndex]
            );
            await expect
                .poll(() =>
                    page.evaluate(
                        () => window.__ottClassicPlayback.snapshot().phase
                    )
                )
                .toBe("playing");
            expect(providerBundles).toEqual(["/dist/provider-m3u.js"]);
            revision++;
            // A new document reloads the playlist and reconstructs all private stores.
            await page.reload();
            await page.waitForFunction(() => window.curList?.length === 3);
            const after = await page.evaluate(() => {
                const id = window.curList[window.primaryIndex];
                return {
                    group: window.catsArray[window.catIndex],
                    id,
                    index: window.primaryIndex,
                    name: window.channels[id].channel_name,
                    route: new URL(window.channels[id].url).pathname,
                };
            });
            expect(after.id).not.toBe(before);
            expect(after).toMatchObject({
                group: "News",
                index: 2,
                name: names[1],
                route: "/1/index.m3u8",
            });
            await expect
                .poll(() =>
                    page.evaluate(
                        () => window.__ottClassicPlayback.snapshot().phase
                    )
                )
                .toBe("playing");
            // Each cold document loads its selected family once; playback and
            // channel rotation must not eagerly fetch any other provider.
            expect(providerBundles).toEqual([
                "/dist/provider-m3u.js",
                "/dist/provider-m3u.js",
            ]);
            expect(errors).toEqual([]);
        }
    );
}

test("built driver, media session and journal stay connected through playback", async ({
    page,
    context,
    baseURL,
}) => {
    const origin = new URL(baseURL).origin;
    const errors = [];
    const providerScripts = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (/\/providers\/.+\/provider\.js$/.test(url.pathname))
            providerScripts.push(url.pathname);
    });
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/demo/pattern.m3u8")
            return route.fulfill({
                body: fs.readFileSync(path.join(mediaRoot, "index.m3u8")),
                contentType: "application/vnd.apple.mpegurl",
                headers: { "Access-Control-Allow-Origin": "*" },
            });
        if (url.pathname === "/demo/segment00.ts")
            return route.fulfill({
                body: fs.readFileSync(path.join(mediaRoot, "segment00.ts")),
                contentType: "video/mp2t",
                headers: { "Access-Control-Allow-Origin": "*" },
            });
        if (url.origin === origin) return route.continue();
        return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(() => {
        localStorage.setItem("ottplaylang", "_eng");
        localStorage.setItem("ottplayprov", "demo");
        localStorage.setItem(
            "demoplaybackJournal",
            JSON.stringify({
                bookmark: {
                    channelId: "900000002",
                    groupId: "Demo",
                    kind: "live",
                },
                history: [],
                sourceId: "demo",
                updatedAt: Date.now(),
                version: 2,
            })
        );
    });
    await page.goto("/f/pc/", { waitUntil: "load" });
    await page.keyboard.press("Shift");
    // iPhone requires this element policy as well as the WKWebView's inline
    // permission. Desktop playback alone cannot detect system fullscreen takeover.
    await expect(page.locator("#video")).toHaveJSProperty("playsInline", true);
    await expect(page.locator("#videopip")).toHaveJSProperty(
        "playsInline",
        true
    );
    await expect
        .poll(() =>
            page.evaluate(() => {
                const video = document.querySelector("video");
                return (
                    video &&
                    video.readyState >= 2 &&
                    video.currentTime > 0 &&
                    video.getVideoPlaybackQuality().totalVideoFrames > 0
                );
            })
        )
        .toBe(true);
    expect(providerScripts).toEqual([]);

    const source = await page.evaluate(() => {
        window.__overlayMediaEvents = [];
        for (const type of ["pause", "emptied"])
            video.addEventListener(type, () =>
                window.__overlayMediaEvents.push(type)
            );
        window.infoBarHide();
        return video.currentSrc;
    });
    await page.mouse.click(640, 670);
    await expect(page.locator("#info1")).toBeVisible();
    // Both the menu preview and full-size overlay must keep the same decoder
    // running, instead of hiding the problem by stopping and restarting video.
    for (const noSmall of [0, 1]) {
        await page.evaluate((value) => {
            window.settings.noSmall = window.sNoSmall = value;
        }, noSmall);
        await page.mouse.click(640, 70);
        await expect(
            page.locator(noSmall ? "#list_osd" : "#list_window")
        ).toBeVisible();
        // WebKit may decode this entire short fixture ahead of presentation,
        // so measure the playhead after the menu opens, not decoded frame count.
        const position = await page.evaluate(() => video.currentTime);
        await expect
            .poll(() =>
                page.evaluate(
                    (before) => Math.abs(video.currentTime - before),
                    position
                )
            )
            .toBeGreaterThan(0.05);
        expect(await page.evaluate(() => video.paused)).toBe(false);
        expect(await page.evaluate(() => video.currentSrc)).toBe(source);
        await page.evaluate(() => window._doKey(window.keys.RETURN));
        await expect(page.locator("#list_osd")).toBeHidden();
        await expect(page.locator("#list_window")).toBeHidden();
    }
    expect(await page.evaluate(() => window.__overlayMediaEvents)).toEqual([]);

    // Use the actual user-facing media command. The provider supplies the URL,
    // while engine events drive typed state and the source-scoped media journal.
    await page.evaluate(() => {
        window.playMedia({
            stream_url:
                "https://liminal-sketch-vv8r.here.now/demo/pattern.m3u8",
            title: "Local browser fixture",
        });
    });
    await expect
        .poll(() =>
            page.evaluate(() => {
                const state = window.__ottClassicPlayback.snapshot();
                return state.phase === "playing" && state.target.kind === "vod";
            })
        )
        .toBe(true);
    await page.evaluate(() => window.stbPause());
    await expect
        .poll(() =>
            page.evaluate(() => window.__ottClassicPlayback.snapshot().phase)
        )
        .toBe("paused");
    await page.evaluate(() => {
        window.stbSetPosTime(0.5);
        window.dispatchEvent(new Event("beforeunload"));
    });
    const paused = await page.evaluate(() => ({
        channelBookmark: JSON.parse(window.providerGetItem("playbackJournal"))
            .bookmark,
        media: JSON.parse(
            window.providerGetItem(
                "mediaJournal.v1:" + window.__ottMedia.sourceId()
            )
        ).history[0],
        phase: window.__ottClassicPlayback.snapshot().phase,
        position: document.querySelector("video").currentTime,
        ref: window.__ottMedia.current().ref,
    }));
    expect(paused.channelBookmark.kind).toBe("live");
    expect(paused.media.itemId).toBe(paused.ref.itemId);
    expect(paused.media.sourceId).toBe(paused.ref.sourceId);
    expect(paused.media.payload.title).toBe("Local browser fixture");
    expect(paused.media.position).toBeCloseTo(0.5, 1);
    expect(paused.position).toBeCloseTo(0.5, 1);
    expect(paused.phase).toBe("paused");
    await page.evaluate(() => window.stbContinue());
    await expect
        .poll(() =>
            page.evaluate(() => window.__ottClassicPlayback.snapshot().phase)
        )
        .toBe("playing");
    await page.evaluate(() => window.stbStop());
    await expect
        .poll(() =>
            page.evaluate(() => window.__ottClassicPlayback.snapshot().phase)
        )
        .toBe("stopped");
    expect(errors).toEqual([]);
});

test("kiosk locks UI selection, retries a stopped channel and restores the lock", async ({
    page,
    context,
    baseURL,
}) => {
    test.setTimeout(60000);
    const origin = new URL(baseURL).origin;
    const pending = [],
        results = [],
        errors = [];
    let sequence = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
        const request = route.request(),
            url = new URL(request.url());
        if (
            url.origin === origin &&
            url.pathname.startsWith("/fixture-control/")
        ) {
            if (request.method() === "POST") {
                if (url.pathname.endsWith("/responses"))
                    results.push(request.postDataJSON());
                return route.fulfill({ json: { status: "ok" } });
            }
            const next = pending.shift(),
                now = Date.now() / 1000;
            return route.fulfill({
                json: {
                    commands: [],
                    requests: next
                        ? [
                              {
                                  ...next,
                                  expires_at: now + 40,
                                  id: String(++sequence).padStart(32, "0"),
                              },
                          ]
                        : [],
                    server_time: now,
                },
            });
        }
        if (url.pathname.startsWith("/demo/"))
            return route.fulfill({ body: "fixture offline", status: 503 });
        return url.origin === origin
            ? route.continue()
            : route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(() => {
        localStorage.setItem("ottplaylang", "_eng");
        if (!localStorage.getItem("ottplayprov"))
            localStorage.setItem("ottplayprov", "demo");
    });
    await page.goto("/f/pc/");
    await page.waitForFunction(() => window.commandChannelsReady === true);
    await page.evaluate(() => {
        window.parentPIN = "";
        window.parentalArray = [];
        window.__ottCommandServer.configure({
            address: location.origin + "/fixture-control",
            enabled: true,
            token: "SYNTHETIC_COMMAND_TOKEN_0123456789abcdef",
        });
    });
    async function rpc(action, params) {
        const length = results.length;
        pending.push({ action, params });
        await expect.poll(() => results.length).toBe(length + 1);
        return results[length];
    }
    expect((await rpc("kiosk", { mode: "on" })).data.state).toBe("waiting");
    const selection = await page.evaluate(() => {
        const category = window.catsArray.findIndex(
            (cat) => window.cats[cat].length > 1
        );
        const id = String(window.cats[window.catsArray[category]][1]);
        window.playChannel(category, 1);
        return { category, id };
    });
    expect((await rpc("kiosk", { mode: "status" })).data.channel.id).toBe(
        selection.id
    );
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await page.keyboard.press("1");
    expect(
        await page.evaluate(({ category }) => {
            window.playChannel(category, 0);
            return String(window.curList[window.primaryIndex]);
        }, selection)
    ).toBe(selection.id);
    expect((await rpc("play", { query: "1" })).status).toBe("rejected");
    expect((await rpc("provider", { query: "m3u" })).status).toBe("rejected");
    await page.evaluate(() => window.stbStop());
    await expect
        .poll(() => page.evaluate(() => window.__ottKiosk.snapshot().retries), {
            timeout: 15000,
        })
        .toBeGreaterThan(0);
    expect(
        await page.evaluate(() => String(window.curList[window.primaryIndex]))
    ).toBe(selection.id);
    // The persisted policy also takes precedence over URL-selected providers.
    await page.goto("/f/pc/?m3u");
    await page.waitForFunction(() => window.commandChannelsReady === true);
    expect(
        await page.evaluate(() => window.__ottKiosk.snapshot().channel.id)
    ).toBe(selection.id);
    expect(await page.evaluate(() => window.__ottActiveProviderDriver.id)).toBe(
        "demo"
    );
    const replacement = await rpc("kiosk", { mode: "set", query: "1" });
    expect(replacement.status).toBe("ok");
    expect(replacement.data.channel.id).not.toBe(selection.id);
    expect((await rpc("kiosk", { mode: "off" })).data.state).toBe("off");
    expect((await rpc("play", { query: "2" })).status).toBe("ok");
    expect(errors).toEqual([]);
});

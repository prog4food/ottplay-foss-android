// Shipped player/bootstrap and real remote polling; only native IPC is simulated.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { test, expect } = require("../helpers/browser-test.cjs");

let localMovie;
function localMediaFixture() {
    if (localMovie) return localMovie;
    const segment = fs.readFileSync(
        path.resolve(__dirname, "../fixtures/media-runtime/segment00.ts")
    );
    const fragments = [];
    for (let index = 0; index < 30; index++) {
        const mux = new (require("mux.js").mp4.Transmuxer)({
            baseMediaDecodeTime: index * 2 * 90000,
            remux: true,
        });
        mux.on("data", (data) => {
            if (!index) fragments.push(Buffer.from(data.initSegment));
            fragments.push(Buffer.from(data.data));
        });
        mux.push(new Uint8Array(segment));
        mux.flush();
    }
    localMovie = Buffer.concat(fragments);
    return localMovie;
}

async function fixture(
    page,
    context,
    baseURL,
    delayed,
    local = false,
    systemLanguage = false
) {
    const origin = new URL(baseURL).origin;
    const control = { pending: [], polls: 0, replies: [], sequence: 0 };
    const observed = { catalogs: 0, errors: [], media: [], providers: [] };
    page.on("pageerror", (error) => observed.errors.push(error.message));
    await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort("blockedbyclient");
        if (url.pathname === "/native-standby/catalog") {
            observed.catalogs++;
            // Keep the native catalog incomplete throughout both playback
            // attempts. A saved late file must not wait for the full scan.
            return route.fulfill({
                json: {
                    items: [
                        {
                            id: "751db9d74d2cfe13",
                            name: "2999-saved-video.mp4",
                            sourceId: "folder",
                            url: origin + "/native-standby/saved.mp4",
                        },
                    ],
                    scanned: 1,
                    scanning: true,
                    sources: [
                        {
                            available: true,
                            id: "folder",
                            kind: "folder",
                            name: "Videos",
                        },
                    ],
                    total: null,
                },
            });
        }
        if (url.pathname === "/native-standby/saved.mp4") {
            observed.media.push(url.pathname);
            return route.fulfill({
                body: localMediaFixture(),
                contentType: "video/mp4",
            });
        }
        if (url.pathname.startsWith("/native-standby-control/")) {
            if (request.method() === "POST") {
                if (url.pathname.endsWith("/responses"))
                    control.replies.push(request.postDataJSON());
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
        if (url.pathname === "/native-standby/channels.m3u") {
            observed.providers.push(url.pathname);
            return route.fulfill({
                body:
                    '#EXTM3U\n#EXTINF:-1 group-title="Fixture",Native standby fixture\n' +
                    origin +
                    "/native-standby/video.mp4\n",
                contentType: "text/plain",
            });
        }
        if (url.pathname === "/native-standby/video.mp4") {
            observed.media.push(url.pathname);
            return route.fulfill({ status: 404 });
        }
        return route.continue();
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(
        ({ origin, delayed, local, systemLanguage }) => {
            localStorage.setItem("ottplaylang", "_eng");
            localStorage.setItem(
                "ottplaylangmode",
                systemLanguage ? "system" : "manual"
            );
            localStorage.setItem("ottplayprov", local ? "offline" : "m3u");
            if (local) {
                const profile = {
                    binding_id: "b133083e-c5b8-420d-86f2-f436c1891f3a",
                    name: "Local saved video",
                    provider: "offline",
                    selected: {
                        name: "2999-saved-video.mp4",
                        source_key: "s0",
                    },
                    sources: [{ key: "s0", kind: "folder", name: "Videos" }],
                    version: 1,
                };
                localStorage.setItem(
                    "offlineProfiles",
                    JSON.stringify({
                        active: 2,
                        profiles: Array.from({ length: 15 }, (_, i) =>
                            i === 2 ? profile : null
                        ),
                        version: 1,
                    })
                );
                localStorage.setItem(
                    "offlineProfileBindings",
                    JSON.stringify({
                        [profile.binding_id]: {
                            library: "tauri",
                            selected: "751db9d74d2cfe13",
                            signature: JSON.stringify({
                                selected: profile.selected,
                                sources: profile.sources,
                            }),
                            sources: { s0: "folder" },
                        },
                    })
                );
                localStorage.setItem("offlinesPlayers", "0");
            }
            localStorage.setItem("m3usPlayers", "0");
            localStorage.setItem(
                "m3um3uArr",
                JSON.stringify({
                    active: 0,
                    M3Us: [{ www: origin + "/native-standby/channels.m3u" }],
                })
            );
            localStorage.setItem("commandServerEnabled", "1");
            localStorage.setItem(
                "commandServerAddress",
                origin + "/native-standby-control"
            );
            localStorage.setItem(
                "commandServerToken",
                "native_standby_fixture_0123456789abcdef"
            );
            // Intentionally disagree with native persistence: native truth must win
            // before any provider starts, even after the web storage was reset.
            localStorage.setItem("__ottStandbyV1", "0");
            const state = (window.__nativeStandbyFixture = {
                calls: [],
                plays: 0,
                probeBeforeReady: null,
                probeResolved: false,
                ready: false,
                readyAfterProbe: null,
                resolveProbe: null,
                standby: !local,
            });
            const play = HTMLMediaElement.prototype.play;
            HTMLMediaElement.prototype.play = function (...args) {
                state.plays++;
                this.muted = true;
                return play.apply(this, args);
            };
            const nativeFetch = window.fetch.bind(window);
            let probed = false;
            const snapshot = () => ({
                pending: 0,
                quiescent: state.standby,
                standby: state.standby,
            });
            async function invoke(command, args = {}) {
                state.calls.push({
                    command,
                    preferredId: args.preferredId,
                    remoteControl: args.remoteControl,
                    standby: args.standby,
                });
                if (command === "background_standby_status") {
                    if (!probed) {
                        probed = true;
                        // The classic bundle declares onStbReady globally. Wrap
                        // it after that declaration, before native probing can
                        // settle and before the device starts the bootstrap.
                        const onReady = window.onStbReady;
                        window.onStbReady = function (...args) {
                            state.ready = true;
                            state.readyAfterProbe = state.probeResolved;
                            return onReady.apply(this, args);
                        };
                        state.probeBeforeReady = !state.ready;
                        if (delayed)
                            return new Promise((resolve) => {
                                state.resolveProbe = () => {
                                    state.probeResolved = true;
                                    resolve({
                                        pending: 0,
                                        quiescent: true,
                                        standby: true,
                                    });
                                };
                            });
                    }
                    state.probeResolved = true;
                    return snapshot();
                }
                if (command === "set_background_standby") {
                    state.standby = args.standby;
                    return snapshot();
                }
                if (command === "offline_media_endpoint")
                    return { endpoint: origin + "/native-standby/catalog" };
                if (command === "proxy_http" || command === "proxy_fetch") {
                    const response = await nativeFetch(
                        args.url.replace(/^@/, ""),
                        {
                            body: args.body || undefined,
                            headers: args.headers,
                            method: args.method || "GET",
                        }
                    );
                    const body = await response.text();
                    if (command === "proxy_fetch") return body;
                    return {
                        body,
                        headers: "Content-Type: text/plain\r\n",
                        status: response.status,
                        statusText: response.statusText,
                    };
                }
                if (command === "plugin:updater|check") return null;
                if (command === "match_channels" || command === "match_logos")
                    return "";
                if (command === "get_epg") return { epg_data: [] };
                if (command === "tmdb_proxy")
                    throw new Error("No fixture TMDb configured");
                if (command === "native_hls_start")
                    return { session: "fixture", url: args.url };
                return { ok: true };
            }
            window.__TAURI__ = {
                core: { invoke },
                event: { listen: async () => () => {} },
            };
        },
        { delayed, local, origin, systemLanguage }
    );
    const response = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/dist/player.js"
    );
    await page.goto("/f/pc/");
    const loaded = await (await response).body();
    const artifact = fs.readFileSync(
        process.env.CI_BROWSER_WEB_ROOT
            ? path.resolve(process.env.CI_BROWSER_WEB_ROOT, "dist/player.js")
            : path.resolve(__dirname, "../../dist/player.js")
    );
    expect(createHash("sha256").update(loaded).digest("hex")).toBe(
        createHash("sha256").update(artifact).digest("hex")
    );
    await page.waitForFunction(
        () =>
            window.__nativeStandbyFixture.ready &&
            window.executeRemoteRequest &&
            window.__ottStandby
    );
    async function rpc(action, params) {
        const count = control.replies.length;
        control.pending.push({ action, params });
        await expect
            .poll(() => control.replies.length, { timeout: 15000 })
            .toBe(count + 1);
        return control.replies[count];
    }
    return { control, observed, rpc };
}

test("native persisted standby is applied before ready without losing remote control", async ({
    page,
    context,
    baseURL,
}) => {
    const { observed, rpc } = await fixture(page, context, baseURL, false);
    expect(
        await page.evaluate(
            () => window.__nativeStandbyFixture.probeBeforeReady
        )
    ).toBe(true);
    expect(
        await page.evaluate(() => window.__nativeStandbyFixture.readyAfterProbe)
    ).toBe(true);
    await expect
        .poll(() => page.evaluate(() => window.__ottStandby.snapshot()))
        .toEqual({
            pending: 0,
            state: "suspended",
        });
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
    expect((await rpc("capabilities", {})).status).toBe("ok");
    expect(observed.providers).toEqual([]);
    expect(observed.media).toEqual([]);
    expect(
        await page.evaluate(() => ({
            plays: window.__nativeStandbyFixture.plays,
            stored: localStorage.getItem("__ottStandbyV1"),
        }))
    ).toEqual({ plays: 0, stored: "1" });
    expect(await page.locator("#launch").isVisible()).toBe(true);
    expect(observed.errors).toEqual([]);
});

test("remote go supersedes a pending native startup probe", async ({
    page,
    context,
    baseURL,
}) => {
    const { observed, rpc } = await fixture(page, context, baseURL, true);
    expect(
        await page.evaluate(
            () => window.__nativeStandbyFixture.probeBeforeReady
        )
    ).toBe(true);
    expect(
        await page.evaluate(() => window.__nativeStandbyFixture.readyAfterProbe)
    ).toBe(false);
    expect(observed.providers).toEqual([]);
    expect((await rpc("lifecycle", { operation: "wake" })).status).toBe("ok");
    await page.waitForFunction(() => !window.__ottStandby.blocked());
    await expect.poll(() => observed.providers.length).toBeGreaterThan(0);
    await page.evaluate(() => window.__nativeStandbyFixture.resolveProbe());
    const status = await rpc("status", {});
    expect(status).toMatchObject({
        data: { player: { background: { state: "running" }, standby: false } },
        status: "ok",
    });
    expect(
        await page.evaluate(() =>
            window.__nativeStandbyFixture.calls
                .filter((call) => call.command === "set_background_standby")
                .map((call) => call.standby)
        )
    ).toEqual([false]);
    expect(observed.errors).toEqual([]);
});

for (const systemLanguage of [false, true]) {
    test(`mounted Local resumes its saved file after standby with ${systemLanguage ? "system" : "explicit"} language`, async ({
        page,
        context,
        baseURL,
    }) => {
        test.setTimeout(45000);
        const { observed, rpc } = await fixture(
            page,
            context,
            baseURL,
            false,
            true,
            systemLanguage
        );
        const selected = "local-751db9d74d2cfe13";
        const catalogStarts = () =>
            page.evaluate(() =>
                window.__nativeStandbyFixture.calls
                    .filter((call) => call.command === "offline_media_endpoint")
                    .map((call) => call.preferredId)
            );
        await page.waitForFunction(
            () => window.commandChannelsReady && window.video?.currentTime > 0.1
        );
        expect(await catalogStarts()).toEqual([selected.slice(6)]);
        expect(
            await page.evaluate(() => window.curList[window.primaryIndex])
        ).toBe(selected);
        expect(await page.evaluate(() => window.cList.length)).toBe(1);
        await page.evaluate(() => {
            window.video.currentTime = 12;
        });
        await page.waitForFunction(
            () => !window.video.seeking && window.video.currentTime >= 12
        );
        const before = await page.evaluate(() => ({
            generation: window.__ottClassicPlayback.snapshot().generation,
            position: window.video.currentTime,
        }));
        expect((await rpc("lifecycle", { operation: "standby" })).status).toBe(
            "ok"
        );
        await page.waitForFunction(
            () =>
                window.__ottStandby.snapshot().state === "suspended" &&
                window.__ottActiveProviderDriver === null
        );
        expect(await page.evaluate(() => window.commandChannelsReady)).toBe(
            false
        );
        expect(await page.evaluate(() => window.video.paused)).toBe(true);
        expect((await rpc("lifecycle", { operation: "wake" })).status).toBe(
            "ok"
        );
        await expect
            .poll(catalogStarts)
            .toEqual([selected.slice(6), selected.slice(6)]);
        await page.waitForFunction(
            () =>
                window.commandChannelsReady &&
                !window.video.paused &&
                window.video.readyState >= 2 &&
                window.video.currentTime >= 12
        );
        const after = await page.evaluate(() => ({
            count: window.cList.length,
            generation: window.__ottClassicPlayback.snapshot().generation,
            position: window.video.currentTime,
            profile: window.__ottOfflineProfiles.selection(),
            provider: window.__ottActiveProviderDriver?.id,
            selected: window.curList[window.primaryIndex],
        }));
        expect(after.generation).toBeGreaterThan(before.generation);
        expect(after.position).toBeGreaterThanOrEqual(before.position - 0.5);
        expect(after).toMatchObject({
            count: 1,
            profile: selected,
            provider: "offline",
            selected,
        });
        await expect(page.locator("#list")).toBeHidden();
        await expect(page.locator("#dialogbox")).toBeHidden();
        expect(observed.catalogs).toBeGreaterThan(1);
        expect(observed.media.length).toBeGreaterThan(0);
        expect(observed.errors).toEqual([]);
    });
}

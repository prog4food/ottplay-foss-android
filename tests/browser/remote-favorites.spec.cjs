// Production bundles and authenticated command polling; no live providers.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

const TOKEN = "synthetic_favorites_" + "d".repeat(32);
const STREAM = "https://favorites-stream.fixture";
const media = path.resolve(__dirname, "../fixtures/media-runtime");

test.use({
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

test("current favorites survive reload and resolve the correct Stalker profile with fresh links", async ({
    page,
    context,
    baseURL,
}) => {
    test.setTimeout(90000);
    const local = new URL(baseURL).origin;
    const pending = [];
    const replies = new Map();
    const resolutions = [];
    const errors = [];
    let sequence = 0;
    let ticket = 0;
    let failedProfile = "";
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const headers = { "Access-Control-Allow-Origin": "*" };
        if (
            url.origin === local &&
            url.pathname.startsWith("/favorites-controller/")
        ) {
            expect(request.headers().authorization).toBe("Bearer " + TOKEN);
            if (url.pathname.endsWith("/api/responses")) {
                const response = request.postDataJSON();
                replies.set(response.id, response);
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
        if (url.pathname === "/stalker/api") {
            const portal = new URL(request.postDataJSON().url);
            const profile =
                portal.hostname === "second.fixture" ? "Second" : "First";
            const action = portal.searchParams.get("action");
            if (profile === failedProfile && action === "get_all_channels")
                return route.fulfill({
                    body: "Unavailable",
                    headers,
                    status: 503,
                });
            if (action === "create_link") {
                const cmd = portal.searchParams.get("cmd") || "";
                const id = cmd.includes("43") ? "43" : "42";
                const stream = `${STREAM}/${profile}/${id}/index.m3u8?ticket=${++ticket}`;
                resolutions.push({ id, profile, stream });
                return route.fulfill({
                    headers,
                    json: { js: { cmd: "ffmpeg " + stream } },
                });
            }
            const responses = {
                get_all_channels: {
                    data: [42, 43].map((id) => ({
                        cmd: "ffmpeg http://localhost/ch/" + id + "_",
                        id: String(id),
                        name: profile + " channel " + id,
                        tv_genre_id: "1",
                        use_http_tmp_link: 1,
                    })),
                    total_items: 2,
                },
                get_genres: [{ id: "1", title: "Fixture" }],
                get_profile: { blocked: "0", id: "1", status: "0" },
                handshake: { token: profile + "-synthetic-token" },
            };
            return route.fulfill({
                headers,
                json: { js: responses[action] || [] },
            });
        }
        if (url.origin === STREAM) {
            const playlist = url.pathname.endsWith(".m3u8");
            return route.fulfill({
                body: fs.readFileSync(
                    path.join(media, playlist ? "index.m3u8" : "segment00.ts")
                ),
                contentType: playlist
                    ? "application/vnd.apple.mpegurl"
                    : "video/mp2t",
                headers,
            });
        }
        if (url.origin === local) return route.continue();
        return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(() => {
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            this.muted = true;
            return play.call(this);
        };
        if (localStorage.getItem("favoritesFixtureSeeded")) return;
        localStorage.setItem("favoritesFixtureSeeded", "1");
        localStorage.setItem("ottplaylang", "_eng");
        localStorage.setItem("ottplayprov", "stalker");
        localStorage.setItem(
            "stalkerstalker_data",
            JSON.stringify({
                active: 0,
                portals: [
                    {
                        mac: "02:00:00:00:00:01",
                        name: "First portal",
                        portal: "https://first.fixture/c/",
                    },
                    {
                        mac: "02:00:00:00:00:02",
                        name: "Second portal",
                        portal: "https://second.fixture/c/",
                    },
                ],
            })
        );
    });
    async function ready(profile) {
        await page.waitForFunction(
            (profile) =>
                window.commandChannelsReady === true &&
                window.channels[42]?.channel_name === profile + " channel 42",
            profile
        );
    }
    async function rpc(action, params = {}) {
        const id = String(++sequence).padStart(32, "0");
        pending.push({ action, id, params });
        await expect.poll(() => replies.has(id), { timeout: 20000 }).toBe(true);
        return replies.get(id);
    }
    async function selectProfile(index) {
        await page.evaluate((index) => {
            window.__ottEditProvider();
            window.selIndex = index;
            window.listKeyHandler(window.keys.ENTER);
        }, index);
        await ready(index ? "Second" : "First");
    }
    await page.goto("/f/pc/");
    await ready("First");
    await page.keyboard.press("Shift");
    await page.evaluate(
        (token) =>
            window.__ottCommandServer.configure({
                address: location.origin + "/favorites-controller",
                enabled: true,
                token,
            }),
        TOKEN
    );
    let caps = await rpc("capabilities");
    expect(caps.data.favorites.operations).toContain("add");
    let runtime = caps.data.player.runtime;
    const favorite = (op, params = {}) =>
        rpc("favorites", { op, runtime, ...params });
    expect((await rpc("play", { query: "First channel 42" })).status).toBe(
        "ok"
    );
    await expect
        .poll(() =>
            resolutions.some(
                (row) => row.profile === "First" && row.id === "42"
            )
        )
        .toBe(true);
    await page.evaluate(() => {
        window.sPreview = 0;
        window._channelsList(window.catsArray.indexOf("Fixture"), 1);
    });
    const first = await favorite("add", { name: "First favorite" });
    expect(first.status).toBe("ok");
    expect(first.data.entry).toMatchObject({
        kind: "live",
        profile_number: 1,
        title: "First channel 42",
    });
    const again = await favorite("add", { name: "First favorite" });
    expect(again.data.entry.id).toBe(first.data.entry.id);
    expect(again.data.created).toBe(false);
    const sameProfileTicket = ticket;
    expect((await favorite("play", { id: first.data.entry.id })).status).toBe(
        "ok"
    );
    await expect.poll(() => ticket).toBeGreaterThan(sameProfileTicket);
    expect(resolutions.at(-1)).toMatchObject({ id: "42", profile: "First" });
    await expect(page.locator("#list_window")).toBeHidden();
    await selectProfile(1);
    expect((await rpc("play", { query: "Second channel 42" })).status).toBe(
        "ok"
    );
    await expect
        .poll(() =>
            resolutions.some(
                (row) => row.profile === "Second" && row.id === "42"
            )
        )
        .toBe(true);
    const second = await favorite("add", { name: "Second favorite" });
    expect(second.status).toBe("ok");
    expect(second.data.entry.profile_number).toBe(2);
    expect(second.data.entry.id).not.toBe(first.data.entry.id);
    const before = ticket;
    const back = await favorite("play", { id: first.data.entry.id });
    expect(back.status).toBe("ok");
    expect(back.data.dispatched).toBe(true);
    await ready("First");
    await expect.poll(() => ticket).toBeGreaterThan(before);
    expect(resolutions.at(-1)).toMatchObject({ id: "42", profile: "First" });
    const initialRuntime = runtime;
    await page.reload();
    await ready("First");
    caps = await rpc("capabilities");
    runtime = caps.data.player.runtime;
    expect(runtime).not.toBe(initialRuntime);
    const list = await favorite("list");
    expect(list.status).toBe("ok");
    expect(list.data.entries.map((entry) => entry.id).sort()).toEqual(
        [first.data.entry.id, second.data.entry.id].sort()
    );
    const afterReload = ticket;
    expect((await favorite("play", { id: second.data.entry.id })).status).toBe(
        "ok"
    );
    await ready("Second");
    await expect.poll(() => ticket).toBeGreaterThan(afterReload);
    expect(resolutions.at(-1)).toMatchObject({ id: "42", profile: "Second" });
    expect(new Set(resolutions.map((row) => row.stream)).size).toBe(
        resolutions.length
    );
    // A broken current profile must not trap the user away from saved channels.
    failedProfile = "First";
    await page.evaluate(() => {
        window.__ottEditProvider();
        window.selIndex = 0;
        window.listKeyHandler(window.keys.ENTER);
    });
    await page.waitForFunction(() => window.commandChannelsReady === false);
    const recoveryTicket = ticket;
    expect((await favorite("play", { id: second.data.entry.id })).status).toBe(
        "ok"
    );
    await ready("Second");
    await expect.poll(() => ticket).toBeGreaterThan(recoveryTicket);
    expect(resolutions.at(-1)).toMatchObject({ id: "42", profile: "Second" });
    expect(errors).toEqual([]);
});

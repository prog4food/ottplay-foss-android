const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

test.use({
    hasTouch: true,
    isMobile: true,
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
    viewport: { height: 851, width: 393 },
});
for (const provider of ["m3u", "vportal"]) {
    test(`strict kiosk consumes Android touch and restores the ${provider} lock`, async ({
        page,
        context,
        baseURL,
    }) => {
        test.setTimeout(60000);
        const origin = new URL(baseURL).origin;
        const pending = [],
            replies = [],
            portalRequests = [],
            errors = [];
        let sequence = 0;
        page.on("pageerror", (error) => errors.push(error.message));
        await context.route("**/*", async (route) => {
            const request = route.request(),
                url = new URL(request.url());
            if (url.pathname.startsWith("/fixture-control/")) {
                if (request.method() === "POST") {
                    if (url.pathname.endsWith("/responses"))
                        replies.push(request.postDataJSON());
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
            if (url.pathname.endsWith("/vportal/api")) {
                const body = request.postDataJSON();
                portalRequests.push(body);
                if (body.params.cmd === "play")
                    return route.fulfill({
                        json: {
                            type: "stream",
                            url:
                                origin +
                                "/fixture/video.m3u8?id=" +
                                body.params.id,
                        },
                    });
                return route.fulfill({
                    json: {
                        items: [
                            {
                                request: { cmd: "play", id: 1 },
                                title: "Три кота — 1",
                                type: "stream",
                            },
                            {
                                request: { cmd: "play", id: 2 },
                                title: "Три кота — 2",
                                type: "stream",
                            },
                            {
                                request: { cmd: "play", id: 3 },
                                title: "Другой мультфильм",
                                type: "stream",
                            },
                        ],
                        type: "videoportal",
                    },
                });
            }
            if (url.pathname === "/fixture/live.m3u")
                return route.fulfill({
                    body:
                        "#EXTM3U\n#EXTINF:-1,Fixture TV\n" +
                        origin +
                        "/fixture/video.m3u8\n",
                    contentType: "application/vnd.apple.mpegurl",
                });
            if (url.pathname === "/fixture/video.m3u8")
                return route.fulfill({
                    body:
                        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n" +
                        Array.from(
                            { length: 60 },
                            (_, i) =>
                                (i ? "#EXT-X-DISCONTINUITY\n" : "") +
                                "#EXTINF:2.000000,\nsegment00.ts?segment=" +
                                i +
                                "\n"
                        ).join("") +
                        "#EXT-X-ENDLIST\n",
                    contentType: "application/vnd.apple.mpegurl",
                });
            if (url.pathname === "/fixture/segment00.ts")
                return route.fulfill({
                    body: fs.readFileSync(
                        path.resolve(
                            __dirname,
                            "../fixtures/media-runtime/segment00.ts"
                        )
                    ),
                    contentType: "video/mp2t",
                });
            return url.origin === origin ? route.continue() : route.abort();
        });
        await context.routeWebSocket("**/*", (socket) => socket.close());
        await context.addInitScript(
            ({ provider, origin }) => {
                if (localStorage.getItem("ottplayprov")) return;
                localStorage.setItem("ottplaylang", "_eng");
                localStorage.setItem("ottplayprov", provider);
                localStorage.setItem(
                    "m3um3uArr",
                    JSON.stringify({
                        active: 0,
                        M3Us: [
                            {
                                medUrl: "portal::[key:FIXTURE_M3U]https://m3u.fixture/api/",
                                name: "M3U fixture",
                                rechours: 0,
                                www: origin + "/fixture/live.m3u",
                            },
                        ],
                    })
                );
                localStorage.setItem(
                    "vportalprofiles",
                    JSON.stringify({
                        active: 0,
                        portals: Array.from({ length: 15 }, (_, i) => ({
                            link:
                                i < 2
                                    ? "portal::[key:FIXTURE_VP_" +
                                      (i + 1) +
                                      "]https://vp" +
                                      (i + 1) +
                                      ".fixture/api/"
                                    : "",
                            name: "VPortal fixture " + (i + 1),
                            sections:
                                i < 2 ? [{ request: {}, title: "Root" }] : [],
                        })),
                    })
                );
                const play = HTMLMediaElement.prototype.play;
                HTMLMediaElement.prototype.play = function () {
                    this.muted = true;
                    return play.call(this);
                };
            },
            { origin, provider }
        );
        await page.goto("/f/pc/");
        await page.waitForFunction(
            (provider) =>
                window.commandChannelsReady === true &&
                (provider === "m3u" || !!window.providerMediaClient),
            provider
        );
        if (provider === "m3u") {
            expect(portalRequests).toHaveLength(0);
            expect(
                await page.evaluate(() => window.providerMediaClient)
            ).toBeFalsy();
            expect(
                await page.evaluate(
                    () =>
                        JSON.parse(localStorage.getItem("m3um3uArr")).M3Us[0]
                            .medUrl
                )
            ).toBe("portal::[key:FIXTURE_M3U]https://m3u.fixture/api/");
        }
        await page.evaluate(() =>
            window.__ottCommandServer.configure({
                address: location.origin + "/fixture-control",
                enabled: true,
                token: "SYNTHETIC_COMMAND_TOKEN_0123456789abcdef",
            })
        );
        async function rpc(action, params) {
            const count = replies.length;
            pending.push({ action, params });
            await expect.poll(() => replies.length).toBe(count + 1);
            return replies[count];
        }
        if (provider === "vportal") {
            expect(
                (await rpc("vportal", { query: "три кота" })).data.total
            ).toBe(2);
        }
        await page.waitForFunction(
            () => document.querySelector("video")?.currentTime > 0.2
        );
        await page.evaluate(() => window.infoBox("Existing local dialog"));
        const lock = await rpc("kiosk", {
            mode: "on",
            strict: true,
            ...(provider === "m3u" ? { query: "Fixture" } : {}),
        });
        expect(lock.status).toBe("ok");
        expect(lock.data).toMatchObject({
            provider,
            state: "locked",
            strict: true,
        });
        if (provider === "vportal") expect(lock.data.media.total).toBe(2);
        await expect(page.locator("html")).toHaveClass(/ott-kiosk-strict/);
        await expect(page.locator("#dialogbox")).toBeHidden();
        const before = await page.evaluate(
            () => document.querySelector("video").currentTime
        );
        const cdp = await context.newCDPSession(page);
        const touch = (type, points) =>
            cdp.send("Input.dispatchTouchEvent", {
                touchPoints: points.map(([x, y, id = 1]) => ({ id, x, y })),
                type,
            });
        // Ordinary taps never expand details; only the media progress bar can seek.
        await page.evaluate(() => window.infoBarHide());
        await page.touchscreen.tap(195, 300);
        await expect(page.locator("#info1")).toBeVisible();
        for (const [x, y] of [
            [10, 10],
            [380, 10],
            [10, 800],
            [380, 800],
            [195, 800],
            [195, 300],
        ])
            await page.touchscreen.tap(x, y);
        await expect(page.locator("#descr")).toBeHidden();
        await expect(page.locator("#audio_badge")).toBeHidden();
        await expect(page.locator("#progress_span")).toBeHidden();
        // Swipes, multi-touch and long presses have no action; repeated taps stay read-only.
        await page.evaluate(() => window.infoBarHide());
        await touch("touchStart", [[100, 300]]);
        await touch("touchMove", [[300, 500]]);
        await touch("touchMove", [[100, 300]]);
        await touch("touchEnd", []);
        await expect(page.locator("#info1")).toBeHidden();
        await touch("touchStart", [
            [100, 300, 1],
            [250, 400, 2],
        ]);
        await touch("touchEnd", []);
        await expect(page.locator("#info1")).toBeHidden();
        await touch("touchStart", [[195, 300]]);
        await page.waitForTimeout(700);
        await touch("touchEnd", []);
        await expect(page.locator("#info1")).toBeHidden();
        await page.touchscreen.tap(195, 300);
        await page.touchscreen.tap(195, 300);
        for (const key of [
            "Escape",
            "Enter",
            "Space",
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "1",
            "Tab",
        ])
            await page.keyboard.press(key);
        await expect(page.locator("#list")).toBeHidden();
        await expect(page.locator("#descr")).toBeHidden();
        expect(
            await page.evaluate(() => document.querySelector("video").paused)
        ).toBe(false);
        const after = await page.evaluate(
            () => document.querySelector("video").currentTime
        );
        expect(after).toBeGreaterThan(before);
        expect(after - before).toBeLessThan(10);
        if (provider === "vportal") {
            const bar = await page.locator("#progress_div").boundingBox();
            expect(bar.height).toBeGreaterThanOrEqual(24);
            const y = bar.y + bar.height / 2;
            const currentItem = await page.evaluate(
                () => window.__ottMedia.current().ref.itemId
            );
            await page.touchscreen.tap(bar.x + bar.width * 0.75, y);
            await expect
                .poll(() =>
                    page.evaluate(
                        () => document.querySelector("video").currentTime
                    )
                )
                .toBeGreaterThan(85);
            await page.touchscreen.tap(bar.x + bar.width * 0.25, y);
            await expect
                .poll(() =>
                    page.evaluate(
                        () => document.querySelector("video").currentTime
                    )
                )
                .toBeLessThan(35);
            await touch("touchStart", [[bar.x + bar.width * 0.25, y]]);
            await touch("touchMove", [[bar.x + bar.width * 0.6, y]]);
            await touch("touchEnd", []);
            await expect
                .poll(() =>
                    page.evaluate(
                        () => document.querySelector("video").currentTime
                    )
                )
                .toBeGreaterThan(68);
            expect(
                await page.evaluate(
                    () => window.__ottMedia.current().ref.itemId
                )
            ).toBe(currentItem);
            expect((await rpc("kiosk", { mode: "status" })).data).toMatchObject(
                { media: { total: 2 }, strict: true }
            );
            await expect(page.locator("#list")).toBeHidden();
            await expect(page.locator("#descr")).toBeHidden();
        }
        expect((await rpc("profile", { number: 2 })).status).toBe("rejected");
        await page.evaluate(() => {
            window.infoBarHide();
            window.$("#buffering").show();
        });
        await page.touchscreen.tap(195, 300);
        await expect(page.locator("#info1")).toBeVisible();
        await expect(page.locator("#info1")).toBeHidden({ timeout: 6500 });
        await page.reload();
        await page.waitForFunction(() => window.commandChannelsReady === true);
        await expect(page.locator("html")).toHaveClass(/ott-kiosk-strict/);
        await page.waitForFunction(
            () => document.querySelector("video")?.currentTime > 0.2
        );
        const restored = await rpc("kiosk", { mode: "status" });
        expect(restored.data).toMatchObject({
            provider,
            state: "locked",
            strict: true,
        });
        expect(restored.data.channel).toEqual(lock.data.channel);
        if (provider === "vportal") expect(restored.data.media.total).toBe(2);
        await page.touchscreen.tap(195, 300);
        await expect(page.locator("#info1")).toBeVisible();
        const unlock = await rpc("kiosk", { mode: "off" });
        expect(unlock.data).toMatchObject({ state: "off", strict: false });
        await expect(page.locator("html")).not.toHaveClass(/ott-kiosk-strict/);
        await page.touchscreen.tap(195, 10);
        await expect(page.locator("#list")).toBeVisible();
        if (provider === "m3u") expect(portalRequests).toHaveLength(0);
        expect(errors).toEqual([]);
    });
}

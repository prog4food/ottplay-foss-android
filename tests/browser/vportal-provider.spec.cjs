const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const link = "portal::[key:FIXTURE_VPORTAL_SECRET]https://portal.fixture/api/";
test.use({
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});
test("VPortal flat channel playlist locks playback and restores after reload", async ({
    page,
    context,
    baseURL,
}) => {
    const origin = new URL(baseURL).origin;
    let resolutions = 0;
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/vportal/api")) {
            const body = route.request().postDataJSON();
            expect(body.params.key).toBe("FIXTURE_VPORTAL_SECRET");
            if (body.params.cmd === "play") {
                resolutions++;
                return route.fulfill({
                    json: {
                        type: "stream",
                        url:
                            origin +
                            "/fixture/video.m3u8?attempt=" +
                            resolutions,
                    },
                });
            }
            return route.fulfill({
                json: {
                    items: [
                        {
                            request: { cmd: "play", id: 42 },
                            title: "Fixture film",
                            type: "stream",
                        },
                    ],
                    type: "videoportal",
                },
            });
        }
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
        if (url.origin === origin) return route.continue();
        return route.abort();
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript((link) => {
        if (!localStorage.getItem("vportalprofiles")) {
            localStorage.setItem("ottplaylang", "_rus");
            localStorage.setItem("ottplayprov", "vportal");
            localStorage.setItem(
                "vportalprofiles",
                JSON.stringify({
                    active: 0,
                    portals: Array.from({ length: 15 }, (_, i) => ({
                        link: i ? "" : link,
                        name: i ? "" : "Кино",
                        sections: i ? [] : [{ request: {}, title: "Root" }],
                    })),
                })
            );
            localStorage.setItem("m3um3uArr", "M3U_MUST_NOT_CHANGE");
        }
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            this.muted = true;
            return play.call(this);
        };
    }, link);
    await page.goto("/f/pc/");
    await expect
        .poll(() => page.evaluate(() => window.commandChannelsReady))
        .toBe(true);
    expect(await page.evaluate(() => window.cList.length)).toBe(1);
    await page.waitForFunction(
        () => document.querySelector("video")?.currentTime > 0.2
    );
    await page.evaluate(() => window.channelsList(0, 0));
    await expect(page.locator("#list")).toContainText("Fixture film");
    await page.evaluate(() => window.showProviderSelection());
    await expect(page.locator("#list")).toContainText("VPortal");
    await page.evaluate(() => window.__ottEditProvider());
    await expect(page.locator("#listCaption")).toHaveText("Профили VPortal");
    await page.screenshot({
        path: test.info().outputPath("vportal-profiles-ru.png"),
    });
    expect(await page.locator("#list").innerText()).not.toContain(
        "FIXTURE_VPORTAL_SECRET"
    );
    await page.evaluate(() => window.channelsList(0, 0));
    await expect(page.locator("#list")).toContainText("Fixture film");
    await page.evaluate(() => {
        window.selIndex = 0;
        window.listKeyHandler(window.keys.ENTER);
    });
    await page.waitForFunction(
        () => document.querySelector("video")?.currentTime > 0.2
    );
    const lock = await page.evaluate(
        () =>
            new Promise((resolve) =>
                window.__ottKiosk.request(
                    { mode: "on", query: "Fixture film" },
                    resolve
                )
            )
    );
    expect(lock.status).toBe("ok");
    expect(lock.data.media).toBeUndefined();
    expect(lock.data.channel, JSON.stringify(lock)).toBeTruthy();
    const stored = await page.evaluate(() =>
        localStorage.getItem("__ottKioskV1")
    );
    expect(stored).not.toContain("video.m3u8");
    expect(stored).not.toContain("FIXTURE_VPORTAL_SECRET");
    const before = resolutions;
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.__ottKiosk.locked())).toBe(true);
    await page.reload();
    await expect.poll(() => resolutions).toBeGreaterThan(before);
    await page.waitForFunction(
        () => document.querySelector("video")?.currentTime > 0.2
    );
    expect(await page.evaluate(() => window.__ottKiosk.snapshot().state)).toBe(
        "locked"
    );
    expect(await page.evaluate(() => localStorage.getItem("m3um3uArr"))).toBe(
        "M3U_MUST_NOT_CHANGE"
    );
    const unlock = await page.evaluate(
        () =>
            new Promise((resolve) =>
                window.__ottKiosk.request({ mode: "off" }, resolve)
            )
    );
    expect(unlock.data.state).toBe("off");
    await page.evaluate(() => window.showProviderSelection());
    await expect(page.locator("#list")).toContainText("VPortal");
});

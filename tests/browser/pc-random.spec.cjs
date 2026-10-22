// Actual bundled keyboard dispatcher and provider/media adapters. Only network
// sources are synthetic; selection, PIN/kiosk policy and decoding run normally.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("../helpers/browser-test.cjs");

const mediaRoot = path.resolve(__dirname, "../fixtures/media-runtime");
test.use({
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

async function boot(page, context, baseURL) {
    const origin = new URL(baseURL).origin;
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort("blockedbyclient");
        if (url.pathname === "/random-fixture/channels.m3u")
            return route.fulfill({
                body:
                    '#EXTM3U\n#EXTINF:-1 group-title="Selected group",Fixture One\n' +
                    origin +
                    "/random-fixture/index.m3u8?id=one\n" +
                    '#EXTINF:-1 group-title="Selected group",Fixture Two\n' +
                    origin +
                    "/random-fixture/index.m3u8?id=two\n" +
                    '#EXTINF:-1 group-title="Other group",Outside\n' +
                    origin +
                    "/random-fixture/index.m3u8?id=outside\n",
                contentType: "application/vnd.apple.mpegurl",
            });
        if (url.pathname === "/nas/config")
            return route.fulfill({
                json: {
                    api: "/nas/api",
                    enabled: true,
                    sourceId: "synology:random-fixture",
                    title: "Random media fixture",
                },
            });
        if (url.pathname === "/nas/api") {
            const request = route.request().postDataJSON();
            return route.fulfill({
                json:
                    request.cmd === "play"
                        ? {
                              type: "stream",
                              url:
                                  origin +
                                  "/random-fixture/index.m3u8?id=" +
                                  request.id,
                          }
                        : {
                              items: [1, 2].map((id) => ({
                                  request: { cmd: "play", id: "film:" + id },
                                  title: "Film " + id,
                                  type: "stream",
                              })),
                              title: "Random media fixture",
                              type: "multistream",
                          },
            });
        }
        if (url.pathname.startsWith("/random-fixture/")) {
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
    await context.addInitScript((origin) => {
        localStorage.setItem("ottplaylang", "_eng");
        localStorage.setItem("ottplayprov", "m3u");
        localStorage.setItem("m3usPlayers", "1");
        localStorage.setItem(
            "m3um3uArr",
            JSON.stringify({
                active: 0,
                M3Us: [{ www: origin + "/random-fixture/channels.m3u" }],
            })
        );
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            this.muted = true;
            return play.call(this);
        };
    }, origin);
    await page.goto("/f/pc/");
    await page.waitForFunction(() => window.commandChannelsReady === true);
    await page.evaluate(() => {
        const group = window.catsArray.indexOf("Selected group");
        if (group < 0) throw new Error("Fixture group was not loaded");
        window.playChannel(group, 0, true);
    });
    await page.waitForFunction(() => window.video.currentTime > 0.1);
    return errors;
}

async function channelState(page) {
    return page.evaluate(() => ({
        category: window.catsArray[window.catIndex],
        id: window.curList[window.primaryIndex],
        order: window.curList.slice(),
    }));
}

test("PC R changes only the current channel list and respects keyboard owners", async ({
    page,
    context,
    baseURL,
}) => {
    const errors = await boot(page, context, baseURL);
    const first = await channelState(page);
    await page.keyboard.press("l");
    await page.waitForFunction(() => !!document.fullscreenElement);
    await page.locator("#video").focus();
    await page.keyboard.press("r");
    await expect
        .poll(async () => (await channelState(page)).id)
        .not.toBe(first.id);
    const second = await channelState(page);
    expect(second.category).toBe("Selected group");
    expect(second.order).toEqual(first.order);

    // Hold/repeat must not select again. Keyup followed by keydown is a new action.
    await page.keyboard.down("r");
    const held = await channelState(page);
    await page.keyboard.down("r");
    expect(await channelState(page)).toEqual(held);
    await page.keyboard.up("r");

    await page.evaluate(() =>
        window.channelsList(window.catIndex, window.primaryIndex)
    );
    const listed = await channelState(page);
    await page.keyboard.press("r");
    await expect
        .poll(async () => (await channelState(page)).id)
        .not.toBe(listed.id);
    expect((await channelState(page)).order).toEqual(first.order);

    await page.evaluate(() => {
        window.channelsList(window.catIndex, window.primaryIndex);
        window.__ottChannelSearch.open();
    });
    await page.locator("#editvar").fill("Fixture");
    await page.locator("#editvar").press("Enter");
    await expect(page.locator("#listIn")).toContainText("Fixture One");
    await expect(page.locator("#listIn")).not.toContainText("Outside");
    const beforeSearch = await channelState(page);
    await page.keyboard.press("r");
    await expect
        .poll(async () => (await channelState(page)).id)
        .not.toBe(beforeSearch.id);
    expect((await channelState(page)).category).toBe("Selected group");

    await page.evaluate(() => {
        window.popupList();
        window.editCaption = "Playlist name";
        window.editvar = "";
        window.editKey = window.editKey2;
        window.setEdit = function () {};
        window.showEditKey2();
    });
    const beforeEdit = await channelState(page);
    await page.locator("#editvar").press("r");
    await expect(page.locator("#editvar")).toHaveValue("r");
    expect(await channelState(page)).toEqual(beforeEdit);
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.closeList());

    const locked = await page.evaluate(
        () =>
            new Promise((resolve) =>
                window.__ottKiosk.request(
                    { mode: "on", query: "Fixture One", strict: true },
                    resolve
                )
            )
    );
    expect(locked.status).toBe("ok");
    await page.waitForFunction(() => window.__ottKiosk.strict());
    const beforeLock = await channelState(page);
    await page.keyboard.press("r");
    expect(await channelState(page)).toEqual(beforeLock);
    await page.evaluate(
        () =>
            new Promise((resolve) =>
                window.__ottKiosk.request({ mode: "off" }, resolve)
            )
    );
    expect(errors).toEqual([]);
});

test("PC R selects a media item without shuffling the displayed folder", async ({
    page,
    context,
    baseURL,
}) => {
    const errors = await boot(page, context, baseURL);
    await page.waitForFunction(() => window.__ottNasLibrary?.available());
    await page.evaluate(() =>
        window.__ottMenuRegistry.open(window).invoke("media.nas")
    );
    await expect(page.locator("#listIn")).toContainText("Film 1");
    const order = await page.evaluate(() =>
        window.__ottMedia.snapshot().frame.items.map((item) => item.title)
    );
    await page.keyboard.press("r");
    await expect
        .poll(() =>
            page.evaluate(() => window.__ottClassicPlayback.programme()?.title)
        )
        .toMatch(/Film [12]$/);
    await page.waitForFunction(() => window.video.currentTime > 0.1);
    const title = await page.evaluate(
        () => window.__ottClassicPlayback.programme().title
    );
    await page.keyboard.press("l");
    await page.waitForFunction(() => !!document.fullscreenElement);
    await page.locator("#video").focus();
    await page.keyboard.press("r");
    await expect
        .poll(() =>
            page.evaluate(() => window.__ottClassicPlayback.programme()?.title)
        )
        .not.toBe(title);
    expect(
        await page.evaluate(() =>
            window.__ottMedia.snapshot().frame.items.map((item) => item.title)
        )
    ).toEqual(order);
    expect(errors).toEqual([]);
});

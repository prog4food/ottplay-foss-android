const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

test("NAS stays out of Settings but opens from the popup and plays its default HLS stream", async ({
    page,
    context,
    baseURL,
}) => {
    const origin = new URL(baseURL).origin;
    const requests = [];
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort("blockedbyclient");
        if (url.pathname === "/nas/config")
            return route.fulfill({
                json: {
                    api: "/nas/api",
                    enabled: true,
                    sourceId: "synology:browser-fixture",
                    title: "Synology",
                },
            });
        if (url.pathname === "/nas/api") {
            const body = route.request().postDataJSON();
            requests.push(body);
            if (body.cmd === "play")
                return route.fulfill({
                    json: {
                        type: "stream",
                        url: origin + "/nas/fixture/index.m3u8",
                        variants: {
                            Compatible: origin + "/nas/fixture/index.m3u8",
                            Original: origin + "/must-not-play.avi",
                        },
                    },
                });
            return route.fulfill({
                json: {
                    controls: { search: true },
                    items: [
                        {
                            request: { cmd: "play", id: "item:1" },
                            title: "NAS video",
                            type: "stream",
                        },
                    ],
                    title: "Synology",
                    type: "category",
                },
            });
        }
        if (url.pathname.startsWith("/nas/fixture/")) {
            const segment = url.pathname.endsWith(".ts");
            return route.fulfill({
                body: fs.readFileSync(
                    path.resolve(
                        __dirname,
                        "../fixtures/media-runtime",
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
    await context.addInitScript(() => {
        localStorage.setItem("ottplaylang", "_eng");
        localStorage.setItem("ottplayprov", "demo");
    });
    await page.goto("/f/pc/");
    await page.waitForFunction(
        () =>
            window.__ottDevice &&
            window.__ottNasLibrary?.available() &&
            !document.body.classList.contains("booting")
    );
    await page.evaluate(() => {
        window.stbStop();
        window.__beforeNasProvider = [
            window.getMediaArray,
            window.playMedia,
            window.providerGetItem,
            window.providerSetItem,
        ];
        window.sFavorites = 1;
        window.optionsList();
    });
    await expect(page.locator("#listCaption")).toHaveText("Settings");
    await expect(page.locator("#listIn")).not.toContainText("Synology");
    expect(await page.evaluate(() => window.listArray)).not.toContain(
        "Synology"
    );
    await page.evaluate(() => window.listKeyHandlerFn(window.keys.RETURN));
    await expect(page.locator("#listCaption")).toHaveText("Menu");
    expect(
        await page.evaluate(() =>
            window.listArray
                .filter((row) => row.id === "media.nas")
                .map((row) => ({ id: row.id, name: row.name }))
        )
    ).toEqual([{ id: "media.nas", name: "Synology" }]);
    await page.evaluate(() =>
        window.__ottMenuRegistry.open(window).invoke("media.nas")
    );
    await expect(page.locator("body")).toContainText("NAS video");
    await page.evaluate(() => {
        const view = window.__ottMedia.snapshot();
        const index = view.frame.items.findIndex(
            (item) => item.title === "NAS video"
        );
        if (index < 0)
            throw new Error("NAS item is absent from the rendered library");
        window.__ottMedia.select(index);
    });
    await page.waitForFunction(() =>
        Array.from(document.querySelectorAll("video")).some(
            (video) => video.currentTime > 0.2 && !video.error
        )
    );
    expect(
        await page.evaluate(() =>
            window.__beforeNasProvider.every(
                (value, index) =>
                    value ===
                    [
                        window.getMediaArray,
                        window.playMedia,
                        window.providerGetItem,
                        window.providerSetItem,
                    ][index]
            )
        )
    ).toBe(true);
    expect(requests.some((request) => request.cmd === "play")).toBe(true);
    expect(
        requests.every((request) => request.app === "ott-play" && !request.key)
    ).toBe(true);
    expect(errors).toEqual([]);
    await page.evaluate(() => window.stbStop());
});

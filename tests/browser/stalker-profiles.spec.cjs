const { test, expect } = require("@playwright/test");

test("Stalker profiles migrate, switch catalogs and restore selection after reload", async ({
    page,
    context,
    baseURL,
}) => {
    const local = new URL(baseURL).origin;
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/stalker/api") {
            const request = route.request().postDataJSON();
            const portal = new URL(request.url);
            const second = portal.hostname === "second.fixture";
            const action = portal.searchParams.get("action");
            const responses = {
                get_all_channels: {
                    data: [
                        {
                            cmd: "https://media.fixture/live.m3u8",
                            id: "42",
                            name: second ? "Second channel" : "First channel",
                            tv_genre_id: "1",
                            use_http_tmp_link: 0,
                        },
                    ],
                    total_items: 1,
                },
                get_genres: [{ id: "1", title: "Fixture" }],
                get_profile: { blocked: "0", id: "1", status: "0" },
                handshake: { token: second ? "second-token" : "first-token" },
            };
            return route.fulfill({
                headers: { "access-control-allow-origin": "*" },
                json: { js: responses[action] || [] },
            });
        }
        if (url.origin === local) return route.continue();
        return route.abort();
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(() => {
        localStorage.setItem("ottplaylang", "_eng");
        localStorage.setItem("ottplayprov", "stalker");
        if (!localStorage.getItem("stalkerstalker_data"))
            localStorage.setItem(
                "stalkerstalker_data",
                JSON.stringify({
                    mac: "02:00:00:00:00:01",
                    portal: "https://first.fixture/c/",
                })
            );
    });
    async function channels(name) {
        await page.waitForFunction(
            (name) =>
                window.commandChannelsReady === true &&
                window.channels[42]?.channel_name === name,
            name
        );
    }
    async function openProfiles() {
        await page.evaluate(() => window.__ottEditProvider());
        await expect(page.locator("#listCaption")).toHaveText(
            "Select Stalker portal"
        );
        expect(await page.evaluate(() => window.listArray.length)).toBe(15);
    }
    await page.goto("/f/pc/");
    await channels("First channel");
    await openProfiles();
    await page.evaluate(() => {
        window.selIndex = 1;
        window.listKeyHandler(window.keys.ENTER);
    });
    await expect(page.locator("#listCaption")).toHaveText(
        "Stalker portal provider"
    );
    await page.evaluate(() => {
        for (const [index, value] of [
            [0, "https://second.fixture/c/"],
            [1, "02:00:00:00:00:02"],
            [2, "Second portal"],
        ]) {
            window.selIndex = index;
            window.listKeyHandler(window.keys.ENTER);
            window.editvar = value;
            window.setEdit();
        }
        window.selIndex = 4;
        window.listKeyHandler(window.keys.ENTER);
    });
    await channels("Second channel");
    await page.reload();
    await channels("Second channel");
    await openProfiles();
    expect(await page.evaluate(() => window.selIndex)).toBe(1);
    await expect(page.locator("#list")).toContainText("Second portal");
    await page.evaluate(() => {
        window.selIndex = 0;
        window.listKeyHandler(window.keys.ENTER);
    });
    await channels("First channel");
    await openProfiles();
    await page.evaluate(() => {
        window.selIndex = 1;
        window.listKeyHandler(window.keys.ENTER);
    });
    await channels("Second channel");
    expect(errors).toEqual([]);
});

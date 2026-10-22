// Real Chromium tab pixels from getDisplayMedia + ImageCapture, not a DOM renderer.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const CONTROLLER = "https://screenshots.fixture.invalid";
const TOKEN = "screenshot_fixture_" + "d".repeat(32);
test.use({
    channel: "chromium",
    launchOptions: {
        args: [
            "--auto-select-tab-capture-source-by-title=OTT screenshot acceptance",
            "--allow-http-screen-capture",
        ],
    },
});
async function setup(page, context, baseURL) {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(baseURL).origin) return route.continue();
        if (url.origin === CONTROLLER)
            return route.fulfill({
                headers: {
                    "Access-Control-Allow-Headers":
                        "Authorization, Content-Type",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Origin": new URL(baseURL).origin,
                },
                json: { commands: [] },
            });
        return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(() => {
        localStorage.setItem("ottplaylang", "_eng");
        const get = navigator.mediaDevices.getDisplayMedia.bind(
            navigator.mediaDevices
        );
        navigator.mediaDevices.getDisplayMedia = (options) =>
            get(options).catch((error) => {
                window.__screenshotTestError = {
                    message: error.message,
                    name: error.name,
                };
                throw error;
            });
    });
    await page.goto("/f/pc/");
    await page.waitForFunction(
        () =>
            !!window.__ottRemoteScreenshot &&
            typeof executeRemoteRequest === "function"
    );
    await page.evaluate(
        ({ address, token }) => {
            document.title = "OTT screenshot acceptance";
            window.__ottCommandServer.configure({
                address,
                enabled: true,
                token,
            });
            window.optionsList(window.settingsCommands);
        },
        { address: CONTROLLER, token: TOKEN }
    );
    await page.keyboard.press("Enter");
    await expect(page.locator("#remoteSettingsContent")).toBeVisible();
    return errors;
}
async function rpc(page, action, params = {}) {
    return page.evaluate(
        ({ action, params }) =>
            new Promise((resolve) =>
                executeRemoteRequest({ action, params }, resolve)
            ),
        { action, params }
    );
}
test("real tab capture includes settings, fresh pixels, browser stop and reload", async ({
    page,
    context,
    baseURL,
}, testInfo) => {
    const errors = await setup(page, context, baseURL);
    const initial = (await rpc(page, "capabilities")).data;
    expect(initial.screenshot).toEqual({
        source: null,
        state: "permission_required",
    });
    expect(
        (await rpc(page, "screenshot", { runtime: initial.player.runtime }))
            .status
    ).toBe("rejected");
    await page.locator("#remoteScreenshotToggle").click();
    await expect
        .poll(() =>
            page.evaluate(() =>
                JSON.stringify({
                    error: window.__screenshotTestError,
                    state: window.__ottRemoteScreenshot.snapshot().state,
                })
            )
        )
        .toBe(JSON.stringify({ state: "ready" }));
    // The configured controller is allowed to inspect the settings screen too.
    expect(
        (await rpc(page, "screenshot", { runtime: initial.player.runtime }))
            .status
    ).toBe("ok");
    await page.keyboard.press("Escape");
    await expect(page.locator("#remoteSettingsContent")).toHaveCount(0);
    // A new marker verifies the screenshot did not reuse the permission-dialog frame.
    await page.evaluate(() => {
        const marker = document.createElement("div");
        marker.id = "shot-marker";
        marker.style.cssText =
            "position:fixed;left:0;top:0;width:80px;height:80px;background:rgb(12,34,210);z-index:999999";
        document.body.appendChild(marker);
    });
    const result = await rpc(page, "screenshot", {
        runtime: initial.player.runtime,
    });
    expect(result.status).toBe("ok");
    expect(result.data.source).toBe("browser-tab");
    expect(result.data.mime).toBe("image/png");
    expect(result.data.runtime).toBe(initial.player.runtime);
    expect(result.data.width).toBeLessThanOrEqual(1280);
    expect(result.data.height).toBeLessThanOrEqual(720);
    const image = Buffer.from(result.data.image, "base64");
    expect(image.length).toBeLessThanOrEqual(1048576);
    const pixel = await page.evaluate(async (data) => {
        const img = await createImageBitmap(
            await (await fetch("data:image/png;base64," + data)).blob()
        );
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        c.getContext("2d").drawImage(img, 0, 0);
        img.close();
        return Array.from(c.getContext("2d").getImageData(20, 20, 1, 1).data);
    }, result.data.image);
    const file = testInfo.outputPath("remote-player-tab.png");
    fs.writeFileSync(file, image, { mode: 0o600 });
    await testInfo.attach("actual remote tab PNG", {
        contentType: "image/png",
        path: file,
    });
    // Allow bounded YUV/RGB screen-capture conversion error, while proving a new blue frame.
    [12, 34, 210, 255].forEach((expected, index) =>
        expect(Math.abs(pixel[index] - expected)).toBeLessThanOrEqual(8)
    );
    await page.locator("#remoteScreenshotIndicator").click();
    expect((await rpc(page, "capabilities")).data.screenshot.state).toBe(
        "permission_required"
    );
    expect(
        (await rpc(page, "screenshot", { runtime: initial.player.runtime }))
            .status
    ).toBe("rejected");
    await page.reload();
    await page.waitForFunction(() => !!window.__ottRemoteScreenshot);
    expect((await rpc(page, "capabilities")).data.screenshot.state).toBe(
        "permission_required"
    );
    expect(errors).toEqual([]);
});
test("unsupported browser has no capture source action or image fallback", async ({
    page,
    context,
    baseURL,
}) => {
    await context.addInitScript(() => {
        Object.defineProperty(window, "ImageCapture", { value: undefined });
    });
    const errors = await setup(page, context, baseURL);
    await expect(page.locator("#remoteScreenshotToggle")).toBeHidden();
    await expect(page.locator("#remoteScreenshotToggle")).toBeDisabled();
    const caps = (await rpc(page, "capabilities")).data;
    expect(caps.screenshot.state).toBe("unsupported");
    expect(
        (await rpc(page, "screenshot", { runtime: caps.player.runtime })).status
    ).toBe("unsupported");
    expect(errors).toEqual([]);
});

test("local Connect selects a browser source and Disconnect revokes capture", async ({
    page,
    context,
    baseURL,
}) => {
    const errors = await setup(page, context, baseURL);
    await expect(page.locator("#remoteDiagnosticsToggle")).toHaveCount(0);
    await expect(page.locator("#remoteDiagnosticsTrust")).toHaveCount(0);
    await page.locator("#commandServerConnect").click();
    await expect(page.locator("#commandServerConnectLabel")).toHaveText(
        "Connect"
    );
    await page.locator("#commandServerConnect").click();
    await expect
        .poll(
            async () => (await rpc(page, "capabilities")).data.screenshot.state
        )
        .toBe("ready");
    const caps = (await rpc(page, "capabilities")).data;
    expect(
        (await rpc(page, "screenshot", { runtime: caps.player.runtime })).status
    ).toBe("ok");
    await page.locator("#commandServerConnect").click();
    expect((await rpc(page, "capabilities")).data.screenshot.state).toBe(
        "permission_required"
    );
    expect(
        (await rpc(page, "screenshot", { runtime: caps.player.runtime })).status
    ).toBe("rejected");
    await expect(page.locator("#remoteScreenshotIndicator")).toHaveCount(0);
    expect(errors).toEqual([]);
});

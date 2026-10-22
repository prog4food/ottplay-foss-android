// The classic player and HLS decoder run normally. Only desktop WCO signals
// and titlebar environment values are simulated; native Chrome is checked separately.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const root = path.resolve(__dirname, "../..");
const css = fs.readFileSync(
    path.join(root, "js/browser-app/window-controls.css"),
    "utf8"
);
const mediaRoot = path.join(root, "tests/fixtures/media-runtime");
const fixtureOrigin = "https://window-controls.invalid";

for (const geometry of [
    { height: 38, name: "macOS", width: 1090, x: 86, y: 0 },
    { height: 33, name: "Windows", width: 1140, x: 0, y: 0 },
]) {
    test(
        "installed-window layout with " + geometry.name + " geometry",
        async ({ page, context, baseURL }, testInfo) => {
            const errors = [],
                rejected = [];
            page.on("pageerror", (error) => errors.push(error.message));
            const origin = new URL(baseURL).origin;
            await context.route("**/*", (route) => {
                const url = new URL(route.request().url());
                if (url.origin === origin) return route.continue();
                if (
                    url.origin === fixtureOrigin &&
                    ["/index.m3u8", "/segment00.ts"].includes(url.pathname)
                ) {
                    return route.fulfill({
                        body: fs.readFileSync(
                            path.join(mediaRoot, path.basename(url.pathname))
                        ),
                        contentType: url.pathname.endsWith("m3u8")
                            ? "application/vnd.apple.mpegurl"
                            : "video/mp2t",
                        headers: { "Access-Control-Allow-Origin": "*" },
                    });
                }
                rejected.push(url.origin + url.pathname);
                return route.abort("blockedbyclient");
            });
            await context.routeWebSocket("**/*", (socket) => socket.close());
            await page.addInitScript(() => {
                localStorage.setItem("ottplaylang", "_eng");
                const overlay = new EventTarget();
                overlay.visible = false;
                Object.defineProperty(navigator, "windowControlsOverlay", {
                    configurable: true,
                    value: overlay,
                });
                const matchMedia = window.matchMedia.bind(window);
                const mode = new EventTarget();
                mode.matches = false;
                window.matchMedia = (query) =>
                    query === "(display-mode: window-controls-overlay)"
                        ? mode
                        : matchMedia(query);
                window.overlayFixture = function (visible) {
                    overlay.visible = visible;
                    mode.matches = visible;
                    overlay.dispatchEvent(new Event("geometrychange"));
                };
            });
            await page.goto("/");
            await expect(page.locator("#listCaption")).toHaveText(
                "First-run setup"
            );
            await expect(page.locator("#window-drag-region")).toHaveCount(1);
            await expect(page.locator("#window-drag-region")).toBeHidden();
            const manifestUrl = await page
                .locator('link[rel="manifest"]')
                .getAttribute("href");
            expect(manifestUrl).toBe("/js/browser-app/manifest.webmanifest");
            const manifest = await (await page.request.get(manifestUrl)).json();
            expect(manifest.id).toBe("/");
            expect(manifest.start_url).toBe("/");
            expect(manifest.display_override).toEqual([
                "window-controls-overlay",
            ]);
            expect(manifest.display).toBe("standalone");
            const baseList = await page.locator("#list").boundingBox();
            const simulation = css
                .replace(
                    /@media\s*\(display-mode:\s*window-controls-overlay\)/g,
                    "@media all"
                )
                .replace(
                    /env\(titlebar-area-(x|y|width|height),\s*0px\)/g,
                    (text, field) => geometry[field] + "px"
                );
            await page.addStyleTag({ content: simulation });
            await page.evaluate(() => overlayFixture(true));
            await expect(page.locator("html")).toHaveClass(
                /ott-window-controls/
            );
            const drag = await page
                .locator("#window-drag-region")
                .boundingBox();
            expect(drag).toEqual({
                height: geometry.height,
                width: geometry.width,
                x: geometry.x,
                y: geometry.y,
            });
            const safeList = await page.locator("#list").boundingBox();
            expect(safeList.y - baseList.y).toBe(geometry.height);
            expect(safeList.y + safeList.height).toBe(
                baseList.y + baseList.height
            );
            const detail = await page.locator("#listDetail").innerText();
            await page.keyboard.press("ArrowDown");
            await expect(page.locator("#listDetail")).not.toHaveText(detail);

            // Exercise actual exported classic-bundle media/layout contracts.
            await page.evaluate((url) => {
                document.getElementById("video").muted = true;
                window.stbPlay(url);
                window.stbToFullScreen();
                document.getElementById("video").loop = true;
                window.jQuery("#list, #list_window").hide();
            }, fixtureOrigin + "/index.m3u8");
            await page.waitForFunction(
                () =>
                    document.getElementById("video").videoWidth > 0 &&
                    document.getElementById("video").currentTime > 0.2
            );
            const full = await page.locator("#vdiv").boundingBox();
            expect(full).toEqual({ height: 720, width: 1280, x: 0, y: 0 });
            await page.evaluate(() => {
                window.overlayFixture(false);
                window.stbSetWindow();
                window.jQuery("#list, #list_window").show();
            });
            const previewBefore = await page.locator("#vdiv").boundingBox();
            const frameBefore = await page.locator("#_t").boundingBox();
            await page.evaluate(() => overlayFixture(true));
            await expect(page.locator("#vdiv")).toHaveClass(
                /ott-window-controls-preview/
            );
            const previewAfter = await page.locator("#vdiv").boundingBox();
            const frameAfter = await page.locator("#_t").boundingBox();
            expect(previewAfter.y - previewBefore.y).toBe(geometry.height);
            expect(frameAfter.y - frameBefore.y).toBe(geometry.height);
            expect(previewAfter.width).toBe(previewBefore.width);
            expect(previewAfter.height).toBe(previewBefore.height);

            await page.evaluate(() => {
                window.stbToFullScreen();
                window.jQuery("#list, #list_window").hide();
            });
            await page.locator("#video").evaluate((video) => video.blur());
            await page.keyboard.press("l");
            await page.waitForFunction(() => !!document.fullscreenElement);
            await expect(page.locator("#window-drag-region")).toBeHidden();
            await page.evaluate(() => document.exitFullscreen());
            await expect(page.locator("#window-drag-region")).toBeVisible();
            await expect(page.locator("#vdiv")).not.toHaveClass(
                /ott-window-controls-preview/
            );
            await page.evaluate(() => {
                const dialog = document.getElementById("dialogbox");
                dialog.innerHTML =
                    "<button>Dialog action</button><p>" +
                    "Programme details ".repeat(500) +
                    "</p>";
                dialog.style.display = "block";
                dialog.style.top = "0px";
                dialog.style.left = "10%";
            });
            const dialog = await page.locator("#dialogbox").boundingBox();
            expect(dialog.y).toBeGreaterThanOrEqual(geometry.height);
            expect(dialog.y + dialog.height).toBeLessThanOrEqual(720);
            expect(
                await page
                    .locator("#dialogbox")
                    .evaluate((node) => node.scrollHeight > node.clientHeight)
            ).toBe(true);
            await page.locator("#dialogbox").hover();
            await page.mouse.wheel(0, 300);
            await expect
                .poll(() =>
                    page
                        .locator("#dialogbox")
                        .evaluate((node) => node.scrollTop)
                )
                .toBeGreaterThan(0);
            await page.evaluate(() => {
                document.getElementById("dialogbox").style.display = "none";
                window.overlayFixture(false);
            });
            await expect(page.locator("#window-drag-region")).toBeHidden();
            const before = await page
                .locator("#video")
                .evaluate(
                    (video) => video.getVideoPlaybackQuality().totalVideoFrames
                );
            await page.waitForFunction(
                (frames) =>
                    document.getElementById("video").getVideoPlaybackQuality()
                        .totalVideoFrames > frames,
                before
            );
            expect(errors).toEqual([]);
            await testInfo.attach("window-controls-evidence", {
                body: JSON.stringify(
                    {
                        dialog,
                        errors,
                        frameAfter,
                        frameBefore,
                        full,
                        geometry,
                        previewAfter,
                        previewBefore,
                        rejected,
                        simulated:
                            "WCO visibility/media query and titlebar CSS env inputs only; real classic bundle, remote input, HLS decoding and Fullscreen API",
                    },
                    null,
                    2
                ),
                contentType: "application/json",
            });
        }
    );
}

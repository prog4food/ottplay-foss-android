// Browser emulation of UA/native API signals, not firmware or decoder emulation.
// Exercise the shipped HTML loader, built classic bundle and real STB adapter.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const fixtures = require("../fixtures/device-detection.json");
const runtimeVersion = require("../../js/media-runtime.json").runtimeVersion;

const adapterRoot = path.resolve(__dirname, "../../devices");
const adapterNames = [];
function collectAdapters(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const name = prefix + entry.name;
        const child = path.join(directory, entry.name);
        if (fs.existsSync(path.join(child, "device.js")))
            adapterNames.push(name);
        else collectAdapters(child, name + "/");
    }
}
collectAdapters(adapterRoot);

// Deliberately independent expected remote codes: reading the adapter's own
// values as expectations would miss loading another valid but wrong adapter.
const remoteOverrides = {
    android: { DOWN: 20, ENTER: 66, RETURN: 4 },
    "lg/webos": { RETURN: 461 },
    "samsung/maple": { DOWN: 5, ENTER: 12, RETURN: 88 },
    "samsung/tizen": { ENTER: 13, RETURN: 10009 },
};
const routeFixtures = adapterNames.sort().map((name) => ({
    expectedDevice: name,
    name: "explicit adapter route " + name,
    pathname: "/f/" + name + "/",
    userAgent:
        "Mozilla/5.0 (SmartTV; Linux; Web0S) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
}));

async function remoteKey(page, keyCode, key, code) {
    // Chromium's input dispatch emits a browser keyboard event with the TV's
    // numeric code, through window.onkeydown and the real list key handler.
    const cdp = await page.context().newCDPSession(page);
    try {
        const event = {
            key,
            nativeVirtualKeyCode: keyCode,
            windowsVirtualKeyCode: keyCode,
        };
        if (code) event.code = code;
        await cdp.send("Input.dispatchKeyEvent", {
            ...event,
            type: "rawKeyDown",
        });
        await cdp.send("Input.dispatchKeyEvent", { ...event, type: "keyUp" });
    } finally {
        await cdp.detach();
    }
}

for (const fixture of fixtures.concat(routeFixtures)) {
    test.describe(fixture.name, () => {
        test.use({ userAgent: fixture.userAgent });
        test("boots the selected adapter and handles remote navigation", async ({
            page,
            context,
            baseURL,
        }, testInfo) => {
            const localOrigin = new URL(baseURL).origin;
            const loadedScripts = [];
            const mediaVersions = [];
            const blockedRequests = [];
            const pageErrors = [];
            page.on("pageerror", (error) => pageErrors.push(error.message));
            page.on("response", (response) => {
                if (
                    response.request().resourceType() === "script" &&
                    response.ok()
                ) {
                    const url = new URL(response.url());
                    loadedScripts.push(url.pathname);
                    if (
                        /\/js\/(runtime-polyfills|hls.min)\.js$/.test(
                            url.pathname
                        )
                    )
                        mediaVersions.push(url.searchParams.get("v"));
                }
            });
            await context.route("**/*", async (route) => {
                if (new URL(route.request().url()).origin === localOrigin) {
                    await route.continue();
                } else {
                    // Keep the device matrix independent of live providers.
                    blockedRequests.push(route.request().url());
                    await route.abort("blockedbyclient");
                }
            });
            await context.routeWebSocket("**/*", (socket) => {
                blockedRequests.push(socket.url());
                socket.close();
            });
            await context.addInitScript((capability) => {
                const originalLog = console.log;
                window.__testPlayerStarts = [];
                console.log = function (...args) {
                    if (args[0] === "startPlayer") {
                        window.__testPlayerStarts.push({
                            back: window.keys && window.keys.RETURN,
                            device: window.ott_device,
                        });
                    }
                    return originalLog.apply(this, args);
                };
                localStorage.setItem("ottplaylang", "_eng");
                if (capability === "mag") {
                    window.gSTB = {
                        GetDeviceMacAddress: function () {
                            return "02:00:00:00:00:01";
                        },
                        GetDeviceModel: function () {
                            return "MAG250";
                        },
                    };
                } else if (capability === "empty-gstb") {
                    window.gSTB = {};
                } else if (capability === "throwing-gstb") {
                    Object.defineProperty(window, "gSTB", {
                        get: function () {
                            throw new Error("Native bridge unavailable");
                        },
                    });
                }
            }, fixture.capability);

            await page.goto(fixture.pathname, { waitUntil: "load" });
            await expect(page.locator("#listCaption")).toHaveText(
                "First-run setup"
            );
            await expect(page.locator("#list")).toBeVisible();
            await expect(page.locator("#boot-log")).toContainText(
                fixture.expectedDevice
            );
            const remote = {
                DOWN: 40,
                ENTER: 13,
                RETURN: 8,
                ...remoteOverrides[fixture.expectedDevice],
            };
            expect(
                await page.evaluate(() => ({
                    back: window.keys.RETURN,
                    device: window.ott_device,
                    down: window.keys.DOWN,
                    enter: window.keys.ENTER,
                }))
            ).toEqual({
                back: remote.RETURN,
                device: fixture.expectedDevice,
                down: remote.DOWN,
                enter: remote.ENTER,
            });
            expect(
                await page.evaluate(() => window.__testPlayerStarts)
            ).toEqual([
                { back: remote.RETURN, device: fixture.expectedDevice },
            ]);
            expect(loadedScripts).toContain("/dist/player.js");
            expect(loadedScripts[0]).toBe("/js/runtime-polyfills.js");
            if (fixture.expectedDevice === "pc2") {
                expect(loadedScripts).toContain("/js/video.min.js");
                expect(loadedScripts).not.toContain("/js/hls.min.js");
                expect(await page.evaluate(() => window.videojs.VERSION)).toBe(
                    "7.21.7"
                );
                expect(mediaVersions).toEqual([runtimeVersion]);
            } else {
                expect(loadedScripts).toContain("/js/hls.min.js");
                expect(
                    await page.evaluate(() => ({
                        ready: window.__ottRuntimePolyfillsReady,
                        runtimeVersion: window.__ottMediaRuntimeVersion,
                        version: window.Hls.version,
                        worker: window.Hls.DefaultConfig.workerPath,
                    }))
                ).toEqual({
                    ready: true,
                    runtimeVersion,
                    version: "1.7.3",
                    worker:
                        localOrigin + "/js/hls.worker.js?v=" + runtimeVersion,
                });
                expect(mediaVersions).toEqual([runtimeVersion, runtimeVersion]);
            }
            expect(
                loadedScripts.filter((url) =>
                    /^\/devices\/.+\/device\.js$/.test(url)
                )
            ).toEqual(["/devices/" + fixture.expectedDevice + "/device.js"]);

            // Browser keyboard input must move the first-run selection. Maple
            // and Android emit their platform keycodes for the same arrow.
            const firstDetail = await page.locator("#listDetail").innerText();
            if (remote.DOWN === 40) await page.keyboard.press("ArrowDown");
            else await remoteKey(page, remote.DOWN, "ArrowDown");
            await expect(page.locator("#listDetail")).not.toHaveText(
                firstDetail
            );
            // The platform-specific Back code must reach firstRun's handler,
            // which opens language selection. Then its Enter returns to setup.
            await remoteKey(page, remote.RETURN, "BrowserBack");
            await expect(page.locator("#listCaption")).toHaveText(
                "Choose language"
            );
            await remoteKey(page, remote.ENTER, "Enter");
            await expect(page.locator("#listCaption")).toHaveText(
                "First-run setup"
            );
            expect(pageErrors).toEqual([]);
            await testInfo.attach("device-runtime", {
                body: JSON.stringify(
                    { blockedRequests, fixture, loadedScripts, pageErrors },
                    null,
                    2
                ),
                contentType: "application/json",
            });
        });
    });
}

for (const locale of [
    {
        asset: "/locales/english.js",
        message:
            "Compatibility runtime could not load. Reopen the player to retry.",
        tag: "en-US",
    },
    {
        asset: "/locales/russian.js",
        message:
            "Не удалось загрузить компоненты совместимости. Откройте плеер заново.",
        tag: "ru-RU",
    },
    {
        asset: null,
        message:
            "Compatibility runtime could not load. Reopen the player to retry.",
        tag: "qaa",
    },
]) {
    test(
        "a failed runtime download shows a retry message before loading libraries: " +
            locale.tag,
        async ({ page, context, baseURL }) => {
            const requestedScripts = [];
            page.on("request", (request) => {
                if (request.resourceType() === "script")
                    requestedScripts.push(new URL(request.url()).pathname);
            });
            const localOrigin = new URL(baseURL).origin;
            await page.addInitScript((tag) => {
                Object.defineProperty(navigator, "languages", {
                    get: () => [tag],
                });
            }, locale.tag);
            await context.route("**/*", async (route) => {
                const url = new URL(route.request().url());
                if (
                    url.origin !== localOrigin ||
                    url.pathname === "/js/runtime-polyfills.js"
                )
                    await route.abort("blockedbyclient");
                else await route.continue();
            });
            await page.goto("/f/lg/webos/", { waitUntil: "load" });
            await expect(page.locator("#boot-status")).toHaveText(
                locale.message
            );
            await expect(page.locator("#boot-log")).toContainText(
                "js/runtime-polyfills.js"
            );
            await expect(page.locator("body")).not.toHaveClass(/\bbooting\b/);
            // The ES5 catalog localizes the failure before any runtime-dependent
            // libraries or player code may load. Unsupported locales need no catalog.
            expect(requestedScripts).toEqual([
                "/js/runtime-polyfills.js",
                ...(locale.asset ? [locale.asset] : []),
            ]);
        }
    );
}

async function enterViewingMode(page) {
    await expect(page.locator("#listCaption")).toHaveText("First-run setup");
    // No channel or stream is needed to exercise viewing-mode keyboard actions.
    // Use the player's real list/volume APIs; keep its handlers unchanged.
    await page.evaluate(() => {
        window.closeList();
        window.stbSetVolume(50);
    });
    await expect(page.locator("#list")).toBeHidden();
}

async function bootForArrowBehavior(page, context, baseURL, device) {
    const origin = new URL(baseURL).origin;
    await context.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin === origin)
            await route.continue();
        else await route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(() => {
        localStorage.setItem("ottplaylang", "_eng");
    });
    await page.goto("/f/" + device + "/", { waitUntil: "load" });
    await enterViewingMode(page);
}

test.describe("viewing-mode arrow behavior", () => {
    for (const device of ["lg/webos", "lg/netcast"]) {
        test(
            device + " fresh Left opens the main Menu",
            async ({ page, context, baseURL }) => {
                const errors = [];
                page.on("pageerror", (error) => errors.push(error.message));
                await bootForArrowBehavior(page, context, baseURL, device);
                await page.keyboard.press("ArrowLeft");
                await expect(page.locator("#list")).toBeVisible();
                await expect(page.locator("#listCaption")).toHaveText("Menu");
                expect(await page.evaluate(() => window.stbGetVolume())).toBe(
                    50
                );
                expect(errors).toEqual([]);
            }
        );

        test(
            device + " saved Left volume choice survives reload",
            async ({ page, context, baseURL }) => {
                const errors = [];
                page.on("pageerror", (error) => errors.push(error.message));
                await bootForArrowBehavior(page, context, baseURL, device);
                // Model an existing explicit setting once. The init script does
                // not seed it again, so reloading must preserve the stored choice.
                await page.evaluate(() => localStorage.setItem("sALfun", "14"));
                await page.reload({ waitUntil: "load" });
                await enterViewingMode(page);
                await page.keyboard.press("ArrowLeft");
                await expect
                    .poll(() => page.evaluate(() => window.stbGetVolume()))
                    .toBe(45);
                await expect(page.locator("#list")).toBeHidden();
                expect(
                    await page.evaluate(() => localStorage.getItem("sALfun"))
                ).toBe("14");
                expect(errors).toEqual([]);
            }
        );
    }

    test("PC default Left and Right retain volume control", async ({
        page,
        context,
        baseURL,
    }) => {
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await bootForArrowBehavior(page, context, baseURL, "pc");
        await page.keyboard.press("ArrowLeft");
        await expect
            .poll(() => page.evaluate(() => window.stbGetVolume()))
            .toBe(45);
        await expect(page.locator("#list")).toBeHidden();
        await page.keyboard.press("ArrowRight");
        await expect
            .poll(() => page.evaluate(() => window.stbGetVolume()))
            .toBe(50);
        await expect(page.locator("#list")).toBeHidden();
        expect(errors).toEqual([]);
    });
});

for (const device of ["lg/webos", "lg/netcast", "pc"]) {
    test(
        device + " settings expose only the appropriate engine controls",
        async ({ page, context, baseURL }) => {
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await bootForArrowBehavior(page, context, baseURL, device);
            for (const menu of ["stbOptions", "settingsInterface"]) {
                await page.evaluate((name) => window[name](), menu);
                await expect(page.locator("#list")).toBeVisible();
                await expect(
                    page
                        .locator("#list")
                        .getByRole("option", { name: /^Streaming player type/ })
                ).toHaveCount(device === "lg/webos" ? 0 : 1);
                await expect(
                    page
                        .locator("#list")
                        .getByText("Buffer Size, s", { exact: false })
                ).toBeVisible();
            }
            if (device === "lg/webos") {
                expect(
                    await page.evaluate(() => {
                        window.setPlayerMode(2);
                        return window.playerMode;
                    })
                ).toBe(3);
            }
            expect(errors).toEqual([]);
        }
    );
}

async function bootForMagicRemote(page, context, baseURL, device, visible) {
    const origin = new URL(baseURL).origin;
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin === origin)
            await route.continue();
        else await route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript((initialVisibility) => {
        localStorage.setItem("ottplaylang", "_eng");
        window.__testCursor = {
            changes: [],
            visible: initialVisibility,
        };
        // Model the optional shim called by the shipped adapter. This is an
        // observable native boundary, not an emulation of LG firmware APIs.
        window.webOS = {
            device: {
                cursorVisible: function (nextVisibility) {
                    window.__testCursor.changes.push(nextVisibility);
                    window.__testCursor.visible = nextVisibility;
                },
            },
        };
    }, visible);
    await page.goto("/f/" + device + "/", { waitUntil: "load" });
    await expect(page.locator("#listCaption")).toHaveText("First-run setup");
    expect(await page.evaluate(() => window.ott_device)).toBe(device);
    await page.evaluate(() => {
        // Observe the real router without replacing page actions or selection.
        const original = window.keyHandler;
        window.__testEnterCount = 0;
        window.keyHandler = function (event) {
            if (event.keyCode === 13) window.__testEnterCount++;
            return original.apply(this, arguments);
        };
    });
    return errors;
}

async function bootForWebosRemote(
    page,
    context,
    baseURL,
    observeNativeExit = true,
    device = "lg/webos",
    pendingGuide = false
) {
    const errors = await bootForMagicRemote(
        page,
        context,
        baseURL,
        device,
        false
    );
    await page.evaluate(
        ({ observeExit, pending }) => {
            // Keep the shipped loader, key router, menus and confirmation dialog.
            // Only observe playback/native effects; no LG firmware is emulated.
            window.__remoteEffects = {
                exits: 0,
                played: [],
                playing: true,
                volume: [],
            };
            if (observeExit) {
                // A successful native close also marks the window closed. Without
                // this boundary, the hosted-tab history fallback races assertions.
                Object.defineProperty(window, "closed", {
                    configurable: true,
                    get: () => window.__remoteEffects.exits > 0,
                });
                window.close = () => window.__remoteEffects.exits++;
            }
            window.stbIsPlaying = () => window.__remoteEffects.playing;
            window.stbPause = () => {
                window.__remoteEffects.playing = false;
            };
            window.stbContinue = () => {
                window.__remoteEffects.playing = true;
            };
            window.stbSetVolume = (volume) =>
                window.__remoteEffects.volume.push(volume);
            const stored = new Map();
            window.providerGetItem = (key) => stored.get(key) ?? null;
            window.providerSetItem = (key, value) => stored.set(key, value);
            window.catsArray = ["Remote fixture"];
            window.cats = { "Remote fixture": [101, 102, 103] };
            window.channels = window.chanels = {};
            for (const id of window.cats["Remote fixture"]) {
                window.channels[id] = { channel_name: "Channel " + id, rec: 0 };
            }
            window.fetchChannelGuide = (id, complete) => {
                if (pending) {
                    window.__deliverGuide = (programmes) =>
                        complete(id, programmes);
                    return;
                }
                const now = Math.floor(Date.now() / 1000);
                complete(id, [
                    {
                        descr: "Remote guide fixture",
                        name: "Programme " + id,
                        time: now - 600,
                        time_to: now + 600,
                    },
                ]);
            };
            window.catIndex = window.primaryIndex = window.playType = 0;
            window.curList = window.cats["Remote fixture"];
            window.playChannel = (category, index) => {
                window.catIndex = category;
                window.curList = window.cats[window.catsArray[category]];
                window.primaryIndex = index;
                window.__remoteEffects.played.push(window.curList[index]);
                window.__remoteEffects.playing = true;
            };
            window.closeList();
            window.infoBarHide();
        },
        { observeExit: observeNativeExit, pending: pendingGuide }
    );
    return errors;
}

test.describe("webOS fullscreen remote navigation", () => {
    test.use({
        userAgent:
            "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 WebAppManager",
    });

    for (const delivery of ["Back key 461", "LG browser history Back"]) {
        test(
            delivery + " returns Menu to video before confirming exit",
            async ({ page, context, baseURL }) => {
                const errors = await bootForWebosRemote(page, context, baseURL);
                const playerUrl = page.url();
                const back = () =>
                    delivery === "Back key 461"
                        ? remoteKey(page, 461, "BrowserBack")
                        : page.goBack();
                await page.evaluate(() => window.popupList());
                await expect(page.locator("#listCaption")).toHaveText("Menu");
                await back();
                await expect(page).toHaveURL(playerUrl);
                await expect(page.locator("#list")).toBeHidden();
                await expect(page.locator("#dialogbox")).toBeHidden();
                expect(
                    await page.evaluate(() => window.__remoteEffects)
                ).toMatchObject({ exits: 0, playing: true });
                expect(await page.evaluate(() => window.closed)).toBe(false);

                await back();
                await expect(page).toHaveURL(playerUrl);
                await expect(page.locator("#dialogbox")).toContainText(
                    "Do you want to exit the player?"
                );
                expect(
                    await page.evaluate(() => window.__remoteEffects.exits)
                ).toBe(0);
                await remoteKey(page, 461, "BrowserBack");
                await expect(page.locator("#dialogbox")).toBeHidden();
                expect(
                    await page.evaluate(() => window.__remoteEffects)
                ).toMatchObject({ exits: 0, playing: true });

                await back();
                await expect(page.locator("#dialogbox")).toBeVisible();
                await remoteKey(page, 13, "Enter");
                await expect(page.locator("#dialogbox")).toBeHidden();
                expect(
                    await page.evaluate(() => window.__remoteEffects.exits)
                ).toBe(1);
                expect(await page.evaluate(() => window.closed)).toBe(true);
                // Observe beyond the real 100ms hosted-close fallback. A successful
                // native close must not navigate while this fixture stays inspectable.
                await page.waitForTimeout(150);
                await expect(page).toHaveURL(playerUrl);
                // A held/second OK must not re-run the retired confirmation callback.
                await remoteKey(page, 13, "Enter");
                expect(
                    await page.evaluate(() => window.__remoteEffects.exits)
                ).toBe(1);
                expect(errors).toEqual([]);
            }
        );
    }

    test("confirmed hosted exit returns to the immediate launcher page", async ({
        page,
        context,
        baseURL,
    }) => {
        const launcher = baseURL + "/__webos_launcher";
        let launcherVisits = 0;
        page.on("framenavigated", (frame) => {
            if (frame === page.mainFrame() && frame.url() === launcher)
                launcherVisits++;
        });
        await page.route("**/__webos_launcher", (route) =>
            route.fulfill({
                body: "<!doctype html><title>Launcher</title><h1>Launcher</h1>",
                contentType: "text/html",
            })
        );
        await page.goto(launcher);
        // Leave window.close intact: Chromium rejects closing a navigated tab.
        const errors = await bootForWebosRemote(page, context, baseURL, false);
        const playerUrl = page.url();
        await page.evaluate(() => window.popupList());
        await page.goBack();
        await expect(page.locator("#list")).toBeHidden();
        await expect(page).toHaveURL(playerUrl);
        await page.goBack();
        await expect(page.locator("#dialogbox")).toBeVisible();
        await remoteKey(page, 461, "BrowserBack");
        await expect(page.locator("#dialogbox")).toBeHidden();
        await expect(page).toHaveURL(playerUrl);
        expect(launcherVisits).toBe(1);
        await page.goBack();
        await expect(page.locator("#dialogbox")).toBeVisible();
        await remoteKey(page, 13, "Enter");
        await expect(page).toHaveURL(launcher);
        await expect(
            page.getByRole("heading", { name: "Launcher" })
        ).toBeVisible();
        expect(launcherVisits).toBe(2);
        expect(errors).toEqual([]);
    });

    test("native editor keeps L and Backspace as text input and remote Back cancels", async ({
        page,
        context,
        baseURL,
    }) => {
        const errors = await bootForWebosRemote(page, context, baseURL);
        await page.evaluate(() => {
            window.__remoteEffects.fullscreen = 0;
            window.__remoteEffects.saved = 0;
            document.documentElement.requestFullscreen = () => {
                window.__remoteEffects.fullscreen++;
                return Promise.resolve();
            };
            window.popupList();
            window.editCaption = "Playlist name";
            window.editvar = "";
            window.editKey = window.editKey2;
            window.setEdit = () => window.__remoteEffects.saved++;
            window.showEditKey2();
        });
        const input = page.locator("#editvar");
        await input.press("L");
        await expect(input).toHaveValue("L");
        await input.press("Backspace");
        await expect(input).toHaveValue("");
        await input.press("L");
        await remoteKey(page, 461, "BrowserBack");
        await expect(page.locator("#listEdit")).toBeHidden();
        await expect(page.locator("#listCaption")).toHaveText("Menu");
        await page.evaluate(() => window.showEditKey2());
        await expect(page.locator("#editvar")).toBeFocused();
        await remoteKey(page, 0, "Unidentified", "BrowserBack");
        await expect(page.locator("#listEdit")).toBeHidden();
        await expect(page.locator("#listCaption")).toHaveText("Menu");
        expect(await page.evaluate(() => window.__remoteEffects)).toMatchObject(
            {
                exits: 0,
                fullscreen: 0,
                playing: true,
                saved: 0,
            }
        );
        expect(errors).toEqual([]);
    });

    for (const digit of ["3", "4"]) {
        test(
            "remote settings shortcut " +
                digit +
                " does not type or repeat into the native editor",
            async ({ page, context, baseURL }) => {
                const errors = await bootForWebosRemote(page, context, baseURL);
                await page.evaluate(() => {
                    window.optionsList();
                    window.settingsCommands();
                });
                await page.keyboard.down(digit);
                const input = page.locator("#editvar");
                await expect(input).toBeVisible();
                await expect(input).toHaveValue("");
                await expect(input).toHaveJSProperty("readOnly", true);
                await page.keyboard.down(digit);
                await page.keyboard.down(digit);
                await expect(input).toHaveValue("");
                await page.keyboard.up(digit);
                await expect(input).toBeFocused();
                await expect(input).toHaveJSProperty("readOnly", false);
                await page.keyboard.type("L3");
                await expect(input).toHaveValue("L3");
                await input.press("Backspace");
                await expect(input).toHaveValue("L");
                await remoteKey(page, 461, "BrowserBack");
                await expect(page.locator("#listEdit")).toBeHidden();
                expect(errors).toEqual([]);
            }
        );
    }
    test("LG D-pad opens native remote text entry with the current draft", async ({
        page,
        context,
        baseURL,
    }) => {
        const errors = await bootForWebosRemote(page, context, baseURL);
        await page.evaluate(() => {
            window.optionsList();
            window.settingsCommands();
            window.sSwopBaseUrl = "/swop";
            window.__swopDrafts = [];
            window.$.ajax = (request) =>
                window.__swopDrafts.push(JSON.parse(request.data).draft);
        });
        await page.keyboard.press("3");
        const input = page.locator("#editvar");
        const remote = page.getByRole("button", {
            exact: true,
            name: "Remote text entry",
        });
        await input.fill("https://fixture.invalid/path?x=3&y=4");
        await page.keyboard.press("ArrowDown");
        await expect(remote).toBeFocused();
        await expect(remote).toHaveCSS("outline-style", "solid");
        await page.keyboard.press("ArrowUp");
        await expect(input).toBeFocused();
        await page.keyboard.press("ArrowUp");
        await expect(remote).toBeFocused();
        await page.keyboard.press("Enter");
        expect(await page.evaluate(() => window.__swopDrafts)).toEqual([
            "https://fixture.invalid/path?x=3&y=4",
        ]);
        await expect(input).toHaveCount(0);
        await remoteKey(page, 461, "BrowserBack");
        await expect(input).toBeVisible();
        await expect(input).toHaveValue("https://fixture.invalid/path?x=3&y=4");
        await expect(input).toBeFocused();
        await remoteKey(page, 461, "BrowserBack");
        await expect(page.locator("#listEdit")).toBeHidden();
        await expect(page.locator("#remoteSettingsContent")).toBeVisible();
        await page.keyboard.press("4");
        await expect(input).toBeVisible();
        await expect(input).toHaveAttribute("type", "password");
        expect(errors).toEqual([]);
    });

    test("resumed archive can leave an empty guide with LG Back", async ({
        page,
        context,
        baseURL,
    }) => {
        const errors = await bootForMagicRemote(
            page,
            context,
            baseURL,
            "lg/webos",
            false
        );
        const archiveStart = await page.evaluate(() => {
            const start = Math.floor(Date.now() / 1000) - 3600;
            const stored = new Map([
                [
                    "continueWatch",
                    JSON.stringify({
                        catIndex: 0,
                        channelId: 101,
                        mode: "archive",
                        playTime: 25,
                        playType: start,
                        updatedAt: Date.now(),
                        v: 1,
                    }),
                ],
            ]);
            // Keep the actual restore, archive controller, guide and key router.
            // Only isolate provider responses and native decoder side effects.
            window.__resumeEffects = { played: [], seeks: [], stops: 0 };
            window.stbPlay = (url, offset) =>
                window.__resumeEffects.played.push({ offset, url });
            window.stbStop = () => window.__resumeEffects.stops++;
            window.stbIsPlaying = () =>
                window.__resumeEffects.played.length > 0;
            window.stbSetPosTime = (time) =>
                window.__resumeEffects.seeks.push(time);
            window.sStopPlay = window.sInfoRew = false;
            window.providerGetItem = (key) => stored.get(key) ?? null;
            window.providerSetItem = (key, value) => stored.set(key, value);
            window.p_pref = "archive-fixture";
            window.channels = window.chanels = {
                101: {
                    category: { name: "Fixture" },
                    channel_name: "Channel 101",
                    rec: 24,
                },
            };
            window.catsArray = ["Fixture"];
            window.cats = { Fixture: [101] };
            window.curList = window.cList = window.cats.Fixture;
            window.catIndex = window.primaryIndex = 0;
            window.playType = window.playTime = 0;
            window.epgArray = window.parentalArray = [];
            window.fetchChannelGuide = (id, complete) => complete(id, []);
            window.getArchiveUrl = () =>
                location.origin + "/archive-fixture.m3u8";
            window.closeList();
            window.infoBarHide();
            if (!window.restoreContinueWatch())
                throw new Error("Fresh archive bookmark was not offered");
            return start;
        });
        await expect(page.locator("#dialogbox")).toContainText(
            "Resume from archive?"
        );
        await page.keyboard.press("Enter");
        await expect
            .poll(() => page.evaluate(() => window.__resumeEffects.seeks))
            .toEqual([25]);
        expect(await page.evaluate(() => window.playType)).toBe(archiveStart);
        await expect(page.locator("#list")).toBeHidden();
        await page.evaluate(() => {
            window.sInfoSlide = 0;
            window.infoBarHide();
        });
        await page.keyboard.press("ArrowRight");
        await expect(page.locator("#info1")).toBeVisible();
        await page.keyboard.press("ArrowRight");
        await expect(page.locator("#descr")).toBeHidden();
        // LG has no dedicated guide key; open EPG through the real Menu entry.
        await page.keyboard.press("ArrowLeft");
        await expect(page.locator("#listCaption")).toHaveText("Menu");
        await remoteKey(
            page,
            await page.evaluate(() => window.keys.RED),
            "ColorF0Red"
        );
        await expect(page.locator("#listCaption")).toHaveText(
            "EPG and archive. Channel: Channel 101"
        );
        await expect(page.locator("#list")).toBeVisible();
        expect(await page.evaluate(() => window.listArray)).toEqual([]);
        if (await page.locator("#dialogbox").isVisible())
            await remoteKey(page, 461, "BrowserBack");
        await remoteKey(page, 461, "BrowserBack");
        await expect(page.locator("#list")).toBeHidden();
        await expect(page.locator("#dialogbox")).toBeHidden();
        const effects = await page.evaluate(() => window.__resumeEffects);
        expect(effects.played).toHaveLength(1);
        expect(effects.seeks).toEqual([25]);
        expect(effects.stops).toBe(0);
        expect(await page.evaluate(() => window.playType)).toBe(archiveStart);
        expect(errors).toEqual([]);
    });

    for (const device of ["lg/webos", "lg/netcast"]) {
        test(`${device} migrates legacy Right volume to Info once and retains later explicit choices`, async ({
            page,
            context,
            baseURL,
        }) => {
            await context.addInitScript(() => {
                // Saving the preference must not depend on a second marker write.
                const setItem = Storage.prototype.setItem;
                Storage.prototype.setItem = function (key, value) {
                    if (this === localStorage && key === "sLgRightInfoMigrated")
                        throw new DOMException(
                            "Marker unavailable",
                            "QuotaExceededError"
                        );
                    return setItem.call(this, key, value);
                };
                // Seed only the legacy installation; real reloads must retain
                // the migration result and the user's later saved preference.
                if (localStorage.getItem("sARfun") === null)
                    localStorage.setItem("sARfun", "13");
            });
            const errors = await bootForWebosRemote(
                page,
                context,
                baseURL,
                true,
                device
            );
            const mapping = () =>
                page.evaluate(() => ({
                    legacy: window.sARfun,
                    right: window.settings.arFun,
                    stored: localStorage.getItem("sARfun"),
                }));
            const migrated = {
                legacy: 4,
                right: 4,
                stored: "4",
            };
            expect(await mapping()).toEqual(migrated);
            await page.evaluate(() => {
                window.sInfoChange = window.sInfoSlide = 0;
                window.updateChannelInfo(101);
                window.infoBarHide();
            });
            await expect(page.locator("#programm_name")).toHaveText(
                "Programme 101"
            );
            await expect(page.locator("#info1")).toBeHidden();
            await page.keyboard.press("ArrowRight");
            await expect(page.locator("#info1")).toBeVisible();
            await expect(page.locator("#descr")).toBeHidden();
            await page.keyboard.press("ArrowRight");
            await expect(page.locator("#descr")).toBeVisible();
            await expect(page.locator("#programm_name2")).toHaveText(
                "Programme 101"
            );
            await page.keyboard.press("ArrowRight");
            await expect(page.locator("#info1")).toBeHidden();
            expect(
                await page.evaluate(() => window.__remoteEffects.volume)
            ).toEqual([]);
            expect(errors).toEqual([]);

            await page.reload({ waitUntil: "load" });
            await expect(page.locator("#listCaption")).toHaveText(
                "First-run setup"
            );
            expect(await mapping()).toEqual(migrated);
            expect(await page.evaluate(() => saveSettings({ arFun: 13 }))).toBe(
                true
            );
            const chosen = {
                ...migrated,
                legacy: 13,
                right: 13,
                stored: "+13",
            };
            expect(await mapping()).toEqual(chosen);
            await page.reload({ waitUntil: "load" });
            await expect(page.locator("#listCaption")).toHaveText(
                "First-run setup"
            );
            expect(await mapping()).toEqual(chosen);
            expect(errors).toEqual([]);
        });

        for (const slide of [0, 1]) {
            test(`${device} Right shows the footer then programme details (animation ${slide})`, async ({
                page,
                context,
                baseURL,
            }) => {
                const errors = await bootForWebosRemote(
                    page,
                    context,
                    baseURL,
                    true,
                    device
                );
                await page.evaluate((animation) => {
                    window.sInfoChange = 0;
                    window.sInfoSlide = animation;
                    window.updateChannelInfo(101);
                    window.infoBarHide();
                }, slide);
                await expect(page.locator("#programm_name")).toHaveText(
                    "Programme 101"
                );
                await expect(page.locator("#info1")).toBeHidden();
                await page.keyboard.press("ArrowRight");
                await expect(page.locator("#info1")).toBeVisible();
                await expect(page.locator("#channel_name")).toHaveText(
                    "Channel 101"
                );
                await expect(page.locator("#descr")).toBeHidden();
                await page.keyboard.press("ArrowRight");
                await expect(page.locator("#descr")).toBeVisible();
                await expect(page.locator("#programm_name2")).toHaveText(
                    "Programme 101"
                );
                await expect(page.locator("#programm_descr")).toContainText(
                    "Remote guide fixture"
                );
                await expect(page.locator("#list")).toBeHidden();
                await page.keyboard.press("ArrowRight");
                await expect(page.locator("#info1")).toBeHidden();
                expect(
                    await page.evaluate(() => window.__remoteEffects)
                ).toEqual({ exits: 0, played: [], playing: true, volume: [] });
                expect(errors).toEqual([]);
            });
        }
    }

    test("Right keeps the footer timed without EPG and expands when EPG arrives", async ({
        page,
        context,
        baseURL,
    }) => {
        const errors = await bootForWebosRemote(
            page,
            context,
            baseURL,
            true,
            "lg/webos",
            true
        );
        await page.evaluate(() => {
            window.sInfoChange = window.sInfoSlide = 0;
            window.sInfoTimeout = 1;
            window.channels[101].rec = 24;
            window.updateChannelInfo(101);
            window.infoBarHide();
        });
        await page.keyboard.press("ArrowRight");
        await expect(page.locator("#info1")).toBeVisible();
        await page.keyboard.press("ArrowRight");
        await expect(page.locator("#info1")).toBeVisible();
        await expect(page.locator("#descr")).toBeHidden();
        await expect(page.locator("#info1")).toBeHidden();
        await page.evaluate(() => {
            const now = Math.floor(Date.now() / 1000);
            window.__deliverGuide([
                { name: "Late programme", time: now - 60, time_to: now + 600 },
            ]);
            window.sInfoTimeout = 5;
        });
        await expect(page.locator("#programm_name")).toHaveText(
            "Late programme"
        );
        await page.keyboard.press("ArrowRight");
        await expect(page.locator("#info1")).toBeVisible();
        await expect(page.locator("#descr")).toBeHidden();
        await page.keyboard.press("ArrowRight");
        await expect(page.locator("#descr")).toBeVisible();
        await expect(page.locator("#programm_name2")).toHaveText(
            "Late programme"
        );
        expect(await page.evaluate(() => window.__remoteEffects)).toEqual({
            exits: 0,
            played: [],
            playing: true,
            volume: [],
        });
        expect(errors).toEqual([]);
    });

    test("Right expands an EPG entry containing only a thumbnail and time", async ({
        page,
        context,
        baseURL,
    }) => {
        const errors = await bootForWebosRemote(
            page,
            context,
            baseURL,
            true,
            "lg/webos",
            true
        );
        await page.evaluate(() => {
            window.sInfoChange = window.sInfoSlide = 0;
            window.sThumbnail = 1;
            window.updateChannelInfo(101);
            const now = Math.floor(Date.now() / 1000);
            window.__deliverGuide([
                {
                    icon: "/icons/ott-play.png",
                    time: now - 60,
                    time_to: now + 600,
                },
            ]);
            window.infoBarHide();
        });
        await expect(page.locator("#programm_descr .img")).toHaveCount(1);
        await expect(page.locator("#programm_name2")).toHaveText("");
        await page.keyboard.press("ArrowRight");
        await expect(page.locator("#descr")).toBeHidden();
        await page.keyboard.press("ArrowRight");
        await expect(page.locator("#descr")).toBeVisible();
        await expect(page.locator("#programm_descr .img")).toBeVisible();
        expect(errors).toEqual([]);
    });

    test("Right still expands media descriptions containing only a poster", async ({
        page,
        context,
        baseURL,
    }) => {
        const errors = await bootForWebosRemote(page, context, baseURL);
        await page.evaluate(() => {
            window.sInfoSlide = window.sInfoSwitch = window.sStopPlay = 0;
            window.stbPlay = () => {};
            window.playMedia({
                description: '<img src="/icons/ott-play.png">',
                id: 8,
                stream_url: location.origin + "/movie-fixture.mp4",
                title: "Poster-only movie",
            });
            window.infoBarHide();
        });
        await expect(page.locator("#programm_name")).toHaveText(
            "Poster-only movie"
        );
        await page.keyboard.press("ArrowRight");
        await expect(page.locator("#info1")).toBeVisible();
        await expect(page.locator("#descr")).toBeHidden();
        await page.keyboard.press("ArrowRight");
        await expect(page.locator("#descr")).toBeVisible();
        await expect(page.locator("#programm_descr img")).toHaveCount(1);
        expect(errors).toEqual([]);
    });

    test("saved Right guide action is preserved without adjusting volume", async ({
        page,
        context,
        baseURL,
    }) => {
        await context.addInitScript(() => localStorage.setItem("sARfun", "10"));
        const errors = await bootForWebosRemote(page, context, baseURL);
        await page.keyboard.press("ArrowRight");
        await expect(page.locator("#list")).toBeVisible();
        await expect(page.locator("#listCaption")).toHaveText(
            "EPG and archive. Channel: Channel 101"
        );
        await expect(page.locator("#list")).toContainText("Programme 101");
        expect(
            await page.evaluate(() => window.__remoteEffects.volume)
        ).toEqual([]);
        expect(await page.evaluate(() => window.__remoteEffects.exits)).toBe(0);
        expect(errors).toEqual([]);
    });

    test("saved directional actions retain channel and category navigation", async ({
        page,
        context,
        baseURL,
    }) => {
        await context.addInitScript(() => {
            localStorage.setItem("sARfun", "15");
            localStorage.setItem("sALfun", "9");
        });
        const errors = await bootForWebosRemote(page, context, baseURL);
        expect(
            await page.evaluate(() => ({
                left: window.settings.alFun,
                right: window.settings.arFun,
            }))
        ).toEqual({ left: 9, right: 15 });
        await page.keyboard.press("ArrowRight");
        expect(
            await page.evaluate(() => window.__remoteEffects.played)
        ).toEqual([102]);
        await page.keyboard.press("ArrowLeft");
        await expect(page.locator("#listCaption")).toHaveText(
            "Category selection"
        );
        expect(
            await page.evaluate(() => window.__remoteEffects.volume)
        ).toEqual([]);
        expect(errors).toEqual([]);
    });

    for (const [delivery, up, down] of [
        ["LG numeric channel codes", [427, "ChannelUp"], [428, "ChannelDown"]],
        ["named channel keys", [0, "ChannelUp"], [0, "ChannelDown"]],
        ["named page keys", [0, "PageUp"], [0, "PageDown"]],
    ]) {
        test(
            delivery + " changes channels from fullscreen",
            async ({ page, context, baseURL }) => {
                const errors = await bootForWebosRemote(page, context, baseURL);
                await remoteKey(page, ...up);
                await remoteKey(page, ...down);
                await remoteKey(page, ...down);
                expect(
                    await page.evaluate(() => window.__remoteEffects.played)
                ).toEqual([102, 101, 103]);
                expect(await page.evaluate(() => window.primaryIndex)).toBe(2);
                await expect(page.locator("#list")).toBeHidden();
                expect(
                    await page.evaluate(() => window.__remoteEffects.volume)
                ).toEqual([]);
                expect(errors).toEqual([]);
            }
        );
    }

    for (const [delivery, yellow, blue] of [
        ["LG numeric colors", [405, "Unidentified"], [406, "Unidentified"]],
        ["named colors", [0, "ColorF2Yellow"], [0, "ColorF3Blue"]],
        [
            "named color codes",
            [0, "Unidentified", "ColorF2Yellow"],
            [0, "Unidentified", "ColorF3Blue"],
        ],
    ]) {
        test(
            delivery + " opens Media Library and categories from Menu",
            async ({ page, context, baseURL }) => {
                const errors = await bootForWebosRemote(page, context, baseURL);
                const playerUrl = page.url();
                const pressColor = (event) =>
                    event[2]
                        ? // CDP drops these non-PC physical codes. Deliver the
                          // host's DOM event through the normal window listener.
                          page.locator("body").dispatchEvent("keydown", {
                              code: event[2],
                              key: event[1],
                              keyCode: event[0],
                          })
                        : remoteKey(page, ...event);
                await page.evaluate(() => {
                    // Stub only the provider boundary; keep the real Menu,
                    // media/category screens and all remote handlers.
                    window.getMediaArray = (_target, complete) => {
                        window.mediaRecords = [
                            {
                                stream_url: "https://media.invalid/fixture.mp4",
                                title: "Remote media fixture",
                            },
                        ];
                        window.mediaName = "Media Library";
                        complete();
                    };
                    window.popupList();
                });
                await expect(page.locator("#listCaption")).toHaveText("Menu");
                await expect(
                    page.locator("#list").getByText("Show Media Library")
                ).toBeVisible();
                await pressColor(yellow);
                await expect(page.locator("#listCaption")).toHaveText(
                    "Media Library"
                );
                await expect(page.locator("#list")).toContainText(
                    "Remote media fixture"
                );
                await remoteKey(page, 461, "BrowserBack");
                await expect(page.locator("#listCaption")).toHaveText("Menu");
                await pressColor(blue);
                await expect(page.locator("#listCaption")).toHaveText(
                    "Category selection"
                );
                await expect(page.locator("#list")).toContainText(
                    "Remote fixture"
                );
                await expect(page).toHaveURL(playerUrl);
                expect(errors).toEqual([]);
            }
        );
    }
});

test("command server settings start and stop polling in the shipped player", async ({
    page,
    context,
    baseURL,
}) => {
    const errors = await bootForMagicRemote(
        page,
        context,
        baseURL,
        "pc",
        false
    );
    const token = "browser-fixture-device-code-1234567890";
    const requests = [];
    await context.route("http://192.0.2.20:8081/**", async (route) => {
        const request = route.request();
        if (request.method() === "OPTIONS") {
            await route.fulfill({
                headers: {
                    "Access-Control-Allow-Headers": "authorization",
                    "Access-Control-Allow-Methods": "GET",
                    "Access-Control-Allow-Origin": new URL(baseURL).origin,
                },
                status: 204,
            });
            return;
        }
        requests.push({
            authorization: request.headers().authorization,
            method: request.method(),
            url: request.url(),
        });
        await route.fulfill({
            body: JSON.stringify({
                commands: [],
                server_time: Date.now() / 1000,
            }),
            contentType: "application/json",
            headers: { "Access-Control-Allow-Origin": new URL(baseURL).origin },
        });
    });
    await page.evaluate(() => window.settingsCommands());
    await page.locator("#commandServerAddress").click();
    await page.locator("#editvar").fill("192.0.2.20");
    await page.locator("#editvar").press("Enter");
    await expect(page.locator("#commandServerStatus")).toContainText(
        "device access code"
    );
    expect(requests).toHaveLength(0);
    await page.locator("#commandServerToken").click();
    await expect(page.locator("#editvar")).toHaveAttribute("type", "password");
    await page.locator("#editvar").fill(token);
    await page.locator("#editvar").press("Enter");
    await expect(page.locator("#commandServerStatus")).toHaveText("Connected");
    expect(requests[0]).toEqual({
        authorization: "Bearer " + token,
        method: "GET",
        url: "http://192.0.2.20:8081/api/webhook/commands?delivery=ack",
    });
    await expect(page.locator("#remoteSettingsContent")).not.toContainText(
        token
    );
    const beforeReload = requests.length;
    await page.reload({ waitUntil: "load" });
    await expect.poll(() => requests.length).toBeGreaterThan(beforeReload);
    await page.evaluate(() => window.settingsCommands());
    await expect(page.locator("#commandServerStatus")).toHaveText("Connected");
    await page.locator("#commandServerConnect").click();
    await expect(page.locator("#commandServerStatus")).toHaveText(
        "Disconnected"
    );
    const stoppedCount = requests.length;
    await page.reload({ waitUntil: "load" });
    await expect(page.locator("#listCaption")).toHaveText("First-run setup");
    await page.evaluate(() => window.settingsCommands());
    // Saving the equivalent bare IP must not undo the user's Disconnect.
    await page.locator("#commandServerAddress").click();
    await page.locator("#editvar").fill("192.0.2.20");
    await page.locator("#editvar").press("Enter");
    await expect(page.locator("#commandServerStatus")).toHaveText(
        "Disconnected"
    );
    await page.waitForTimeout(1200);
    expect(requests).toHaveLength(stoppedCount);
    expect(errors).toEqual([]);
});

test.describe("LG Magic Remote pointer and button transitions", () => {
    test.use({
        userAgent:
            "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 WebAppManager",
    });

    test("status RPC reports opt-in diagnostics from the shipped LG player", async ({
        page,
        context,
        baseURL,
    }) => {
        const errors = await bootForMagicRemote(
            page,
            context,
            baseURL,
            "lg/webos",
            false
        );
        const controller = baseURL + "/__diagnostics-controller";
        const token = "browser-diagnostics-device-code-1234567890";
        const privateValue = "private-input-and-debug-value";
        const queued = [];
        const responses = [];
        const methods = [];
        // Keep the shipped controller, remote dispatcher and response transport.
        // Only the same-origin controller service is replaced with local replies.
        await context.route(controller + "/**", async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            methods.push(request.method());
            expect(request.headers().authorization).toBe("Bearer " + token);
            let body;
            if (url.pathname.endsWith("/api/responses")) {
                expect(request.method()).toBe("POST");
                responses.push(request.postDataJSON());
                body = { status: "ok" };
            } else {
                expect(url.pathname).toBe(
                    "/__diagnostics-controller/api/webhook/commands"
                );
                expect(url.search).toBe("?delivery=ack");
                expect(request.method()).toBe("GET");
                const serverTime = Date.now() / 1000;
                body = {
                    commands: [],
                    requests: queued.splice(0).map((id) => ({
                        action: "status",
                        expires_at: serverTime + 30,
                        id,
                        params: {},
                    })),
                    server_time: serverTime,
                };
            }
            await route.fulfill({
                body: JSON.stringify(body),
                contentType: "application/json",
            });
        });
        const disabledId = "1".repeat(32);
        queued.push(disabledId);
        await page.evaluate(
            ({ address, token }) => {
                window.__ottCommandServer.configure({
                    address,
                    enabled: true,
                    token,
                });
            },
            { address: controller, token }
        );
        await expect.poll(() => responses.length).toBe(1);
        expect(responses[0]).toMatchObject({ id: disabledId, status: "ok" });
        expect(responses[0].data.diagnostics).toEqual({
            epg: { available: true, enabled: false },
            input: { available: true, enabled: false },
            version: 1,
        });
        expect(await page.evaluate(() => window.__ottDebug.enabled)).toBe(
            false
        );
        await expect(page.locator("#ott_debug_hud")).toHaveCount(0);

        await page.evaluate((secret) => {
            window.closeList();
            // Public HUD opt-in installs the real adapter's passive listeners.
            window.__ottDebug.toggleHud();
            window.__ottDebug.push("sys", "fixture", secret);
            document.dispatchEvent(
                new CustomEvent("cursorStateChange", {
                    detail: { privateValue: secret, visibility: true },
                })
            );
            document.dispatchEvent(
                new CustomEvent("webOSMouse", {
                    detail: { privateValue: secret, type: "Enter" },
                })
            );
            window.dispatchEvent(new Event("focus"));
        }, privateValue);
        await expect(page.locator("#ott_debug_hud")).toBeVisible();
        await page.mouse.move(1100, 650);
        await page.mouse.down();
        await page.mouse.up();
        await page.mouse.wheel(0, 120);
        const enabledId = "2".repeat(32);
        queued.push(enabledId);
        await expect.poll(() => responses.length).toBe(2);
        expect(responses[1]).toMatchObject({ id: enabledId, status: "ok" });
        const diagnostics = responses[1].data.diagnostics;
        expect(diagnostics).toEqual({
            epg: { available: true, enabled: false },
            input: {
                area: "in",
                available: true,
                click: expect.any(Number),
                cursor: "on",
                down: expect.any(Number),
                enabled: true,
                focus: "on",
                move: expect.any(Number),
                page: "visible",
                wheel: expect.any(Number),
            },
            version: 1,
        });
        for (const name of ["move", "down", "click", "wheel"])
            expect(diagnostics.input[name]).toBeGreaterThan(0);
        expect(JSON.stringify(responses)).not.toContain(token);
        expect(JSON.stringify(responses)).not.toContain(privateValue);
        expect(methods).toContain("GET");
        expect(methods).toContain("POST");
        expect(await page.evaluate(() => window.__testCursor.changes)).toEqual(
            []
        );
        expect(errors).toEqual([]);
    });

    for (const visible of [true, false]) {
        test(
            "webOS boot preserves a " +
                (visible ? "visible" : "hidden") +
                " system pointer",
            async ({ page, context, baseURL }) => {
                const errors = await bootForMagicRemote(
                    page,
                    context,
                    baseURL,
                    "lg/webos",
                    visible
                );
                expect(await page.evaluate(() => window.__testCursor)).toEqual({
                    changes: [],
                    visible,
                });
                expect(errors).toEqual([]);
            }
        );
    }

    for (const device of ["lg/webos", "lg/netcast"]) {
        test(
            device +
                " hover, wheel, arrows and one-click activation share selection",
            async ({ page, context, baseURL }) => {
                const errors = await bootForMagicRemote(
                    page,
                    context,
                    baseURL,
                    device,
                    true
                );
                const manual = page.locator("#listIn").getByRole("option", {
                    exact: true,
                    name: "Manual setup",
                });
                const manualIndex = Number(
                    await manual.getAttribute("data-idx")
                );
                expect(manualIndex).toBeGreaterThan(0);
                // Genuine pointer movement must focus an unselected row without
                // activating it. A click can then perform the same action as OK.
                await manual.hover();
                await expect
                    .poll(() => page.evaluate(() => window.selIndex))
                    .toBe(manualIndex);
                await expect(page.locator("#listCaption")).toHaveText(
                    "First-run setup"
                );
                expect(await page.evaluate(() => window.__testEnterCount)).toBe(
                    0
                );
                await page.mouse.wheel(0, -120);
                await expect
                    .poll(() => page.evaluate(() => window.selIndex))
                    .toBe(manualIndex - 1);
                await page.evaluate(() => {
                    // Native 5-way navigation hides the pointer. This event
                    // reports the system state, rather than requesting it.
                    document.dispatchEvent(
                        new CustomEvent("cursorStateChange", {
                            detail: { visibility: false },
                        })
                    );
                });
                await page.keyboard.press("ArrowDown");
                await expect
                    .poll(() => page.evaluate(() => window.selIndex))
                    .toBe(manualIndex);
                await page.keyboard.press("ArrowUp");
                await expect
                    .poll(() => page.evaluate(() => window.selIndex))
                    .toBe(manualIndex - 1);
                // Return to pointer mode after buttons changed focus. Move away
                // first so this exercises a fresh pointer entry into the row.
                await page.evaluate(() => {
                    document.dispatchEvent(
                        new CustomEvent("cursorStateChange", {
                            detail: { visibility: true },
                        })
                    );
                });
                await page.mouse.move(1100, 100);
                await manual.hover();
                await expect
                    .poll(() => page.evaluate(() => window.selIndex))
                    .toBe(manualIndex);
                // The pointer can stay on a row while a key or page change
                // moves selection elsewhere. Click without a mousemove must
                // still focus and activate the row exactly once.
                await page.keyboard.press("ArrowUp");
                await expect
                    .poll(() => page.evaluate(() => window.selIndex))
                    .toBe(manualIndex - 1);
                await page.mouse.down();
                await page.mouse.up();
                await expect(page.locator("#listCaption")).toHaveText(
                    "Choose provider"
                );
                expect(await page.evaluate(() => window.__testEnterCount)).toBe(
                    1
                );
                const back = device === "lg/webos" ? 461 : 8;
                await remoteKey(page, back, "BrowserBack");
                await expect(page.locator("#listCaption")).toHaveText(
                    "First-run setup"
                );
                await remoteKey(page, back, "BrowserBack");
                await expect(page.locator("#listCaption")).toHaveText(
                    "Choose language"
                );
                await remoteKey(page, 13, "Enter");
                await expect(page.locator("#listCaption")).toHaveText(
                    "First-run setup"
                );
                expect(await page.evaluate(() => window.__testEnterCount)).toBe(
                    2
                );
                expect(
                    await page.evaluate(() => window.__testCursor.changes)
                ).toEqual([]);
                expect(errors).toEqual([]);
            }
        );
    }

    test("dialog focus preserves remote Enter and explicit keyboard buttons", async ({
        page,
        context,
        baseURL,
    }) => {
        const errors = await bootForMagicRemote(
            page,
            context,
            baseURL,
            "pc",
            true
        );
        const dialog = page.getByRole("dialog", {
            exact: true,
            name: "Information",
        });
        await page.evaluate(() => window.infoBox("Information test"));
        await expect(dialog).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(dialog).toBeHidden();
        const confirm = async () => {
            await page.evaluate(() => {
                window.__dialogAnswers = [];
                window.confirmBox(
                    "Confirm test",
                    () => window.__dialogAnswers.push("yes"),
                    () => window.__dialogAnswers.push("no")
                );
            });
            await expect(dialog).toBeFocused();
        };
        for (const key of ["Enter", "Escape", "Backspace"]) {
            await confirm();
            await page.keyboard.press(key);
            await expect(dialog).toBeHidden();
            expect(await page.evaluate(() => window.__dialogAnswers)).toEqual([
                key === "Enter" ? "yes" : "no",
            ]);
        }
        await confirm();
        await page.keyboard.press("Tab");
        await expect(
            dialog.getByRole("button", { exact: true, name: "Yes" })
        ).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(
            dialog.getByRole("button", { exact: true, name: "No" })
        ).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(dialog).toBeHidden();
        expect(await page.evaluate(() => window.__dialogAnswers)).toEqual([
            "no",
        ]);
        expect(errors).toEqual([]);
    });

    test("PC keeps click-to-select then click-to-activate behavior", async ({
        page,
        context,
        baseURL,
    }) => {
        const errors = await bootForMagicRemote(
            page,
            context,
            baseURL,
            "pc",
            true
        );
        const manual = page.locator("#listIn").getByRole("option", {
            exact: true,
            name: "Manual setup",
        });
        const manualIndex = Number(await manual.getAttribute("data-idx"));
        await manual.hover();
        expect(await page.evaluate(() => window.selIndex)).toBe(0);
        await manual.click();
        expect(await page.evaluate(() => window.selIndex)).toBe(manualIndex);
        await expect(page.locator("#listCaption")).toHaveText(
            "First-run setup"
        );
        expect(await page.evaluate(() => window.__testEnterCount)).toBe(0);
        await manual.click();
        await expect(page.locator("#listCaption")).toHaveText(
            "Choose provider"
        );
        expect(await page.evaluate(() => window.__testEnterCount)).toBe(1);
        expect(errors).toEqual([]);
    });
});

// Real HTML/bootstrap/bundle with a fresh browser profile. Native arrays emulate
// only the document-start locale contract, not a native shell or hardware device.
for (const scenario of [
    { expected: "_rus", languages: ["ru-RU"], name: "browser Russian" },
    {
        expected: "_rus",
        languages: ["en-US"],
        name: "native ordered preferences",
        native: ["qaa", "ru-RU", "en-US"],
    },
    {
        expected: "_eng",
        languages: ["ru-RU"],
        name: "saved choice wins",
        native: ["ru-RU"],
        saved: "_eng",
    },
    {
        expected: "",
        languages: ["en-US"],
        name: "unsupported native preference",
        native: ["qaa"],
    },
    {
        expected: "",
        fallback: "zh",
        languages: ["zh-Hant-TW"],
        name: "unsupported writing system",
    },
    {
        expected: "",
        failedDictionary: true,
        languages: ["ru-RU"],
        name: "unavailable automatic dictionary",
    },
    {
        expected: "",
        failedDictionary: true,
        languages: ["ru-RU"],
        mode: "system",
        name: "retry the saved system language after a failed dictionary",
        retrySystem: true,
        saved: "_rus",
    },
    {
        expected: "_rus",
        languages: ["ru-RU"],
        name: "cookie fallback after storage quota",
        storageQuota: true,
    },
]) {
    test(
        "startup language: " + scenario.name,
        async ({ page, context, baseURL }) => {
            const errors = [];
            const dictionaries = [];
            const origin = new URL(baseURL).origin;
            page.on("pageerror", (error) => errors.push(error.message));
            await context.route("**/*", async (route) => {
                const url = new URL(route.request().url());
                if (url.origin !== origin)
                    return route.abort("blockedbyclient");
                if (url.pathname.startsWith("/locales/")) {
                    dictionaries.push(url.pathname);
                    if (
                        scenario.failedDictionary &&
                        (!scenario.retrySystem || dictionaries.length === 1)
                    )
                        return route.abort("failed");
                }
                return route.continue();
            });
            await context.routeWebSocket("**/*", (socket) => socket.close());
            await context.addInitScript((choice) => {
                Object.defineProperty(navigator, "languages", {
                    value: choice.languages,
                });
                Object.defineProperty(navigator, "language", {
                    value: choice.fallback || choice.languages[0],
                });
                if (choice.native)
                    window.__ottPreferredLanguages = choice.native;
                if (choice.saved)
                    localStorage.setItem("ottplaylang", choice.saved);
                if (choice.mode)
                    localStorage.setItem("ottplaylangmode", choice.mode);
                if (choice.storageQuota)
                    Storage.prototype.setItem = function () {
                        throw new DOMException(
                            "Quota exceeded",
                            "QuotaExceededError"
                        );
                    };
            }, scenario);
            await page.goto("/f/pc/", { waitUntil: "load" });
            const caption =
                scenario.expected === "_rus"
                    ? "Первоначальная настройка"
                    : scenario.expected
                      ? "First-run setup"
                      : "Choose language";
            await expect(page.locator("#listCaption")).toHaveText(caption);
            await expect(page.locator("#list")).toBeVisible();
            expect(
                await page.evaluate(() => stbGetItem("ottplaylang") || "")
            ).toBe(scenario.retrySystem ? scenario.saved : scenario.expected);
            if (scenario.retrySystem) {
                expect(dictionaries).toEqual(["/locales/russian.js"]);
                await page.keyboard.press("Enter");
                await expect(page.locator("#listCaption")).toHaveText(
                    "Первоначальная настройка"
                );
                expect(dictionaries).toEqual([
                    "/locales/russian.js",
                    "/locales/russian.js",
                ]);
                expect(
                    await page.evaluate(() => ({
                        effective: window.__ottInterfaceLanguage,
                        lang: document.documentElement.lang,
                        mode: stbGetItem("ottplaylangmode"),
                        saved: stbGetItem("ottplaylang"),
                    }))
                ).toEqual({
                    effective: "_rus",
                    lang: "ru",
                    mode: "system",
                    saved: "_rus",
                });
            }
            if (scenario.expected) {
                expect(dictionaries).toEqual([
                    scenario.expected === "_rus"
                        ? "/locales/russian.js"
                        : "/locales/english.js",
                ]);
                expect(
                    await page.evaluate(() => window.__ottBootLanguage)
                ).toBeNull();
                await page.reload({ waitUntil: "load" });
                await expect(page.locator("#listCaption")).toHaveText(caption);
                expect(
                    await page.evaluate(() => stbGetItem("ottplaylang"))
                ).toBe(scenario.expected);
            }
            expect(errors).toEqual([]);
        }
    );
}

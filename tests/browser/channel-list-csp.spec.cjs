const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { JSDOM } = require("jsdom");
const { readDictionary } = require("../../scripts/localization-catalog.cjs");

const root = path.resolve(__dirname, "../..");
const origin = "http://127.0.0.1:4198";
const nonce = "ottplay-channel-fixture";
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function nativePolicy() {
    const security = JSON.parse(read("src-tauri/tauri.conf.json")).app.security;
    const disabled = security.dangerousDisableAssetCspModification;
    assert.notEqual(
        disabled,
        true,
        "Native CSP modification must remain enabled"
    );
    for (const directive of ["script-src", "style-src"]) {
        assert(
            !Array.isArray(disabled) || !disabled.includes(directive),
            directive + " must retain Tauri's nonce protection"
        );
    }
    // Tauri codegen 2.6.3 adds nonces to embedded script/style tags; Tauri
    // 2.11.5 appends those nonces to the effective CSP. A config-only policy
    // misses this regression: nonce sources make unsafe-inline ineffective.
    return security.csp
        .split(";")
        .map((part) => {
            const directive = part.trim();
            return /^(script-src|style-src)\s/.test(directive)
                ? directive + " 'nonce-" + nonce + "'"
                : directive;
        })
        .join("; ");
}

function initializeFixture(native, capacitor) {
    window.ott_device = "pc";
    window.__fixtureViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
        window.__fixtureViolations.push(event.effectiveDirective);
    });
    const background = (window.__fixtureBackground = {
        probes: 0,
        standby: false,
    });
    const snapshot = () => ({
        pending: 0,
        quiescent: background.standby,
        standby: background.standby,
    });
    const status = async () => {
        background.probes++;
        return snapshot();
    };
    const setStandby = async ({ standby }) => {
        background.standby = standby;
        return snapshot();
    };
    if (capacitor) {
        // The renderer uses real startup admission; model its native status
        // rather than letting a missing bridge put the fixture into standby.
        window.Capacitor = {
            getPlatform: () => "ios",
            isNativePlatform: () => true,
            Plugins: { NativeBackground: { setStandby, status } },
        };
    } else if (native) {
        window.__TAURI__ = {
            core: {
                invoke: async (command, args) => {
                    if (command === "background_standby_status")
                        return status();
                    if (command === "set_background_standby")
                        return setStandby(args);
                    return command === "plugin:updater|check"
                        ? null
                        : { ok: true };
                },
            },
        };
    }
}

function renderFixture(initialSettings, channelDescription) {
    document.body.classList.remove("booting");
    document.getElementById("launch").remove();
    uiInit();
    listDetail = document.getElementById("listDetail");
    listPodval = document.getElementById("listPodval");
    const now = Date.now() / 1000;
    const logo =
        "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="blue"/></svg>'
        );
    catsArray = ["Fixture"];
    cats = { Fixture: ["one", "two"] };
    channels = {
        one: {
            channel_name: "News",
            descr:
                channelDescription === undefined
                    ? '<b>Trusted description text</b><span style="color:red" data-ott-key="13" onclick="window.__metadataExecuted=true">Metadata text</span><script>window.__metadataExecuted=true</script>'
                    : channelDescription,
            icon: logo,
            name: "Current bulletin",
            nextpr: [{ name: "Next bulletin", time: now + 1800 }],
            rec: 1,
            time: now - 1800,
            time_to: now + 1800,
        },
        two: {
            channel_name: "Films",
            descr: "Second description",
            name: "Current film",
            rec: 0,
            time: now - 1800,
            time_to: now + 1800,
        },
    };
    for (let number = 3; number <= 40; number++) {
        const id = "fixture" + number;
        cats.Fixture.push(id);
        channels[id] = {
            channel_name: "Fixture channel " + number,
            descr: "Fixture description " + number,
            name: "Programme " + number,
            rec: 1,
            time: now - 1800,
            time_to: now + 1800,
        };
    }
    channels.fixture3.name = "";
    channels.fixture3.time = channels.fixture3.time_to = 0;
    window.channels = window.chanels = channels;
    getCurProgData = () => true;
    getChannelPicon = () => logo;
    settings.pageSize = 25;
    settings.interfaceTheme = 0;
    settings.noSmall = 1;
    window.sNoSmall = 1;
    settings.showScroll = window.sShowScroll = 1;
    sShowNum =
        sShowName =
        sShowPikon =
        sShowProgress =
        sShowProgram =
        sShowArchive =
            1;
    sShowDescr = 1;
    sThumbnail = window.sThumbnail = 1;
    sNextCountL = 1;
    sPreview = 0;
    sPSchannels = 0;
    parentPIN = "";
    parentalArray = [];
    sSHLcolor = "120,100";
    sSHLcolSel = "240,100";
    sSHLcolorB = "255,0";
    window.sSHLcolor = sSHLcolor;
    window.sSHLcolSel = sSHLcolSel;
    window.sSHLcolorB = sSHLcolorB;
    if (initialSettings) {
        loadSettings();
        Object.keys(initialSettings).forEach((key) => {
            settings[key] = initialSettings[key];
        });
    }
    bodyColor = "#f0f0f0";
    setColor();
    setFontSize();
    setListPos();
    _channelsList(0, 0);
    window.__fixtureReady = true;
}

async function fixturePage(
    browser,
    profile,
    initialSettings,
    language,
    channelDescription
) {
    const capacitor = profile === "capacitor";
    const native = profile === "tauri" || capacitor;
    const stage = capacitor
        ? "dist-mobile/"
        : native
          ? "src-tauri/frontend/"
          : "";
    const html = read(native ? stage + "index.html" : "dist/index.html");
    const parsed = new JSDOM(html);
    const document = parsed.window.document;
    const viewport =
        document.querySelector('meta[name="viewport"]')?.outerHTML || "";
    for (const script of document.querySelectorAll("script")) script.remove();
    const body = document.body.outerHTML;
    const styles = Array.from(document.querySelectorAll("style"), (style) => {
        style.setAttribute("nonce", nonce);
        return style.outerHTML;
    });
    parsed.window.close();
    const scripts = [
        "/fixture-init.js",
        "/js/runtime-polyfills.js",
        ...(native ? ["/js/native-environment.js"] : []),
        native ? "/js/jquery.min.js" : "/js/jquery-1.11.1.min.js",
        "/js/ottplay-core.js",
        "/dist/player.js",
        ...(language ? ["/locales/" + language + ".js"] : []),
        "/fixture-render.js",
    ];
    const assets = new Map([
        [
            "/fixture-init.js",
            "(" +
                initializeFixture.toString() +
                ")(" +
                native +
                "," +
                capacitor +
                ");",
        ],
        [
            "/fixture-render.js",
            "(" +
                renderFixture.toString() +
                ")(" +
                JSON.stringify(initialSettings) +
                "," +
                JSON.stringify(channelDescription) +
                ");",
        ],
        ["/js/runtime-polyfills.js", read(stage + "js/runtime-polyfills.js")],
        ["/js/ottplay-core.js", read(stage + "js/ottplay-core.js")],
        ["/dist/player.js", read(stage + "dist/player.js")],
        ["/styles/player.css", read(stage + "styles/player.css")],
    ]);
    for (const file of scripts.filter((file) =>
        /jquery|native-environment|\/locales\//.test(file)
    ))
        assets.set(file, read(stage + file.slice(1)));
    if (!native) {
        for (const file of fs.readdirSync(path.join(root, "fonts"))) {
            if (/\.(woff2?|ttf|eot|svg)$/.test(file))
                assets.set(
                    "/fonts/" + file,
                    fs.readFileSync(path.join(root, "fonts", file))
                );
        }
    }
    const context = await browser.newContext({
        hasTouch: capacitor,
        isMobile: capacitor,
        serviceWorkers: "block",
        viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    const errors = [];
    const unexpectedRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
        if (
            message.type() === "error" &&
            message.text().startsWith("[window.onerror]")
        )
            errors.push(message.text());
    });
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
            unexpectedRequests.push(url.origin + url.pathname);
            return route.abort("blockedbyclient");
        }
        if (url.pathname === "/") {
            return route.fulfill({
                body:
                    '<!doctype html><html><head><meta charset="utf-8">' +
                    viewport +
                    styles.join("\n") +
                    '<link rel="stylesheet" href="/styles/player.css"></head>' +
                    body.replace(
                        /<\/body>/i,
                        scripts
                            .map(
                                (src) =>
                                    '<script nonce="' +
                                    nonce +
                                    '" src="' +
                                    src +
                                    '"></script>'
                            )
                            .join("\n") + "</body>"
                    ) +
                    "</html>",
                contentType: "text/html; charset=utf-8",
                headers:
                    profile === "tauri"
                        ? { "Content-Security-Policy": nativePolicy() }
                        : {},
                status: 200,
            });
        }
        if (!assets.has(url.pathname)) {
            unexpectedRequests.push(url.pathname);
            return route.abort("blockedbyclient");
        }
        return route.fulfill({
            body: assets.get(url.pathname),
            contentType: url.pathname.endsWith(".css")
                ? "text/css"
                : url.pathname.startsWith("/fonts/")
                  ? "application/octet-stream"
                  : "text/javascript",
            status: 200,
        });
    });
    await page.goto(origin + "/");
    await expect
        .poll(() => page.evaluate(() => window.__fixtureReady), {
            message:
                profile +
                " fixture must finish the actual channel renderer: " +
                errors.join("; "),
        })
        .toBe(true);
    if (native) {
        await expect
            .poll(() => page.evaluate(() => window.__fixtureBackground.probes))
            .toBeGreaterThan(0);
        await expect
            .poll(() =>
                page.evaluate(() => window.__ottStandby.snapshot().state)
            )
            .toBe("running");
    }
    await expect(page.locator("#_name")).toContainText("Current bulletin");
    expect(errors).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
    return { close: () => context.close(), errors, page, unexpectedRequests };
}

async function listTouchFixture(browser, native = true) {
    const fixture = await fixturePage(browser, "server");
    // Gesture timings must be deliberate: IPC latency is not finger velocity.
    const clockStart = Date.now();
    await fixture.page.clock.install({ time: clockStart });
    await fixture.page.clock.pauseAt(clockStart + 1000);
    await fixture.page.evaluate((native) => {
        if (native) window.Capacitor = {};
        window.__touchClicks = [];
        window.__touchPlayed = [];
        window.playChannel = (...args) => window.__touchPlayed.push(args);
        const clicks = new WeakSet();
        const recordClick = (event) => {
            if (clicks.has(event)) return;
            clicks.add(event);
            window.__touchClicks.push(event.target.id);
        };
        window.addEventListener("click", recordClick, true);
        window.__touchBegin = (index, fingers = 1) => {
            const target =
                typeof index === "number"
                    ? document.getElementById("it" + index)
                    : index;
            if (!target) throw new Error("Touch target must be mounted");
            const rect = target.getBoundingClientRect();
            window.__touchGesture = {
                height: window.__ottListRowH,
                owner: window.__ottClassicScreenPort.listOwner(),
                target,
                x: rect.left + 20,
                y: rect.top + rect.height / 2,
            };
            // Detached rows no longer bubble to window after showPage replaces
            // innerHTML. Observe accidental clicks there as well as live rows.
            target.addEventListener("click", recordClick, true);
            return window.__touchSend("touchstart", 0, 0, false, fingers);
        };
        window.__touchSend = (
            type,
            rows = 0,
            dx = 0,
            fixedScreen = false,
            fingers = 1
        ) => {
            const gesture = window.__touchGesture;
            const x = gesture.x + dx;
            const y = gesture.y + rows * gesture.height;
            const touch = {
                clientX: x,
                clientY: y,
                identifier: 7,
                screenX: fixedScreen ? 0 : x,
                screenY: fixedScreen ? 0 : y,
                target: gesture.target,
            };
            const event = new Event(type, { bubbles: true, cancelable: true });
            const ended = type === "touchend" || type === "touchcancel";
            const touches = Array.from({ length: fingers }, (_, finger) => ({
                ...touch,
                identifier: touch.identifier + finger,
            }));
            Object.defineProperties(event, {
                changedTouches: { value: touches },
                targetTouches: { value: ended ? [] : touches },
                touches: { value: ended ? [] : touches },
            });
            // Keep the original target, including after it has been detached.
            gesture.target.dispatchEvent(event);
            return {
                connected: gesture.target.isConnected,
                index: window.selIndex,
                prevented: event.defaultPrevented,
            };
        };
    }, native);
    return fixture;
}

for (const direction of [-1, 1]) {
    test(`native fast flick coasts across several pages (${direction})`, async ({
        browser,
    }) => {
        const fixture = await listTouchFixture(browser);
        const page = fixture.page;
        try {
            await page.evaluate(() => {
                for (let number = 41; number <= 500; number++) {
                    const id = "fixture" + number;
                    cats.Fixture.push(id);
                    channels[id] = {
                        channel_name: "Fixture channel " + number,
                        rec: 0,
                    };
                }
                _channelsList(0, 250);
                window.__touchBegin(250);
            });
            for (const rows of [5.25, 10.25]) {
                await page.clock.runFor(30);
                await page.evaluate(
                    (rows) => window.__touchSend("touchmove", rows),
                    rows * direction
                );
            }
            const release = await page.evaluate((direction) => {
                window.__touchSend("touchend", 10.25 * direction);
                return {
                    index: window.selIndex,
                    pageSize: window.listPageSize,
                };
            }, direction);
            expect(release.index).toBe(250 - 10 * direction);
            await page.clock.runFor(1600);
            const end = await page.evaluate(() => window.selIndex);
            expect((release.index - end) * direction).toBeGreaterThanOrEqual(
                release.pageSize * 2
            );
            await expect(page.locator("#it" + end)).toBeVisible();
            expect(await page.evaluate(() => window.__touchClicks)).toEqual([]);
            expect(await page.evaluate(() => window.__touchPlayed)).toEqual([]);

            // A slow drag keeps its exact finger distance, without a tail.
            await page.evaluate(() => window.__touchBegin(window.selIndex));
            for (let step = 1; step <= 8; step++) {
                await page.clock.runFor(100);
                await page.evaluate(
                    (rows) => window.__touchSend("touchmove", rows),
                    (step * direction) / 2
                );
            }
            await page.evaluate(
                (rows) => window.__touchSend("touchend", rows),
                4.25 * direction
            );
            const slow = await page.evaluate(() => window.selIndex);
            expect(slow).toBe(end - 4 * direction);
            await page.clock.runFor(1600);
            expect(await page.evaluate(() => window.selIndex)).toBe(slow);
            expect(fixture.errors).toEqual([]);
            expect(fixture.unexpectedRequests).toEqual([]);
        } finally {
            await fixture.close();
        }
    });
}

test("native list swipe continues across replaced pages and clamps both ends", async ({
    browser,
}) => {
    const fixture = await listTouchFixture(browser);
    const page = fixture.page;
    try {
        await page.evaluate(() => {
            window.changeSelect(21);
            window.__touchBegin(21);
        });
        // Vertical dominance still scrolls with substantial horizontal drift.
        // Screen coordinates deliberately differ: this path uses client pixels.
        const crossed = await page.evaluate(() =>
            window.__touchSend("touchmove", -9.25, 30, true)
        );
        expect(crossed).toEqual({
            connected: false,
            index: 30,
            prevented: true,
        });
        await expect(page.locator("#it30")).toBeVisible();
        expect(
            await page.evaluate(() =>
                window.__touchSend("touchmove", -13.25, 35, true)
            )
        ).toMatchObject({ connected: false, index: 34, prevented: true });
        expect(
            await page.evaluate(() => window.__touchSend("touchmove", -80))
        ).toMatchObject({ index: 39 });
        // Overscroll must not have to be unwound before reversing direction.
        expect(
            await page.evaluate(() => window.__touchSend("touchmove", -77.75))
        ).toMatchObject({ index: 37 });
        expect(
            await page.evaluate(() => window.__touchSend("touchmove", 80))
        ).toMatchObject({ index: 0 });
        expect(
            await page.evaluate(() => window.__touchSend("touchmove", 90))
        ).toMatchObject({ index: 0 });
        await page.evaluate(() => window.__touchSend("touchend", 90));
        await expect(page.locator("#it0")).toBeVisible();
        expect(await page.evaluate(() => window.__touchClicks)).toEqual([]);
        expect(await page.evaluate(() => window.__touchPlayed)).toEqual([]);
        expect(fixture.errors).toEqual([]);
        expect(fixture.unexpectedRequests).toEqual([]);
    } finally {
        await fixture.close();
    }
});

test("native list swipe never becomes a tap after reversal or a coalesced end", async ({
    browser,
}) => {
    const fixture = await listTouchFixture(browser);
    const page = fixture.page;
    try {
        const reversed = await page.evaluate(() => {
            window.changeSelect(10);
            window.__touchBegin(10);
            window.__touchSend("touchmove", -3.25);
            window.__touchSend("touchmove", 0);
            return window.__touchSend("touchend", 0);
        });
        expect(reversed.index).toBe(10);
        expect(await page.evaluate(() => window.__touchClicks)).toEqual([]);
        const ended = await page.evaluate(() => {
            window.__touchBegin(10);
            return window.__touchSend("touchend", -4.25);
        });
        expect(ended.index).toBe(14);
        expect(await page.evaluate(() => window.__touchClicks)).toEqual([]);
        await expect(page.locator("#it14")).toBeVisible();

        // The next stationary native tap activates its row immediately;
        // a drag must not poison the next gesture or activate its final row.
        await page.evaluate(() => {
            window.__touchBegin(8);
            window.__touchSend("touchend");
        });
        expect(await page.evaluate(() => window.selIndex)).toBe(8);
        expect(await page.evaluate(() => window.__touchClicks)).toEqual([
            "it8",
        ]);
        expect(await page.evaluate(() => window.__touchPlayed)).toEqual([
            [0, 8],
        ]);
        expect(await page.evaluate(() => window.isListVisible)).toBe(false);
        expect(fixture.errors).toEqual([]);
        expect(fixture.unexpectedRequests).toEqual([]);
    } finally {
        await fixture.close();
    }
});

test("native list taps activate selected and nested unfocused rows exactly once", async ({
    browser,
}) => {
    for (const index of [0, 8]) {
        const fixture = await listTouchFixture(browser);
        const page = fixture.page;
        try {
            await page.evaluate((index) => {
                const row = document.getElementById("it" + index);
                const target = row.querySelector("span");
                if (!target)
                    throw new Error("Rendered row must have a nested target");
                window.__touchBegin(target);
                // Ordinary finger jitter is a tap, not a list scroll.
                window.__touchSend("touchend", 0.1, 2);
            }, index);
            expect(await page.evaluate(() => window.selIndex)).toBe(index);
            expect(await page.evaluate(() => window.__touchPlayed)).toEqual([
                [0, index],
            ]);
            expect(await page.evaluate(() => window.__touchClicks.length)).toBe(
                1
            );
            expect(await page.evaluate(() => window.isListVisible)).toBe(false);
            expect(fixture.errors).toEqual([]);
            expect(fixture.unexpectedRequests).toEqual([]);
        } finally {
            await fixture.close();
        }
    }
});

test("native mouse and remote keys and browser touch retain focus before activation", async ({
    browser,
}) => {
    for (const input of ["mouse", "remote", "browser-touch"]) {
        const fixture = await listTouchFixture(
            browser,
            input !== "browser-touch"
        );
        const page = fixture.page;
        try {
            if (input === "mouse") await page.locator("#it1").click();
            else if (input === "remote")
                await page.evaluate(() => window._doKey(window.keys.DOWN));
            else
                await page.evaluate(() => {
                    window.__touchBegin(1);
                    window.__touchSend("touchend");
                });
            expect(await page.evaluate(() => window.selIndex)).toBe(1);
            expect(await page.evaluate(() => window.__touchPlayed)).toEqual([]);
            expect(await page.evaluate(() => window.isListVisible)).toBe(true);
            if (input === "mouse") await page.locator("#it1").click();
            else if (input === "remote")
                await page.evaluate(() => window._doKey(window.keys.ENTER));
            else
                await page.evaluate(() => {
                    window.__touchBegin(1);
                    window.__touchSend("touchend");
                });
            expect(await page.evaluate(() => window.__touchPlayed)).toEqual([
                [0, 1],
            ]);
            expect(await page.evaluate(() => window.isListVisible)).toBe(false);
            expect(fixture.errors).toEqual([]);
            expect(fixture.unexpectedRequests).toEqual([]);
        } finally {
            await fixture.close();
        }
    }
});

test("native list swipe cancellation and departed owners cannot operate another screen", async ({
    browser,
}) => {
    const fixture = await listTouchFixture(browser);
    const page = fixture.page;
    try {
        expect(
            await page.evaluate(() => {
                window.changeSelect(24);
                window.__touchBegin(24);
                window.__touchSend("touchmove", -3.25);
                window.__touchSend("touchcancel", -3.25);
                window.__touchSend("touchmove", -6.25);
                return window.__touchSend("touchend", -6.25).index;
            })
        ).toBe(27);
        const replaced = await page.evaluate(() => {
            window.__touchBegin(27);
            window.listArray = window.listArray.slice();
            window.listDataArray = window.listArray;
            window.selIndex = 0;
            window.showPage();
            window.__touchSend("touchmove", -5);
            window.__touchSend("touchend", -5);
            return {
                index: window.selIndex,
                oldActive: window.__touchGesture.owner.active(),
            };
        });
        expect(replaced).toEqual({ index: 0, oldActive: false });
        await page.evaluate(() => {
            window.__touchBegin(0);
            window.__touchAnswers = [];
            window.confirmBox(
                "Keep this dialog open?",
                () => window.__touchAnswers.push("yes"),
                () => window.__touchAnswers.push("no")
            );
            window.__touchSend("touchmove", -5);
            window.__touchSend("touchend", 0);
        });
        await expect(page.locator("#dialogbox")).toBeVisible();
        expect(await page.evaluate(() => window.selIndex)).toBe(0);
        expect(await page.evaluate(() => window.__touchAnswers)).toEqual([]);
        expect(await page.evaluate(() => window.__touchClicks)).toEqual([]);
        expect(await page.evaluate(() => window.__touchPlayed)).toEqual([]);
        expect(fixture.errors).toEqual([]);
        expect(fixture.unexpectedRequests).toEqual([]);
    } finally {
        await fixture.close();
    }
});

test("native list swipe leaves editor defaults and multifinger shortcuts intact", async ({
    browser,
}) => {
    const fixture = await listTouchFixture(browser);
    try {
        const result = await fixture.page.evaluate(() => {
            const host = document.createElement("div");
            host.innerHTML =
                '<input id="touch-input"><textarea id="touch-textarea"></textarea>' +
                '<select id="touch-select"><option id="touch-option">Choice</option></select>' +
                '<label for="touch-input"><span id="touch-label">Label</span></label>' +
                '<div contenteditable="true"><span id="touch-editable">Text</span></div>';
            document.getElementById("listIn").appendChild(host);
            const editorDefaults = [];
            for (const id of [
                "touch-input",
                "touch-textarea",
                "touch-select",
                "touch-option",
                "touch-label",
                "touch-editable",
            ]) {
                editorDefaults.push(
                    window.__touchBegin(document.getElementById(id)).prevented,
                    window.__touchSend("touchmove", -5).prevented,
                    window.__touchSend("touchend", -5).prevented
                );
            }
            host.remove();
            const keys = [];
            const alerts = [];
            window._doKey = (key) => keys.push(key);
            window.alert = (message) => alerts.push(message);
            for (const fingers of [2, 3]) {
                window.__touchBegin(0, fingers);
                window.__touchSend("touchend", 0, 0, false, fingers);
            }
            window.__touchBegin(0, 4);
            window.__touchSend("touchend", 0, 0, false, 4);
            window.__touchBegin(0);
            window.__touchSend("touchmove", -10);
            window.__touchSend("touchend", -10);
            const lockedIndex = window.selIndex;
            window.__touchBegin(0, 4);
            window.__touchSend("touchend", 0, 0, false, 4);
            window.__touchBegin(0);
            window.__touchSend("touchend", -3.25);
            return {
                alerts,
                clicks: window.__touchClicks,
                editorDefaults,
                expectedAlerts: [
                    window._("Touchscreen locked"),
                    window._("Touchscreen unlocked"),
                ],
                expectedKeys: [window.keys.ENTER, window.keys.SETUP],
                index: window.selIndex,
                keys,
                lockedIndex,
                played: window.__touchPlayed,
            };
        });
        expect(result.editorDefaults).toEqual(Array(18).fill(false));
        expect(result.keys).toEqual(result.expectedKeys);
        expect(result.alerts).toEqual(result.expectedAlerts);
        expect(result.lockedIndex).toBe(0);
        expect(result.index).toBe(3);
        expect(result.clicks).toEqual([]);
        expect(result.played).toEqual([]);
        expect(fixture.errors).toEqual([]);
        expect(fixture.unexpectedRequests).toEqual([]);
    } finally {
        await fixture.close();
    }
});

test("native list swipe cancels an added finger after paging in either lift order", async ({
    browser,
}) => {
    const fixture = await listTouchFixture(browser);
    try {
        for (const firstLift of ["original", "added"]) {
            const result = await fixture.page.evaluate((firstLift) => {
                const keys = [];
                window._doKey = (key) => keys.push(key);
                window.changeSelect(24 - window.selIndex);
                window.__touchBegin(24);
                window.__touchSend("touchmove", -3.25);
                const gesture = window.__touchGesture;
                const original = {
                    clientX: gesture.x,
                    clientY: gesture.y - 3.25 * gesture.height,
                    identifier: 7,
                    target: gesture.target,
                };
                const target = document.getElementById("it27");
                const box = target.getBoundingClientRect();
                const added = {
                    clientX: box.left + 30,
                    clientY: box.top + box.height / 2,
                    identifier: 8,
                    target,
                };
                for (const touch of [original, added]) {
                    touch.screenX = touch.clientX;
                    touch.screenY = touch.clientY;
                }
                function send(type, changed, touches) {
                    const event = new Event(type, {
                        bubbles: true,
                        cancelable: true,
                    });
                    Object.defineProperties(event, {
                        changedTouches: { value: [changed] },
                        targetTouches: {
                            value: touches.filter(
                                (touch) => touch.target === changed.target
                            ),
                        },
                        touches: { value: touches },
                    });
                    changed.target.dispatchEvent(event);
                    return event.defaultPrevented;
                }
                const prevented = [
                    send("touchstart", added, [original, added]),
                ];
                const first = firstLift === "original" ? original : added;
                const last = firstLift === "original" ? added : original;
                prevented.push(send("touchend", first, [last]));
                last.clientY -= 5 * gesture.height;
                last.screenY = last.clientY;
                prevented.push(send("touchmove", last, [last]));
                prevented.push(send("touchend", last, []));
                const index = window.selIndex;
                // The detached target must lose its temporary listeners after
                // the last lift, not retain a callback into another gesture.
                const released = !send("touchmove", original, [original]);
                window.__touchBegin(27);
                window.__touchSend("touchend", -3.25);
                return {
                    clicks: window.__touchClicks,
                    detached: !original.target.isConnected,
                    index,
                    keys,
                    nextIndex: window.selIndex,
                    prevented,
                    released,
                };
            }, firstLift);
            expect(result, firstLift).toEqual({
                clicks: [],
                detached: true,
                index: 27,
                keys: [],
                nextIndex: 30,
                prevented: [true, true, true, true],
                released: true,
            });
        }
        expect(fixture.errors).toEqual([]);
        expect(fixture.unexpectedRequests).toEqual([]);
    } finally {
        await fixture.close();
    }
});

test("browser list swipe retains legacy remote navigation", async ({
    browser,
}) => {
    const fixture = await listTouchFixture(browser, false);
    try {
        const result = await fixture.page.evaluate(() => {
            window.changeSelect(10);
            window.__touchBegin(10);
            window.__touchSend("touchmove", -10);
            return window.__touchSend("touchend", -10);
        });
        expect(result.index).toBe(9);
        expect(await fixture.page.evaluate(() => window.__touchClicks)).toEqual(
            []
        );
        expect(fixture.errors).toEqual([]);
        expect(fixture.unexpectedRequests).toEqual([]);
    } finally {
        await fixture.close();
    }
});

for (const profile of ["server", "tauri", "capacitor"]) {
    test(
        profile + " remote channel selection closes the list after admission",
        async ({ browser }) => {
            // Hostile metadata is tested by the rich-channel security case.
            // New Chromium reports CSP even during inert parsing; this case
            // requires no application-generated inline event handlers.
            const fixture = await fixturePage(
                browser,
                profile,
                undefined,
                undefined,
                "<b>Trusted description text</b><span>Metadata text</span>"
            );
            const page = fixture.page;
            try {
                await page.evaluate(() => {
                    window.channelsList = window._channelsList;
                    window.curList = window.cList = window.cats.Fixture;
                    window.catIndex = window.primaryIndex = 0;
                    window.commandChannelsReady = true;
                    window.settings.stopPlay = 0;
                    window.settings.infoSwitch = 0;
                    window.__remotePlayed = [];
                    // Keep command admission, selection and overlays real; only
                    // replace provider/decoder boundaries in this offline fixture.
                    window.getChannelUrl = (id) => "fixture:" + id;
                    window.stbPlay = (url) => window.__remotePlayed.push(url);
                    window.setPlayer = () => {};
                    window.checkMedia = () => {};
                    window.providerGetItem = () => null;
                    window.providerSetItem = () => {};
                });
                const list = page.locator("#list");
                const play = (query, pendingPreview) =>
                    page.evaluate(
                        ({ query, pendingPreview }) =>
                            new Promise((resolve) => {
                                if (pendingPreview)
                                    window.previewChId(pendingPreview);
                                executeRemoteRequest(
                                    { action: "play", params: { query } },
                                    resolve
                                );
                            }),
                        { pendingPreview, query }
                    );
                const openList = () =>
                    page.evaluate(() => {
                        window.__remotePlayed = [];
                        window.channelsList(
                            window.catIndex,
                            window.primaryIndex
                        );
                    });
                const playback = () =>
                    page.evaluate(() => ({
                        channel: window.curList[window.primaryIndex],
                        played: window.__remotePlayed,
                        preview: window.previewChan,
                        visible: window.isListVisible,
                    }));

                if (profile !== "server") {
                    // A pending native probe must reject admission without
                    // claiming playback or closing the user's current list.
                    await page.evaluate(() => {
                        window.__ottStandby.native(
                            window.__ottNativeStandby,
                            () =>
                                new Promise((resolve) => {
                                    window.__finishFixtureProbe = resolve;
                                })
                        );
                    });
                    await expect
                        .poll(() =>
                            page.evaluate(
                                () =>
                                    typeof window.__finishFixtureProbe ===
                                        "function" &&
                                    window.__ottStandby.blocked()
                            )
                        )
                        .toBe(true);
                    const beforeBlocked = await playback();
                    expect(await play("2")).toMatchObject({
                        data: { error: "Playback was rejected by the player." },
                        status: "rejected",
                    });
                    await expect(list).toBeVisible();
                    expect(await playback()).toEqual(beforeBlocked);
                    for (const command of [
                        { channel_number: 2, command: "channel_by_number" },
                        { channel_name: "Films", command: "channel_by_name" },
                        { command: "random_channel", random_range: [1, 1] },
                    ]) {
                        expect(
                            await page.evaluate(
                                (value) => window.handleCommand(value),
                                command
                            )
                        ).toBe("rejected");
                    }
                    expect(await playback()).toEqual(beforeBlocked);
                    await page.evaluate(() =>
                        window.__finishFixtureProbe({
                            pending: 0,
                            quiescent: false,
                            standby: false,
                        })
                    );
                    await expect
                        .poll(() =>
                            page.evaluate(
                                () => window.__ottStandby.snapshot().state
                            )
                        )
                        .toBe("running");
                }

                // The actual ott request handler must enter fullscreen even
                // when the requested channel is already playing.
                for (const query of ["2", "2"]) {
                    await openList();
                    await expect(list).toBeVisible();
                    expect((await play(query)).status).toBe("ok");
                    await expect(list).toBeHidden();
                    expect(await playback()).toMatchObject({
                        channel: "two",
                        played: ["fixture:two"],
                        visible: false,
                    });
                }

                // Legacy remote commands share the same production admission.
                for (const command of [
                    { channel_number: 1, command: "channel_by_number" },
                    { channel_name: "Films", command: "channel_by_name" },
                    { command: "random_channel", random_range: [1, 1] },
                ]) {
                    await openList();
                    await expect(list).toBeVisible();
                    await page.evaluate(
                        (command) => window.handleCommand(command),
                        command
                    );
                    await expect(list).toBeHidden();
                    expect(await playback()).toMatchObject({
                        channel:
                            command.command === "channel_by_name"
                                ? "two"
                                : "one",
                        played: [
                            command.command === "channel_by_name"
                                ? "fixture:two"
                                : "fixture:one",
                        ],
                        visible: false,
                    });
                }

                // Closing an active preview must not restore the old stream;
                // a pending preview must not replace the remote choice later.
                await page.evaluate(() => {
                    window.sPreview = 1;
                });
                for (const previewStarted of [true, false]) {
                    await openList();
                    if (previewStarted) {
                        await page.evaluate(() =>
                            window.previewChId("fixture3")
                        );
                        await expect
                            .poll(() =>
                                page.evaluate(() => window.__remotePlayed)
                            )
                            .toEqual(["fixture:fixture3"]);
                        await page.evaluate(() => {
                            window.__remotePlayed = [];
                        });
                    }
                    expect(
                        (
                            await play(
                                "2",
                                previewStarted ? undefined : "fixture3"
                            )
                        ).status
                    ).toBe("ok");
                    await expect(list).toBeHidden();
                    await page.waitForTimeout(650);
                    expect(await playback()).toEqual({
                        channel: "two",
                        played: ["fixture:two"],
                        preview: null,
                        visible: false,
                    });
                }

                await page.evaluate(() => {
                    window.sPreview = 0;
                    window.settings.psChannels = window.sPSchannels = 1;
                    // Exercise the real protected-record verifier, not a legacy plaintext fixture.
                    window.parentPIN = window.__ottPinSecurity.prepare("1234");
                    window.parentalArray = ["one"];
                    window.__ottParental.revoke();
                });
                await openList();
                expect((await play("9999")).status).toBe("rejected");
                await expect(list).toBeVisible();
                expect((await playback()).played).toEqual([]);

                // A remote request may dispatch a PIN challenge, but cannot
                // dismiss the list or start media until the real PIN succeeds.
                expect((await play("1")).status).toBe("ok");
                const dialog = page.locator("#dialogbox");
                await expect(dialog).toBeVisible();
                await expect(list).toBeVisible();
                expect((await playback()).played).toEqual([]);
                expect((await play("9999")).status).toBe("rejected");
                await expect(dialog).toBeVisible();
                for (let digit = 0; digit < 4; digit++)
                    await page.locator("#k0 .btn").click();
                await expect(dialog).toBeHidden();
                await expect(list).toBeVisible();
                expect((await playback()).played).toEqual([]);

                expect((await play("1")).status).toBe("ok");
                await expect(dialog).toBeVisible();
                for (const digit of [1, 2, 3, 4])
                    await page.locator("#k" + digit + " .btn").click();
                await expect(dialog).toBeHidden();
                await expect(list).toBeHidden();
                expect(await playback()).toMatchObject({
                    channel: "one",
                    played: ["fixture:one"],
                    visible: false,
                });
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
                expect(
                    await page.evaluate(() =>
                        window.__fixtureViolations.filter((directive) =>
                            directive.startsWith("script-src")
                        )
                    )
                ).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );
}

for (const profile of ["server", "tauri"]) {
    test(
        profile +
            " settings value grid works under CSP and retains draft semantics",
        async ({ browser }) => {
            const fixture = await fixturePage(browser, profile);
            const page = fixture.page;
            try {
                await page.evaluate(() => {
                    settingsInterface();
                    window.__valueRow = listArray.find(
                        (row) => row.settingId === "interfaceTheme"
                    );
                    window.__originalTheme = __valueRow.val;
                    __valueRow.val = 0;
                });
                await page.evaluate(
                    () =>
                        new Promise((resolve) =>
                            requestAnimationFrame(() =>
                                requestAnimationFrame(resolve)
                            )
                        )
                );
                await page.evaluate(() => {
                    window.__fixtureViolations = [];
                    selectValue(__valueRow);
                });
                const choice = page.locator("#ik1");
                await expect(choice).toHaveCSS("line-height", "32px");
                const widths = await page
                    .locator("#listAbout .osk-key")
                    .evaluateAll((rows) =>
                        rows.map((row) => row.getBoundingClientRect().width)
                    );
                expect(widths).toHaveLength(3);
                expect(widths[0]).toBeGreaterThan(200);
                expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(
                    1
                );
                await choice.click();
                expect(await page.evaluate(() => __valueRow.val)).toBe(0);
                await expect(page.locator("#listDetail")).toHaveText("PLi-HD");
                await expect(page.locator("#listAbout")).toBeVisible();
                expect(await page.evaluate(() => __fixtureViolations)).toEqual(
                    []
                );
                await choice.click();
                expect(await page.evaluate(() => __valueRow.val)).toBe(1);
                await expect(page.locator("#listAbout")).toBeHidden();
                // The value picker updates the draft; cancelling Settings keeps saved state.
                await page.evaluate(() => _doKey(keys.RETURN));
                await page.evaluate(() => settingsInterface());
                expect(
                    await page.evaluate(
                        () =>
                            listArray.find(
                                (row) => row.settingId === "interfaceTheme"
                            ).val === __originalTheme
                    )
                ).toBe(true);
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );
    test(
        profile + " a newer notification keeps its full visible lifetime",
        async ({ browser }) => {
            const fixture = await fixturePage(browser, profile);
            const page = fixture.page;
            try {
                // install() keeps wall time running until explicitly paused.
                await page.clock.install({ time: 0 });
                await page.clock.pauseAt(60000);
                await page.evaluate(() => showShift("Previous notification"));
                await page.clock.runFor(2500);
                await page.evaluate(() => showShift("Settings saved"));
                await page.clock.runFor(500);
                await expect(page.locator("#info")).toBeVisible();
                await expect(page.locator("#info")).toHaveText(
                    "Settings saved"
                );
                await page.clock.runFor(2499);
                await expect(page.locator("#info")).toBeVisible();
                await page.clock.runFor(1);
                await expect(page.locator("#info")).toBeHidden();
                await page.evaluate(() => showShift("Detached notification"));
                await page.clock.runFor(2500);
                await page.evaluate(() => {
                    const oldInfo = document.getElementById("info");
                    const replacement = oldInfo.cloneNode(false);
                    oldInfo.replaceWith(replacement);
                    showShift("Replacement node");
                });
                await page.clock.runFor(500);
                await expect(page.locator("#info")).toBeVisible();
                await expect(page.locator("#info")).toHaveText(
                    "Replacement node"
                );
                await page.clock.runFor(2499);
                await expect(page.locator("#info")).toBeVisible();
                await page.clock.runFor(1);
                await expect(page.locator("#info")).toBeHidden();
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );
    test(
        profile + " confirmation buttons keep their meaning under CSP",
        async ({ browser }) => {
            const fixture = await fixturePage(browser, profile);
            const page = fixture.page;
            try {
                await page.evaluate(() => {
                    // Reinitialization must not bind another activation handler.
                    window.uiInit();
                    window.uiInit();
                    window.stbBindKeyHandler();
                    window.closeList();
                });
                for (const answer of ["No", "Yes"]) {
                    for (const action of ["click", "Enter", "Space"]) {
                        await page.evaluate(() => {
                            window.__fixtureViolations = [];
                            window.__dialogAnswers = [];
                            window.confirmBox(
                                "Continue watching?",
                                () => window.__dialogAnswers.push("Yes"),
                                () => window.__dialogAnswers.push("No")
                            );
                        });
                        const button = page
                            .locator("#dialogbox")
                            .getByRole("button", { exact: true, name: answer });
                        if (action === "click")
                            await button.locator(".btn").click();
                        else {
                            await button.focus();
                            await page.keyboard.press(action);
                        }
                        await expect(page.locator("#dialogbox")).toBeHidden();
                        await expect(page.locator("#list_window")).toBeHidden();
                        expect(
                            await page.evaluate(() => window.__dialogAnswers)
                        ).toEqual([answer]);
                        expect(
                            await page.evaluate(
                                () => window.__fixtureViolations
                            )
                        ).toEqual([]);
                    }
                }
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );
    test(
        profile + " quality picker consumes clicks and preserves resume input",
        async ({ browser }) => {
            const fixture = await fixturePage(browser, profile);
            const page = fixture.page;
            try {
                await page.evaluate(() => {
                    window.stbBindKeyHandler();
                    window.__qualityChosen = [];
                    window.__qualityResumed = 0;
                    window.curColor = "#ffffff";
                    window.curColorB = "#345678";
                    window.__openQuality = () => {
                        window.__fixtureViolations = [];
                        window.showSelectBox(
                            0,
                            ["480", "720", "1080", "auto"],
                            (index) => {
                                window.__qualityChosen.push(index);
                                window.closeList();
                                window.confirmBox("Continue watching?", () => {
                                    window.__qualityResumed++;
                                });
                            },
                            -1,
                            true
                        );
                    };
                    window.__openQuality();
                });
                const picker = page.locator("#numprog");
                const selected = picker.getByRole("button", {
                    exact: true,
                    name: "480",
                });
                const fullHd = picker.getByRole("button", {
                    exact: true,
                    name: "1080",
                });
                await expect(selected).toHaveAttribute("aria-pressed", "true");
                await expect(selected).toHaveCSS(
                    "background-color",
                    "rgb(52, 86, 120)"
                );
                await fullHd.click();
                await expect(fullHd).toHaveAttribute("aria-pressed", "true");
                await expect(fullHd).toHaveCSS(
                    "background-color",
                    "rgb(52, 86, 120)"
                );
                await expect(page.locator("#list_window")).toBeHidden();
                expect(
                    await page.evaluate(() => window.__qualityChosen)
                ).toEqual([]);
                await fullHd.click();
                await expect(picker).toBeHidden();
                await expect(page.locator("#dialogbox")).toContainText(
                    "Continue watching?"
                );
                expect(
                    await page.evaluate(() => window.__qualityChosen)
                ).toEqual([2]);
                expect(await page.evaluate(() => window.__qualityResumed)).toBe(
                    0
                );
                await page.keyboard.press("Enter");
                await expect(page.locator("#dialogbox")).toBeHidden();
                await expect(page.locator("#list_window")).toBeHidden();
                expect(await page.evaluate(() => window.__qualityResumed)).toBe(
                    1
                );

                await page.evaluate(() => window.__openQuality());
                await page.keyboard.press("ArrowDown");
                await page.keyboard.press("ArrowDown");
                await expect(fullHd).toHaveAttribute("aria-pressed", "true");
                await page.keyboard.press("Enter");
                await expect(page.locator("#dialogbox")).toBeVisible();
                expect(
                    await page.evaluate(() => window.__qualityChosen)
                ).toEqual([2, 2]);
                expect(await page.evaluate(() => window.__qualityResumed)).toBe(
                    1
                );
                await page.keyboard.press("Enter");
                await expect(page.locator("#dialogbox")).toBeHidden();
                await expect(page.locator("#list_window")).toBeHidden();
                expect(await page.evaluate(() => window.__qualityResumed)).toBe(
                    2
                );

                await page.evaluate(() => window.__openQuality());
                await selected.focus();
                await page.keyboard.press("Space");
                await expect(page.locator("#dialogbox")).toBeVisible();
                expect(
                    await page.evaluate(() => window.__qualityChosen)
                ).toEqual([2, 2, 0]);
                expect(await page.evaluate(() => window.__qualityResumed)).toBe(
                    2
                );
                expect(
                    await page.evaluate(() => window.__fixtureViolations)
                ).toEqual([]);
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );
    test(
        profile +
            " archive confirmation preserves translated lines and choices",
        async ({ browser }) => {
            for (const [language, title, age, yes, no] of [
                [
                    "english",
                    "Resume from archive?",
                    "Bookmark age (days): 0",
                    "Yes",
                    "No",
                ],
                [
                    "russian",
                    "Продолжить из архива?",
                    "Давность закладки (дни): 0",
                    "Да",
                    "Нет",
                ],
            ]) {
                const fixture = await fixturePage(
                    browser,
                    profile,
                    undefined,
                    language
                );
                const page = fixture.page;
                try {
                    const archiveStart = await page.evaluate(() => {
                        // Provider startup normally installs numeric channel
                        // IDs and the production keyboard listener.
                        window.channels[101] = window.channels.one;
                        window.cats.Fixture = [101];
                        window.curList = window.cats.Fixture;
                        window.catIndex = window.primaryIndex = 0;
                        window.stbBindKeyHandler();
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
                        window.providerGetItem = (key) =>
                            stored.get(key) ?? null;
                        window.providerSetItem = (key, value) =>
                            stored.set(key, value);
                        window.__confirmationChoices = [];
                        window.playArchive = (time) =>
                            window.__confirmationChoices.push([
                                "archive",
                                time,
                            ]);
                        window.playChannel = (category, index) =>
                            window.__confirmationChoices.push([
                                "live",
                                category,
                                index,
                            ]);
                        window.stbIsPlaying = () => false;
                        return start;
                    });
                    const dialog = page.locator("#dialogbox");
                    for (const accept of [true, false]) {
                        expect(
                            await page.evaluate(() => restoreContinueWatch())
                        ).toBe(true);
                        await expect(dialog).toBeVisible();
                        await expect(dialog).toContainText(title);
                        await expect(dialog).toContainText(age);
                        await expect(dialog).not.toContainText(
                            /<br\s*\/?\s*>/i
                        );
                        await expect(
                            dialog.locator(".localized-text > br")
                        ).toHaveCount(2);
                        await expect(dialog.locator("center > br")).toHaveCount(
                            2
                        );
                        const lines = await dialog.evaluate((element) => {
                            const nodes = [
                                ...element.querySelector(".localized-text")
                                    .childNodes,
                            ].filter(
                                (node) =>
                                    node.nodeType === Node.TEXT_NODE &&
                                    node.textContent.trim()
                            );
                            return nodes.slice(0, 2).map((node) => {
                                const range = document.createRange();
                                range.selectNodeContents(node);
                                const rect = range.getBoundingClientRect();
                                return { height: rect.height, top: rect.top };
                            });
                        });
                        expect(lines).toHaveLength(2);
                        expect(lines[1].top - lines[0].top).toBeGreaterThan(
                            lines[0].height * 1.5
                        );
                        await expect(
                            dialog.getByRole("button", {
                                exact: true,
                                name: yes,
                            })
                        ).toBeVisible();
                        await expect(
                            dialog.getByRole("button", {
                                exact: true,
                                name: no,
                            })
                        ).toBeVisible();
                        if (accept) await page.keyboard.press("Enter");
                        else if (profile === "tauri")
                            await page.keyboard.press("Backspace");
                        else
                            await dialog
                                .getByRole("button", { exact: true, name: no })
                                .click();
                        await expect(dialog).toBeHidden();
                    }
                    expect(
                        await page.evaluate(() => window.__confirmationChoices)
                    ).toEqual([
                        ["archive", archiveStart],
                        ["live", 0, 0],
                    ]);
                    expect(fixture.errors).toEqual([]);
                    expect(fixture.unexpectedRequests).toEqual([]);
                } finally {
                    await fixture.close();
                }
            }
        }
    );

    test(
        profile +
            " confirmation allows only plain breaks and keeps markup inert",
        async ({ browser }) => {
            const fixture = await fixturePage(browser, profile);
            const page = fixture.page;
            try {
                const markup =
                    '<img src="/injected" onerror="window.__confirmationInjected=true"><svg onload="window.__confirmationInjected=true"></svg><script>window.__confirmationInjected=true</script><br onclick="window.__confirmationInjected=true">&lt;br&gt;';
                await page.evaluate((untrusted) => {
                    window.stbBindKeyHandler();
                    window.__confirmationChoices = [];
                    confirmBox(
                        "Title<br>A<br/>B<BR />C\r\nD\rE\nF" + untrusted,
                        () => window.__confirmationChoices.push("yes"),
                        () => window.__confirmationChoices.push("no")
                    );
                }, markup);
                const dialog = page.locator("#dialogbox");
                await expect(dialog).toBeVisible();
                await expect(dialog.locator("center > br")).toHaveCount(2);
                await expect(
                    dialog.locator(".localized-text > br")
                ).toHaveCount(6);
                await expect(
                    dialog.locator("img, svg, script, br[onclick]")
                ).toHaveCount(0);
                await expect(dialog).toContainText(markup);
                expect(
                    await page.evaluate(() => window.__confirmationInjected)
                ).toBeUndefined();
                await page.keyboard.press("Backspace");
                await expect(dialog).toBeHidden();
                expect(
                    await page.evaluate(() => window.__confirmationChoices)
                ).toEqual(["no"]);
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );
}

for (const profile of ["server", "tauri", "capacitor"]) {
    test(
        profile +
            " new script catalogs preserve native IME composition and RTL text",
        async ({ browser }) => {
            const fixture = await fixturePage(
                browser,
                profile,
                undefined,
                "arabic"
            );
            const page = fixture.page;
            try {
                await page.evaluate(() => {
                    window.stbBindKeyHandler();
                    window.__languageInputSaves = [];
                });
                const stage =
                    profile === "capacitor"
                        ? "dist-mobile/"
                        : profile === "tauri"
                          ? "src-tauri/frontend/"
                          : "";
                const languageCases = [
                    ["_ara", "arabic", "أخبار ١٢ العربية"],
                    ["_per", "persian", "می\u200cروم فارسی"],
                    ["_hin", "hindi", "हिन्दी समाचार"],
                    ["_mal", "malayalam", "മലയാളം വാർത്തകൾ"],
                    ["_chi", "chinese", "中文新闻𠀀"],
                    ["_jpn", "japanese", "ニュース東京"],
                    ["_kor", "korean", "한글한"],
                    ["_geo", "georgian", "ქართული ამბები"],
                    ["_amh", "amharic", "አማርኛ ዜና"],
                    ["_lao", "lao", "ຂ່າວ\u200bລາວ"],
                    ["_ori", "odia", "ଓଡ଼ିଆ ସମ୍ବାଦ"],
                    ["_asm", "assamese", "অসমীয়া বাতৰি"],
                    ["_snd", "sindhi", "سنڌي خبرون"],
                    ["_yor", "yoruba", "Ìròyìn Yorùbá ẹ́"],
                    ["_ibo", "igbo", "Akụkọ Igbo ụ̀"],
                ];
                for (const [code, name, value] of languageCases) {
                    const dictionary = readDictionary(
                        path.join(root, stage, "locales", name + ".js")
                    );
                    await page.evaluate(
                        ({ code, dictionary }) => {
                            window.keyStrings = dictionary;
                            stbSetItem("ottplaylang", code);
                            window.editCaption = dictionary.Search;
                            window.editvar = "";
                            window.setEdit = () =>
                                window.__languageInputSaves.push(
                                    window.editvar
                                );
                            showEditKey1();
                        },
                        { code, dictionary }
                    );
                    const input = page.locator("#editvar");
                    await expect(input).toBeFocused();
                    await expect(input).toHaveAttribute("dir", "auto");
                    await expect(page.locator("#editRemoteInput")).toHaveText(
                        dictionary["Remote text entry"]
                    );
                    await expect(
                        page.locator('#listEdit [data-ott-key="13"]')
                    ).toContainText(dictionary.Set);
                    await expect(
                        page.locator('#listEdit [data-ott-key="27"]')
                    ).toContainText(dictionary.Cancel);
                    await input.dispatchEvent("compositionstart", { data: "" });
                    await input.fill(value);
                    for (const key of ["Enter", "Escape", "ArrowDown"])
                        await input.dispatchEvent("keydown", {
                            key,
                            keyCode:
                                key === "Enter"
                                    ? 13
                                    : key === "Escape"
                                      ? 27
                                      : 40,
                        });
                    await expect(input).toBeVisible();
                    await expect(input).toBeFocused();
                    await input.dispatchEvent("compositionend", {
                        data: value,
                    });
                    await input.dispatchEvent("keydown", {
                        key: "Enter",
                        keyCode: 229,
                    });
                    await expect(input).toBeVisible();
                    await input.press("Enter");
                    await expect(input).toBeVisible();
                    const save = page.locator('#listEdit [data-ott-key="13"]');
                    await input.press("ArrowUp");
                    await expect(save).toBeFocused();
                    await save.press("ArrowUp");
                    await expect(
                        page.locator("#editRemoteInput")
                    ).toBeFocused();
                    await page.locator("#editRemoteInput").press("ArrowUp");
                    await expect(input).toBeFocused();
                    await input.press("ArrowDown");
                    await page.locator("#editRemoteInput").press("ArrowDown");
                    await expect(save).toBeFocused();
                    if (code === "_ara") {
                        await input.focus();
                        await save.dispatchEvent("click");
                    } else await save.press("Enter");
                    await expect(page.locator("#listEdit")).toBeHidden();
                    expect(
                        await page.evaluate(() =>
                            window.__languageInputSaves.at(-1)
                        )
                    ).toBe(value);
                }
                expect(
                    await page.evaluate(
                        () => window.__languageInputSaves.length
                    )
                ).toBe(languageCases.length);
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );
}

for (const profile of ["server", "tauri", "capacitor"]) {
    test(
        profile + " native editor hint buttons save and cancel settings",
        async ({ browser }) => {
            const fixture = await fixturePage(browser, profile);
            const page = fixture.page;
            try {
                await page.evaluate(() => {
                    uiInit();
                    uiInit();
                    saveSettings({
                        swopBaseUrl: "https://example.invalid/old",
                    });
                    settingsCommands();
                    window.__editorHintKeys = [];
                    const dispatch = window._doKey;
                    window._doKey = (key, event) => {
                        window.__editorHintKeys.push(key);
                        dispatch(key, event);
                    };
                });
                const saved = "https://example.invalid/swop?text=Привет&x=1";
                for (const save of [true, false]) {
                    await page.evaluate(() => aboutKeyHandler(keys.N2));
                    await page
                        .locator("#editvar")
                        .fill(save ? saved : "discard");
                    await page
                        .locator("#listEdit [data-ott-key]")
                        .filter({
                            hasText: save ? "Set" : "Cancel",
                        })
                        .click();
                    await expect(page.locator("#listEdit")).toBeHidden();
                    await expect(page.locator("#listAbout")).toContainText(
                        saved
                    );
                    expect(
                        await page.evaluate(() => ({
                            current: settings.swopBaseUrl,
                            facade: window.sSwopBaseUrl,
                            persisted: stbGetItem("sSwopBaseUrl"),
                        }))
                    ).toEqual({
                        current: saved,
                        facade: saved,
                        persisted: saved,
                    });
                }
                expect(
                    await page.evaluate(() => ({
                        actual: window.__editorHintKeys,
                        expected: [keys.ENTER, keys.EXIT],
                    }))
                ).toEqual({ actual: [13, 27], expected: [13, 27] });
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );
    test(
        profile + " Actions popup stays above programme details in every theme",
        async ({ browser }) => {
            const fixture = await fixturePage(browser, profile);
            const page = fixture.page;
            try {
                // Exercise phone-sized landscape geometry without a native
                // bridge, provider, saved profile or physical-device claim.
                await page.setViewportSize({ height: 430, width: 932 });
                await page.evaluate(() => {
                    window.sNoNumbersKeys = 0;
                    window.cList = Object.keys(channels);
                    window.providerGetItem = () => null;
                    window.providerSetItem = () => {};
                    window.favoritesArray = [];
                    channels.one.descr =
                        "Synthetic programme description over the Actions area. ".repeat(
                            60
                        );
                    window.__ottChannels.mount(window);
                    setEditor();
                });
                for (const theme of [0, 1, 2]) {
                    for (const position of [0, 1]) {
                        await page.evaluate(
                            ({ theme, position }) => {
                                settings.interfaceTheme = theme;
                                settings.listPosition = position;
                                setColor();
                                setFontSize();
                                setListPos();
                                _channelsList(0, 0);
                            },
                            { position, theme }
                        );
                        await expect(page.locator("#_prd")).toContainText(
                            "Synthetic programme description"
                        );
                        await page
                            .locator("#listPodval [data-ott-key]")
                            .filter({ hasText: "Actions" })
                            .click();
                        const popup = page.locator("#listPopUp");
                        await expect(popup).toBeVisible();
                        const targets = await popup
                            .locator("[data-ott-key]")
                            .evaluateAll((buttons) =>
                                buttons.map((button) => {
                                    const rect = button.getBoundingClientRect();
                                    const hit = document.elementFromPoint(
                                        rect.left + rect.width / 2,
                                        rect.top + rect.height / 2
                                    );
                                    return {
                                        label: button.textContent.trim(),
                                        receivesPoint: button.contains(hit),
                                    };
                                })
                            );
                        expect(targets.length).toBeGreaterThan(0);
                        expect(
                            targets.filter((target) => !target.receivesPoint),
                            `theme=${theme} position=${position}`
                        ).toEqual([]);
                        // A real coordinate click must reach Search through
                        // the long description and open its editor.
                        await popup
                            .locator("[data-ott-key]")
                            .filter({ hasText: "Search" })
                            .click();
                        await expect(page.locator("#listEdit")).toBeVisible();
                        await expect(popup).toBeHidden();
                        await page.evaluate(() => _doKey(keys.RETURN));
                        await expect(page.locator("#listEdit")).toBeHidden();
                    }
                }
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );
    test(
        profile +
            " Actions popup dispatches once and ignores covered or stale controls",
        async ({ browser }) => {
            const fixture = await fixturePage(browser, profile);
            const page = fixture.page;
            try {
                await page.evaluate(() => {
                    uiInit();
                    uiInit();
                    _channelsList(0, 0);
                    $("#listPopUp").show();
                    window.__popupDispatches = [];
                    window._doKey = (key) => window.__popupDispatches.push(key);
                    window.__sendPopupInput = () => {
                        const button = document.querySelector(
                            '#listPopUp [data-ott-key="' + keys.N6 + '"]'
                        );
                        button.click();
                        for (const keyCode of [13, 32])
                            button.dispatchEvent(
                                new KeyboardEvent("keydown", {
                                    bubbles: true,
                                    cancelable: true,
                                    keyCode,
                                })
                            );
                    };
                    window.__sendPopupInput();
                });
                const expected = await page.evaluate(() => [
                    keys.N6,
                    keys.N6,
                    keys.N6,
                ]);
                expect(
                    await page.evaluate(() => window.__popupDispatches)
                ).toEqual(expected);
                await page.evaluate(() => {
                    confirmBox("Cover the list", () => {});
                    window.__sendPopupInput();
                });
                await expect(page.locator("#dialogbox")).toBeVisible();
                expect(
                    await page.evaluate(() => window.__popupDispatches)
                ).toEqual(expected);
                await page.evaluate(() => {
                    window.__ottClassicScreenPort.close("dialog");
                    $("#dialogbox, #listPopUp").hide();
                    window.__sendPopupInput();
                    closeList();
                    // Even a stale visible DOM subtree cannot dispatch after
                    // its list owner has been retired.
                    $("#list, #listPopUp").show();
                });
                await expect(page.locator("#listPopUp")).toBeVisible();
                await page.evaluate(() => window.__sendPopupInput());
                expect(
                    await page.evaluate(() => window.__popupDispatches)
                ).toEqual(expected);
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );

    test(
        profile +
            " Actions dialog Search keeps its editor through input, save and cancel",
        async ({ browser }) => {
            const fixture = await fixturePage(browser, profile);
            const page = fixture.page;
            try {
                await page.evaluate(() => {
                    window.sNoNumbersKeys = 1;
                    window.cList = Object.keys(channels);
                    window.providerGetItem = () => null;
                    window.providerSetItem = () => {};
                    window.favoritesArray = [];
                    window.__ottChannels.mount(window);
                    setEditor();
                });
                for (const save of [true, false]) {
                    await page.evaluate(() => _channelsList(0, 0));
                    await page
                        .locator("#listPodval [data-ott-key]")
                        .filter({ hasText: "Actions" })
                        .click();
                    await expect(page.locator("#dialogbox")).toBeVisible();
                    await page
                        .locator("#dialogbox [data-ott-key]")
                        .filter({ hasText: "Search" })
                        .click();
                    await expect(page.locator("#listEdit")).toBeVisible();
                    await expect(page.locator("#dialogbox")).toBeHidden();
                    expect(
                        await page.evaluate(() => {
                            const port = window.__ottClassicScreenPort;
                            const dialog = port.owner("dialog");
                            return {
                                dialogActive: !!(dialog && dialog.active()),
                                editorForeground: port
                                    .owner("editor")
                                    .foreground(),
                            };
                        })
                    ).toEqual({ dialogActive: false, editorForeground: true });
                    await page.evaluate(() => _doKey(keys.DOWN));
                    await expect(page.locator("#listEdit")).toBeVisible();
                    await page.locator("#editvar").fill("News");
                    await page.evaluate(
                        (save) => _doKey(save ? keys.ENTER : keys.RETURN),
                        save
                    );
                    await expect(page.locator("#listEdit")).toBeHidden();
                    if (save) {
                        await expect(page.locator("#listIn .item")).toHaveCount(
                            1
                        );
                        await expect(page.locator("#it0")).toContainText(
                            "News"
                        );
                    } else {
                        await expect(
                            page.locator("#listCaption")
                        ).toContainText("Channel list");
                        await expect(page.locator("#listIn .item")).toHaveCount(
                            25
                        );
                    }
                }
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );
}

async function snapshot(page) {
    return page.evaluate(async () => {
        await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        const row = document.getElementById("it0");
        const picon = row.querySelector(".img");
        const progress = document.getElementById("prone");
        const archive = picon.previousElementSibling;
        const programme = document.getElementById("pnone");
        const scrollbar = document.querySelector(".list-scroll");
        const size = (element) => {
            const rect = element.getBoundingClientRect();
            return {
                height: Math.round(rect.height),
                width: Math.round(rect.width),
            };
        };
        return {
            archive: size(archive),
            archiveColor: getComputedStyle(archive).backgroundColor,
            detailAccent: getComputedStyle(
                document.querySelector("#_name > div")
            ).color,
            nextAccent: getComputedStyle(
                document.querySelector("#_nextpr span")
            ).color,
            picon: size(picon),
            piconImage: getComputedStyle(picon).backgroundImage,
            programmeAccent: getComputedStyle(programme).color,
            progress: size(progress.parentElement),
            progressColor: getComputedStyle(progress).backgroundColor,
            rowHeight: Math.round(row.getBoundingClientRect().height),
            scrollbar: size(scrollbar),
            scrollThumb: size(scrollbar.children[1]),
            scrollThumbColor: getComputedStyle(scrollbar.children[1])
                .backgroundColor,
            selection: getComputedStyle(row).backgroundColor,
            thumbnail: size(document.querySelector("#_prd .img")),
            titleColor: getComputedStyle(programme.parentElement).color,
        };
    });
}

test("PLi-HD switches the shipped UI and restores custom Classic colours", async ({
    browser,
}, testInfo) => {
    for (const profile of ["server", "tauri"]) {
        const fixture = await fixturePage(browser, profile);
        const page = fixture.page;
        try {
            const classic = await snapshot(page);
            await page.screenshot({
                path: testInfo.outputPath(profile + "-classic.png"),
            });
            const saved = await page.evaluate(() => {
                const saved = saveSettings({ interfaceTheme: 1 });
                _channelsList(0, 0);
                return saved;
            });
            expect(saved).toBe(true);
            await expect(page.locator("body")).toHaveClass(/theme-pli-hd/);
            await expect(page.locator("#_name")).toContainText(
                "Current bulletin"
            );
            const pli = await snapshot(page);
            expect(pli.selection).toBe("rgb(48, 50, 64)");
            expect(pli.programmeAccent).toBe("rgb(252, 192, 0)");
            expect(pli.detailAccent).toBe("rgb(252, 192, 0)");
            expect(pli.progressColor).toBe("rgb(252, 192, 0)");
            expect(pli.rowHeight).toBe(20);
            expect(pli.picon.height).toBeLessThanOrEqual(pli.rowHeight);
            expect(
                await page.evaluate(() => {
                    const clock = document.getElementById("listTime");
                    clock.textContent = "18:30:00";
                    const rect = clock.getBoundingClientRect();
                    return clock.contains(
                        document.elementFromPoint(
                            rect.x + rect.width / 2,
                            rect.y + rect.height / 2
                        )
                    );
                })
            ).toBe(true);
            await expect(page.locator("#listCaption")).toHaveCSS(
                "background-color",
                "rgb(36, 36, 36)"
            );
            await expect(page.locator("#it0")).toHaveCSS(
                "border-radius",
                "0px"
            );
            await expect(page.locator("#dialogbox")).toHaveCSS(
                "border-radius",
                "0px"
            );
            await expect(page.locator("#listIn .item")).toHaveCount(25);
            await page.screenshot({
                path: testInfo.outputPath(profile + "-pli-hd.png"),
            });
            await page.locator("#it1").click();
            await expect(page.locator("#it1")).toHaveCSS(
                "background-color",
                "rgb(48, 50, 64)"
            );
            await expect(page.locator("#_name")).toContainText("Current film");
            expect(
                await page.evaluate(() => {
                    const saved = saveSettings({ interfaceTheme: 0 });
                    _channelsList(0, 0);
                    return saved;
                })
            ).toBe(true);
            await expect(page.locator("body")).not.toHaveClass(/theme-pli-hd/);
            await expect(page.locator("#_name")).toContainText(
                "Current bulletin"
            );
            expect(await snapshot(page)).toEqual(classic);
            expect(fixture.errors).toEqual([]);
            expect(fixture.unexpectedRequests).toEqual([]);
        } finally {
            await fixture.close();
        }
    }
});

test("PLi-HD keeps preview, mask and list aligned after mirroring and resize", async ({
    browser,
}) => {
    for (const profile of ["server", "tauri"]) {
        const fixture = await fixturePage(browser, profile);
        const page = fixture.page;
        try {
            await page.evaluate(() => {
                const videoBox = document.createElement("div");
                videoBox.id = "vdiv";
                document.body.prepend(videoBox);
            });
            for (const viewport of [
                { height: 720, width: 1280 },
                { height: 1080, width: 1920 },
                { height: 540, width: 960 },
            ]) {
                await page.setViewportSize(viewport);
                for (const side of [0, 1]) {
                    for (const noSmall of [0, 1]) {
                        const boxes = await page.evaluate(
                            ({ side, noSmall }) => {
                                saveSettings({
                                    interfaceTheme: 1,
                                    listPosition: side,
                                    noSmall,
                                });
                                setFontSize();
                                _channelsList(0, 0);
                                const rect = (id) => {
                                    const r = document
                                        .getElementById(id)
                                        .getBoundingClientRect();
                                    return {
                                        bottom: r.bottom,
                                        height: r.height,
                                        right: r.right,
                                        width: r.width,
                                        x: r.x,
                                        y: r.y,
                                    };
                                };
                                return {
                                    bottom: rect("_b"),
                                    detail: rect("listDetail"),
                                    last: rect("it24"),
                                    left: rect("_l"),
                                    list: rect("listIn"),
                                    preview: rect("vdiv"),
                                    right: rect("_r"),
                                    top: rect("_t"),
                                };
                            },
                            { noSmall, side }
                        );
                        const x = viewport.width / 1280;
                        const y = viewport.height / 720;
                        expect(boxes.list.x).toBeCloseTo(
                            (side ? 60 : 530) * x,
                            0
                        );
                        expect(boxes.list.y).toBeCloseTo(110 * y, 0);
                        expect(boxes.list.width).toBeCloseTo(690 * x, 0);
                        expect(boxes.list.height).toBeCloseTo(510 * y, 0);
                        expect(boxes.last.bottom).toBeLessThanOrEqual(
                            boxes.list.bottom + 0.5
                        );
                        expect(boxes.detail.x).toBeCloseTo(
                            (side ? 778 : 85) * x,
                            0
                        );
                        expect(boxes.detail.y).toBeCloseTo(
                            (noSmall ? 110 : 360) * y,
                            0
                        );
                        if (!noSmall) {
                            expect(boxes.preview.x).toBeCloseTo(
                                (side ? 778 : 85) * x,
                                0
                            );
                            expect(boxes.preview.y).toBeCloseTo(110 * y, 0);
                            expect(boxes.preview.width).toBeCloseTo(417 * x, 0);
                            expect(boxes.preview.height).toBeCloseTo(
                                243 * y,
                                0
                            );
                            expect(boxes.top.bottom).toBeCloseTo(
                                boxes.preview.y,
                                0
                            );
                            expect(boxes.left.right).toBeCloseTo(
                                boxes.preview.x,
                                0
                            );
                            expect(boxes.right.x).toBeCloseTo(
                                boxes.preview.right,
                                0
                            );
                            expect(boxes.bottom.y).toBeCloseTo(
                                boxes.preview.bottom,
                                0
                            );
                        }
                    }
                }
            }
            expect(fixture.errors).toEqual([]);
            expect(fixture.unexpectedRequests).toEqual([]);
        } finally {
            await fixture.close();
        }
    }
});

for (const language of ["english", "russian"]) {
    test(`${language} credits controls retain readable English attribution offline`, async ({
        browser,
    }) => {
        const fixture = await fixturePage(
            browser,
            "tauri",
            undefined,
            language
        );
        const page = fixture.page;
        try {
            const title = await page.locator("#listCaption").textContent();
            await page.evaluate(() => {
                infoArr
                    .find((entry) => entry.name === "Interface credits")
                    .action();
            });
            const credits = page.locator("#listAbout .interface-credits");
            await expect(credits.locator("div[lang=en]")).toBeVisible();
            await expect(credits.locator(".credits-title")).toHaveText(
                language === "russian"
                    ? "Авторы интерфейса"
                    : "Interface credits"
            );
            await expect(credits.locator(".credits-language")).toHaveText(
                language === "russian"
                    ? "Оригинальный текст: Английский"
                    : "Original text: English"
            );
            await expect(credits.locator(".credits-navigation")).toHaveText(
                language === "russian"
                    ? "Прокрутка — вверх и вниз. Назад — закрыть."
                    : "Use Up / Down to scroll. Back to close."
            );
            await expect(credits).toContainText("Vali (2009–2010)");
            await expect(credits).toContainText("VU+NL, Milo");
            await expect(credits).toContainText("alex_qr");
            await expect(credits.locator("a").first()).toHaveAttribute(
                "href",
                "https://github.com/littlesat/skin-PLiHD"
            );
            expect(
                await page.evaluate(() => {
                    aboutKeyHandler(keys.DOWN);
                    return document.querySelector(
                        "#listAbout .interface-credits"
                    ).scrollTop;
                })
            ).toBeGreaterThan(0);
            await page.evaluate(() => aboutKeyHandler(keys.RETURN));
            await expect(credits).toHaveCount(0);
            await expect(page.locator("#listCaption")).toHaveText(title);
            await expect(page.locator("#it0")).toBeVisible();
            await page.evaluate(() => {
                infoArr
                    .find((entry) => entry.name === "Interface credits")
                    .action();
            });
            await page.locator('#listPodval [role="button"]').click();
            await expect(credits).toHaveCount(0);
            await expect(page.locator("#it0")).toBeVisible();
            expect(fixture.errors).toEqual([]);
            expect(fixture.unexpectedRequests).toEqual([]);
        } finally {
            await fixture.close();
        }
    });
}

for (const profile of ["tauri", "capacitor"]) {
    test(`${profile} media controls dispatch without inline handlers`, async ({
        browser,
    }) => {
        const fixture = await fixturePage(browser, profile);
        const page = fixture.page;
        try {
            await page.evaluate(() => {
                const saved = {};
                window.__fixtureViolations = [];
                window.__fixtureShuffles = 0;
                window.__ottMedia.useSource({
                    client: {
                        cancel() {},
                        load(_target, done) {
                            window.mediaRecords = [
                                {
                                    description: "Fixture media description",
                                    id: 1,
                                    stream_url: "fixture.mp4",
                                    title: "Film",
                                },
                            ];
                            window.mediaName = "Library";
                            done();
                        },
                    },
                    read: (key) => saved[key] || null,
                    sourceId: "fixture-media-controls",
                    title: "Library",
                    write: (key, value) => {
                        saved[key] = value;
                    },
                });
                window.__ottMedia.open(null);
                window.__ottMedia.toggleShuffle = () =>
                    window.__fixtureShuffles++;
            });
            const controls = page.locator("#mediaPlaybackControls");
            await controls.getByRole("button", { name: "Repeat: All" }).click();
            await controls
                .getByRole("button", { name: "Repeat: One" })
                .press("Space");
            await expect(
                controls.getByRole("button", { name: "Repeat: Off" })
            ).toBeVisible();
            await expect(
                controls.getByRole("button", { name: "Repeat: Off" })
            ).toBeFocused();
            // The debounced detail renderer replaces this container's contents.
            // Wait for its real output before inserting the forged control.
            await expect(page.locator("#listDetail > #_prd")).toHaveText(
                "Fixture media description"
            );
            await page.evaluate(() => {
                const forged = document.createElement("div");
                forged.id = "mediaPlaybackControls";
                forged.innerHTML =
                    '<span role="button" data-ott-key="' +
                    window.keys.N5 +
                    '">Metadata action</span>';
                forged.addEventListener("click", (event) =>
                    event.stopPropagation()
                );
                document.getElementById("_prd").appendChild(forged);
            });
            await page.getByRole("button", { name: "Metadata action" }).click();
            expect(await page.evaluate(() => window.__fixtureShuffles)).toBe(0);
            await controls
                .getByRole("button", { name: "Shuffle: Off" })
                .click();
            expect(await page.evaluate(() => window.__fixtureShuffles)).toBe(1);
            expect(
                await page.evaluate(() =>
                    window.__fixtureViolations.filter((directive) =>
                        directive.startsWith("script-src")
                    )
                )
            ).toEqual([]);
            expect(fixture.errors).toEqual([]);
            expect(fixture.unexpectedRequests).toEqual([]);
        } finally {
            await fixture.close();
        }
    });
}

test("active Tauri CSP reproduces the former inline-style failure", async ({
    browser,
}) => {
    const fixture = await fixturePage(browser, "tauri");
    try {
        const result = await fixture.page.evaluate(async () => {
            window.__fixtureViolations.length = 0;
            const example = document.createElement("div");
            example.innerHTML =
                '<span id="old-accent" style="color:rgb(1,2,3)">Old programme</span><div id="old-picon" style="width:24px;height:24px"></div>';
            document.body.appendChild(example);
            const trusted = document.createElement("span");
            trusted.style.color = "rgb(1, 2, 3)";
            example.appendChild(trusted);
            await new Promise((resolve) => setTimeout(resolve, 20));
            return {
                attrColor: getComputedStyle(
                    document.getElementById("old-accent")
                ).color,
                attrHeight: document
                    .getElementById("old-picon")
                    .getBoundingClientRect().height,
                propertyColor: getComputedStyle(trusted).color,
                violations: window.__fixtureViolations,
            };
        });
        expect(result.attrColor).not.toBe("rgb(1, 2, 3)");
        expect(result.attrHeight).toBe(0);
        expect(result.propertyColor).toBe("rgb(1, 2, 3)");
        expect(
            result.violations.some((directive) =>
                directive.startsWith("style-src")
            )
        ).toBe(true);
    } finally {
        await fixture.close();
    }
});

test("server and Tauri retain rich channel formatting under the native CSP", async ({
    browser,
}) => {
    const server = await fixturePage(browser, "server");
    const native = await fixturePage(browser, "tauri");
    try {
        const expected = await snapshot(server.page);
        const actual = await snapshot(native.page);
        for (const state of [expected, actual]) {
            expect(state.programmeAccent).toBe("rgb(0, 255, 0)");
            expect(state.detailAccent).toBe("rgb(0, 255, 0)");
            expect(state.nextAccent).toBe("rgb(0, 255, 0)");
            expect(state.titleColor).toBe("rgb(240, 240, 240)");
            expect(state.selection).toBe("rgb(0, 0, 128)");
            expect(state.archiveColor).toBe("rgb(0, 255, 0)");
            expect(state.progressColor).toBe("rgb(0, 255, 0)");
            expect(state.picon.width).toBeGreaterThan(10);
            expect(state.picon.height).toBeGreaterThan(10);
            expect(state.piconImage).toContain("data:image/svg+xml");
            expect(state.archive.height).toBeGreaterThan(0);
            expect(state.progress.width).toBe(40);
            expect(state.progress.height).toBeGreaterThan(0);
            expect(state.scrollbar.width).toBeGreaterThan(0);
            expect(state.scrollbar.height).toBeGreaterThan(0);
            expect(state.scrollThumb.height).toBeGreaterThan(0);
            expect(state.scrollThumb.height).toBeLessThan(
                state.scrollbar.height
            );
            expect(state.scrollThumbColor).toBe("rgba(180, 180, 200, 0.85)");
            expect(state.thumbnail).toEqual({ height: 200, width: 133 });
        }
        // OS fonts intentionally differ, so compare box geometry and colors,
        // not glyph widths or platform-specific rasterized text.
        expect(actual).toEqual(expected);
        for (const fixture of [server, native]) {
            const page = fixture.page;
            expect(await page.locator("#_prd b").textContent()).toBe(
                "Trusted description text"
            );
            expect(
                await page.locator("#_prd span").getAttribute("style")
            ).toBeNull();
            expect(
                await page.locator("#_prd span").getAttribute("onclick")
            ).toBeNull();
            expect(
                await page.locator("#_prd span").getAttribute("data-ott-key")
            ).toBeNull();
            expect(await page.locator("#_prd script").count()).toBe(0);
            expect(
                await page.evaluate(() => window.__metadataExecuted)
            ).toBeUndefined();
            await page.evaluate(() => {
                const valid = getChannelPicon("two");
                getChannelPicon = (id) =>
                    id === "one" ? { toString: null } : valid;
                _channelsList(0, 0);
            });
            await expect(page.locator("#it0 .img")).toHaveCSS(
                "background-image",
                "none"
            );
            await expect(page.locator("#it1 .img")).toHaveCSS(
                "background-image",
                /data:image\/svg\+xml/
            );
            await expect(page.locator("#pntwo")).toHaveCSS(
                "color",
                "rgb(0, 255, 0)"
            );
            await page.evaluate(() => {
                const valid = getChannelPicon("two");
                getChannelPicon = () => valid;
                _channelsList(0, 0);
            });
            await expect(page.locator("#pnfixture3")).toHaveText("");
            await page.evaluate(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
                const channel = channels.fixture3;
                channel.name = "Arrived programme";
                channel.time = Date.now() / 1000 - 1800;
                channel.time_to = channel.time + 3600;
                updateChanelList("fixture3");
            });
            await expect(page.locator("#pnfixture3")).toHaveText(
                "Arrived programme"
            );
            await expect(page.locator("#pnfixture3")).toHaveCSS(
                "color",
                "rgb(0, 255, 0)"
            );
            expect(
                await page
                    .locator("#prfixture3")
                    .evaluate(
                        (element) => element.getBoundingClientRect().width
                    )
            ).toBeGreaterThan(0);
            await page.evaluate(() => {
                window.sThumbnail = 0;
                updateChanelList("one");
            });
            await expect(page.locator("#_prd .img")).toHaveCount(0);
            await page.locator("#it1").click();
            await expect(page.locator("#_name")).toContainText("Current film");
            await expect(page.locator("#it1")).toHaveCSS(
                "background-color",
                "rgb(0, 0, 128)"
            );
            await expect(page.locator("#it0")).not.toHaveCSS(
                "background-color",
                "rgb(0, 0, 128)"
            );
            await expect(page.locator("#listIn .item")).toHaveCount(25);
            await page.locator(".list-scroll-thumb").click();
            await expect(page.locator("#_name")).toContainText("Programme 27");
            await expect(page.locator("#listIn .item")).toHaveCount(15);
            await expect(page.locator("#it26")).toHaveCSS(
                "background-color",
                "rgb(0, 0, 128)"
            );
            const secondPage = await page.evaluate(() => {
                const scroll = document.querySelector(".list-scroll");
                const list = document
                    .getElementById("listIn")
                    .getBoundingClientRect();
                const selected = document
                    .getElementById("it26")
                    .getBoundingClientRect();
                return {
                    beforeHeight:
                        scroll.children[0].getBoundingClientRect().height,
                    piconWidth: document
                        .querySelector("#it26 .img")
                        .getBoundingClientRect().width,
                    programmeColor: getComputedStyle(
                        document.getElementById("pnfixture27")
                    ).color,
                    selectedVisible:
                        selected.top >= list.top &&
                        selected.bottom <= list.bottom,
                    thumbHeight:
                        scroll.children[1].getBoundingClientRect().height,
                };
            });
            expect(secondPage.beforeHeight).toBeGreaterThan(0);
            expect(secondPage.thumbHeight).toBeGreaterThan(0);
            expect(secondPage.piconWidth).toBeGreaterThan(10);
            expect(secondPage.programmeColor).toBe("rgb(0, 255, 0)");
            expect(secondPage.selectedVisible).toBe(true);
            await page.locator(".list-scroll-before").click();
            await expect(page.locator("#_name")).toContainText("Current film");
            await expect(page.locator("#it1")).toHaveCSS(
                "background-color",
                "rgb(0, 0, 128)"
            );
            await page.evaluate(() => {
                window.sShowPikon =
                    window.sShowProgress =
                    window.sShowArchive =
                    window.sShowProgram =
                        0;
                _channelsList(0, 0);
            });
            await expect(
                page.locator(
                    "#listIn .img, #listIn .progress_div, #listIn .ott-channel-archive, #pnone"
                )
            ).toHaveCount(0);
            await page.evaluate(() => bucketsList(0));
            await expect(page.locator("#it0")).toContainText("Fixture");
            await expect(
                page.locator(
                    "#listIn .ott-channel-label, #listIn .ott-channel-archive, #listIn .progress_div"
                )
            ).toHaveCount(0);
            expect(fixture.errors).toEqual([]);
            expect(fixture.unexpectedRequests).toEqual([]);
        }
        const scriptSecurity = await native.page.evaluate(async () => {
            window.__fixtureViolations.length = 0;
            const script = document.createElement("script");
            script.textContent = "window.__untrustedScriptExecuted = true";
            document.body.appendChild(script);
            await new Promise((resolve) => setTimeout(resolve, 20));
            return {
                executed: window.__untrustedScriptExecuted === true,
                violations: window.__fixtureViolations,
            };
        });
        expect(scriptSecurity.executed).toBe(false);
        expect(
            scriptSecurity.violations.some((directive) =>
                directive.startsWith("script-src")
            )
        ).toBe(true);
    } finally {
        await server.close();
        await native.close();
    }
});

for (const profile of ["server", "tauri"]) {
    test(
        profile + ": category picker arrows page without opening or leaving",
        async ({ browser }) => {
            test.setTimeout(90000);
            const fixture = await fixturePage(browser, profile, {});
            const page = fixture.page;
            try {
                await page.evaluate(() => {
                    // The fixture skips provider boot, which normally installs
                    // these production entry points and the keyboard listener.
                    window.channelsList = window._channelsList;
                    window.stbBindKeyHandler();
                    window.__categoryVolumeCalls = [];
                    window.changeVolume = (delta) =>
                        window.__categoryVolumeCalls.push(delta);
                });
                for (const pageSize of [10, 25, 30]) {
                    const total = 2 * pageSize + 7;
                    await page.evaluate((count) => {
                        const channel =
                            window.channels[
                                window.cats[window.catsArray[0]][0]
                            ];
                        window.catsArray = [];
                        window.cats = {};
                        window.channels = window.chanels = {};
                        for (let index = 0; index < count; index++) {
                            const category = "Paging category " + index;
                            const id = "paging-member-" + index;
                            window.catsArray.push(category);
                            window.cats[category] = [id];
                            window.channels[id] = Object.assign({}, channel, {
                                channel_name: "Member of category " + index,
                            });
                        }
                        window.catIndex = window.primaryIndex = 0;
                        window.curList = window.cats[window.catsArray[0]];
                    }, total);
                    const assertCategory = async (index) => {
                        await expect(page.locator("#list")).toBeVisible();
                        await expect(page.locator("#listCaption")).toHaveText(
                            "Category selection"
                        );
                        const selected = page.locator("#listIn .ott-selected");
                        await expect(selected).toHaveCount(1);
                        await expect(selected).toHaveAttribute(
                            "id",
                            "it" + index
                        );
                        await expect(selected).toContainText(
                            "Paging category " + index
                        );
                        const start = Math.floor(index / pageSize) * pageSize;
                        expect(
                            await page
                                .locator("#listIn .item")
                                .evaluateAll((items) =>
                                    items.map((item) => item.id)
                                )
                        ).toEqual(
                            Array.from(
                                { length: Math.min(pageSize, total - start) },
                                (_, offset) => "it" + (start + offset)
                            )
                        );
                        await expect
                            .poll(() =>
                                selected.evaluate((item) => {
                                    const row = item.getBoundingClientRect();
                                    const list = document
                                        .getElementById("listIn")
                                        .getBoundingClientRect();
                                    return {
                                        highlighted:
                                            getComputedStyle(item)
                                                .backgroundColor !==
                                            "rgba(0, 0, 0, 0)",
                                        index: window.selIndex,
                                        pageSize: window.listPageSize,
                                        visible:
                                            row.height > 0 &&
                                            row.top >= list.top - 1 &&
                                            row.bottom <= list.bottom + 1,
                                    };
                                })
                            )
                            .toEqual({
                                highlighted: true,
                                index,
                                pageSize,
                                visible: true,
                            });
                        await expect(
                            page.locator("#listIn .ott-channel-label")
                        ).toHaveCount(0);
                    };
                    for (const arrowFun of [0, 2]) {
                        expect(
                            await page.evaluate(
                                (input) => {
                                    const saved = saveSettings(input);
                                    bucketsList(3);
                                    document.activeElement.blur();
                                    return saved;
                                },
                                { arrowFun, pageSize, volumeStep: 7 }
                            )
                        ).toBe(true);
                        await assertCategory(3);
                        // Real key events exercise screen ownership, the
                        // category callback, shared paging and DOM rendering.
                        for (const [key, index] of [
                            ["ArrowLeft", 0],
                            ["ArrowLeft", 0],
                            ["ArrowRight", pageSize],
                            ["ArrowRight", 2 * pageSize],
                            ["ArrowRight", total - 1],
                            ["ArrowRight", total - 1],
                            ["ArrowLeft", pageSize + 6],
                            ["ArrowLeft", 6],
                            ["ArrowLeft", 0],
                            ["ArrowRight", pageSize],
                        ]) {
                            await page.keyboard.press(key);
                            await assertCategory(index);
                        }
                        await page.keyboard.press("Enter");
                        await expect(page.locator("#listCaption")).toHaveText(
                            "Channel list. Category: Paging category " +
                                pageSize
                        );
                        await expect(
                            page.locator("#listIn .ott-channel-label")
                        ).toHaveAttribute(
                            "data-channel-id",
                            "paging-member-" + pageSize
                        );
                        await expect(
                            page.locator("#listIn .ott-channel-label")
                        ).toContainText("Member of category " + pageSize);
                        await page.evaluate(
                            (index) => bucketsList(index),
                            pageSize
                        );
                        await page.keyboard.press("Backspace");
                        await expect(page.locator("#list")).toBeHidden();
                        expect(
                            await page.evaluate(() => window.isListVisible)
                        ).toBe(false);
                        expect(
                            await page.evaluate(
                                () => window.__categoryVolumeCalls
                            )
                        ).toEqual([]);
                    }
                    expect(
                        await page.evaluate((size) => {
                            window.__categoryVolumeCalls = [];
                            const saved = saveSettings({
                                arrowFun: 1,
                                pageSize: size,
                                volumeStep: 7,
                            });
                            bucketsList(3);
                            return saved;
                        }, pageSize)
                    ).toBe(true);
                    await page.keyboard.press("ArrowRight");
                    await assertCategory(3);
                    await page.keyboard.press("ArrowLeft");
                    await assertCategory(3);
                    expect(
                        await page.evaluate(() => {
                            const calls = window.__categoryVolumeCalls;
                            window.__categoryVolumeCalls = [];
                            return calls;
                        })
                    ).toEqual([7, -7]);
                }
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );

    test(
        profile + ": Studio defaults and focus survive paging and EPG updates",
        async ({ browser }, testInfo) => {
            const fixture = await fixturePage(browser, profile, {});
            const page = fixture.page;
            try {
                await expect(page.locator("body")).toHaveClass(/theme-studio/);
                await expect(page.locator("#listIn .item")).toHaveCount(25);
                await expect(page.locator("#it0")).toHaveCSS(
                    "background-color",
                    "rgb(231, 241, 235)"
                );
                await expect(page.locator("#it0 .ott-channel-label")).toHaveCSS(
                    "color",
                    "rgb(17, 33, 25)"
                );
                await expect(
                    page.locator("#it0 .ott-channel-programme")
                ).toHaveCSS("color", "rgb(74, 98, 85)");
                expect(
                    await page.evaluate(
                        () =>
                            parseFloat(
                                getComputedStyle(
                                    document.getElementById("list")
                                ).fontSize
                            ) <= document.getElementById("it0").offsetHeight
                    )
                ).toBe(true);
                await page.screenshot({
                    path: testInfo.outputPath(
                        profile + "-studio-2026-default.png"
                    ),
                });
                await page.evaluate(() => {
                    changeSelect(1);
                    updateChannelListRow("two");
                });
                await expect(page.locator("#it0")).not.toHaveClass(
                    /ott-selected/
                );
                await expect(page.locator("#it1 .ott-channel-label")).toHaveCSS(
                    "color",
                    "rgb(17, 33, 25)"
                );
                await page.evaluate(() => changeSelect(24));
                await expect(page.locator("#listIn .item")).toHaveCount(15);
                await expect(page.locator("#it25")).toHaveClass(/ott-selected/);
                await page.evaluate(() => changeSelect(-1));
                await expect(page.locator("#it24")).toHaveClass(/ott-selected/);
                await page.evaluate(() => {
                    channels[101] = channels.one;
                    cats.Fixture[0] = 101;
                    curList = [101];
                    primaryIndex = 0;
                    _channelsList(0, 0);
                    changeSelect(1);
                });
                await expect(page.locator("#it0")).toHaveClass(/ott-playing/);
                await expect(page.locator("#it1")).not.toHaveClass(
                    /ott-playing/
                );
                await page.evaluate(() => changeSelect(1));
                await expect(page.locator("#_name")).toHaveCount(0);
                await page.evaluate(() => settingsInterface());
                await expect(page.locator("#listIn .ott-selected")).toHaveCSS(
                    "color",
                    "rgb(17, 33, 25)"
                );
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );

    test(
        profile +
            ": all themes honor row count, list side and video mode across resolutions",
        async ({ browser }) => {
            test.setTimeout(120000);
            const fixture = await fixturePage(browser, profile);
            const page = fixture.page;
            try {
                await page.evaluate(() => {
                    const videoBox = document.createElement("div");
                    videoBox.id = "vdiv";
                    document.body.prepend(videoBox);
                });
                for (const viewport of [
                    { height: 506, width: 900 },
                    { height: 720, width: 1280 },
                    { height: 1080, width: 1920 },
                    { height: 2160, width: 3840 },
                ]) {
                    await page.setViewportSize(viewport);
                    for (const theme of [0, 1, 2]) {
                        for (const pageSize of [10, 25, 30]) {
                            for (const side of [0, 1]) {
                                for (const noSmall of [0, 1]) {
                                    const result = await page.evaluate(
                                        (input) => {
                                            const saved = saveSettings(input);
                                            _channelsList(0, 0);
                                            const rect = (id) => {
                                                const r = document
                                                    .getElementById(id)
                                                    .getBoundingClientRect();
                                                return {
                                                    bottom: r.bottom,
                                                    height: r.height,
                                                    right: r.right,
                                                    x: r.x,
                                                    y: r.y,
                                                };
                                            };
                                            const row =
                                                document.getElementById("it0");
                                            return {
                                                bottom: rect("_b"),
                                                caption: rect("listCaption"),
                                                count: document.querySelectorAll(
                                                    "#listIn .item"
                                                ).length,
                                                detail: rect("listDetail"),
                                                last: rect(
                                                    "it" + (input.pageSize - 1)
                                                ),
                                                left: rect("_l"),
                                                list: rect("listIn"),
                                                osdVisible:
                                                    $("#list_osd").is(
                                                        ":visible"
                                                    ),
                                                piconHeight:
                                                    row.querySelector(".img")
                                                        .offsetHeight,
                                                preview: rect("vdiv"),
                                                right: rect("_r"),
                                                rowHeight: row.offsetHeight,
                                                saved,
                                                top: rect("_t"),
                                                windowVisible:
                                                    $("#list_window").is(
                                                        ":visible"
                                                    ),
                                            };
                                        },
                                        {
                                            interfaceTheme: theme,
                                            listPosition: side,
                                            noSmall,
                                            pageSize,
                                        }
                                    );
                                    expect(result.saved).toBe(true);
                                    expect(result.count).toBe(pageSize);
                                    expect(
                                        result.last.bottom
                                    ).toBeLessThanOrEqual(
                                        result.list.bottom + 0.5
                                    );
                                    expect(
                                        result.last.right
                                    ).toBeLessThanOrEqual(
                                        result.list.right + 0.5
                                    );
                                    expect(
                                        result.piconHeight
                                    ).toBeLessThanOrEqual(result.rowHeight);
                                    expect(result.windowVisible).toBe(!noSmall);
                                    expect(result.osdVisible).toBe(!!noSmall);
                                    expect(
                                        result.detail.y
                                    ).toBeGreaterThanOrEqual(
                                        result.caption.bottom
                                    );
                                    expect(
                                        side
                                            ? result.list.x < result.detail.x
                                            : result.list.x > result.detail.x
                                    ).toBe(true);
                                    if (!noSmall) {
                                        expect(result.top.bottom).toBeCloseTo(
                                            result.preview.y,
                                            0
                                        );
                                        expect(result.left.right).toBeCloseTo(
                                            result.preview.x,
                                            0
                                        );
                                        expect(result.right.x).toBeCloseTo(
                                            result.preview.right,
                                            0
                                        );
                                        expect(result.bottom.y).toBeCloseTo(
                                            result.preview.bottom,
                                            0
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
                // Resize an already mounted channel formatter, without reopening it.
                await page.setViewportSize({ height: 360, width: 640 });
                await expect
                    .poll(() =>
                        page.evaluate(() => {
                            const row = document.getElementById("it0");
                            return (
                                row.querySelector(".img").offsetHeight <=
                                row.offsetHeight
                            );
                        })
                    )
                    .toBe(true);
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );

    test(
        profile +
            ": display switches, fonts, clock and opacity apply from saved settings",
        async ({ browser }) => {
            const fixture = await fixturePage(browser, profile, {});
            const page = fixture.page;
            try {
                for (const theme of [0, 1, 2]) {
                    for (const enabled of [0, 1]) {
                        expect(
                            await page.evaluate(
                                ({ theme, enabled }) => {
                                    const saved = saveSettings({
                                        channelLogoMode: enabled * 2,
                                        interfaceTheme: theme,
                                        nextCountList: enabled,
                                        showArchive: enabled,
                                        showDescription: enabled,
                                        showName: enabled,
                                        showNumber: enabled,
                                        showProgram: enabled,
                                        showProgress: enabled,
                                        showScroll: enabled,
                                        thumbnail: enabled,
                                    });
                                    _channelsList(0, 0);
                                    return saved;
                                },
                                { enabled, theme }
                            )
                        ).toBe(true);
                        for (const selector of [
                            ".ott-channel-number",
                            ".ott-channel-picon",
                            ".ott-channel-programme",
                            ".ott-channel-progress",
                            ".ott-channel-archive",
                        ])
                            await expect(
                                page.locator("#it0 " + selector)
                            ).toHaveCount(enabled);
                        await expect(page.locator(".list-scroll")).toHaveCount(
                            enabled
                        );
                        await expect
                            .poll(() =>
                                page
                                    .locator("#_descr")
                                    .evaluate((el) => el.offsetHeight > 0)
                            )
                            .toBe(!!enabled);
                        await expect(
                            page.locator(".ott-channel-thumbnail")
                        ).toHaveCount(enabled);
                        await expect(page.locator("#_nextpr span")).toHaveCount(
                            enabled
                        );
                        expect(
                            (await page.locator("#it0").textContent()).includes(
                                "News"
                            )
                        ).toBe(!!enabled);
                    }
                }
                for (const fontSize of [0, 1, 2, 3, 4, 5, 6]) {
                    const sizes = [];
                    for (const fontShift of [0, 30]) {
                        sizes.push(
                            await page.evaluate(
                                ({ fontSize, fontShift }) => {
                                    saveSettings({
                                        fontShift,
                                        fontSize,
                                        pageSize: 10,
                                    });
                                    _channelsList(0, 0);
                                    return {
                                        family: getComputedStyle(document.body)
                                            .fontFamily,
                                        size: parseFloat(
                                            getComputedStyle(
                                                document.getElementById("list")
                                            ).fontSize
                                        ),
                                    };
                                },
                                { fontShift, fontSize }
                            )
                        );
                    }
                    expect(sizes[0].family).not.toContain("undefined");
                    expect(sizes[0].size).toBeGreaterThan(sizes[1].size);
                }
                for (const count of [0, 1, 20]) {
                    await page.evaluate((nextCountList) => {
                        const now = Date.now() / 1000;
                        channels.one.nextpr = Array.from(
                            { length: 20 },
                            (_, i) => ({
                                name: "Upcoming " + i,
                                time: now + 1800 * (i + 1),
                            })
                        );
                        saveSettings({
                            fontShift: 0,
                            nextCountList,
                            pageSize: 30,
                        });
                        _channelsList(0, 0);
                    }, count);
                    await expect(page.locator("#_nextpr span")).toHaveCount(
                        count
                    );
                    if (count) {
                        expect(
                            await page.evaluate(
                                () =>
                                    document
                                        .getElementById("_nextpr")
                                        .getBoundingClientRect().top >=
                                    document
                                        .getElementById("_name")
                                        .getBoundingClientRect().bottom
                            )
                        ).toBe(true);
                    }
                }
                for (const preview of [0, 1, 2]) {
                    await page.evaluate((preview) => {
                        window.__previewCalls = 0;
                        window.previewChId = () => window.__previewCalls++;
                        saveSettings({ preview });
                        _channelsList(0, 0);
                    }, preview);
                    await expect
                        .poll(() => page.locator("#_name").count())
                        .toBe(1);
                    // Flush the renderer's deferred detail callback.
                    await page.evaluate(
                        () => new Promise((resolve) => setTimeout(resolve, 250))
                    );
                    expect(
                        await page.evaluate(() => window.__previewCalls > 0)
                    ).toBe(preview === 1);
                }
                await page.evaluate(() => {
                    saveSettings({ preview: 0 });
                    closeList();
                });
                for (const opacity of [0, 3, 10]) {
                    await page.evaluate(
                        (osdOpacity) =>
                            saveSettings({ osdOpacity, permanentTime: 1 }),
                        opacity
                    );
                    await expect(page.locator("#permanentTime")).toBeVisible();
                    const alpha = await page
                        .locator("#permanentTime")
                        .evaluate((el) => {
                            const parts =
                                getComputedStyle(el).backgroundColor.match(
                                    /[\d.]+/g
                                );
                            return parts.length === 4 ? Number(parts[3]) : 1;
                        });
                    expect(alpha).toBe(opacity / 10);
                }
                await page.evaluate(() => saveSettings({ permanentTime: 2 }));
                await expect(page.locator("#permanentTime")).not.toHaveClass(
                    /osd/
                );
                await expect(page.locator("#permanentTime")).toHaveCSS(
                    "background-color",
                    "rgba(0, 0, 0, 0)"
                );
                await page.evaluate(() => {
                    saveSettings({ osdOpacity: 3, permanentTime: 1 });
                    saveSettings({ fontShift: 4 });
                });
                await expect(page.locator("#permanentTime")).toHaveCSS(
                    "background-color",
                    "rgba(14, 17, 20, 0.3)"
                );
                await page.evaluate(() => saveSettings({ permanentTime: 0 }));
                await expect(page.locator("#permanentTime")).toBeHidden();
                for (const enabled of [1, 0]) {
                    const label = await page.evaluate(
                        (useGraphicalIndicators) => {
                            saveSettings({ useGraphicalIndicators });
                            return _("yes");
                        },
                        enabled
                    );
                    expect(label.includes("<span")).toBe(!!enabled);
                }
                expect(fixture.errors).toEqual([]);
                expect(fixture.unexpectedRequests).toEqual([]);
            } finally {
                await fixture.close();
            }
        }
    );
}

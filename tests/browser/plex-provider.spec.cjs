const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("../helpers/browser-test.cjs");

const plex = "https://plex.fixture";
const token = "fixture-plex-secret";
const mediaRoot = path.resolve(__dirname, "../fixtures/media-runtime");
test.use({
    launchOptions: async ({ browserName }, use) => {
        await use(
            browserName === "chromium"
                ? { args: ["--autoplay-policy=no-user-gesture-required"] }
                : {}
        );
    },
});

for (const language of ["_eng", "_rus"]) {
    test(
        "Plex shows a localized animated loader through slow startup and reload: " +
            language,
        async ({ page, context, baseURL }) => {
            const local = new URL(baseURL).origin;
            const pending = [];
            await context.route("**/*", async (route) => {
                const url = new URL(route.request().url());
                if (url.origin === local) return route.continue();
                if (
                    url.origin === plex &&
                    url.pathname === "/library/sections"
                ) {
                    pending.push(route);
                    return;
                }
                return route.abort();
            });
            await context.routeWebSocket("**/*", (socket) => socket.close());
            await context.addInitScript(
                ({ language, plex, token }) => {
                    localStorage.setItem("ottplaylang", language);
                    localStorage.setItem("ottplayprov", "plex");
                    localStorage.setItem(
                        "plexcfg",
                        JSON.stringify({ address: plex, token })
                    );
                },
                { language, plex, token }
            );
            await page.goto("/f/pc/");
            await expect.poll(() => pending.length).toBe(1);
            const dialog = page.locator("#dialogbox");
            const spinner = dialog.locator(".ott-spinner");
            const waitText =
                language === "_rus"
                    ? "Загрузка. Подождите…"
                    : "Loading… please wait…";
            const connectionText =
                language === "_rus"
                    ? "Подключение к Plex…"
                    : "Connecting to Plex…";
            await expect(dialog).toBeVisible();
            await expect(dialog).toContainText(waitText);
            await expect(dialog).toContainText(connectionText);
            await expect(spinner).toBeVisible();
            await expect(page.locator("#launch")).toBeHidden();
            const transform = await spinner.evaluate(
                (element) => getComputedStyle(element).transform
            );
            await expect
                .poll(() =>
                    spinner.evaluate(
                        (element) => getComputedStyle(element).transform
                    )
                )
                .not.toBe(transform);
            // The provider can legitimately take longer than the legacy three-second fallback.
            await page.waitForTimeout(3500);
            await expect(spinner).toBeVisible();
            await page.screenshot({
                path: test.info().outputPath("plex-loading.png"),
            });
            await pending[0].fulfill({
                body: "Temporarily unavailable",
                headers: { "access-control-allow-origin": "*" },
                status: 503,
            });
            await expect(spinner).toBeVisible();
            await expect(dialog).toContainText(waitText);
            await expect.poll(() => pending.length).toBe(2);
            await expect(spinner).toBeVisible();
            await pending[1].fulfill({
                headers: { "access-control-allow-origin": "*" },
                json: {
                    MediaContainer: {
                        Directory: [
                            { key: "7", title: "My library", type: "movie" },
                        ],
                    },
                },
            });
            await expect(dialog).toBeHidden();
            // Unconfigured startup opens profile folder selection, never all
            // library contents as an implicit playback queue.
            for (const count of [3, 4]) {
                await expect.poll(() => pending.length).toBe(count);
                await pending[count - 1].fulfill({
                    headers: { "access-control-allow-origin": "*" },
                    json: {
                        MediaContainer: {
                            Directory: [
                                {
                                    key: "7",
                                    title: "My library",
                                    type: "movie",
                                },
                            ],
                        },
                    },
                });
            }
            await expect(page.locator("#list")).toContainText("My library");
            await page.evaluate(() => window.loadChannels());
            await expect.poll(() => pending.length).toBe(5);
            await expect(spinner).toBeVisible();
            await expect(dialog).toContainText(waitText);
            await expect(dialog).toContainText(connectionText);
            await page.waitForTimeout(3500);
            await expect(spinner).toBeVisible();
            await pending[4].fulfill({
                body: "Unauthorized",
                headers: { "access-control-allow-origin": "*" },
                status: 401,
            });
            await expect(spinner).toBeHidden();
            const settingsText = await page.evaluate(() =>
                window._("Plex settings")
            );
            await expect(page.locator("#listCaption")).toHaveText(settingsText);
        }
    );
}

for (const format of ["JSON", "XML"]) {
    test(
        "Plex account sign-in selects a server without retaining the account token: " +
            format,
        async ({ page, context, baseURL }) => {
            const local = new URL(baseURL).origin;
            const accountToken = "fixture-account-access";
            const serverToken = "fixture-server-access";
            await context.route("**/*", async (route) => {
                const url = new URL(route.request().url());
                const headers = { "access-control-allow-origin": "*" };
                if (url.origin === local) return route.continue();
                if (
                    url.origin === "https://plex.tv" ||
                    url.origin === "https://clients.plex.tv"
                ) {
                    if (url.pathname === "/api/v2/pins")
                        return route.fulfill({
                            headers,
                            json: { code: "ABCD", expiresIn: 900, id: 7 },
                        });
                    if (url.pathname === "/api/v2/pins/7")
                        return route.fulfill({
                            headers,
                            json: {
                                authToken: accountToken,
                                code: "ABCD",
                                expiresIn: 900,
                                id: 7,
                            },
                        });
                    if (url.pathname === "/api/v2/resources")
                        return route.fulfill({
                            headers,
                            json: [
                                {
                                    accessToken: serverToken,
                                    clientIdentifier: "fixture-server",
                                    connections: [
                                        {
                                            local: false,
                                            relay: false,
                                            uri: plex,
                                        },
                                    ],
                                    name: "Fixture server",
                                    owned: true,
                                    provides: "server",
                                },
                            ],
                        });
                }
                if (url.origin === plex) {
                    if (url.pathname === "/identity") {
                        expect(url.searchParams.get("X-Plex-Token")).toBeNull();
                        expect(
                            route.request().headers()["x-plex-token"]
                        ).toBeUndefined();
                        return route.fulfill({
                            headers,
                            ...(format === "XML"
                                ? {
                                      body: '<MediaContainer machineIdentifier="fixture-server"/>',
                                      contentType: "application/xml",
                                  }
                                : {
                                      json: {
                                          MediaContainer: {
                                              machineIdentifier:
                                                  "fixture-server",
                                          },
                                      },
                                  }),
                        });
                    }
                    if (url.pathname === "/library/sections")
                        return route.fulfill({
                            headers,
                            ...(format === "XML"
                                ? {
                                      body: '<MediaContainer size="1"><Directory key="7" title="Account library" type="movie"/></MediaContainer>',
                                      contentType: "application/xml",
                                  }
                                : {
                                      json: {
                                          MediaContainer: {
                                              Directory: [
                                                  {
                                                      key: "7",
                                                      title: "Account library",
                                                      type: "movie",
                                                  },
                                              ],
                                          },
                                      },
                                  }),
                        });
                }
                return route.abort();
            });
            await context.routeWebSocket("**/*", (socket) => socket.close());
            await context.addInitScript(() => {
                localStorage.setItem("ottplaylang", "_eng");
                localStorage.setItem("ottplayprov", "plex");
            });
            await page.goto("/f/pc/");
            await expect(page.locator("body")).toContainText(
                "Sign in with Plex"
            );
            await page.evaluate(() => {
                window.selIndex = 0;
                window.listKeyHandler(window.keys.ENTER);
            });
            await page.waitForFunction(() =>
                window.listArray?.some((row) =>
                    String(row).includes("Fixture server")
                )
            );
            await page.evaluate(() => {
                window.selIndex = window.listArray.findIndex((row) =>
                    String(row).includes("Fixture server")
                );
                window.listKeyHandler(window.keys.ENTER);
            });
            await expect(page.locator("body")).toContainText("Account library");
            const stored = await page.evaluate(() =>
                Object.fromEntries(
                    Object.keys(localStorage).map((key) => [
                        key,
                        localStorage.getItem(key),
                    ])
                )
            );
            expect(JSON.parse(stored.plexcfg)).toMatchObject({
                address: plex,
                token: serverToken,
            });
            expect(JSON.stringify(stored)).not.toContain(accountToken);
        }
    );
}

// Folder browsing remains a supported Media API for controllers and saved
// media queues, while ordinary profile startup now uses the channel playlist.
async function openLegacyPlex(page, restore = false) {
    await page.waitForFunction(
        () =>
            window.__ottActiveProviderDriver?.libraryReady() &&
            window.providerMediaClient
    );
    if (!restore)
        await page.waitForFunction(
            () =>
                !window.cList.length ||
                window.__ottClassicPlayback.snapshot().phase === "playing"
        );
    await page.evaluate((restore) => {
        if (!restore) window.stbStop();
        // Close an unconfigured profile picker through its public editor entry,
        // so a delayed picker callback cannot replace the explicit Media view.
        window.__ottEditProvider();
        if (restore) window.closeList();
        window.__ottChannels.mount(window);
        window.__ottMedia.useSource(null);
        const open = () =>
            window.__ottMedia.open({
                path: "/library/sections",
                plexSource: window.__ottMedia.sourceId(),
                title: "Plex",
            });
        if (!restore || !window.__ottMedia.restoreLast(open)) open();
    }, restore);
}

async function select(page, title) {
    await page.waitForFunction(
        (title) =>
            window.__ottMedia
                ?.snapshot()
                .frame?.items.some((item) => item.title === title),
        title
    );
    await page.evaluate((title) => {
        const index = window.__ottMedia
            .snapshot()
            .frame.items.findIndex((item) => item.title === title);
        window.__ottMedia.select(index);
    }, title);
}

test("Plex load failure preserves a restored strict kiosk until remote unlock", async ({
    page,
    context,
    baseURL,
}) => {
    const local = new URL(baseURL).origin;
    const pending = [],
        replies = [],
        errors = [];
    let failLoad = false,
        failedLoads = 0,
        sequence = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", (route) => {
        const request = route.request(),
            url = new URL(request.url());
        if (url.origin !== local) return route.abort();
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
        const json = (body) =>
            route.fulfill({ json: { MediaContainer: body } });
        if (url.pathname === "/library/sections") {
            if (failLoad) {
                failedLoads++;
                return route.fulfill({ body: "Unauthorized", status: 401 });
            }
            return json({
                Directory: [
                    { key: "7", title: "Kiosk library", type: "movie" },
                ],
            });
        }
        if (url.pathname === "/library/sections/7/all")
            return json({ Metadata: [] });
        if (url.pathname === "/library/sections/7/folder")
            return json({
                Metadata: [
                    { ratingKey: "42", title: "Kiosk film", type: "movie" },
                ],
                offset: 0,
                size: 1,
                totalSize: 1,
            });
        if (url.pathname === "/library/metadata/42")
            return json({
                Metadata: [
                    {
                        Media: [
                            {
                                audioCodec: "aac",
                                container: "mpegts",
                                Part: [{ key: "/library/parts/42/file.ts" }],
                                videoCodec: "h264",
                            },
                        ],
                        ratingKey: "42",
                        title: "Kiosk film",
                        type: "movie",
                    },
                ],
            });
        if (url.pathname.endsWith("/decision"))
            return json({
                generalDecisionCode: 1001,
                Metadata: [{ Media: [{ Part: [{ decision: "transcode" }] }] }],
            });
        if (url.pathname.endsWith("/stop") || url.pathname.endsWith("/ping"))
            return route.fulfill({ body: "" });
        return route.continue();
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(
        ({ local }) => {
            if (!localStorage.getItem("ottplayprov")) {
                localStorage.setItem("ottplaylang", "_eng");
                localStorage.setItem("ottplayprov", "plex");
                localStorage.setItem(
                    "plexcfg",
                    JSON.stringify({
                        address: local,
                        folders: [
                            {
                                path: "/library/sections/7/folder",
                                title: "Kiosk library",
                            },
                        ],
                        playback: "compatible",
                        token: "synthetic-kiosk-token",
                    })
                );
            }
            const play = HTMLMediaElement.prototype.play;
            HTMLMediaElement.prototype.play = function () {
                this.muted = true;
                this.loop = true;
                return play.call(this);
            };
        },
        { local }
    );
    await page.goto("/f/pc/");
    await page.keyboard.press("Shift");
    await openLegacyPlex(page);
    await select(page, "Kiosk library");
    await select(page, "Browse folders");
    await select(page, "Kiosk film");
    await page.waitForFunction(
        () =>
            window.__ottClassicPlayback.snapshot().phase === "playing" &&
            window.video.currentTime > 0.2
    );
    await page.evaluate(() =>
        window.__ottCommandServer.configure({
            address: location.origin + "/fixture-control",
            enabled: true,
            token: "SYNTHETIC_COMMAND_TOKEN_0123456789abcdef",
        })
    );
    async function kiosk(params) {
        const count = replies.length;
        pending.push({ action: "kiosk", params });
        await expect.poll(() => replies.length).toBe(count + 1);
        expect(replies[count].status).toBe("ok");
        return replies[count].data;
    }
    expect(await kiosk({ mode: "on", strict: true })).toMatchObject({
        media: { title: "Kiosk film", total: 1 },
        provider: "plex",
        state: "locked",
        strict: true,
    });
    const saved = await page.evaluate(() => ({
        credentials: window.stbGetPersistedItem("plexcfg"),
        policy: window.stbGetPersistedItem("__ottKioskV1"),
    }));
    expect(JSON.parse(saved.policy)).toMatchObject({
        provider: "plex",
        strict: true,
    });
    failLoad = true;
    await page.reload();
    await expect.poll(() => failedLoads).toBe(1);
    expect(await kiosk({ mode: "status" })).toMatchObject({
        media: { title: "Kiosk film", total: 1 },
        provider: "plex",
        state: "locked",
        strict: true,
    });
    await expect(page.locator("html")).toHaveClass(/ott-kiosk-strict/);
    await expect(page.locator("#dialogbox")).toBeHidden();
    await expect(page.locator("#list_window")).toBeHidden();
    expect(await page.evaluate(() => window.commandChannelsReady)).toBe(false);
    expect(await page.evaluate(() => window.__ottEditProvider())).toBe(false);
    await expect(page.locator("#list_window")).toBeHidden();
    expect(
        await page.evaluate(() => ({
            credentials: window.stbGetPersistedItem("plexcfg"),
            policy: window.stbGetPersistedItem("__ottKioskV1"),
        }))
    ).toEqual(saved);
    expect(await kiosk({ mode: "off" })).toMatchObject({
        state: "off",
        strict: false,
    });
    await expect(page.locator("html")).not.toHaveClass(/ott-kiosk-strict/);
    expect(await page.evaluate(() => window.__ottEditProvider())).toBe(true);
    await expect(page.locator("#listCaption")).toHaveText("Plex settings");
    await expect(page.locator("#list_window")).toBeVisible();
    await expect(page.locator("#dialogbox")).toBeHidden();
    expect(errors).toEqual([]);
});

const touchTest = test.extend({ hasTouch: true });

touchTest(
    "Plex file selection shows an owned wait through collection and resolution, cancels and retries",
    async ({ page, context, baseURL }) => {
        const local = new URL(baseURL).origin;
        const title = "Винни-Пух <тест>";
        const rows = [
            { ratingKey: "42", title, type: "movie" },
            { ratingKey: "43", title: "Following film", type: "movie" },
        ];
        const collections = [],
            metadata = [],
            errors = [];
        let hold = false;
        page.on("pageerror", (error) => errors.push(error.message));
        const headers = { "access-control-allow-origin": "*" };
        const folder = (route) =>
            route.fulfill({
                headers,
                json: {
                    MediaContainer: {
                        Metadata: rows,
                        offset: 0,
                        size: 2,
                        totalSize: 2,
                    },
                },
            });
        await context.route("**/*", (route) => {
            const url = new URL(route.request().url());
            if (url.origin === local) return route.continue();
            if (url.origin !== plex) return route.abort();
            if (url.pathname === "/library/sections")
                return route.fulfill({
                    headers,
                    json: {
                        MediaContainer: {
                            Directory: [
                                {
                                    key: "7",
                                    title: "My library",
                                    type: "movie",
                                },
                            ],
                        },
                    },
                });
            if (url.pathname === "/library/sections/7/all")
                return route.fulfill({
                    headers,
                    json: { MediaContainer: { Metadata: [] } },
                });
            if (url.pathname === "/library/sections/7/folder") {
                if (hold) {
                    collections.push(route);
                    return;
                }
                return folder(route);
            }
            if (/^\/library\/metadata\/\d+$/.test(url.pathname)) {
                metadata.push(route);
                return;
            }
            if (url.pathname.endsWith("/decision"))
                return route.fulfill({
                    headers,
                    json: {
                        MediaContainer: {
                            generalDecisionCode: 1001,
                            Metadata: [
                                {
                                    Media: [
                                        { Part: [{ decision: "transcode" }] },
                                    ],
                                },
                            ],
                        },
                    },
                });
            if (url.pathname.endsWith("/start.m3u8"))
                return route.fulfill({
                    body:
                        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n" +
                        Array.from(
                            { length: 15 },
                            (_, index) =>
                                (index ? "#EXT-X-DISCONTINUITY\n" : "") +
                                "#EXTINF:2.000000,\nsegment00.ts?n=" +
                                index +
                                "\n"
                        ).join("") +
                        "#EXT-X-ENDLIST\n",
                    contentType: "application/vnd.apple.mpegurl",
                    headers,
                });
            if (url.pathname.endsWith(".ts"))
                return route.fulfill({
                    body: fs.readFileSync(path.join(mediaRoot, "segment00.ts")),
                    contentType: "video/mp2t",
                    headers,
                });
            if (
                url.pathname.endsWith("/stop") ||
                url.pathname.endsWith("/ping")
            )
                return route.fulfill({ body: "", headers, status: 200 });
            return route.fulfill({
                body: "missing fixture route",
                headers,
                status: 404,
            });
        });
        await context.routeWebSocket("**/*", (socket) => socket.close());
        await context.addInitScript(
            ({ plex, token }) => {
                localStorage.setItem("ottplaylang", "_rus");
                localStorage.setItem("ottplayprov", "plex");
                localStorage.setItem(
                    "plexcfg",
                    JSON.stringify({
                        address: plex,
                        playback: "compatible",
                        token,
                    })
                );
                const play = HTMLMediaElement.prototype.play;
                HTMLMediaElement.prototype.play = function () {
                    this.muted = true;
                    return play.call(this);
                };
            },
            { plex, token }
        );
        await page.goto("/f/pc/");
        await page.keyboard.press("Shift");
        await openLegacyPlex(page);
        await select(page, "My library");
        await select(
            page,
            await page.evaluate(() => window._("Browse folders"))
        );
        await expect(page.locator("#list")).toContainText(title);
        hold = true;
        await page.keyboard.press("Enter");
        await expect.poll(() => collections.length).toBe(1);
        const dialog = page.locator("#dialogbox");
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("Загрузка. Подождите…");
        await expect(dialog).toContainText(title);
        await expect(dialog.locator(".ott-spinner")).toBeVisible();
        // The modal owns remote keys until a user explicitly tabs to a control.
        // Auto-focusing Cancel would turn this Enter into an unintended dismissal.
        await expect(dialog).toBeFocused();
        expect(
            await page.evaluate(
                () => window.__ottScreens.current().model.parent.kind
            )
        ).toBe("list");
        for (const key of ["ArrowDown", "ArrowUp", "Enter"])
            await page.keyboard.press(key);
        await expect(dialog).toBeVisible();
        expect(collections).toHaveLength(1);
        await page.evaluate(() => window.__ottMedia.select(1));
        await page.locator("#it1").click();
        expect(await page.evaluate(() => window.selIndex)).toBe(0);
        await page.locator("#it1").hover();
        await page.mouse.wheel(0, 100);
        expect(await page.evaluate(() => window.selIndex)).toBe(0);
        const box = await page.locator("#it1").boundingBox();
        await page.touchscreen.tap(
            box.x + box.width / 2,
            box.y + box.height / 2
        );
        expect(await page.evaluate(() => window.selIndex)).toBe(0);
        const repeat = await page.evaluate(
            () => window.__ottMedia.snapshot().repeat
        );
        await page
            .locator('#mediaPlaybackControls [data-ott-key="57"]')
            .click({ position: { x: 10, y: 10 } });
        await page.getByRole("button", { exact: true, name: "Фильтр" }).click();
        expect(
            await page.evaluate(() => window.__ottMedia.snapshot().repeat)
        ).toBe(repeat);
        await expect(page.locator("#listEdit")).toBeHidden();
        expect(collections.length).toBe(1);
        expect(metadata.length).toBe(0);
        expect(
            await page.evaluate(
                () => window.__ottMedia.snapshot().frame.selected
            )
        ).toBe(0);
        await page.screenshot({
            path: test.info().outputPath("plex-file-collecting.png"),
        });
        await page.keyboard.press("Backspace");
        await expect(dialog).toBeHidden();
        await folder(collections[0]);
        expect(
            await page.evaluate(() => window.__ottMedia.current())
        ).toBeNull();

        await page.keyboard.press("Enter");
        await expect.poll(() => collections.length).toBe(2);
        await folder(collections[1]);
        await expect.poll(() => metadata.length).toBe(1);
        await expect(dialog.locator(".ott-spinner")).toBeVisible();
        await page.screenshot({
            path: test.info().outputPath("plex-file-resolving.png"),
        });
        await page.keyboard.press("Backspace");
        await expect(dialog).toBeHidden();
        await metadata[0].fulfill({ headers, json: { MediaContainer: {} } });
        expect(
            await page.evaluate(() => window.__ottMedia.current())
        ).toBeNull();

        await page.keyboard.press("Enter");
        await expect.poll(() => collections.length).toBe(3);
        await folder(collections[2]);
        for (let attempt = 0; attempt < 3; attempt++) {
            await expect.poll(() => metadata.length).toBe(attempt + 2);
            await expect(dialog.locator(".ott-spinner")).toBeVisible();
            await metadata[attempt + 1].fulfill({
                body: "Unavailable",
                headers,
                status: 503,
            });
        }
        await expect(dialog).toContainText(
            await page.evaluate(() => window._("Plex connection failed"))
        );
        await expect(dialog.locator(".ott-spinner")).toHaveCount(0);
        await page.keyboard.press("Enter");
        await expect(dialog).toBeHidden();
        await page.keyboard.press("Enter");
        await expect.poll(() => collections.length).toBe(4);
        await folder(collections[3]);
        await expect.poll(() => metadata.length).toBe(5);
        await metadata[4].fulfill({
            headers,
            json: {
                MediaContainer: {
                    Metadata: [
                        {
                            Media: [
                                {
                                    audioCodec: "mp3",
                                    container: "avi",
                                    Part: [
                                        { key: "/library/parts/42/file.avi" },
                                    ],
                                    videoCodec: "mpeg4",
                                },
                            ],
                            ratingKey: "42",
                            type: "movie",
                        },
                    ],
                },
            },
        });
        await page.waitForFunction(() => {
            const video = document.querySelector("video");
            return (
                window.__ottClassicPlayback.snapshot().phase === "playing" &&
                video.currentTime > 0.2 &&
                !video.error
            );
        });
        await expect(dialog).toBeHidden();
        await expect(page.locator("#buffering")).toBeHidden();
        await expect(page.locator("#list_window")).toBeHidden();
        await page.screenshot({
            path: test.info().outputPath("plex-file-playing.png"),
        });
        expect(errors).toEqual([]);
    }
);

test("Explicit Plex Media browsing plays direct HLS and keeps access URLs out of history", async ({
    page,
    context,
    baseURL,
}) => {
    const local = new URL(baseURL).origin;
    const requests = [];
    const errors = [];
    let expandedFolder = false;
    let failCollection = false;
    let holdCollection = false;
    let releaseCollection;
    let holdDecision = false;
    let releaseDecision;
    const folderOffsets = [];
    const folderParents = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === local) return route.continue();
        if (url.origin !== plex) return route.abort();
        requests.push(url.pathname);
        const headers = { "access-control-allow-origin": "*" };
        const json = (body) =>
            route.fulfill({ headers, json: { MediaContainer: body } });
        if (url.pathname === "/library/sections")
            return json({
                Directory: [{ key: "7", title: "My library", type: "movie" }],
            });
        if (url.pathname === "/library/sections/7/all")
            return json({ Metadata: [] });
        if (url.pathname === "/hubs/search")
            return json({
                Hub: [
                    {
                        Metadata: [
                            {
                                ratingKey: "42",
                                title: "Test film",
                                type: "movie",
                            },
                        ],
                    },
                ],
            });
        if (url.pathname === "/library/sections/7/folder") {
            const level = Number(url.searchParams.get("parent") || 0);
            folderParents.push(level);
            if (level === 3 && failCollection)
                return route.fulfill({
                    body: "Unavailable",
                    headers,
                    status: 503,
                });
            if (level === 3 && holdCollection)
                await new Promise((release) => {
                    releaseCollection = release;
                });
            if (level === 3 && expandedFolder) {
                const offset = Number(
                    url.searchParams.get("X-Plex-Container-Start") || 0
                );
                folderOffsets.push(offset);
                const rows = [
                    {
                        key: "/library/sections/7/folder?parent=4",
                        title: "Child folder",
                    },
                    { ratingKey: "42", title: "Test film", type: "movie" },
                    { ratingKey: "43", title: "Following film", type: "movie" },
                ];
                return json({
                    Metadata: rows.slice(offset, offset + 2),
                    offset,
                    size: Math.min(2, rows.length - offset),
                    totalSize: rows.length,
                });
            }
            return json(
                level < 3
                    ? {
                          Metadata: [
                              {
                                  key:
                                      "/library/sections/7/folder?parent=" +
                                      (level + 1),
                                  title: "Folder " + (level + 1),
                              },
                          ],
                      }
                    : {
                          Metadata: [
                              {
                                  ratingKey: "42",
                                  title: "  ",
                                  titleSort: "Test film",
                                  type: "movie",
                              },
                          ],
                          offset: 0,
                          size: 1,
                          totalSize: 1,
                      }
            );
        }
        if (/^\/library\/metadata\/(42|43)$/.test(url.pathname))
            return json({
                Metadata: [
                    {
                        Media: [
                            {
                                audioCodec: "mp3",
                                container: "avi",
                                Part: [{ key: "/library/parts/42/file.avi" }],
                                videoCodec: "mpeg4",
                            },
                        ],
                        ratingKey: url.pathname.split("/").pop(),
                        type: "movie",
                    },
                ],
            });
        if (url.pathname.endsWith("/decision")) {
            if (holdDecision)
                await new Promise((release) => {
                    releaseDecision = release;
                });
            return json({
                generalDecisionCode: 1001,
                Metadata: [{ Media: [{ Part: [{ decision: "transcode" }] }] }],
            });
        }
        if (url.pathname.endsWith("/start.m3u8"))
            return route.fulfill({
                body:
                    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n" +
                    Array.from(
                        { length: 30 },
                        (_, index) =>
                            (index ? "#EXT-X-DISCONTINUITY\n" : "") +
                            "#EXTINF:2.000000,\nsegment00.ts?segment=" +
                            index +
                            "\n"
                    ).join("") +
                    "#EXT-X-ENDLIST\n",
                contentType: "application/vnd.apple.mpegurl",
                headers,
            });
        if (url.pathname.endsWith(".ts"))
            return route.fulfill({
                body: fs.readFileSync(path.join(mediaRoot, "segment00.ts")),
                contentType: "video/mp2t",
                headers,
            });
        if (url.pathname.endsWith("/stop") || url.pathname.endsWith("/ping"))
            return route.fulfill({ body: "", headers, status: 200 });
        return route.fulfill({
            body: "missing fixture route",
            headers,
            status: 404,
        });
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(
        ({ plex, token }) => {
            // Silent AAC can stall Chromium's audio clock without OS output.
            // Muting each attempt also covers the real page reload below.
            const play = HTMLMediaElement.prototype.play;
            HTMLMediaElement.prototype.play = function () {
                this.muted = true;
                return play.call(this);
            };
            localStorage.setItem("ottplaylang", "_eng");
            localStorage.setItem("ottplayprov", "plex");
            localStorage.setItem(
                "plexcfg",
                JSON.stringify({ address: plex, playback: "compatible", token })
            );
        },
        { plex, token }
    );
    await page.goto("/f/pc/");
    // Real users activate the page with a remote/key/click before selecting media.
    await page.keyboard.press("Shift");
    await openLegacyPlex(page);
    await select(page, "My library");
    await select(page, "Browse folders");
    for (let level = 1; level <= 3; level++)
        await select(page, "Folder " + level);
    const depth = await page.evaluate(
        () => window.__ottMedia.snapshot().frames.length
    );
    expect(depth).toBeGreaterThanOrEqual(5);
    await page.evaluate(() => window.__ottMedia.back());
    await select(page, "Folder 3");
    const folderTrail = await page.evaluate(() =>
        window.__ottMedia.snapshot().frames.map((frame) => frame.route.title)
    );
    await page.evaluate(() => {
        window.sFavorites = 1;
        document.querySelector("video").muted = true;
    });
    const controls = page.locator("#mediaPlaybackControls");
    const loadingShuffle = await page.evaluate(() =>
        window._("Shuffle: Loading...")
    );
    const shuffle = (state) =>
        controls.getByRole("button", {
            exact: true,
            name: state === "Loading..." ? loadingShuffle : "Shuffle: " + state,
        });
    await expect(shuffle("Off")).toBeVisible();
    await expect(shuffle("Off")).toHaveAttribute("data-state", "off");
    await expect(shuffle("Off")).toHaveAttribute("aria-pressed", "false");
    await expect(
        controls.getByRole("button", { name: "Repeat: All" })
    ).toBeVisible();
    await page.keyboard.press("9");
    await expect(
        controls.getByRole("button", { name: "Repeat: One" })
    ).toHaveAttribute("data-state", "one");
    // Playwright models NumLock off: Shift selects the numeric keypad value.
    await page.keyboard.press("Shift+Numpad9");
    await expect(
        controls.getByRole("button", { name: "Repeat: Off" })
    ).toHaveAttribute("data-state", "off");
    // Pointer activation follows the same state cycle as physical digits.
    for (const [before, after] of [
        ["Off", "All"],
        ["All", "One"],
        ["One", "Off"],
    ]) {
        await controls
            .getByRole("button", { name: "Repeat: " + before })
            .click();
        await expect(
            controls.getByRole("button", { name: "Repeat: " + after })
        ).toBeVisible();
    }
    const panel = await page.locator("#listDetail").boundingBox();
    const toolbar = await controls.boundingBox();
    expect(toolbar.x).toBeGreaterThanOrEqual(panel.x);
    expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(
        panel.x + panel.width
    );
    expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(
        panel.y + panel.height
    );
    await page.screenshot({
        path: test.info().outputPath("plex-controls.png"),
    });
    expect(await page.locator("#list").innerText()).toContain("Test film");
    holdCollection = true;
    await page.keyboard.press("5");
    await expect.poll(() => typeof releaseCollection).toBe("function");
    await expect(shuffle("Loading...")).toBeVisible();
    await expect(shuffle("Loading...")).toHaveAttribute(
        "data-state",
        "loading"
    );
    await expect(shuffle("Loading...")).toHaveAttribute("aria-busy", "true");
    expect(await page.evaluate(() => window.__ottMedia.current())).toBeNull();
    await page.screenshot({
        path: test.info().outputPath("plex-controls-loading.png"),
    });
    holdCollection = false;
    releaseCollection();
    await page.waitForFunction(() =>
        Array.from(document.querySelectorAll("video")).some(
            (video) => video.currentTime > 0.2 && !video.error
        )
    );
    const shuffledGeneration = await page.evaluate(
        () => window.__ottClassicPlayback.snapshot().generation
    );
    await page.evaluate(() => window.__ottMedia.open(null));
    await expect(shuffle("On")).toBeVisible();
    await expect(shuffle("On")).toHaveAttribute("data-state", "on");
    await expect(shuffle("On")).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({
        path: test.info().outputPath("plex-controls-active.png"),
    });
    const playing = await page.evaluate(() => ({
        id: window.__ottMedia.current().ref.itemId,
        position: document.querySelector("video").currentTime,
    }));
    // Turning shuffle off changes the queue, not the current media attempt.
    await page.keyboard.press("Shift+Numpad5");
    await expect(shuffle("Off")).toBeVisible();
    await expect(shuffle("Off")).toHaveAttribute("aria-pressed", "false");
    const ordered = await page.evaluate(() => ({
        generation: window.__ottClassicPlayback.snapshot().generation,
        id: window.__ottMedia.current().ref.itemId,
        position: document.querySelector("video").currentTime,
    }));
    expect(ordered.generation).toBe(shuffledGeneration);
    expect(ordered.id).toBe(playing.id);
    expect(ordered.position).toBeGreaterThanOrEqual(playing.position);
    await page.keyboard.press("5");
    await page.waitForFunction((previousGeneration) => {
        const playback = window.__ottClassicPlayback.snapshot();
        const video = document.querySelector("video");
        return (
            playback.generation > previousGeneration &&
            playback.phase === "playing" &&
            video.readyState >= 2 &&
            video.currentTime > 0.2 &&
            !video.seeking &&
            !video.error
        );
    }, shuffledGeneration);
    const state = await page.evaluate(() => ({
        current: window.__ottMedia.current()?.payload.__ottPlexPlayback.type,
        journals: Object.keys(localStorage)
            .filter((key) => key.includes("mediaJournal.v1:"))
            .map((key) => localStorage.getItem(key)),
        provider: localStorage.getItem("ottplayprov"),
        queue: window.__ottMedia
            .current()
            ?.sequence.items.map((item) => item.title),
        repeat: window.__ottMedia.current()?.sequence.repeat,
    }));
    expect(state.provider).toBe("plex");
    expect(state.current).toBe("hls");
    expect(state.queue).toEqual(["Test film"]);
    expect(state.repeat).toBe("off");
    expect(state.journals.length).toBeGreaterThan(0);
    expect(JSON.stringify(state.journals)).not.toContain(token);
    expect(requests).toContain("/video/:/transcode/universal/decision");
    // Desktop modifier arrows seek even with saved volume bindings; plain
    // arrows remain available to menus and dialogs. Exercise the real router.
    const arrow = (key, keyCode, altKey = false) =>
        page.evaluate(
            ({ key, keyCode, altKey }) =>
                document.dispatchEvent(
                    new KeyboardEvent("keydown", {
                        altKey,
                        bubbles: true,
                        cancelable: true,
                        code: key,
                        key,
                        keyCode,
                        which: keyCode,
                    })
                ),
            { altKey, key, keyCode }
        );
    const playbackIdentity = () =>
        page.evaluate(() => ({
            generation: window.__ottClassicPlayback.snapshot().generation,
            ref: window.__ottMedia.current().ref,
            trail: window.__ottMedia
                .snapshot()
                .frames.map((frame) => frame.route.title),
            volume: document.querySelector("video").volume,
        }));
    const savedBindings = await page.evaluate(() => {
        const saved = [window.sALfun, window.sARfun, window.sArrowFun];
        window.sALfun = 14;
        window.sARfun = 13;
        window.sArrowFun = 0;
        window.closeList();
        document.querySelector("video").volume = 0.42;
        return saved;
    });
    const beforeSeek = await playbackIdentity();
    for (const [key, keyCode, position] of [
        ["ArrowLeft", 37, 15],
        ["ArrowRight", 39, 35],
    ]) {
        await page.evaluate(() => {
            const video = document.querySelector("video");
            video.pause();
            video.currentTime = 25;
        });
        await page.waitForFunction(() => {
            const video = document.querySelector("video");
            return !video.seeking && Math.abs(video.currentTime - 25) < 0.05;
        });
        await arrow(key, keyCode, true);
        expect(await playbackIdentity()).toEqual(beforeSeek);
        await page.waitForFunction((position) => {
            const video = document.querySelector("video");
            return (
                !video.seeking && Math.abs(video.currentTime - position) < 0.2
            );
        }, position);
        expect(await playbackIdentity()).toEqual(beforeSeek);
        await expect(page.locator("#list")).toBeHidden();
        await expect(page.locator("#dialogbox")).toBeHidden();
        await expect(page.locator("#listPopUp")).toBeHidden();
    }
    // Visible list/dialog owners still receive arrows without seeking the
    // underlying paused movie or falling through to the volume bindings.
    await page.evaluate(() => window.__ottMedia.open(null));
    await expect(page.locator("#listCaption")).toContainText("Folder 3");
    for (const [key, keyCode] of [
        ["ArrowLeft", 37],
        ["ArrowRight", 39],
    ])
        await arrow(key, keyCode);
    await expect(page.locator("#list")).toBeVisible();
    expect(await playbackIdentity()).toEqual(beforeSeek);
    expect(
        await page.evaluate(() => document.querySelector("video").currentTime)
    ).toBeCloseTo(35, 1);
    await page.evaluate(() => {
        window.closeList();
        window.showPlaybackSeekDialog(0);
    });
    await expect(page.locator("#dialogbox")).toBeVisible();
    await arrow("ArrowRight", 39);
    await expect(page.locator("#step")).toContainText("10");
    expect(
        await page.evaluate(() => document.querySelector("video").currentTime)
    ).toBeCloseTo(35, 1);
    await arrow("ArrowLeft", 37);
    await page.keyboard.press("Escape");
    await expect(page.locator("#dialogbox")).toBeHidden();
    expect(await playbackIdentity()).toEqual(beforeSeek);
    expect(
        await page.evaluate(() => document.querySelector("video").currentTime)
    ).toBeCloseTo(35, 1);
    await page.evaluate(([left, right, listArrows]) => {
        window.sALfun = left;
        window.sARfun = right;
        window.sArrowFun = listArrows;
    }, savedBindings);
    await page.evaluate(() => {
        const video = document.querySelector("video");
        video.pause();
        video.currentTime = 12.375;
    });
    await page.waitForFunction(() => {
        const video = document.querySelector("video");
        return !video.seeking && Math.abs(video.currentTime - 12.375) < 0.05;
    });
    const bookmark = await page.evaluate(() => {
        window.body_onUnload();
        const key = Object.keys(localStorage).find((key) =>
            key.includes("mediaJournal.v1:")
        );
        return JSON.parse(localStorage.getItem(key)).history[0];
    });
    expect(bookmark.position).toBeCloseTo(12.375, 2);
    const resolvesBeforeReload = requests.filter(
        (path) => path === "/library/metadata/42"
    ).length;
    // A fresh folder listing can grow between sessions; resume must collect
    // later pages without descending into its child folders.
    expandedFolder = true;
    holdCollection = true;
    releaseCollection = undefined;
    holdDecision = true;
    await page.reload();
    await openLegacyPlex(page, true);
    await expect.poll(() => typeof releaseCollection).toBe("function");
    const startupSpinner = page.locator("#dialogbox .ott-spinner");
    await expect(startupSpinner).toBeVisible();
    await expect(page.locator("#dialogbox")).toContainText(
        "Loading… please wait…"
    );
    await page.waitForTimeout(3500);
    await expect(startupSpinner).toBeVisible();
    holdCollection = false;
    releaseCollection();
    await expect.poll(() => typeof releaseDecision).toBe("function");
    await expect(startupSpinner).toBeVisible();
    await page.screenshot({
        path: test.info().outputPath("plex-restoring.png"),
    });
    holdDecision = false;
    releaseDecision();
    await page.waitForFunction(() => {
        const video = document.querySelector("video");
        return (
            window.__ottMedia?.current() &&
            video.currentTime >= 12.375 &&
            !video.error
        );
    });
    expect(
        await page.evaluate(() => window.__ottMedia.current().ref.itemId)
    ).toBe(bookmark.itemId);
    await expect(startupSpinner).toBeHidden();
    expect(
        requests.filter((path) => path === "/library/metadata/42").length
    ).toBeGreaterThan(resolvesBeforeReload);
    expect(
        await page.evaluate(() => document.querySelector("video").currentTime)
    ).toBeLessThan(15);
    await page.evaluate(() => window.__ottMedia.open(null));
    await expect(page.locator("#listCaption")).toContainText("Folder 3");
    await expect(page.locator("#list")).toContainText("Following film");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    expect(
        await page.evaluate(() => window.__ottMedia.current().ref.itemId)
    ).toBe(bookmark.itemId);
    const restoredFolder = await page.evaluate(() => {
        const view = window.__ottMedia.snapshot();
        return {
            selected: view.frame.items[view.frame.selected].ref.itemId,
            titles: view.frame.items.map((item) => item.title),
            trail: view.frames.map((frame) => frame.route.title),
        };
    });
    expect(restoredFolder.trail).toEqual(folderTrail);
    expect(restoredFolder.selected).toBe(bookmark.itemId);
    expect(restoredFolder.titles).toEqual(
        expect.arrayContaining(["Child folder", "Test film", "Following film"])
    );
    expect(folderOffsets).toContain(2);
    const resolvesBeforeEnd = requests.filter(
        (path) => path === "/library/metadata/43"
    ).length;
    await page.waitForFunction(() => {
        const video = document.querySelector("video");
        return (
            video.readyState >= 2 &&
            Number.isFinite(video.duration) &&
            !video.seeking
        );
    });
    await page.evaluate(() => {
        const video = document.querySelector("video");
        video.currentTime = video.duration - 1;
    });
    await page.waitForFunction(() => {
        const current = window.__ottMedia.current();
        const video = document.querySelector("video");
        return (
            current?.payload.request.path === "/library/metadata/43" &&
            video.currentTime > 0.2 &&
            video.currentTime < 5 &&
            !video.error
        );
    });
    expect(
        requests.filter((path) => path === "/library/metadata/43").length
    ).toBe(resolvesBeforeEnd + 1);
    expect(folderOffsets.every((offset) => offset === 0 || offset === 2)).toBe(
        true
    );
    expect(folderParents).not.toContain(4);
    await page.evaluate(() => window.closeList());
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(
        () =>
            window.__ottMedia.current()?.payload.request.path ===
                "/library/metadata/42" &&
            document.querySelector("video").currentTime > 0.2
    );
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(
        () =>
            window.__ottMedia.current()?.payload.request.path ===
                "/library/metadata/43" &&
            document.querySelector("video").currentTime > 0.2
    );
    // A transient catalog error must not permanently disable full-screen
    // arrows after the individual file has successfully resumed.
    await page.evaluate(() => {
        const playing = window.__ottMedia.current();
        window.__ottMedia.checkpoint(playing.ref, 1, true);
    });
    failCollection = true;
    await page.reload();
    await openLegacyPlex(page, true);
    await page.waitForFunction(
        () =>
            window.__ottMedia?.current()?.payload.request.path ===
                "/library/metadata/43" &&
            document.querySelector("video").currentTime > 0.2
    );
    expect(
        await page.evaluate(() => window.__ottMedia.current().sequence)
    ).toBeNull();
    failCollection = false;
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(
        () =>
            window.__ottMedia.current()?.payload.request.path ===
                "/library/metadata/42" &&
            document.querySelector("video").currentTime > 0.2
    );
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(
        () =>
            window.__ottMedia.current()?.payload.request.path ===
                "/library/metadata/43" &&
            document.querySelector("video").currentTime > 0.2
    );
    const stopsBefore = requests.filter((path) =>
        path.endsWith("/stop")
    ).length;
    await page.evaluate(() => window.stbStop());
    await expect
        .poll(() => requests.filter((path) => path.endsWith("/stop")).length)
        .toBe(stopsBefore + 1);
    await page.evaluate(() => window.__ottMedia.open("plexsearch?search=Test"));
    await expect(
        controls.getByRole("button", { name: "Repeat: Off" })
    ).toBeVisible();
    await expect(
        controls.getByRole("button", { name: /^Shuffle:/ })
    ).toHaveCount(0);
    const stoppedGeneration = await page.evaluate(
        () => window.__ottClassicPlayback.snapshot().generation
    );
    await select(page, "Test film");
    await page.waitForFunction((previousGeneration) => {
        const state = window.__ottClassicPlayback.snapshot();
        const video = document.querySelector("video");
        return (
            state.generation > previousGeneration &&
            state.phase === "playing" &&
            video.currentTime > 0.2 &&
            video.readyState >= 2 &&
            Number.isFinite(video.duration) &&
            video.duration > 0.2 &&
            !video.seeking &&
            !video.error
        );
    }, stoppedGeneration);
    await page.evaluate(() => {
        const video = document.querySelector("video");
        // Leave actual media before EOF: the transport stream's audio ends
        // slightly before the duration advertised by the synthetic playlist.
        video.currentTime = video.duration - 1;
    });
    await page.waitForFunction(() => {
        const key = Object.keys(localStorage).find((key) =>
            key.includes("mediaJournal.v1:")
        );
        return (
            window.__ottClassicPlayback.snapshot().phase === "stopped" &&
            JSON.parse(localStorage.getItem(key)).history[0].position === 0
        );
    });
    const completedResolves = requests.filter(
        (path) => path === "/library/metadata/42"
    ).length;
    await page.reload();
    await openLegacyPlex(page, true);
    await expect(page.locator("body")).toContainText("My library");
    expect(await page.evaluate(() => window.__ottMedia.current())).toBeNull();
    expect(
        requests.filter((path) => path === "/library/metadata/42").length
    ).toBe(completedResolves);
    expect(errors).toEqual([]);
});

test("Plex appends folder pages without changing selection or Back ownership and retries a failed cursor", async ({
    page,
    context,
    baseURL,
}, testInfo) => {
    const local = new URL(baseURL).origin;
    const errors = [];
    const requests = [];
    const pending = [];
    const rows = Array.from({ length: 20 }, (_, index) => ({
        ratingKey: String(100 + index),
        title: "Film " + String(index + 1).padStart(2, "0"),
        type: "movie",
    }));
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === local) return route.continue();
        if (url.origin !== plex) return route.abort();
        const headers = { "access-control-allow-origin": "*" };
        const json = (body) =>
            route.fulfill({ headers, json: { MediaContainer: body } });
        if (url.pathname === "/library/sections")
            return json({
                Directory: [{ key: "7", title: "My library", type: "movie" }],
            });
        if (url.pathname === "/library/sections/7/all")
            return json({ Metadata: [], title2: "Folder" });
        if (url.pathname === "/library/sections/7/folder") {
            if (!url.searchParams.has("parent"))
                return json({
                    Metadata: [
                        {
                            key: "/library/sections/7/folder?parent=17",
                            title: "Turtles",
                        },
                    ],
                    title2: "Folder",
                });
            expect(url.searchParams.get("parent")).toBe("17");
            const offset = Number(
                request.headers()["x-plex-container-start"] || 0
            );
            expect(
                Number(url.searchParams.get("X-Plex-Container-Start") || 0)
            ).toBe(offset);
            requests.push(offset);
            const response = {
                Metadata: rows.slice(offset, offset + (offset ? 4 : 8)),
                offset,
                size: offset ? 4 : 8,
                title2: "Folder",
                totalSize: rows.length,
            };
            if (!offset) return json(response);
            const status = await new Promise((release) =>
                pending.push({ offset, release })
            );
            try {
                if (status === 503)
                    return await route.fulfill({
                        body: "Fixture unavailable",
                        headers,
                        status,
                    });
                return await json(response);
            } catch (error) {
                if (!request.failure()) throw error;
            }
        }
        return route.fulfill({
            body: "Unexpected fixture request",
            headers,
            status: 404,
        });
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(
        ({ plex, token }) => {
            localStorage.setItem("ottplaylang", "_eng");
            localStorage.setItem("ottplayprov", "plex");
            localStorage.setItem(
                "plexcfg",
                JSON.stringify({ address: plex, token })
            );
        },
        { plex, token }
    );

    async function view() {
        return page.evaluate(() => {
            const state = window.__ottMedia.snapshot();
            const frame = state.frame;
            const cursor = frame.items.findIndex(
                (item) => item.payload.__ottMediaNext
            );
            return {
                cursor,
                cursorState:
                    cursor < 0
                        ? null
                        : frame.items[cursor].payload.__ottMediaPageState ||
                          null,
                depth: state.frames.length,
                ids: frame.items
                    .filter((item) => item.payload.request)
                    .map((item) => item.payload.request.path),
                route: frame.route,
                selected: frame.selected,
                selectedTitle: frame.items[frame.selected]?.title,
                uiSelected: window.selIndex,
                uiTitle: window.listArray[window.selIndex]?.title,
            };
        });
    }
    async function highlightCursor(distance = 0) {
        await page.evaluate((distance) => {
            const state = window.__ottMedia.snapshot();
            const cursor = state.frame.items.findIndex(
                (item) => item.payload.__ottMediaNext
            );
            if (cursor < 0) throw new Error("Missing owned pagination cursor");
            window.setSelect(cursor - distance);
        }, distance);
    }
    async function release(offset, status = 200) {
        await expect
            .poll(() => pending.some((row) => row.offset === offset))
            .toBe(true);
        const index = pending.findIndex((row) => row.offset === offset);
        pending.splice(index, 1)[0].release(status);
    }

    await page.goto("/f/pc/");
    await openLegacyPlex(page);
    await select(page, "My library");
    await select(page, "Browse folders");
    await select(page, "Turtles");
    await expect(page.locator("#listCaption")).toContainText("Turtles");
    const initial = await view();
    expect(initial.route.title).toBe("Turtles");
    expect(initial.ids).toHaveLength(8);
    expect(initial.cursor).toBe(8);
    expect(requests).toEqual([0]);

    // Highlighting a real row near the end prefetches without pressing Enter.
    await highlightCursor(2);
    await expect.poll(() => requests).toEqual([0, 8]);
    const highlighted = await view();
    expect(highlighted.selectedTitle).toBe("Film 07");
    const loading = await page.evaluate(() => window._("Loading..."));
    expect(highlighted.cursorState).toBe("loading");
    await expect(page.locator("#list")).toContainText(loading);
    await testInfo.attach("plex-folder-loading", {
        body: await page.screenshot(),
        contentType: "image/png",
    });
    await release(8);
    await expect.poll(async () => (await view()).ids.length).toBe(12);
    const appended = await view();
    expect(appended.route).toEqual(initial.route);
    expect(appended.depth).toBe(initial.depth);
    expect(appended.ids.slice(0, 8)).toEqual(initial.ids);
    expect(appended.selected).toBe(highlighted.selected);
    expect(appended.selectedTitle).toBe(highlighted.selectedTitle);
    expect(appended.uiTitle).toBe(highlighted.selectedTitle);

    // A selected cursor becomes the first inserted row at that exact index.
    await highlightCursor();
    await expect.poll(() => requests).toEqual([0, 8, 12]);
    const cursor = (await view()).selected;
    await release(12);
    await expect.poll(async () => (await view()).ids.length).toBe(16);
    const inserted = await view();
    expect(inserted.selected).toBe(cursor);
    expect(inserted.uiSelected).toBe(cursor);
    expect(inserted.selectedTitle).toBe("Film 13");
    expect(inserted.uiTitle).toBe("Film 13");
    expect(inserted.depth).toBe(initial.depth);
    await testInfo.attach("plex-folder-appended", {
        body: await page.screenshot(),
        contentType: "image/png",
    });

    // Fail closed with all prior rows intact, then retry the same cursor.
    await highlightCursor();
    await expect.poll(() => requests).toEqual([0, 8, 12, 16]);
    await release(16, 503);
    const retry = await page.evaluate(() =>
        window._("Could not load. Select to retry.")
    );
    await expect.poll(async () => (await view()).cursorState).toBe("error");
    expect((await view()).ids).toEqual(inserted.ids);
    await expect(page.locator("#list")).toContainText(retry);
    await page.evaluate(() => window.listKeyHandler(window.keys.ENTER));
    await expect.poll(() => requests).toEqual([0, 8, 12, 16, 16]);
    await release(16);
    await expect.poll(async () => (await view()).ids.length).toBe(20);
    const complete = await view();
    expect(complete.cursor).toBe(-1);
    expect(complete.ids).toEqual(
        rows.map((row) => "/library/metadata/" + row.ratingKey)
    );
    expect(complete.selectedTitle).toBe("Film 17");
    expect(complete.route).toEqual(initial.route);
    expect(complete.depth).toBe(initial.depth);
    await page.evaluate(() => window.__ottMedia.back());
    expect((await view()).depth).toBe(initial.depth - 1);
    expect((await view()).route.target.path).toBe("/library/sections/7/folder");
    await expect(page.locator("#list")).toContainText("Turtles");

    // Leave a new pending visit; even its late response cannot reopen it.
    await select(page, "Turtles");
    await expect.poll(async () => (await view()).ids.length).toBe(8);
    await highlightCursor(2);
    await expect.poll(() => pending.some((row) => row.offset === 8)).toBe(true);
    const aborted = page.waitForEvent("requestfailed", {
        predicate: (request) => {
            const url = new URL(request.url());
            return (
                url.origin === plex &&
                url.pathname === "/library/sections/7/folder" &&
                url.searchParams.get("X-Plex-Container-Start") === "8"
            );
        },
    });
    await page.evaluate(() => window.__ottMedia.back());
    await aborted;
    const parent = await view();
    await release(8);
    await page.evaluate(
        () =>
            new Promise((done) =>
                requestAnimationFrame(() => requestAnimationFrame(done))
            )
    );
    expect(await view()).toEqual(parent);
    await expect(page.locator("#list")).toContainText("Turtles");
    await expect(page.locator("#list")).not.toContainText("Film 09");
    expect(errors).toEqual([]);
});

for (const { engine, strict } of [
    { engine: "html5", strict: false },
    { engine: "hls.js", strict: false },
    { engine: "shaka", strict: false },
    { engine: "video.js", strict: false },
    { engine: "hls.js", strict: true },
]) {
    test(
        "Plex aspect persists through media changes and " +
            (strict ? "strict kiosk natural episode end and " : "") +
            "reload: " +
            engine,
        async ({ page, context, baseURL, browserName }) => {
            test.skip(
                engine === "html5" && browserName !== "webkit",
                "Native HLS requires WebKit"
            );
            test.setTimeout(60000);
            const local = new URL(baseURL).origin;
            const errors = [];
            const films = [
                { ratingKey: "42", title: "First aspect film", type: "movie" },
                { ratingKey: "43", title: "Next aspect film", type: "movie" },
            ].map((item, index) =>
                strict
                    ? {
                          ...item,
                          grandparentTitle: "Aspect series",
                          index: index + 1,
                          parentIndex: 1,
                          title: "Aspect episode " + (index + 1),
                          type: "episode",
                      }
                    : item
            );
            page.on("pageerror", (error) => errors.push(error.message));
            await context.route("**/*", (route) => {
                const url = new URL(route.request().url());
                if (url.origin !== local) return route.abort();
                const json = (body) =>
                    route.fulfill({ json: { MediaContainer: body } });
                if (url.pathname === "/library/sections")
                    return json({
                        Directory: [
                            {
                                key: "7",
                                title: "Aspect library",
                                type: strict ? "show" : "movie",
                            },
                        ],
                    });
                if (url.pathname === "/library/sections/7/all")
                    return json({ Metadata: [] });
                if (url.pathname === "/library/sections/7/folder")
                    return json({
                        Metadata: films,
                        offset: 0,
                        size: 2,
                        totalSize: 2,
                    });
                if (url.pathname.endsWith("/decision"))
                    return json({
                        generalDecisionCode: 1001,
                        Metadata: [
                            { Media: [{ Part: [{ decision: "transcode" }] }] },
                        ],
                    });
                if (
                    url.pathname.endsWith("/stop") ||
                    url.pathname.endsWith("/ping")
                )
                    return route.fulfill({ body: "" });
                if (/^\/library\/metadata\/(42|43)$/.test(url.pathname)) {
                    const id = url.pathname.split("/").pop();
                    return json({
                        Metadata: [
                            {
                                ...films.find((film) => film.ratingKey === id),
                                Media: [
                                    {
                                        audioCodec: "aac",
                                        container: "mpegts",
                                        Part: [
                                            {
                                                key:
                                                    "/library/parts/" +
                                                    id +
                                                    "/file.ts",
                                            },
                                        ],
                                        videoCodec: "h264",
                                    },
                                ],
                            },
                        ],
                    });
                }
                return route.continue();
            });
            await context.routeWebSocket("**/*", (socket) => socket.close());
            await context.addInitScript(
                ({ local, engine, strict }) => {
                    const play = HTMLMediaElement.prototype.play;
                    HTMLMediaElement.prototype.play = function () {
                        this.muted = true;
                        this.loop = !window.__aspectNaturalEnd;
                        return play.call(this);
                    };
                    localStorage.setItem("ottplaylang", "_eng");
                    localStorage.setItem("ottplayprov", "plex");
                    localStorage.setItem(
                        "plexsPlayers",
                        engine === "shaka"
                            ? "2"
                            : engine === "html5"
                              ? "0"
                              : "1"
                    );
                    localStorage.setItem(
                        "plexcfg",
                        JSON.stringify({
                            address: local,
                            folders: strict
                                ? [
                                      {
                                          path: "/library/sections/7/folder",
                                          title: "Aspect library",
                                      },
                                  ]
                                : undefined,
                            playback: "compatible",
                            token: "synthetic-aspect-token",
                        })
                    );
                },
                { engine, local, strict }
            );
            await page.setViewportSize({ height: 720, width: 960 });
            await page.goto(engine === "video.js" ? "/f/pc2/" : "/f/pc/");
            await page.keyboard.press("Shift");
            await openLegacyPlex(page);
            await select(page, "Aspect library");
            await select(page, "Browse folders");
            await select(page, films[0].title);
            async function ready(id) {
                const target =
                    "request:" +
                    JSON.stringify({ path: "/library/metadata/" + id });
                try {
                    await page.waitForFunction(
                        (target) => {
                            const media = window.video;
                            if (media?.error)
                                throw new Error(
                                    "Decoder error " +
                                        media.error.code +
                                        ": " +
                                        media.error.message
                                );
                            return (
                                window.__ottMedia?.current()?.ref.itemId ===
                                    target &&
                                media?.videoWidth === 640 &&
                                media?.videoHeight === 360 &&
                                media?.readyState >= 2 &&
                                media.currentTime > 0.1
                            );
                        },
                        target,
                        { timeout: 15000 }
                    );
                    expect(
                        await page.evaluate(() => ({
                            aspect: !!window.captureAspectTarget?.(),
                            target: window.__ottMedia?.current()?.ref.itemId,
                        }))
                    ).toEqual({
                        aspect: true,
                        target,
                    });
                    await page.evaluate(() => {
                        window.stbPause();
                        window.stbToFullScreen();
                    });
                } catch (error) {
                    try {
                        const state = await page.evaluate(() => {
                            const media = window.video;
                            const ranges = (value) =>
                                Array.from({ length: value.length }, (_, i) => [
                                    value.start(i),
                                    value.end(i),
                                ]);
                            const checkpoint =
                                window.stbGetPersistedItem("__ottKioskV1");
                            const hls = window.hlsInstance;
                            const playback =
                                window.__ottClassicPlayback?.snapshot();
                            return {
                                currentRef:
                                    window.__ottMedia?.current()?.ref || null,
                                hls: hls
                                    ? {
                                          attachedToVideo: hls.media === media,
                                          autoLevelEnabled:
                                              hls.autoLevelEnabled,
                                          currentLevel: hls.currentLevel,
                                          loadLevel: hls.loadLevel,
                                          nextLoadLevel: hls.nextLoadLevel,
                                      }
                                    : null,
                                kioskCheckpoint: checkpoint,
                                media: media
                                    ? {
                                          buffered: ranges(media.buffered),
                                          currentSrc: media.currentSrc.split(
                                              /[?#]/,
                                              1
                                          )[0],
                                          currentTime: media.currentTime,
                                          duration: Number.isFinite(
                                              media.duration
                                          )
                                              ? media.duration
                                              : String(media.duration),
                                          ended: media.ended,
                                          error: media.error
                                              ? {
                                                    code: media.error.code,
                                                    message:
                                                        media.error.message,
                                                }
                                              : null,
                                          networkState: media.networkState,
                                          paused: media.paused,
                                          readyState: media.readyState,
                                          seekable: ranges(media.seekable),
                                          seeking: media.seeking,
                                          videoHeight: media.videoHeight,
                                          videoWidth: media.videoWidth,
                                      }
                                    : null,
                                playback: playback
                                    ? {
                                          duration: playback.duration,
                                          generation: playback.generation,
                                          phase: playback.phase,
                                          position: playback.position,
                                          target: playback.target
                                              ? {
                                                    channelId:
                                                        playback.target
                                                            .channelId,
                                                    kind: playback.target.kind,
                                                    sourceId:
                                                        playback.target
                                                            .sourceId,
                                                }
                                              : null,
                                      }
                                    : null,
                            };
                        });
                        await test.info().attach("aspect-readiness-failure", {
                            body: JSON.stringify({ target, ...state }, null, 2),
                            contentType: "application/json",
                        });
                    } catch (diagnosticError) {
                        // Diagnostics must never replace the original failure.
                        console.error(
                            "Unable to capture aspect readiness state:",
                            diagnosticError
                        );
                    }
                    throw error;
                }
            }
            async function aspect() {
                return page.evaluate(() => {
                    const target = window.captureAspectTarget();
                    return (
                        target && {
                            mode: target.mode,
                            savedMode: target.savedMode,
                        }
                    );
                });
            }
            async function geometry(mode) {
                const value = await page.evaluate(() => {
                    const media = window.video;
                    const box = media.getBoundingClientRect();
                    const wrapper = document
                        .getElementById("video")
                        .getBoundingClientRect();
                    return {
                        box: {
                            height: box.height,
                            width: box.width,
                            x: box.x,
                            y: box.y,
                        },
                        height: window.innerHeight,
                        width: window.innerWidth,
                        wrapper: {
                            height: wrapper.height,
                            width: wrapper.width,
                            x: wrapper.x,
                            y: wrapper.y,
                        },
                    };
                });
                const scale = (mode === "fit" ? Math.min : Math.max)(
                    value.width / 640,
                    value.height / 360
                );
                const expected = {
                    height: Math.round(360 * scale),
                    width: Math.round(640 * scale),
                };
                expected.x = Math.round((value.width - expected.width) / 2);
                expected.y = Math.round((value.height - expected.height) / 2);
                for (const box of [value.box, value.wrapper])
                    for (const property of ["width", "height", "x", "y"])
                        expect(
                            Math.abs(box[property] - expected[property]),
                            property + " uses centered " + mode
                        ).toBeLessThanOrEqual(1);
            }
            await ready("42");
            expect(await page.evaluate(() => window.playerMode)).toBe(
                engine === "shaka" ? 2 : engine === "html5" ? 0 : 1
            );
            if (engine === "video.js")
                expect(
                    await page.evaluate(
                        () =>
                            window.videojs
                                .getPlayer("video")
                                .tech({ IWillNotUseThisInPlugins: true })
                                .el() === window.video
                    )
                ).toBe(true);
            else {
                expect(
                    await page.evaluate(() => window._corePlaybackMode)
                ).toBe(engine === "shaka" ? 2 : engine === "html5" ? 0 : 1);
                if (engine === "hls.js")
                    expect(
                        await page.evaluate(
                            () => window.hlsInstance.media === window.video
                        )
                    ).toBe(true);
                if (engine === "shaka")
                    expect(
                        await page.evaluate(
                            () =>
                                window.player.getMediaElement() === window.video
                        )
                    ).toBe(true);
            }
            // Explicit Media playback shares preferences with its configured flat playlist.
            expect(await page.evaluate(() => window.cList.length)).toBe(
                strict ? 2 : 0
            );
            await page.evaluate(() => window.stbToggleAspectRatio());
            await page
                .getByRole("button", { exact: true, name: "Fill screen" })
                .click();
            expect(await aspect()).toEqual({ mode: "fill", savedMode: "fill" });
            await geometry("fill");
            for (const viewport of [
                { height: 720, width: 960 },
                { height: 960, width: 720 },
            ]) {
                await page.setViewportSize(viewport);
                for (const mode of ["fit", "fill"]) {
                    expect(
                        await page.evaluate(
                            (mode) => window.captureAspectTarget().set(mode),
                            mode
                        )
                    ).toBe(true);
                    expect(await aspect()).toEqual({ mode, savedMode: mode });
                    await geometry(mode);
                }
            }
            if (strict) {
                const kiosk = await page.evaluate(
                    () =>
                        new Promise((resolve) =>
                            window.__ottKiosk.request(
                                { mode: "on", strict: true },
                                resolve
                            )
                        )
                );
                expect(kiosk.status).toBe("ok");
                expect(kiosk.data).toMatchObject({
                    media: { index: 0, title: films[0].title, total: 2 },
                    strict: true,
                });
                expect(await aspect()).toEqual({
                    mode: "fill",
                    savedMode: "fill",
                });
                // Observe the real decoder event before the application's target
                // listener advances the queue. Only this episode may reach its end;
                // the next one loops to keep later assertions independent of timing.
                const ending = await page.evaluate(() => {
                    const media = window.video;
                    const duration = media.duration;
                    if (!Number.isFinite(duration) || duration <= 0.5)
                        throw new Error("Expected finite episode duration");
                    window.__aspectNaturalEnd = true;
                    document.addEventListener(
                        "ended",
                        function ended(event) {
                            if (event.target !== media) return;
                            document.removeEventListener("ended", ended, true);
                            const target = window.captureAspectTarget();
                            window.__aspectEnded = {
                                aspect: target && {
                                    mode: target.mode,
                                    savedMode: target.savedMode,
                                },
                                duration: media.duration,
                                ended: media.ended,
                                isTrusted: event.isTrusted,
                                itemId: window.__ottMedia.current().ref.itemId,
                                position: media.currentTime,
                                strict: window.__ottKiosk.strict(),
                            };
                            window.__aspectNaturalEnd = false;
                        },
                        true
                    );
                    media.loop = false;
                    media.currentTime = duration - 0.3;
                    window.stbResume();
                    return { duration, loop: media.loop };
                });
                expect(ending.loop).toBe(false);
                await ready("43");
                const ended = await page.evaluate(() => window.__aspectEnded);
                expect(ended).toMatchObject({
                    aspect: { mode: "fill", savedMode: "fill" },
                    ended: true,
                    isTrusted: true,
                    itemId: 'request:{"path":"/library/metadata/42"}',
                    strict: true,
                });
                expect(ended.position).toBeCloseTo(ending.duration, 1);
                expect(ended.duration).toBe(ending.duration);
                await test.info().attach("decoder-ended", {
                    body: JSON.stringify(ended, null, 2),
                    contentType: "application/json",
                });
                // Kiosk checkpoints its cursor every five seconds. Wait for the
                // real durable write before testing fresh-page restoration.
                await page.waitForFunction(() => {
                    const saved = JSON.parse(
                        window.stbGetPersistedItem("__ottKioskV1") || "null"
                    );
                    return (
                        saved?.strict === true &&
                        saved.media.index === 1 &&
                        saved.media.records[1].request.path ===
                            "/library/metadata/43"
                    );
                });
            } else {
                await page.evaluate(() => window.__ottMedia.open(null));
                await select(page, films[1].title);
                await ready("43");
            }
            expect(await page.evaluate(() => window.__ottKiosk.strict())).toBe(
                strict
            );
            expect(await aspect()).toEqual({ mode: "fill", savedMode: "fill" });
            await geometry("fill");
            await page.reload();
            if (!strict) await openLegacyPlex(page, true);
            await ready("43");
            expect(await page.evaluate(() => window.__ottKiosk.strict())).toBe(
                strict
            );
            expect(await aspect()).toEqual({ mode: "fill", savedMode: "fill" });
            await geometry("fill");
            expect(errors).toEqual([]);
        }
    );
}

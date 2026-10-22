const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("../helpers/browser-test.cjs");

test.use({
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

// Read production programme state and default footer after actual decoder playback.
// No renderer, media state, or DOM setter is replaced by this assertion.
async function expectProgramme(page, expected, openedAt) {
    await expect
        .poll(() =>
            page.evaluate(() => {
                const item = window.__ottClassicPlayback.programme();
                return (
                    item && {
                        collection: item.collection,
                        nextTitle: item.nextTitle,
                        title: item.title,
                    }
                );
            })
        )
        .toEqual(expected);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const item = window.__ottClassicPlayback.programme();
                return (
                    !!item &&
                    item.startedAt > 0 &&
                    item.duration > 0 &&
                    Math.abs(item.duration - window.video.duration) < 0.1
                );
            })
        )
        .toBe(true);
    const info = await page.evaluate(() => {
        window.updateMediaInfo();
        const item = window.__ottClassicPlayback.programme();
        const clock = (seconds) => {
            const date = new Date(seconds * 1000);
            return [date.getHours(), date.getMinutes(), date.getSeconds()]
                .map((value) => String(value).padStart(2, "0"))
                .join(":");
        };
        return {
            currentClock: clock(item.startedAt),
            decoderDuration: window.video.duration,
            duration: item.duration,
            nextClock: clock(item.startedAt + item.duration),
            nextStartedAt: item.nextStartedAt,
            startedAt: item.startedAt,
        };
    });
    expect(info.startedAt).toBeGreaterThanOrEqual(openedAt - 1);
    expect(info.startedAt).toBeLessThanOrEqual(Date.now() / 1000 + 1);
    expect(Math.abs(info.duration - info.decoderDuration)).toBeLessThan(0.1);
    expect(
        Math.abs(info.nextStartedAt - info.startedAt - info.duration)
    ).toBeLessThan(0.001);
    await expect(page.locator("#channel_name")).toHaveText(expected.collection);
    await expect(page.locator("#programm_name")).toHaveText(expected.title);
    await expect(page.locator("#nprogramm_name")).toHaveText(
        expected.nextTitle
    );
    await expect(page.locator("#begin_time")).toHaveText(info.currentClock);
    await expect(page.locator("#nbegin_time")).toHaveText(info.nextClock);
    return info;
}

for (const provider of ["plex", "vportal"]) {
    for (const layout of ["/f/pc/", "/f/"]) {
        test(`${provider} selected folders stream into ordinary channels ${layout}`, async ({
            page,
            context,
            baseURL,
        }) => {
            const origin = new URL(baseURL).origin;
            const first = [],
                second = [],
                metadata = [];
            const errors = [];
            let holdMetadata = false;
            const pendingMetadata = [];
            page.on("pageerror", (error) => errors.push(error.message));
            const json = (route, value) =>
                route.fulfill({
                    json:
                        provider === "plex" ? { MediaContainer: value } : value,
                });
            const row = (id) =>
                provider === "plex"
                    ? {
                          ratingKey: String(id),
                          title: `Film ${id}`,
                          type: "movie",
                      }
                    : {
                          request: { cmd: "play", id },
                          title: `Film ${id}`,
                          type: "stream",
                      };
            const catalog = (route, id) =>
                json(
                    route,
                    provider === "plex"
                        ? {
                              Metadata: [row(id)],
                              offset: 0,
                              size: 1,
                              totalSize: 1,
                          }
                        : { items: [row(id)], type: "videoportal" }
                );
            const resolved = (route, id) =>
                json(
                    route,
                    provider === "plex"
                        ? {
                              Metadata: [
                                  {
                                      ...row(id),
                                      Media: [
                                          {
                                              audioCodec: "aac",
                                              container: "mpegts",
                                              Part: [
                                                  {
                                                      key: `/library/parts/${id}/file.ts`,
                                                  },
                                              ],
                                              videoCodec: "h264",
                                          },
                                      ],
                                  },
                              ],
                          }
                        : {
                              type: "stream",
                              url: origin + `/playlist-media/${id}.m3u8`,
                          }
                );
            await context.route("**/*", async (route) => {
                const url = new URL(route.request().url());
                if (url.origin !== origin) return route.abort();
                if (url.pathname === "/library/sections")
                    return json(route, {
                        Directory: [
                            { key: "1", title: "Selected one", type: "movie" },
                            { key: "2", title: "Selected two", type: "movie" },
                            { key: "3", title: "Not selected", type: "movie" },
                        ],
                    });
                if (/^\/library\/sections\/\d+\/all$/.test(url.pathname)) {
                    if (url.pathname.includes("/1/")) first.push(route);
                    else if (url.pathname.includes("/2/")) second.push(route);
                    else
                        throw new Error("Unselected Plex folder was requested");
                    return;
                }
                if (/^\/library\/metadata\/\d+$/.test(url.pathname)) {
                    const id = Number(url.pathname.split("/").pop());
                    metadata.push(id);
                    if (holdMetadata) {
                        pendingMetadata.push({ id, route });
                        return;
                    }
                    return resolved(route, id);
                }
                if (url.pathname.endsWith("/vportal/api")) {
                    const params = route.request().postDataJSON().params;
                    if (params.cmd === "play") {
                        metadata.push(params.id);
                        if (holdMetadata) {
                            pendingMetadata.push({ id: params.id, route });
                            return;
                        }
                        return resolved(route, params.id);
                    }
                    if (params.folder === "one") first.push(route);
                    else if (params.folder === "two") second.push(route);
                    else
                        throw new Error(
                            "Unselected VPortal section was requested"
                        );
                    return;
                }
                if (url.pathname.endsWith("/decision"))
                    return json(route, {
                        generalDecisionCode: 1001,
                        Metadata: [
                            { Media: [{ Part: [{ decision: "transcode" }] }] },
                        ],
                    });
                if (url.pathname.endsWith(".m3u8"))
                    return route.fulfill({
                        body:
                            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n" +
                            Array.from(
                                { length: 60 },
                                (_, i) =>
                                    `${i ? "#EXT-X-DISCONTINUITY\n" : ""}#EXTINF:2.000000,\n${origin}/playlist-media/segment.ts?i=${i}\n`
                            ).join("") +
                            "#EXT-X-ENDLIST\n",
                        contentType: "application/vnd.apple.mpegurl",
                    });
                if (url.pathname === "/playlist-media/segment.ts")
                    return route.fulfill({
                        body: fs.readFileSync(
                            path.resolve(
                                __dirname,
                                "../fixtures/media-runtime/segment00.ts"
                            )
                        ),
                        contentType: "video/mp2t",
                    });
                if (
                    url.pathname.endsWith("/stop") ||
                    url.pathname.endsWith("/ping") ||
                    url.pathname === "/:/timeline"
                )
                    return route.fulfill({ body: "" });
                return route.continue();
            });
            await context.routeWebSocket("**/*", (socket) => socket.close());
            await context.addInitScript(
                ({ origin, provider }) => {
                    localStorage.setItem("ottplaylang", "_eng");
                    localStorage.setItem("ottplayprov", provider);
                    if (provider === "plex")
                        localStorage.setItem(
                            "plexcfg",
                            JSON.stringify({
                                address: origin,
                                folders: [1, 2].map((id) => ({
                                    path: `/library/sections/${id}/all?type=1`,
                                    title: `Selected ${id}`,
                                })),
                                playback: "compatible",
                                token: "synthetic-media-token",
                            })
                        );
                    else
                        localStorage.setItem(
                            "vportalprofiles",
                            JSON.stringify({
                                active: 0,
                                portals: Array.from({ length: 15 }, (_, i) => ({
                                    link: i
                                        ? ""
                                        : `portal::[key:TEST]${origin}/portal/`,
                                    name: i ? "" : "Selected media",
                                    sections: i
                                        ? []
                                        : ["one", "two"].map((folder) => ({
                                              request: { folder },
                                              title: folder,
                                          })),
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
            const openedAt = Date.now() / 1000;
            await page.goto(layout);
            await page.keyboard.press("Shift");
            await expect.poll(() => first.length).toBe(1);
            await expect(page.locator("#dialogbox .ott-spinner")).toBeVisible();
            expect(await page.evaluate(() => window.commandChannelsReady)).toBe(
                false
            );
            await catalog(first.shift(), 1);
            await expect.poll(() => second.length).toBe(1);
            await page.waitForFunction(() => window.video?.currentTime > 0.2);
            expect(await page.evaluate(() => window.cList.length)).toBe(1);
            const playing = await page.evaluate(() => ({
                generation: window.__ottClassicPlayback.snapshot().generation,
                selected: window.curList[window.primaryIndex],
            }));
            await expect(page.locator("#dialogbox")).toBeHidden();
            await page.evaluate(() => window.popMedia());
            await expect(page.locator("#list")).toContainText("Film 1");
            await expect(page.locator("#list")).not.toContainText("Film 2");
            await catalog(second.shift(), 2);
            await expect
                .poll(() => page.evaluate(() => window.cList.length))
                .toBe(2);
            expect(
                await page.evaluate(() => ({
                    generation:
                        window.__ottClassicPlayback.snapshot().generation,
                    selected: window.curList[window.primaryIndex],
                }))
            ).toEqual(playing);
            await expect(page.locator("#list")).toContainText("Film 1");
            await expect(page.locator("#list")).toContainText("Film 2");
            await expectProgramme(
                page,
                {
                    collection: provider === "plex" ? "Selected 1" : "one",
                    nextTitle: "Film 2",
                    title: "Film 1",
                },
                openedAt
            );
            await expect(page.locator("#mediaPlaybackControls")).toHaveCount(0);
            await page.evaluate(() => {
                window.sNoNumbersKeys = 1;
                window.showActionsDialog();
            });
            await expect(page.locator("#dialogbox")).toContainText(
                "Repeat: All"
            );
            await page.evaluate(() =>
                window.dialogBoxKeyHandler(window.keys.PLAY)
            );
            await expect(page.locator("#dialogbox")).toContainText(
                "Repeat: One"
            );
            await page.evaluate(() =>
                window.dialogBoxKeyHandler(window.keys.RETURN)
            );
            holdMetadata = true;
            await page.evaluate(() => {
                window.selIndex = window.listArray.findIndex(
                    (id) => window.channels[id].channel_name === "Film 2"
                );
                window.channelsKeyHandler(window.keys.ENTER);
            });
            await expect.poll(() => pendingMetadata.length).toBe(1);
            await expect(page.locator("#dialogbox .ott-spinner")).toBeVisible();
            await page.keyboard.press("ArrowDown");
            expect(pendingMetadata.length).toBe(1);
            await page.keyboard.press("Backspace");
            await expect(page.locator("#dialogbox")).toBeHidden();
            await expect(page.locator("#list")).toBeVisible();
            expect(
                await page.evaluate(
                    () =>
                        window.channels[window.listArray[window.selIndex]]
                            .channel_name
                )
            ).toBe("Film 2");
            const cancelled = pendingMetadata.shift();
            await resolved(cancelled.route, cancelled.id);
            expect(
                await page.evaluate(
                    () => window.__ottMedia.current()?.payload.title
                )
            ).toBe("Film 1");
            holdMetadata = false;
            const beforeRetry = metadata.length;
            await page.keyboard.press("Enter");
            await expect.poll(() => metadata.length).toBe(beforeRetry + 1);
            await expect.poll(() => metadata[metadata.length - 1]).toBe(2);
            await page.waitForFunction(
                () =>
                    window.video?.currentTime > 0.2 &&
                    window.__ottMedia.current()?.payload.title === "Film 2" &&
                    window.__ottClassicPlayback.snapshot().phase === "playing"
            );
            await page.keyboard.press("ArrowUp");
            await expect.poll(() => metadata[metadata.length - 1]).toBe(1);
            await page.waitForFunction(
                () =>
                    window.video?.currentTime > 0.2 &&
                    window.__ottMedia.current()?.payload.title === "Film 1" &&
                    window.__ottClassicPlayback.snapshot().phase === "playing"
            );
            await page.keyboard.press("ArrowDown");
            await expect.poll(() => metadata[metadata.length - 1]).toBe(2);
            await page.waitForFunction(
                () =>
                    window.__ottMedia.current()?.payload.title === "Film 2" &&
                    window.__ottClassicPlayback.snapshot().phase === "playing"
            );
            const beforeReload = metadata.length;
            await page.reload();
            await expect.poll(() => first.length).toBe(1);
            await catalog(first.shift(), 1);
            await expect.poll(() => second.length).toBe(1);
            await expect(page.locator("#dialogbox .ott-spinner")).toBeVisible();
            expect(metadata.length).toBe(beforeReload);
            await catalog(second.shift(), 2);
            await page.waitForFunction(
                () =>
                    window.__ottMedia.current()?.payload.title === "Film 2" &&
                    window.__ottClassicPlayback.snapshot().phase === "playing"
            );
            expect(metadata[metadata.length - 1]).toBe(2);
            // A removed saved video leaves an accessible list after boot cleanup,
            // without silently replacing it with the first remaining file.
            const beforeMissing = metadata.length;
            await page.reload();
            await expect.poll(() => first.length).toBe(1);
            await catalog(first.shift(), 1);
            await expect.poll(() => second.length).toBe(1);
            await json(
                second.shift(),
                provider === "plex"
                    ? { Metadata: [], offset: 0, size: 0, totalSize: 0 }
                    : { items: [], type: "videoportal" }
            );
            await expect(page.locator("#list")).toBeVisible();
            await expect(page.locator("#list")).toContainText("Film 1");
            await expect(page.locator("#launch")).toBeHidden();
            await expect(page.locator("#dialogbox")).toContainText(
                "Channel is not available"
            );
            await page.keyboard.press("Enter");
            await expect(page.locator("#dialogbox")).toBeHidden();
            expect(await page.evaluate(() => window.isListVisible)).toBe(true);
            expect(await page.evaluate(() => window.commandChannelsReady)).toBe(
                true
            );
            expect(metadata.length).toBe(beforeMissing);
            expect(errors).toEqual([]);
        });
    }
}

for (const layout of ["/f/pc/", "/f/"]) {
    test(`Local folder uses current and next programme clocks ${layout}`, async ({
        page,
        context,
        baseURL,
    }) => {
        const origin = new URL(baseURL).origin;
        const fragments = [];
        const segment = fs.readFileSync(
            path.resolve(__dirname, "../fixtures/media-runtime/segment00.ts")
        );
        for (let index = 0; index < 30; index++) {
            const mux = new (require("mux.js").mp4.Transmuxer)({
                baseMediaDecodeTime: index * 2 * 90000,
                remux: true,
            });
            mux.on("data", (data) => {
                if (!index) fragments.push(Buffer.from(data.initSegment));
                fragments.push(Buffer.from(data.data));
            });
            mux.push(new Uint8Array(segment));
            mux.flush();
        }
        const movie = Buffer.concat(fragments);
        await context.route("**/*", (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) return route.abort();
            if (url.pathname === "/footer-local/catalog")
                return route.fulfill({
                    json: {
                        items: ["First.mp4", "Next.mp4"].map((name, index) => ({
                            directory: "Cartoons",
                            id: String(index),
                            name,
                            sourceId: "folder",
                            url: origin + `/footer-local/${index}.mp4`,
                        })),
                        sources: [
                            {
                                available: true,
                                id: "folder",
                                kind: "folder",
                                name: "Videos",
                            },
                        ],
                    },
                });
            if (/^\/footer-local\/\d.mp4$/.test(url.pathname))
                return route.fulfill({ body: movie, contentType: "video/mp4" });
            return route.continue();
        });
        await context.routeWebSocket("**/*", (socket) => socket.close());
        await context.addInitScript((origin) => {
            localStorage.setItem("ottplaylang", "_eng");
            localStorage.setItem("ottplayprov", "offline");
            localStorage.setItem(
                "localMediaEndpoint",
                origin + "/footer-local/catalog"
            );
            localStorage.setItem("offlinesPlayers", "0");
            const play = HTMLMediaElement.prototype.play;
            HTMLMediaElement.prototype.play = function () {
                this.muted = true;
                return play.call(this);
            };
        }, origin);
        const openedAt = Date.now() / 1000;
        await page.goto(layout);
        await page.keyboard.press("Shift");
        await page.waitForFunction(() => window.video?.currentTime > 0.2);
        const first = await expectProgramme(
            page,
            {
                collection: "Cartoons",
                nextTitle: "Next.mp4",
                title: "First.mp4",
            },
            openedAt
        );
        await expect
            .poll(() => page.evaluate(() => window.video.currentTime))
            .toBeGreaterThan(1);
        const afterProgress = await expectProgramme(
            page,
            {
                collection: "Cartoons",
                nextTitle: "Next.mp4",
                title: "First.mp4",
            },
            openedAt
        );
        expect(afterProgress.startedAt).toBe(first.startedAt);
        expect(afterProgress.nextStartedAt).toBe(first.nextStartedAt);
    });
}

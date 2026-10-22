"use strict";
// Exercise source ownership with the shipping worker, gzip parser and IndexedDB.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const { chromium } = require("playwright");
const { artifacts } = require("../scripts/hosted-epg.cjs");
const root = path.resolve(__dirname, "..");
const generated = artifacts();
const context = vm.createContext({});
vm.runInContext(
    fs.readFileSync(path.join(root, "vendor/ottplay-core.js"), "utf8"),
    context
);
const core = context.OttPlayCore;
const now = Math.floor(Date.now() / 1000);
const stamp = (offset) =>
    new Date((now + offset) * 1000)
        .toISOString()
        .replace(/[-:T]/g, "")
        .slice(0, 14) + " +0000";
const station = (id, name = "РЕН ТВ HD") => ({ icons: [], id, names: [name] });
const programme = (channel, title, start = -3600, stop = 3600) => ({
    catchupAttribute: "",
    catchupElement: "",
    channel,
    description: "",
    start: stamp(start),
    stop: stamp(stop),
    title,
});
const feed = (id, title, name = "РЕН ТВ HD") => ({
    channels: [station(id, name)],
    programmes: title ? [programme(id, title)] : [],
});
const channel = (id, sources = [0, 1], tvgId = "18", name = "РЕН ТВ HD") => ({
    archiveHours: 48,
    id,
    name,
    sources,
    tvgId,
    tvgName: "",
});
const cases = [
    {
        channels: [channel("ren")],
        expected: { ren: ["Preferred name"] },
        feeds: [feed("other", "Preferred name"), feed("18", "Later ID")],
        name: "source affinity precedes a later exact XMLTV ID",
    },
    {
        channels: [channel("ren")],
        expected: { ren: ["Preferred ID"] },
        feeds: [feed("18", "Preferred ID"), feed("other", "Later name")],
        name: "first source exact ID survives later name matches",
    },
    {
        // Browser name normalization is a different policy. Only source ownership
        // cases with matching normalization use the browser merger as an oracle.
        browserOracle: false,
        channels: [
            {
                ...channel("ren", [0, 1], "missing", "Cinema"),
                tvgName: "News Extra",
            },
        ],
        expected: { ren: ["Preferred fuzzy"] },
        feeds: [
            feed("news", "Preferred fuzzy", "News"),
            feed("cinema", "Later exact", "Cinema"),
        ],
        name: "per-source native fuzzy matching retains source priority",
    },
    {
        channels: [channel("ren")],
        expected: { ren: ["First owner"] },
        feeds: [feed("18", "First owner"), feed("18", "Second owner")],
        name: "duplicate XMLTV IDs belong to the preferred source",
    },
    {
        channels: [
            channel("forward"),
            channel("reverse", [1, 0]),
            channel("only-second", [1]),
        ],
        expected: {
            forward: ["First feed"],
            "only-second": ["Second feed"],
            reverse: ["Second feed"],
        },
        feeds: [feed("18", "First feed"), feed("18", "Second feed")],
        name: "each playlist channel retains its own ordered source affinity",
    },
    {
        channels: [channel("ren")],
        expected: { ren: [] },
        feeds: [
            {
                channels: [station("18")],
                programmes: [
                    programme("18", "Expired", -7 * 86400, -6 * 86400),
                ],
            },
            feed("18", "Later current programme"),
        ],
        name: "expired programmes do not transfer ownership to another source",
    },
    {
        channels: [channel("ren")],
        expected: { ren: [] },
        feeds: [feed("18", ""), feed("18", "Later current programme")],
        name: "metadata-only source retains the same ownership as an expired source",
    },
    {
        channels: [channel("ren")],
        error: "EPG_EMPTY",
        feeds: [feed("18", ""), feed("18", "")],
        name: "all metadata-only sources still report EPG_EMPTY",
    },
];
const escape = (value) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const fixtures = new Map();
for (const [index, scenario] of cases.entries())
    scenario.feeds.forEach((value, source) => {
        const xml =
            '<?xml version="1.0"?><tv>' +
            value.channels
                .map(
                    (row) =>
                        `<channel id="${escape(row.id)}">${row.names.map((name) => `<display-name>${escape(name)}</display-name>`).join("")}</channel>`
                )
                .join("") +
            value.programmes
                .map(
                    (row) =>
                        `<programme channel="${escape(row.channel)}" start="${row.start}" stop="${row.stop}"><title>${escape(row.title)}</title></programme>`
                )
                .join("") +
            "</tv>";
        fixtures.set(`/feed-${index}-${source}.xml.gz`, zlib.gzipSync(xml));
    });
const server = http.createServer((request, response) => {
    const name = new URL(request.url, "http://fixture").pathname;
    if (name === "/") {
        response.end("<!doctype html><title>Hosted source ownership</title>");
        return;
    }
    if (fixtures.has(name)) {
        response.end(fixtures.get(name));
        return;
    }
    let bytes = name.startsWith("/hosted/") && generated[name.slice(8)];
    if (name === "/js/ottplay-core.js")
        bytes = fs.readFileSync(path.join(root, "vendor/ottplay-core.js"));
    if (name === "/js/runtime-polyfills.js")
        bytes = fs.readFileSync(path.join(root, "js/runtime-polyfills.js"));
    if (bytes) {
        response.setHeader("Content-Type", "text/javascript");
        response.end(bytes);
        return;
    }
    response.writeHead(404);
    response.end();
});

(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        const origin = "http://127.0.0.1:" + server.address().port;
        await page.goto(origin);
        const failures = [];
        for (const [index, scenario] of cases.entries()) {
            try {
                const sources = scenario.feeds.map(
                    (_, source) => `${origin}/feed-${index}-${source}.xml.gz`
                );
                const channels = scenario.channels.map((row) => ({
                    ...row,
                    sources: row.sources.map((source) => sources[source]),
                }));
                if (scenario.browserOracle !== false) {
                    const merged = core.mergeBrowserGuides(
                        scenario.feeds.map((value, source) =>
                            core.parseBrowserGuide(
                                value.channels,
                                value.programmes,
                                {},
                                sources[source],
                                sources[source],
                                (value) => value
                            )
                        ),
                        (value) => value
                    );
                    for (const row of channels) {
                        const key = core.matchedGuideChannel(
                            { ...row, epgUrls: row.sources },
                            merged
                        );
                        assert(
                            key,
                            scenario.name +
                                ": browser source has channel metadata"
                        );
                        const titles = Array.from(merged.byChannel[key] || [])
                            .filter(
                                (item) =>
                                    item.end > now - row.archiveHours * 3600 &&
                                    item.start < now + 48 * 3600
                            )
                            .map((item) => item.title);
                        assert.deepEqual(
                            titles,
                            scenario.expected ? scenario.expected[row.id] : [],
                            scenario.name + ": browser oracle"
                        );
                    }
                }
                const result = await page.evaluate(
                    ({ channels, sources }) =>
                        new Promise((resolve, reject) => {
                            const worker = new Worker("/hosted/epg-worker.js");
                            const received = {};
                            let ready;
                            const timeout = setTimeout(() => {
                                worker.terminate();
                                reject(
                                    new Error("Hosted source worker timed out")
                                );
                            }, 15000);
                            const finish = (value) => {
                                clearTimeout(timeout);
                                worker.terminate();
                                resolve(value);
                            };
                            worker.onerror = (event) =>
                                finish({ error: event.message });
                            worker.onmessage = ({ data }) => {
                                if (data.type === "error")
                                    finish({ error: data.code });
                                if (data.type === "ready") {
                                    ready = data;
                                    channels.forEach((row) =>
                                        worker.postMessage({
                                            id: row.id,
                                            query: row.id,
                                            type: "guide",
                                        })
                                    );
                                }
                                if (data.type === "guide") {
                                    received[data.query] =
                                        data.rows &&
                                        data.rows.map((row) => row.name);
                                    if (
                                        Object.keys(received).length ===
                                        channels.length
                                    )
                                        finish({ guides: received, ready });
                                }
                            };
                            worker.postMessage({
                                channels,
                                refreshMs: 7200000,
                                sources,
                                type: "load",
                            });
                        }),
                    { channels, sources }
                );
                if (scenario.error)
                    assert.equal(result.error, scenario.error, scenario.name);
                else {
                    assert.equal(result.error, undefined, scenario.name);
                    assert.deepEqual(
                        result.guides,
                        scenario.expected,
                        scenario.name
                    );
                    assert.equal(
                        Object.keys(result.ready.mappings).length,
                        channels.length,
                        scenario.name
                    );
                }
                console.log("PASS hosted XMLTV sources: " + scenario.name);
            } catch (error) {
                failures.push(error);
                console.error(error.message);
            }
        }
        assert.equal(
            failures.length,
            0,
            "Hosted XMLTV source scenarios failed: " + failures.length
        );
    } finally {
        if (browser) await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

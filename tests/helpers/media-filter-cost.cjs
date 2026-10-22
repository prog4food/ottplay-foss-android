// Deterministic deep-copy counts for the actual media runtime. Timings are
// diagnostic only: assertions should use copied object/property counts.
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const vm = require("node:vm");
const ts = require("typescript");
const { fixture } = require("../test_port_vod.cjs");

const root = path.resolve(__dirname, "../..");

function instrumentMedia(host, transform = (source) => source) {
    const cost = { objects: 0, properties: 0 };
    host.__mediaCopyCost = cost;
    for (const file of ["library", "classic-adapter"]) {
        let source = transform(
            fs.readFileSync(
                path.join(root, "src/media/" + file + ".ts"),
                "utf8"
            ),
            file
        );
        if (file === "library") {
            const anchor = "var parents = seen || [];";
            if (!source.includes(anchor))
                throw new Error("Missing copy instrumentation anchor");
            source = source.replace(
                anchor,
                "(window as any).__mediaCopyCost.objects++;" +
                    "(window as any).__mediaCopyCost.properties += Object.keys(value).length;" +
                    anchor
            );
        }
        vm.runInContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    module: ts.ModuleKind.None,
                    target: ts.ScriptTarget.ES5,
                },
            }).outputText,
            host
        );
    }
    return cost;
}

function mediaFilterCost({
    rows = 300,
    depth = 6,
    samples = 5,
    transform,
} = {}) {
    const host = fixture();
    const cost = instrumentMedia(host, transform);
    for (let page = 0; page < depth + 1; page++) {
        host.catalogs["page" + page] = Array.from(
            { length: rows },
            (_, index) => ({
                description:
                    "A fixture synopsis, detached from provider and UI state. ".repeat(
                        3
                    ),
                id: page * rows + index,
                metadata: { credits: [{ name: "Director" }], year: 2026 },
                request: { cmd: "play", id: page * rows + index },
                stream_url: "https://media.invalid/" + index + ".m3u8",
                title: (index % 10 ? "Other movie " : "Три кота ") + index,
            })
        );
        host.catalogs["page" + page].push({
            playlist_url: "page" + (page + 1),
            title: "Next",
        });
    }
    for (let page = 0; page < depth; page++)
        host.__ottMedia.open("page" + page, "Page " + page);
    function measure(run) {
        const times = [];
        let copied;
        for (let index = 0; index < samples; index++) {
            cost.objects = cost.properties = 0;
            const start = performance.now();
            run();
            times.push(performance.now() - start);
            if (!index) copied = { ...cost };
        }
        times.sort((a, b) => a - b);
        return {
            ...copied,
            medianMs: Number(times[Math.floor(times.length / 2)].toFixed(2)),
        };
    }
    function apply(query) {
        host.__ottMedia.filter();
        host.editvar = query;
        host.setEdit();
    }
    const result = {
        depth,
        filterApplyAndClear: measure(() => {
            apply("три кот");
            apply("");
        }),
        filterOpen: measure(() => host.__ottMedia.filter()),
        nextAndBack: measure(() => {
            host.__ottMedia.open("page" + depth, "Page " + depth);
            host.__ottMedia.back();
        }),
        rows,
        show: measure(() => host.__ottMedia.show()),
    };
    // Public snapshots and both mutable compatibility projections must retain
    // independent payloads even when a candidate reduces internal view copying.
    const snapshot = host.__ottMedia.snapshot();
    const expected = snapshot.frame.items[0].title;
    snapshot.frame.items[0].payload.metadata.credits[0].name =
        "poisoned snapshot";
    if (host.listArray[0].metadata.credits[0].name !== "Director")
        throw new Error("Public snapshot shared the rendered payload");
    host.listArray[0].title = "poisoned UI";
    if (host.mediaRecords[0].title !== expected)
        throw new Error("UI projection shared the provider payload");
    host.mediaRecords[0].metadata.credits[0].name = "poisoned provider";
    if (host.listArray[0].metadata.credits[0].name !== "Director")
        throw new Error("Provider projection shared nested UI metadata");
    host.__ottMedia.show();
    if (
        host.listArray[0].title !== expected ||
        host.listArray[0].metadata.credits[0].name !== "Director"
    )
        throw new Error("Candidate leaked owned catalog state");
    const all = host.__ottMedia.snapshot();
    if (
        all.frames.length !== depth ||
        all.frames.some((frame) => frame.items.length < rows)
    )
        throw new Error("Public snapshot omitted ancestor catalog items");
    return result;
}

module.exports = { instrumentMedia, mediaFilterCost };

if (require.main === module)
    for (const [rows, depth] of [
        [300, 1],
        [300, 6],
        [1000, 6],
        [1000, 12],
    ])
        console.log(JSON.stringify(mediaFilterCost({ depth, rows })));

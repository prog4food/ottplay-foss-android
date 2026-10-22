#!/usr/bin/env node
// Record a real local UI scenario in a disposable, network-isolated profile.
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const scenario = require("./demo-scenario.cjs");
const root = path.resolve(__dirname, "..");

async function main() {
    const { values } = parseArgs({ options: { output: { type: "string" } } });
    const output = path.resolve(
        values.output ||
            path.join(
                root,
                ".local-artifacts",
                "demo-video",
                new Date().toISOString().replace(/[:.]/g, "-")
            )
    );
    if (fs.existsSync(output))
        throw new Error(
            "Output directory already exists; choose a new recording directory."
        );
    const chromium = scenario.chromium();
    await scenario.preflight(root);
    fs.mkdirSync(output, { mode: 0o700, recursive: true });
    const browser = await chromium.launch({
        args: [
            "--enable-webgl",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
        ],
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
        headless: true,
    });
    const checkpoints = [],
        errors = [];
    let context;
    try {
        context = await browser.newContext({
            recordVideo: { dir: output, size: { height: 720, width: 1280 } },
            serviceWorkers: "block",
            viewport: { height: 720, width: 1280 },
        });
        await context.route("**/*", (route) => scenario.route(route, root));
        await context.routeWebSocket("**/*", (socket) => socket.close());
        const page = await context.newPage();
        page.setDefaultTimeout(60000);
        page.on("pageerror", (error) => errors.push(error.message));
        const video = page.video();
        const started = Date.now();
        const checkpoint = async (label) => {
            const image = `${String(checkpoints.length + 1).padStart(2, "0")}-${label}.png`;
            await page.screenshot({
                path: path.join(output, image),
                timeout: 180000,
            });
            checkpoints.push({
                image,
                label,
                seconds: (Date.now() - started) / 1000,
            });
            // Intentional reading time in the recorded demo, not a readiness wait.
            await page.waitForTimeout(1400);
        };
        await scenario.run(page, checkpoint);
        if (errors.length)
            throw new Error("Browser errors: " + errors.join("; "));
        await context.close();
        context = null;
        const recording = path.join(output, "screen.webm");
        await video.saveAs(recording);
        await video.delete();
        fs.writeFileSync(
            path.join(output, "recording.json"),
            JSON.stringify(
                {
                    audio: false,
                    checkpoints,
                    errors,
                    network: "local fixtures only; all WebSockets blocked",
                    private_geometry: scenario.privateGeometry,
                    resolution: "1280x720",
                    scenario: scenario.name,
                    source: "screen.webm",
                    version: 1,
                },
                null,
                2
            ) + "\n"
        );
        console.log(recording);
    } finally {
        if (context) await context.close();
        await browser.close();
    }
}
main().catch((error) => {
    console.error("Demo recording: " + error.message);
    process.exitCode = 1;
});

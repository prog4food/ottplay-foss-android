/* Bootstrap the shipped vendor artifact in the fixture's own JavaScript realm. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const filename = path.resolve(__dirname, "../../vendor/ottplay-core.js");
const script = new vm.Script(fs.readFileSync(filename, "utf8"), { filename });
module.exports = function sharedCoreRuntime(context, options = {}) {
    assert(
        vm.isContext(context),
        "Pass the actual context used by the host fixture"
    );
    const saved = {};
    // The browser artifact must use its browser export even in a CommonJS test.
    for (const key of ["exports", "module", "define"]) {
        saved[key] = Object.getOwnPropertyDescriptor(context, key);
        Object.defineProperty(context, key, {
            configurable: true,
            value: undefined,
            writable: true,
        });
    }
    try {
        script.runInContext(context);
    } finally {
        for (const key of Object.keys(saved)) {
            if (saved[key]) Object.defineProperty(context, key, saved[key]);
            else delete context[key];
        }
    }
    const core = context["play.ott:ottplay-shared-core"];
    assert(core, "Vendor browser export is present");
    (context.window || context).OttPlayCore = core;
    // Artifact tests must prove that the bundle supplies its private modules.
    // Source-extraction fixtures keep their existing real-source bootstrap.
    if (options.vendorOnly) return core;
    const privateRuntime = require("./private-runtime.cjs");
    if (!context.window) context.window = context;
    require("./pin-runtime.cjs")(context);
    for (const file of [
        "src/settings/library-backup.ts",
        "src/provider/source-identity.ts",
        "src/access/session.ts",
        "src/access/classic-adapter.ts",
        "src/channels/channel-references.ts",
        "src/channels/library.ts",
        "src/channels/classic-library.ts",
        "src/channels/classic-search.ts",
        "src/ui/screen-controller.ts",
        "src/ui/input-router.ts",
        "src/ui/classic-screen-port.ts",
        "src/ui/menu-registry.ts",
        "src/device/adapter.ts",
        "src/device/media-backend.ts",
        "src/device/media-session.ts",
        "src/device/native-pip.ts",
        "src/playback/session.ts",
        "src/playback/journal.ts",
        "src/playback/classic-adapter.ts",
        "src/playback/archive.ts",
        "src/playback/classic-archive.ts",
        "src/media/library.ts",
        "src/media/journal.ts",
        "src/media/classic-adapter.ts",
        "src/provider/runtime.ts",
        "src/provider/driver-profiles.ts",
        "src/provider/channel-catalog.ts",
        "src/provider/stalker-driver.ts",
        "src/provider/catalog-drivers.ts",
        "src/provider/catalog-xml.ts",
        "src/provider/media-catalog.ts",
        "src/provider/playlist-drivers.ts",
        "src/provider/edem-driver.ts",
        "src/provider/m3u-settings.ts",
        "src/provider/m3u-driver.ts",
        "src/provider/drivers.ts",
        "src/provider/xtream-media.ts",
    ])
        privateRuntime(context, file);
    return core;
};

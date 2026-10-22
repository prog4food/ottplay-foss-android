// Launch only the installed LG Simulator; no webOS CLI dependency is required.
// LG CLI 3.2.6 lib/launch.js documents the app-directory/JSON argument contract.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function launchCommand({ version, sdk, app }, platform = process.platform) {
    if (!/^[1-9][0-9]*$/.test(version))
        throw new Error("webOS version must be a positive integer");
    const extensions = {
        darwin: [".app"],
        linux: [".appimage", ".AppImage"],
        win32: [".exe"],
    }[platform];
    if (!extensions)
        throw new Error("Unsupported Simulator platform: " + platform);
    const directory = path.resolve(sdk);
    const appDirectory = path.resolve(app);
    if (!fs.statSync(appDirectory).isDirectory())
        throw new Error("Simulator app must be a directory");
    if (!fs.statSync(path.join(appDirectory, "appinfo.json")).isFile())
        throw new Error("Simulator app must contain appinfo.json");
    const prefix = `webOS_TV_${version}_Simulator_`;
    const candidates = [];
    for (const name of fs.readdirSync(directory)) {
        const extension = extensions.find((suffix) => name.endsWith(suffix));
        if (!extension || !name.startsWith(prefix)) continue;
        const release = name.slice(prefix.length, -extension.length);
        if (
            !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(release)
        )
            continue;
        const file = path.join(directory, name);
        const executable =
            platform === "darwin"
                ? path.join(
                      file,
                      "Contents/MacOS",
                      name.slice(0, -extension.length)
                  )
                : file;
        try {
            if (!fs.statSync(executable).isFile()) continue;
            fs.accessSync(executable, fs.constants.X_OK);
        } catch (_) {
            continue;
        }
        candidates.push({ file, release: release.split(".").map(BigInt) });
    }
    candidates.sort((a, b) => {
        for (let index = 0; index < 3; index++) {
            if (a.release[index] !== b.release[index])
                return a.release[index] > b.release[index] ? -1 : 1;
        }
        return a.file.localeCompare(b.file);
    });
    if (!candidates.length)
        throw new Error(
            `No executable webOS ${version} Simulator found in ${directory}`
        );
    const simulator = candidates[0].file;
    return platform === "darwin"
        ? {
              args: [simulator, "--args", appDirectory, "{}"],
              file: "/usr/bin/open",
          }
        : { args: [appDirectory, "{}"], file: simulator };
}

function launch(options, platform) {
    const command = launchCommand(options, platform);
    const result = spawnSync(command.file, command.args, {
        shell: false,
        stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.signal)
        throw new Error("Simulator terminated by " + result.signal);
    return result.status;
}

if (require.main === module) {
    try {
        const [version, sdk, app, ...extra] = process.argv.slice(2);
        if (!version || !sdk || !app || extra.length)
            throw new Error(
                "Usage: launch-webos-simulator.cjs VERSION SDK APP"
            );
        process.exitCode = launch({ app, sdk, version });
    } catch (error) {
        console.error("Error: " + error.message);
        process.exitCode = 1;
    }
}

module.exports = { launch, launchCommand };

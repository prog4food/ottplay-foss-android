const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const repositoryRoot = path.resolve(__dirname, "..");
const packageManifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")
);
const npmLock = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8")
);
const rustUpdater = fs
    .readFileSync(path.join(repositoryRoot, "Cargo.lock"), "utf8")
    .match(
        /\[\[package\]\]\s+name = "tauri-plugin-updater"\s+version = "([^"]+)"/
    );
assert(rustUpdater, "Cargo.lock must contain the desktop updater plugin");
const updaterPackage = "@tauri-apps/plugin-updater";
const npmUpdater = npmLock.packages[`node_modules/${updaterPackage}`].version;
assert.equal(packageManifest.dependencies[updaterPackage], npmUpdater);
assert.equal(npmLock.packages[""].dependencies[updaterPackage], npmUpdater);
assert.equal(
    npmUpdater.split(".").slice(0, 2).join("."),
    rustUpdater[1].split(".").slice(0, 2).join("."),
    `Tauri updater major/minor must match for desktop builds: npm ${npmUpdater}, Rust ${rustUpdater[1]}`
);
console.log("Tauri updater npm/Rust release versions match");
const ts = require(require.resolve("typescript", { paths: [process.cwd()] }));
const standbyContext = { exports: {}, Promise };
vm.runInNewContext(
    ts.transpileModule(
        fs.readFileSync(
            path.join(repositoryRoot, "src/core/standby.ts"),
            "utf8"
        ),
        { compilerOptions: { module: ts.ModuleKind.CommonJS } }
    ).outputText,
    standbyContext
);
const source = fs.readFileSync(
    process.argv[2] || path.join(__dirname, "../src/index.ts"),
    "utf8"
);
const marker = "// Mode B only: Tauri updater check";
assert(source.includes(marker));
const code = ts.transpileModule(source.slice(source.indexOf(marker)), {
    compilerOptions: {
        module: ts.ModuleKind.ES2015,
        target: ts.ScriptTarget.ES2020,
    },
}).outputText;
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(options = {}) {
    const calls = [],
        confirmations = [],
        notices = [],
        errors = [];
    const window = {
        alert: () => {
            throw new Error("Native alert must not be used");
        },
        clearInterval,
        clearTimeout,
        confirm: () => {
            throw new Error("Native confirm must not be used");
        },
        setTimeout,
    };
    const standby = standbyContext.exports.installStandby(
        window,
        () => "0",
        () => {}
    );
    if (!options.browser)
        window.__TAURI__ = { core: { Channel: class Channel {} } };
    if (options.noChannel) delete window.__TAURI__.core.Channel;
    if (options.relaunch)
        window.__TAURI__.process = { relaunch: options.relaunch };
    const context = {
        _: (key, ...values) => {
            let text = options.translations?.[key] || key;
            values.forEach((value, index) => {
                text = text.replace(new RegExp("%" + (index + 1), "g"), value);
            });
            return text;
        },
        confirmBox: (message, yes, no) =>
            confirmations.push({ message, no, yes }),
        console: { debug: (...args) => errors.push(args) },
        infoBox: (message) => notices.push(message),
        tauriInvoke: async (command, args) => {
            calls.push({ args, command });
            if (command === "plugin:updater|check")
                return (
                    options.checkPromise ||
                    (options.noUpdate ? null : { rid: 42, version: "1.1.41" })
                );
            if (options.installFails) throw new Error("Download failed");
            return options.installPromise;
        },
        window,
    };
    vm.createContext(context);
    vm.runInContext(code, context);
    assert.equal(
        calls.length,
        0,
        "Updater must wait for the selected language to load"
    );
    const start = () => context.checkTauriUpdatesAfterLanguage();
    if (!options.deferLanguage) start();
    return { calls, confirmations, errors, notices, standby, start };
}
(async () => {
    const delayedOptions = { deferLanguage: true };
    const delayed = fixture(delayedOptions);
    await settle();
    assert.equal(
        delayed.confirmations.length,
        0,
        "No English prompt while the selected catalog is loading"
    );
    delayedOptions.translations = {
        "OttPlay FOSS %1 is available. Download and install now?":
            "Доступна версия %1. Установить?",
    };
    delayed.start();
    await settle();
    assert.equal(
        delayed.confirmations[0].message,
        "Доступна версия 1.1.41. Установить?"
    );
    delayed.start();
    assert.equal(
        delayed.calls.length,
        1,
        "Changing language cannot repeat the startup update check"
    );
    const pending = fixture();
    await settle();
    assert.equal(
        pending.calls.length,
        1,
        "Installation must wait for explicit confirmation"
    );
    assert.equal(pending.confirmations.length, 1);
    assert.equal(
        pending.confirmations[0].message,
        "OttPlay FOSS 1.1.41 is available. Download and install now?"
    );
    pending.confirmations[0].no();
    await settle();
    assert.equal(pending.calls.length, 1, "Cancellation must not install");
    const accepted = fixture();
    await settle();
    accepted.confirmations[0].yes();
    await settle();
    assert.equal(
        accepted.calls[1].command,
        "plugin:updater|download_and_install"
    );
    assert.equal(accepted.calls[1].args.rid, 42);
    assert.equal(typeof accepted.calls[1].args.onEvent, "object");
    assert.deepEqual(accepted.notices, [
        "Update installed. Please restart OttPlay FOSS.",
    ]);
    let restarted = 0;
    const restart = fixture({
        relaunch: async () => {
            restarted++;
        },
    });
    await settle();
    restart.confirmations[0].yes();
    await settle();
    assert.equal(restarted, 1);
    assert.equal(restart.notices.length, 0);
    const restartFailure = fixture({
        relaunch: async () => {
            throw new Error("Unavailable");
        },
    });
    await settle();
    restartFailure.confirmations[0].yes();
    await settle();
    assert.equal(restartFailure.notices.length, 1);
    for (const option of [{ installFails: true }, { noChannel: true }]) {
        const failed = fixture(option);
        await settle();
        failed.confirmations[0].yes();
        await settle();
        assert.equal(
            failed.notices.length,
            0,
            "Never report a failed installation as installed"
        );
        assert.equal(failed.errors.length, 1);
    }
    const noUpdate = fixture({ noUpdate: true });
    await settle();
    assert.equal(noUpdate.confirmations.length, 0);
    const browser = fixture({ browser: true });
    await settle();
    assert.equal(browser.calls.length, 0);
    const localized = fixture({
        translations: {
            "OttPlay FOSS %1 is available. Download and install now?":
                "Доступна версия %1. Установить?",
            "Update installed. Please restart OttPlay FOSS.":
                "Обновление установлено. Перезапустите OttPlay FOSS.",
        },
    });
    await settle();
    assert.equal(
        localized.confirmations[0].message,
        "Доступна версия 1.1.41. Установить?"
    );
    localized.confirmations[0].yes();
    await settle();
    assert.deepEqual(localized.notices, [
        "Обновление установлено. Перезапустите OttPlay FOSS.",
    ]);
    const blocked = fixture({ deferLanguage: true });
    blocked.standby.set(true);
    blocked.start();
    await settle();
    assert.equal(
        blocked.calls.length,
        0,
        "Standby prevents new native update checks"
    );
    let completeCheck;
    const checking = fixture({
        checkPromise: new Promise((resolve) => {
            completeCheck = resolve;
        }),
    });
    checking.standby.set(true);
    assert.equal(checking.standby.snapshot().pending, 1);
    assert.equal(checking.standby.snapshot().state, "suspending");
    completeCheck({ rid: 42, version: "1.1.41" });
    await settle();
    assert.equal(checking.standby.snapshot().pending, 0);
    assert.equal(
        checking.confirmations.length,
        0,
        "Late native check cannot open a prompt"
    );
    let rejectCheck;
    const timedCheck = fixture({
        checkPromise: new Promise((_, reject) => {
            rejectCheck = reject;
        }),
    });
    assert.equal(timedCheck.calls.length, 1);
    assert.equal(timedCheck.calls[0].command, "plugin:updater|check");
    assert.equal(
        timedCheck.calls[0].args.timeout,
        10000,
        "The native updater must bound its metadata request, not only a JS waiter"
    );
    timedCheck.standby.set(true);
    await settle();
    assert.equal(
        timedCheck.standby.snapshot().pending,
        1,
        "Standby must retain the request until native settlement"
    );
    assert.equal(timedCheck.standby.snapshot().state, "suspending");
    rejectCheck(new Error("Native updater request timed out"));
    await settle();
    assert.equal(timedCheck.standby.snapshot().pending, 0);
    assert.equal(timedCheck.standby.snapshot().state, "suspended");
    assert.equal(timedCheck.errors.length, 1);
    assert.equal(timedCheck.confirmations.length, 0);
    assert.equal(timedCheck.notices.length, 0);
    assert.equal(
        timedCheck.calls.length,
        1,
        "A failed metadata check is not retried or converted to an installation"
    );
    const lateConsent = fixture();
    await settle();
    lateConsent.standby.set(true);
    lateConsent.confirmations[0].yes();
    await settle();
    assert.equal(
        lateConsent.calls.length,
        1,
        "Old confirmation cannot start a download"
    );
    let completeInstall;
    const installing = fixture({
        installPromise: new Promise((resolve) => {
            completeInstall = resolve;
        }),
        relaunch: async () => {
            throw new Error("Must not relaunch");
        },
    });
    await settle();
    installing.confirmations[0].yes();
    await settle();
    installing.standby.set(true);
    assert.equal(installing.standby.snapshot().pending, 1);
    assert.equal(installing.standby.snapshot().state, "suspending");
    completeInstall();
    await settle();
    assert.equal(installing.standby.snapshot().state, "suspended");
    assert.equal(installing.notices.length, 0);
    assert.equal(
        installing.errors.length,
        0,
        "Late download cannot trigger relaunch"
    );
    console.log("Tauri updater DOM dialog contracts passed (14 scenarios)");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

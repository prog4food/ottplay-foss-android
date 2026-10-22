const { settingsSource } = require("./helpers/settings-source-fixture.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { compatibilitySource } = require("./helpers/english-source-fixture.cjs");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "..");
function extract(file, names, assignments = []) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const source = ast.statements
        .filter(
            (node) =>
                (ts.isFunctionDeclaration(node) &&
                    names.includes(node.name?.text)) ||
                (ts.isExpressionStatement(node) &&
                    ts.isBinaryExpression(node.expression) &&
                    assignments.includes(node.expression.left.getText(ast)))
        )
        .map((node) => node.getText(ast))
        .join("\n");
    return ts
        .transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES2018,
            },
        })
        .outputText.replace(/^export /gm, "");
}
// Only checked-in scripts run. Network/resources and device APIs are not enabled.
const dom = new JSDOM(
    '<div id="listCaption">Settings</div><div id="listDetail">Parent detail</div><div id="listPodval">Parent footer</div><div id="listEdit" style="display:none"></div><div id="listAbout" style="display:none;height:321px"></div>',
    { runScripts: "dangerously", url: "https://example.invalid/" }
);
const w = dom.window;
require("./helpers/shared-core-runtime.cjs")(dom.getInternalVMContext());
Object.assign(w, require("./load-wire.cjs")());
w.eval(compatibilitySource);
w.eval(fs.readFileSync(path.join(root, "js/jquery-1.11.1.min.js"), "utf8"));
const stored = new Map();
let diagnosticSession;
let diagnosticListener = null;
let screenshotEnabled = false;
let screenshotConnected = false;
let screenshotBrowser = true;
let screenshotListener = null;
const screenshotChanges = [];
Object.assign(w, {
    _: (text) => text,
    __ottRemoteDiagnostics: {
        setEnabled: () =>
            assert.fail("Connection authorization needs no diagnostic toggle"),
        setTrusted: () =>
            assert.fail("Connection authorization needs no trust toggle"),
        status: () => ({
            enabled: true,
            message: "Remote diagnostics is ready for an authorized operator.",
            sessionId: diagnosticSession,
            state: "ready",
            trusted: true,
        }),
        stopSession: () => {
            diagnosticSession = undefined;
            if (diagnosticListener) diagnosticListener();
        },
        subscribe: (listener) => {
            diagnosticListener = listener;
        },
    },
    __ottRemoteScreenshot: {
        selectSource: (local) => {
            assert.equal(local, true);
            screenshotEnabled = true;
            screenshotChanges.push(true);
            if (screenshotListener) screenshotListener();
        },
        status: () => ({
            browserSelectionSupported: screenshotBrowser,
            connected: screenshotConnected,
            enabled: screenshotEnabled,
            message: screenshotEnabled
                ? "The browser screenshot source is ready."
                : "Select the player tab or window in the browser sharing dialog.",
            needsSourceSelection: screenshotConnected && !screenshotEnabled,
            pending: false,
            state: screenshotEnabled ? "ready" : "permission_required",
        }),
        stop: () => {
            screenshotEnabled = false;
            screenshotChanges.push(false);
            if (screenshotListener) screenshotListener();
        },
        subscribe: (listener) => {
            screenshotListener = listener;
        },
    },
    deviceUUID: "<script>window.injected=true</script>" + "uid".repeat(100),
    keys: { DOWN: 40, ENTER: 13, EXIT: 8, N2: 50, RETURN: 27, UP: 38 },
    listCaptionElement: w.document.getElementById("listCaption"),
    listDetailElement: w.document.getElementById("listDetail"),
    listFooterElement: w.document.getElementById("listPodval"),
    sLocalCmdUrl:
        "https://example.invalid/" +
        "long".repeat(100) +
        '<img src=x onerror="window.injected=true">',
    sSwopBaseUrl: "https://example.invalid/swop",
    stbSetItem: (key, value) => stored.set(key, value),
    ui_state: {},
});
const initialSettings = {
    sLocalCmdUrl: w.sLocalCmdUrl,
    sSwopBaseUrl: w.sSwopBaseUrl,
};
w.storage = {
    del: (key) => stored.delete(key),
    get: (key) => stored.get(key) ?? null,
    set: (key, value) => stored.set(key, String(value)),
    setI: (key, value) => stored.set(key, String(value)),
};
w.eval(settingsSource());
Object.assign(w, initialSettings);
w.eval(
    extract("src/utils/helpers.ts", [
        "metadataText",
        "metadataImageUrl",
        "metadataCssUrl",
        "metadataHtml",
        "hasTmdbService",
    ])
);
w.eval(
    extract("src/ui/index.ts", [
        "saveListPanelState",
        "restoreListPanelState",
        "renderButtonHint",
        "showEditKey2",
        "editKey2",
    ])
);
w.eval(
    extract("src/plugins/command-server.ts", ["normalizeCommandServerAddress"])
);
w.eval(
    extract(
        "src/index.ts",
        ["pullSettingsFromWindow"],
        ["window.settingsCommands"]
    )
);
w.eval(
    extract("src/settings/transfer-ui.ts", [
        "editSettingsText",
        "importSettingsUI",
    ]) + "\nwindow.importSettingsUI = importSettingsUI;"
);
let saves = 0;
const originalSave = w.saveListPanelState;
w.saveListPanelState = () => {
    saves++;
    originalSave();
};
let restored;
w.optionsList = () => {
    restored = [
        w.listCaptionElement.innerHTML,
        w.listDetailElement.innerHTML,
        w.listFooterElement.innerHTML,
    ];
};
w._doKey = (key) =>
    w.document.getElementById("listEdit").style.display !== "none"
        ? w.editKey2(key)
        : w.aboutKeyHandler(key);
const prompts = [];
let response = null;
w.prompt = (message, initial) => {
    prompts.push({ initial, message });
    return response;
};
w.settingsCommands();
assert.equal(w.listCaptionElement.textContent, "Remote control");
assert.equal(w.listDetailElement.textContent, "");
assert.equal(saves, 0);
const content = w.document.getElementById("remoteSettingsContent");
assert.equal(content.style.height, "100%");
assert.equal(content.style.overflowY, "auto");
assert.equal(content.style.overflowWrap, "anywhere");
assert.equal(
    content.querySelector("img,script"),
    null,
    "UID and URLs remain literal text"
);
assert.equal(w.injected, undefined);
assert.ok(content.textContent.includes(w.deviceUUID));
Object.defineProperty(content, "clientHeight", { value: 200 });
assert.equal(w.aboutKeyHandler(w.keys.DOWN), true);
assert.equal(content.scrollTop, 100);
w.aboutKeyHandler(w.keys.UP);
assert.equal(content.scrollTop, 0);
let controls = w.listFooterElement.querySelectorAll("span[data-ott-key]");
assert.equal(
    controls.length,
    4,
    "existing footer actions fit one row; server shortcuts stay on their visible buttons"
);
function editor() {
    return w.document.getElementById("editvar");
}
function submit(value) {
    editor().value = value;
    editor().dispatchEvent(
        new w.KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
    );
}
const initial = w.sLocalCmdUrl;
controls[1].click();
assert.equal(
    w.document.getElementById("listAbout").style.display,
    "none",
    "about overlay cannot intercept editor keys"
);
assert.equal(editor().value, initial);
assert.ok(
    w.listCaptionElement.textContent.includes(
        "empty disables local command polling"
    )
);
submit("  https://example.invalid/local?x=&amp;<literal>  ");
assert.equal(w.sLocalCmdUrl, "https://example.invalid/local?x=&amp;<literal>");
assert.equal(stored.get("sLocalCmdUrl"), w.sLocalCmdUrl);
assert.equal(w.settings.localCmdUrl, w.sLocalCmdUrl);
assert.equal(w.document.getElementById("listEdit").style.display, "none");
assert.equal(w.listCaptionElement.textContent, "Remote control");
assert.ok(w.listFooterElement.textContent.includes("↑↓ Scroll"));
controls = w.listFooterElement.querySelectorAll("span[data-ott-key]");
controls[2].click();
submit(" https://example.invalid/new-swop/// ");
assert.equal(w.sSwopBaseUrl, "https://example.invalid/new-swop");
assert.equal(stored.get("sLocalCmdUrl"), w.sLocalCmdUrl);
assert.equal(stored.get("sSwopBaseUrl"), w.sSwopBaseUrl);
w.listFooterElement.querySelectorAll("span[data-ott-key]")[1].click();
assert.equal(
    editor().value,
    w.sLocalCmdUrl,
    "subsequent edit uses literal current URL"
);
editor().value = "discard this";
editor().dispatchEvent(
    new w.KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
);
assert.equal(w.sLocalCmdUrl, "https://example.invalid/local?x=&amp;<literal>");
w.aboutKeyHandler(w.keys.ENTER);
submit("   ");
assert.equal(stored.get("sLocalCmdUrl"), "", "empty URL disables polling");
w.aboutKeyHandler(w.keys.N2);
submit("   ");
assert.equal(
    stored.get("sSwopBaseUrl"),
    "",
    "empty URL disables remote text entry"
);
assert.equal(
    saves,
    5,
    "only nested editor visits use the single-level CPD buffer"
);
assert.equal(
    prompts.length,
    0,
    "shared editor does not rely on native prompt support"
);
w.listFooterElement.querySelector("span[data-ott-key]").click();
assert.deepEqual(restored, ["Settings", "Parent detail", "Parent footer"]);
assert.equal(w.document.getElementById("listAbout").style.display, "none");
assert.equal(w.document.getElementById("remoteSettingsContent"), null);
assert.equal(w.aboutKeyHandler(999), false);
w.settingsCommands();
w.aboutKeyHandler(w.keys.EXIT);
assert.deepEqual(restored, ["Settings", "Parent detail", "Parent footer"]);
// Outbound controls are separate from the inbound listener and never expose the saved code.
let serverListener = null;
let serverState = { enabled: false, message: "Disconnected" };
const serverChanges = [];
w.__ottCommandServer = {
    configure(config) {
        serverChanges.push({ ...config });
        w.settings.commandServerAddress = config.address.trim();
        w.settings.commandServerToken = config.token.trim();
        w.settings.commandServerEnabled = config.enabled ? 1 : 0;
        serverState = {
            enabled: config.enabled,
            message: config.enabled ? "Connecting..." : "Disconnected",
        };
        if (serverListener) serverListener();
    },
    status() {
        return serverState;
    },
    subscribe(listener) {
        serverListener = listener;
    },
};
w.settings.commandServerAddress = "";
w.settings.commandServerToken = "";
w.settingsCommands();
w.document.getElementById("commandServerAddress").click();
submit(" 192.168.1.20:8081 ");
assert.equal(w.settings.commandServerAddress, "192.168.1.20:8081");
assert.equal(
    serverChanges.at(-1).enabled,
    false,
    "an address without an access code does not connect"
);
w.aboutKeyHandler(52);
assert.equal(editor().type, "password", "access code editor must be masked");
const serverSecret = "s".repeat(64);
submit(serverSecret);
assert.equal(w.settings.commandServerToken, serverSecret);
assert.ok(
    !w.document.getElementById("listAbout").textContent.includes(serverSecret)
);
assert.equal(
    serverChanges.at(-1).enabled,
    true,
    "saving the second required field connects without an extra action"
);
assert.equal(
    w.document.getElementById("commandServerStatus").textContent,
    "Connecting..."
);
serverState = { enabled: true, message: "Connected" };
serverListener();
assert.equal(
    w.document.getElementById("commandServerStatus").textContent,
    "Connected"
);
w.aboutKeyHandler(53);
assert.equal(serverChanges.at(-1).enabled, false);
w.aboutKeyHandler(w.keys.RETURN);
assert.equal(
    serverListener,
    null,
    "closed settings unsubscribe status updates"
);

// A remote without digits or a pointer can configure the new server with
// directional keys and OK. Exercise actual DOM key events and selected controls.
w.sNoNumbersKeys = 1;
w.keys.LEFT = 37;
w.keys.RIGHT = 39;
let discoveryListener = null;
let discoveryState = { code: "", message: "Idle", servers: [], state: "idle" };
const discoveries = [];
let canceledDiscoveries = 0;
w.__ottControlDiscovery = {
    cancel() {
        canceledDiscoveries++;
        discoveryState = {
            code: "",
            message: "Canceled",
            servers: [],
            state: "canceled",
        };
        if (discoveryListener) discoveryListener();
    },
    start(explicit) {
        discoveries.push(explicit);
        discoveryState = {
            code: "ABC12345",
            message: "Waiting",
            servers: [],
            state: "waiting",
        };
        if (discoveryListener) discoveryListener();
    },
    status() {
        return discoveryState;
    },
    subscribe(listener) {
        discoveryListener = listener;
    },
};
w.settingsCommands();
function remoteKey(key) {
    const event = new w.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        keyCode: key,
    });
    w.document.activeElement.dispatchEvent(event);
    assert.equal(
        event.defaultPrevented,
        true,
        "focused control consumes remote key once"
    );
}
assert.deepEqual(
    [...w.document.querySelectorAll("#remoteSettingsContent button .btn")].map(
        (badge) => badge.textContent
    ),
    ["3", "4", "5", "6"],
    "numeric shortcuts remain visible without duplicated footer hints"
);
assert.equal(
    w.document.getElementById("commandServerDiscoveryCancel").disabled,
    true
);
assert.equal(w.document.activeElement.id, "commandServerAddress");
assert.match(w.document.activeElement.style.outline, /2px solid/);
remoteKey(w.keys.ENTER);
assert.equal(editor().value, "192.168.1.20:8081");
submit("192.168.1.30:8081");
assert.equal(w.settings.commandServerAddress, "192.168.1.30:8081");
assert.equal(w.document.activeElement.id, "commandServerAddress");
remoteKey(w.keys.RIGHT);
assert.equal(w.document.activeElement.id, "commandServerToken");
remoteKey(w.keys.ENTER);
assert.equal(editor().type, "password");
submit("d".repeat(64));
assert.equal(w.settings.commandServerToken, "d".repeat(64));
remoteKey(w.keys.RIGHT);
assert.equal(w.document.activeElement.id, "commandServerConnect");
const previousChanges = serverChanges.length;
remoteKey(w.keys.ENTER);
assert.equal(
    serverChanges.length,
    previousChanges + 1,
    "OK performs one connection toggle"
);
assert.equal(serverChanges.at(-1).enabled, false);
assert.equal(w.document.activeElement.id, "commandServerConnect");
const keyboardContent = w.document.getElementById("remoteSettingsContent");
Object.defineProperty(keyboardContent, "clientHeight", { value: 200 });
remoteKey(w.keys.DOWN);
assert.equal(keyboardContent.scrollTop, 100, "UP/DOWN retain scrolling");
remoteKey(w.keys.UP);
assert.equal(keyboardContent.scrollTop, 0);
remoteKey(w.keys.RIGHT);
assert.equal(w.document.activeElement.id, "commandServerFind");
remoteKey(w.keys.ENTER);
assert.deepEqual(discoveries, [true], "OK starts one explicit discovery");
assert.equal(
    w.document.getElementById("commandServerDiscoveryCancel").disabled,
    false
);
assert.match(
    w.document.getElementById("commandServerDiscoveryStatus").textContent,
    /ABC12345/
);
remoteKey(w.keys.RIGHT);
assert.match(w.document.activeElement.textContent, /Local URL/);
remoteKey(w.keys.ENTER);
assert.match(w.editCaption, /Local command URL/);
w.editKey2(w.keys.RETURN);
remoteKey(w.keys.RIGHT);
assert.match(w.document.activeElement.textContent, /Swop URL/);
remoteKey(w.keys.RIGHT);
assert.match(w.document.activeElement.textContent, /HTTP remote/);
remoteKey(w.keys.RIGHT);
assert.match(w.document.activeElement.textContent, /Close/);
remoteKey(w.keys.RIGHT);
assert.equal(w.document.activeElement.id, "commandServerDiscoveryCancel");
const previousCancellations = canceledDiscoveries;
remoteKey(w.keys.ENTER);
assert.equal(
    canceledDiscoveries,
    previousCancellations + 1,
    "OK cancels the pending pairing once"
);
assert.equal(
    w.document.getElementById("commandServerDiscoveryCancel").disabled,
    true
);
assert.equal(w.document.getElementById("remoteDiagnosticsToggle"), null);
assert.equal(w.document.getElementById("remoteDiagnosticsTrust"), null);
assert(
    !w.document
        .getElementById("remoteSettingsContent")
        .textContent.includes("Allow screenshots for 10 minutes")
);
diagnosticSession = "session-under-test";
diagnosticListener();
remoteKey(w.keys.RIGHT);
assert.equal(w.document.activeElement.id, "remoteDiagnosticsStopSession");
remoteKey(w.keys.ENTER);
assert.equal(
    diagnosticSession,
    undefined,
    "Stop capture ends only the current session"
);
assert.equal(w.__ottRemoteDiagnostics.status().enabled, true);
screenshotConnected = true;
screenshotListener();
remoteKey(w.keys.RIGHT);
assert.equal(w.document.activeElement.id, "remoteScreenshotToggle");
assert.deepEqual(
    screenshotChanges,
    [],
    "No browser source is selected by navigating settings"
);
w.__ottRemoteInputActive = true;
remoteKey(w.keys.ENTER);
assert.deepEqual(
    screenshotChanges,
    [],
    "Remote input cannot open the browser OS picker"
);
w.__ottRemoteInputActive = false;
remoteKey(w.keys.ENTER);
assert.deepEqual(screenshotChanges, [true]);
assert.equal(w.document.activeElement.textContent, "Stop browser sharing");
remoteKey(w.keys.ENTER);
assert.deepEqual(screenshotChanges, [true, false]);
assert.equal(
    w.document.activeElement.textContent,
    "Select screenshot source in browser"
);
remoteKey(w.keys.RIGHT);
assert.equal(
    w.document.activeElement.id,
    "commandServerAddress",
    "selection wraps"
);
remoteKey(w.keys.LEFT);
assert.equal(w.document.activeElement.id, "remoteScreenshotToggle");
// Native snapshots use connection authorization without a local source action.
screenshotBrowser = false;
screenshotEnabled = true;
screenshotListener();
assert.equal(w.document.getElementById("remoteScreenshotToggle").hidden, true);
assert.equal(
    w.document.getElementById("remoteScreenshotToggle").disabled,
    true
);
remoteKey(w.keys.LEFT);
assert.match(w.document.activeElement.textContent, /Close/);
remoteKey(w.keys.ENTER);
assert.equal(w.document.getElementById("listAbout").style.display, "none");
assert.equal(serverListener, null);
assert.equal(
    diagnosticListener,
    null,
    "closed settings unsubscribe diagnostics updates"
);
assert.equal(
    discoveryListener,
    null,
    "closed settings unsubscribe discovery updates"
);
w.sNoNumbersKeys = 0;

// New server copy uses the existing translator; missing entries remain English.
const originalTranslate = w._;
const translated = {
    "Access code": "Translated access code",
    "Cancel pairing": "Translated cancel pairing",
    "Command server": "Translated server",
    Connected: "Translated connected",
    Disconnect: "Translated disconnect",
    "Find command server": "Translated find server",
    "Server address": "Translated address",
    "Server device access code": "Translated code editor",
};
w._ = (key) => translated[key] || key;
serverState = { enabled: true, message: "Connected" };
w.settingsCommands();
assert.equal(
    w.document.querySelector("#remoteSettingsContent b").textContent,
    translated["Command server"]
);
assert.equal(
    w.document.getElementById("commandServerAddress").textContent,
    "3 " + translated["Server address"]
);
assert.equal(
    w.document.getElementById("commandServerToken").textContent,
    "4 " + translated["Access code"]
);
assert.equal(
    w.document.getElementById("commandServerStatus").textContent,
    translated.Connected
);
assert.equal(
    w.document.getElementById("commandServerConnect").textContent,
    "5 " + translated.Disconnect
);
assert.equal(
    w.document.getElementById("commandServerFind").textContent,
    "6 " + translated["Find command server"]
);
assert.equal(
    w.document.getElementById("commandServerDiscoveryCancel").textContent,
    translated["Cancel pairing"]
);
w.aboutKeyHandler(52);
assert.equal(w.editCaption, translated["Server device access code"]);
w.editKey2(w.keys.RETURN);
w.aboutKeyHandler(w.keys.RETURN);
w._ = originalTranslate;

// Exercise the actual import validation/confirmation/apply functions after real editor teardown.
w.eval(extract("src/settings/index.ts", ["importSettings", "applyImport"]));
let confirmation;
let successes = 0;
let reloads = 0;
let restarts = 0;
w.confirmBox = (_message, yes, no) => {
    assert.equal(w.document.getElementById("listEdit").style.display, "none");
    assert.equal(w.listCaptionElement.textContent, "Settings");
    confirmation = { no, yes };
};
w.loadSettings = () => {
    reloads++;
};
w.restart = () => {
    restarts++;
};
w.showShift = () => {
    successes++;
};
w.providerSetItem = (key, value) => stored.set(key, value);
const beforeImport = [...stored];
w.importSettingsUI();
editor().value = '{"version":1}';
editor().dispatchEvent(
    new w.KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
);
assert.deepEqual(
    [...stored],
    beforeImport,
    "cancelled editor cannot write settings"
);
assert.equal(confirmation, undefined);
for (const invalid of ["", "not JSON", '{"version":2,"settings":{}}']) {
    w.importSettingsUI();
    submit(invalid);
    assert.equal(confirmation, undefined);
    assert.equal(successes, 0, "malformed import cannot report success");
    assert.deepEqual([...stored], beforeImport);
}
const envelope = JSON.stringify({
    favoritesArray: [3],
    parentalArray: [2],
    settings: {
        localCmdUrl: "http://lan/?literal=&amp;<text>",
        swopBaseUrl: "",
    },
    version: 1,
});
w.importSettingsUI();
submit(envelope);
assert.ok(confirmation, "valid import still requires existing confirmation");
assert.deepEqual([...stored], beforeImport);
confirmation.no();
assert.deepEqual(
    [...stored],
    beforeImport,
    "rejected confirmation cannot write settings"
);
w.importSettingsUI();
submit(envelope);
confirmation.yes();
assert.equal(stored.get("sLocalCmdUrl"), "http://lan/?literal=&amp;<text>");
const restoredSource = w.__ottSourceIdentity.current(w);
assert.deepEqual(
    JSON.parse(stored.get("channelLibrary:" + restoredSource)).locks,
    ["unresolved:2"]
);
assert.deepEqual(
    JSON.parse(stored.get("favoritesLibrary:" + restoredSource)).lists.lists
        .Favorites,
    [{ legacyId: 3, origin: "raw" }]
);
assert.equal(successes, 1);
assert.equal(reloads, 1);
assert.equal(restarts, 1);
// Touch controls use the real dialog renderer and renderButtonHint dispatch boundary.
const dialog = w.document.createElement("div");
dialog.id = "dialogbox";
w.document.body.appendChild(dialog);
w.strENTER = "Enter";
w.strRETURN = "Back";
w.eval(require("./helpers/localization-runtime.cjs").localizationRuntime());
w.eval(
    extract("src/ui/index.ts", ["confirmBox", "localizedTextHtml", "uiInit"])
);
w.getViewportWidthScale = () => 1;
w.getViewportHeightScale = () => 1;
w.uiInit();
let accepted = 0,
    cancelled = 0,
    resumed = 0;
let playing = true;
w.stbIsPlaying = () => playing;
w.stbContinue = () => {
    playing = true;
    resumed++;
};
w._doKey = (key) => w.dialogBoxKeyHandler(key);
let bubbled = 0;
dialog.addEventListener("click", () => {
    bubbled++;
});
function openConfirmation() {
    w.confirmBox(
        "Replace settings?",
        () => {
            accepted++;
        },
        () => {
            cancelled++;
        }
    );
    const buttons = [...dialog.querySelectorAll("span[data-ott-key]")];
    assert.equal(
        buttons.length,
        2,
        "Touch users need visible Yes and No controls"
    );
    assert.match(buttons[0].textContent, /Yes/);
    assert.match(buttons[1].textContent, /No/);
    return buttons;
}
let choices = openConfirmation();
playing = false;
choices[1].click();
assert.equal(accepted, 0);
assert.equal(cancelled, 1);
assert.equal(
    resumed,
    1,
    "No resumes playback paused while the dialog was open"
);
assert.equal(dialog.style.display, "none");
assert.equal(w.dialogBoxKeyHandler, null);
choices = openConfirmation();
choices[0].click();
assert.equal(accepted, 1);
assert.equal(cancelled, 1);
assert.equal(resumed, 1, "Yes must not invoke cancellation playback recovery");
assert.equal(dialog.style.display, "none");
assert.equal(w.dialogBoxKeyHandler, null);
assert.equal(
    bubbled,
    0,
    "Dialog buttons must not trigger underlying body actions"
);
openConfirmation();
w._doKey(w.keys.UP);
assert.equal(accepted, 1);
assert.equal(cancelled, 2, "Existing non-ENTER cancellation remains available");
assert.equal(dialog.style.display, "none");
// The resume timeout belongs to its dialog; stale callbacks cannot accept another prompt.
{
    const originalSetTimeout = w.setTimeout;
    const originalClearTimeout = w.clearTimeout;
    const scheduled = new Map();
    let now = 0;
    let sequence = 0;
    w.setTimeout = (callback, delay) => {
        const id = ++sequence;
        scheduled.set(id, { callback, due: now + delay });
        return id;
    };
    w.clearTimeout = (id) => scheduled.delete(id);
    const advance = (delay) => {
        now += delay;
        for (const [id, timer] of [...scheduled]) {
            if (timer.due <= now) {
                scheduled.delete(id);
                timer.callback();
            }
        }
    };
    let resumed = 0;
    const openResume = () =>
        w.confirmBox("Continue watching?", () => resumed++, undefined, 10000);
    try {
        openResume();
        const expired = [...scheduled.values()][0].callback;
        advance(9999);
        assert.equal(resumed, 0, "Resume waits for the full ten seconds");
        assert.notEqual(dialog.style.display, "none");
        advance(1);
        assert.equal(resumed, 1);
        assert.equal(dialog.style.display, "none");
        assert.equal(w.dialogBoxKeyHandler, null);
        expired();
        assert.equal(resumed, 1, "An expired callback cannot resume twice");

        for (const key of [w.keys.ENTER, w.keys.RETURN]) {
            openResume();
            const stale = [...scheduled.values()][0].callback;
            w._doKey(key);
            const afterChoice = resumed;
            assert.equal(
                scheduled.size,
                0,
                "A manual choice cancels the timer"
            );
            stale();
            advance(10000);
            assert.equal(
                resumed,
                afterChoice,
                "Manual choice wins the timeout race"
            );
        }
        openResume();
        const replaced = [...scheduled.values()][0].callback;
        const afterChoice = resumed;
        w.confirmBox("Delete settings?", () => {
            throw new Error("Unrelated confirmation must never auto-accept");
        });
        const replacement = w.dialogBoxKeyHandler;
        assert.equal(
            scheduled.size,
            0,
            "Replacing a dialog releases its timer"
        );
        replaced();
        advance(10000);
        assert.equal(resumed, afterChoice);
        assert.equal(w.dialogBoxKeyHandler, replacement);
        assert.notEqual(dialog.style.display, "none");
        w._doKey(w.keys.RETURN);

        openResume();
        const closed = [...scheduled.values()][0].callback;
        w.__ottClassicScreenPort.invalidate();
        assert.equal(scheduled.size, 0, "Screen teardown releases the timer");
        closed();
        assert.equal(resumed, afterChoice);
    } finally {
        w.setTimeout = originalSetTimeout;
        w.clearTimeout = originalClearTimeout;
    }
}
async function testHttpRemoteSettings() {
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const requests = [];
    let state = { code: "", enabled: false, port: 0 };
    let complete;
    let fail;
    w.__ottLocalHttpRemote = {
        setEnabled(enabled) {
            requests.push(enabled);
            return new Promise((resolve, reject) => {
                complete = () => {
                    state = {
                        code: enabled ? String(requests.length).repeat(64) : "",
                        enabled,
                        port: enabled ? 19999 : 0,
                    };
                    resolve();
                };
                fail = reject;
            });
        },
        status: () => state,
    };
    w._doKey = (key) => w.aboutKeyHandler(key);
    w.settingsCommands();
    assert.equal(
        requests.length,
        0,
        "opening settings cannot enable the listener"
    );
    assert.equal(w.document.getElementById("localHttpDeviceCode"), null);
    assert.match(
        w.document.getElementById("remoteSettingsContent").textContent,
        /HTTP remote control: off/
    );
    const httpToggle =
        w.listFooterElement.querySelectorAll("span[data-ott-key]")[3];
    assert.match(httpToggle.textContent, /Enable HTTP remote/);
    httpToggle.click();
    w.aboutKeyHandler(49);
    await tick();
    assert.deepEqual(
        requests,
        [true],
        "repeated keys cannot race pending enable"
    );
    assert.equal(
        w.document.getElementById("localHttpDeviceCode"),
        null,
        "credentials require backend acknowledgement"
    );
    assert.match(
        w.document.getElementById("remoteSettingsContent").textContent,
        /Applying HTTP remote settings/
    );
    complete();
    await tick();
    const code = w.document.getElementById("localHttpDeviceCode");
    assert.equal(code.value, "1".repeat(64));
    assert.equal(code.readOnly, true);
    code.click();
    assert.equal(code.selectionStart, 0);
    assert.equal(
        code.selectionEnd,
        64,
        "a touch/click selects the complete code for copying"
    );
    assert.match(
        w.document.getElementById("remoteSettingsContent").textContent,
        /HTTP port: 19999/
    );
    assert.match(
        w.document.getElementById("remoteSettingsContent").textContent,
        /Authorization: Bearer/
    );
    assert.match(w.listFooterElement.textContent, /Disable HTTP remote/);
    w.aboutKeyHandler(49);
    await tick();
    assert.deepEqual(requests, [true, false]);
    complete();
    await tick();
    assert.equal(
        w.document.getElementById("localHttpDeviceCode"),
        null,
        "disabled access must hide the old credential"
    );
    w.aboutKeyHandler(49);
    await tick();
    fail(new Error("native listener unavailable"));
    await tick();
    assert.match(
        w.document.getElementById("remoteSettingsContent").textContent,
        /Could not update HTTP remote control/
    );
    assert.equal(w.document.getElementById("localHttpDeviceCode"), null);
    w.aboutKeyHandler(49);
    await tick();
    w.aboutKeyHandler(w.keys.RETURN);
    complete();
    await tick();
    assert.equal(
        w.document.getElementById("listAbout").style.display,
        "none",
        "async completion cannot reopen a closed settings screen"
    );
    assert.equal(w.document.getElementById("remoteSettingsContent"), null);

    const keys = [
        "Remote control",
        "Local HTTP remote control",
        "Enable HTTP remote",
        "Disable HTTP remote",
        "Device access code",
        "HTTP port",
        "Disabled by default. Enabling creates a new device access code.",
        "Send this code from your proxy in the Authorization: Bearer header.",
        "HTTP remote control is unavailable on this device.",
        "Could not update HTTP remote control.",
        "Applying HTTP remote settings...",
        "on",
    ];
    const { languageAssets } = require("../scripts/localization-catalog.cjs");
    assert.deepEqual(
        Object.keys(languageAssets).sort(),
        Object.keys(require("./fixtures/locale-alphabets.json").locales).sort()
    );
    for (const [code, file] of Object.entries(languageAssets)) {
        w.eval(fs.readFileSync(path.join(root, file), "utf8"));
        for (const key of keys) assert.ok(w.keyStrings[key], `${code}: ${key}`);
    }
    w._ = (key) => w.keyStrings[key] || key;
    w.eval(fs.readFileSync(path.join(root, "locales/russian.js"), "utf8"));
    w.settingsCommands();
    assert.equal(w.listCaptionElement.textContent, "Удалённое управление");
    assert.match(
        w.document.getElementById("remoteSettingsContent").textContent,
        /Код доступа к устройству/
    );
    assert.match(w.listFooterElement.textContent, /Выключить HTTP-пульт/);
    w.aboutKeyHandler(w.keys.RETURN);
}
testHttpRemoteSettings()
    .then(() => {
        dom.window.close();
        console.log(
            "OK: Remote settings layout, authenticated HTTP controls, selectable credentials, async lifecycle and 28 translations"
        );
    })
    .catch((error) => {
        dom.window.close();
        console.error(error);
        process.exitCode = 1;
    });

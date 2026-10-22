const { settingsSource } = require("./helpers/settings-source-fixture.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");
const { compatibilitySource } = require("./helpers/english-source-fixture.cjs");
const root = path.resolve(__dirname, "..");

function parse(file) {
    return ts.createSourceFile(
        file,
        fs.readFileSync(path.join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
}
function compile(text) {
    const code = ts
        .transpileModule(text, {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        })
        .outputText.replace(/^export /gm, "");
    acorn.parse(code, { ecmaVersion: 5 });
    return code;
}
function functions(file, names) {
    const source = parse(file);
    const found = source.statements.filter(
        (node) =>
            ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
    );
    assert.equal(found.length, names.length, "All production functions exist");
    return compile(found.map((node) => node.getText(source)).join("\n"));
}
const index = parse("src/index.ts");
function assignment(property) {
    const node = index.statements.find(
        (node) =>
            ts.isExpressionStatement(node) &&
            ts.isBinaryExpression(node.expression) &&
            ts.isPropertyAccessExpression(node.expression.left) &&
            node.expression.left.name.text === property
    );
    assert.ok(node, "Production window assignment exists: " + property);
    return compile(node.getText(index));
}
const ready = index.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "onStbReady"
);
const startup = ready.body.statements.find(ts.isTryStatement).tryBlock
    .statements;
const load = startup.findIndex(
    (node) => node.getText(index) === "loadSettings();"
);
const configure = startup.findIndex((node) =>
    node
        .getText(index)
        .startsWith("(window as any).__ottCommandServer.configure(")
);
assert.ok(
    load >= 0 && configure > load,
    "Startup restores settings before connection consent"
);
const bootSource = compile(
    startup
        .slice(load, configure + 1)
        .map((node) => node.getText(index))
        .join("\n")
);
const controllerSource = functions("src/plugins/command-server.ts", [
    "normalizeCommandServerAddress",
    "createCommandServer",
    "createCommandServerTransport",
]);
const token = "fixture_device_code_" + "a".repeat(40);
const nextToken = "fixture_device_code_" + "b".repeat(40);

function fixture(initial = []) {
    // No resource loader, real requests, device bridge, or user profile exists.
    const dom = new JSDOM(
        '<div id="listCaption">Settings</div><div id="listDetail">Parent</div><div id="listPodval">Footer</div><div id="listEdit" style="display:none"></div><div id="listAbout" style="display:none"></div>',
        { runScripts: "dangerously", url: "http://player.invalid/" }
    );
    const w = dom.window;
    require("./helpers/screen-runtime.cjs")(w);
    Object.assign(w, require("./load-wire.cjs")());
    const stored = new Map(initial);
    const writes = [];
    const requests = [];
    const delivered = [];
    const jobs = new Map();
    let sequence = 0;
    w.eval(compatibilitySource);
    w.eval(fs.readFileSync(path.join(root, "js/jquery-1.11.1.min.js"), "utf8"));
    const storage = {
        del(name) {
            stored.delete(name);
        },
        get: (name) => stored.get(name) ?? null,
        getI(name, fallback) {
            const value = Number.parseInt(stored.get(name), 10);
            return Number.isNaN(value) ? fallback : value;
        },
        set(name, value) {
            stored.set(name, String(value));
            writes.push([name, String(value)]);
        },
        setI(name, value) {
            this.set(name, value);
        },
    };
    Object.assign(w, {
        _: (value) => value,
        __ottKiosk: { init() {} },
        __ottLocalHttpRemote: { init() {}, status: () => ({ enabled: false }) },
        deviceUUID: "fixture-device",
        executeRemoteRequest: () => {},
        handleCommand: (command) => delivered.push(command),
        keys: {
            DOWN: 40,
            ENTER: 13,
            EXIT: 8,
            LEFT: 37,
            N2: 50,
            RETURN: 27,
            RIGHT: 39,
            UP: 38,
        },
        listCaptionElement: w.document.getElementById("listCaption"),
        listDetailElement: w.document.getElementById("listDetail"),
        listFooterElement: w.document.getElementById("listPodval"),
        optionsList() {},
        stbSetItem: (name, value) => storage.set(name, value),
        storage,
        ui_state: {},
    });
    require("./helpers/pin-runtime.cjs")(w);
    w.eval(settingsSource());
    w.eval(
        functions("src/utils/helpers.ts", [
            "metadataText",
            "metadataImageUrl",
            "metadataCssUrl",
            "metadataHtml",
            "hasTmdbService",
        ])
    );
    w.eval(
        functions("src/ui/index.ts", [
            "saveListPanelState",
            "restoreListPanelState",
            "renderButtonHint",
            "showEditKey2",
            "editKey2",
        ])
    );
    w.eval(functions("src/settings/transfer-ui.ts", ["editSettingsText"]));
    w.eval(controllerSource);
    w.XMLHttpRequest = class {
        constructor() {
            this.headers = {};
            this.aborted = false;
        }
        open(method, url) {
            Object.assign(this, { method, url });
        }
        setRequestHeader(name, value) {
            this.headers[name] = value;
        }
        send(body) {
            this.body = body;
            requests.push(this);
        }
        abort() {
            this.aborted = true;
            if (this.onabort) this.onabort();
        }
        respond(body, status = 200) {
            this.status = status;
            this.responseText = JSON.stringify(body);
            this.onload();
        }
    };
    w.Request = class {
        constructor(url, options) {
            Object.assign(this, options, { url });
        }
    };
    w.fetch = (request) =>
        new Promise((resolve) => {
            requests.push({
                ...request,
                respond(body, status = 200) {
                    resolve({
                        status,
                        text: () => Promise.resolve(JSON.stringify(body)),
                    });
                },
            });
        });
    // The production transport/controller use deterministic isolated timers.
    w.setTimeout = (fn, delay) => {
        jobs.set(++sequence, { delay, fn });
        return sequence;
    };
    w.clearTimeout = (id) => jobs.delete(id);
    const connectionState = index.statements.find(
        (node) =>
            ts.isVariableStatement(node) &&
            node.declarationList.declarations.some(
                (decl) => decl.name.getText(index) === "remoteControlConnection"
            )
    );
    assert.ok(
        connectionState,
        "Private runtime connection state is initialized before hooks"
    );
    w.eval(compile(connectionState.getText(index)));
    w.eval(functions("src/index.ts", ["remoteControlConfig"]));
    w.eval(
        functions("src/plugins/remote-inspect.ts", ["installRemoteInspection"])
    );
    const inspectionState = index.statements.find(
        (node) =>
            ts.isVariableStatement(node) &&
            node.declarationList.declarations.some(
                (decl) => decl.name.getText(index) === "remoteInspection"
            )
    );
    assert.ok(
        inspectionState,
        "Production inspection wrapper is installed before delivery"
    );
    w.eval(compile(inspectionState.getText(index)));
    w.eval(assignment("__ottCommandServer"));
    w.eval(
        functions("src/plugins/control-discovery.ts", [
            "createControlDiscovery",
        ])
    );
    w.eval(assignment("__ottControlDiscovery"));
    w.eval(assignment("settingsCommands"));
    w.eval(bootSource);
    const controller = w.__ottCommandServer;
    function open() {
        w.settingsCommands();
    }
    function close() {
        w.aboutKeyHandler(w.keys.RETURN);
    }
    function edit(property, value, cancel = false) {
        w.document
            .getElementById(
                property === "address"
                    ? "commandServerAddress"
                    : "commandServerToken"
            )
            .click();
        const field = w.document.getElementById("editvar");
        assert.ok(field, "Real shared editor is open");
        if (property === "token") assert.equal(field.type, "password");
        field.value = value;
        field.dispatchEvent(
            new w.KeyboardEvent("keydown", {
                bubbles: true,
                key: cancel ? "Escape" : "Enter",
            })
        );
        assert.equal(
            w.document.getElementById("listEdit").style.display,
            "none"
        );
    }
    function destroy() {
        // Release only this fixture's fake timers and detached document.
        jobs.clear();
        dom.window.close();
    }
    return {
        close,
        controller,
        delivered,
        destroy,
        edit,
        jobs,
        open,
        requests,
        stored,
        w,
        writes,
    };
}

for (const failureAt of [1, 2, 3, 4]) {
    const h = fixture();
    try {
        h.controller.configure({
            address: "https://old.example",
            enabled: true,
            token,
        });
        assert.equal(h.w.remoteControlConfig().enabled, true);
        const initialRequest = h.requests[h.requests.length - 1];
        const actualSave = h.w.saveSettings;
        let calls = 0;
        const diagnostics = [];
        const screenshots = [];
        h.w.__ottRemoteDiagnostics = {
            configurationChanged(config) {
                diagnostics.push(JSON.parse(JSON.stringify(config)));
            },
        };
        h.w.__ottRemoteScreenshot = {
            configurationChanged() {
                screenshots.push(
                    JSON.parse(JSON.stringify(h.w.remoteControlConfig()))
                );
            },
        };
        h.w.saveSettings = (patch) =>
            ++calls >= failureAt ? false : actualSave(patch);
        // configure persists disabled first, then enabled; each callback contains two writes.
        try {
            h.controller.configure({
                address: "https://new.example",
                enabled: true,
                token: nextToken,
            });
        } catch (error) {
            assert.match(error.message, /settings could not be saved/);
        }
        assert.equal(initialRequest.aborted, true);
        assert.equal(h.w.remoteControlConfig().enabled, false);
        assert.equal(h.controller.status().enabled, false);
        assert.ok(diagnostics.length && screenshots.length);
        assert.ok(diagnostics.every((config) => config.enabled === false));
        assert.ok(screenshots.every((config) => config.enabled === false));
        assert.equal(
            h.w.remoteControlConfig().address,
            failureAt <= 2
                ? "https://new.example"
                : "https://new.example/api/webhook/commands"
        );
        if (failureAt === 1)
            assert.equal(
                h.w.settings.commandServerEnabled,
                1,
                "reproduce stale saved enablement when the very first disable write fails"
            );
        const detached = h.w.remoteControlConfig();
        detached.enabled = true;
        detached.token = token;
        assert.equal(
            h.w.remoteControlConfig().enabled,
            false,
            "hooks cannot mutate private connection authority"
        );
        h.w.saveSettings = actualSave;
        h.controller.configure({
            address: "https://new.example",
            enabled: true,
            token: nextToken,
        });
        assert.equal(h.w.remoteControlConfig().enabled, true);
        assert.equal(h.w.remoteControlConfig().token, nextToken);
        assert.equal(diagnostics[diagnostics.length - 1].enabled, true);
        assert.equal(screenshots[screenshots.length - 1].enabled, true);
        assert.equal(
            h.requests[h.requests.length - 1].headers.Authorization,
            "Bearer " + nextToken
        );
        const resumed = fixture([...h.stored]);
        try {
            assert.equal(resumed.w.remoteControlConfig().enabled, true);
            assert.equal(resumed.w.remoteControlConfig().token, nextToken);
        } finally {
            resumed.destroy();
        }
    } finally {
        h.destroy();
    }
}
console.log(
    "PASS runtime connection authority: first/second callback save failures, stale preferences, detached snapshots, reconnect and saved boot"
);

for (const first of ["address", "token"]) {
    const h = fixture();
    try {
        h.open();
        const second = first === "address" ? "token" : "address";
        const values = { address: " 192.168.1.20 ", token: " " + token + " " };
        h.edit(first, values[first]);
        assert.equal(
            h.requests.length,
            0,
            "A single field cannot authorize polling"
        );
        assert.equal(h.controller.status().enabled, false);
        assert.match(
            h.w.document.getElementById("commandServerStatus").textContent,
            first === "address" ? /access code/i : /server.*address/i
        );
        h.edit(second, values[second]);
        assert.equal(
            h.requests.length,
            1,
            "Saving the second field starts one request immediately"
        );
        assert.equal(h.requests[0].method, "GET");
        assert.equal(
            h.requests[0].url,
            "http://192.168.1.20:8081/api/webhook/commands?delivery=ack"
        );
        assert.equal(h.requests[0].headers.Authorization, "Bearer " + token);
        assert.equal(h.stored.get("commandServerEnabled"), "1");
        assert.ok(!h.requests[0].url.includes(token));
        assert.ok(
            !h.w.document
                .getElementById("listAbout")
                .textContent.includes(token)
        );
        assert.ok(!JSON.stringify(h.controller.status()).includes(token));
        assert.equal(
            h.w.document.getElementById("commandServerConnectLabel")
                .textContent,
            "Disconnect"
        );
        assert.deepEqual(
            h.writes.slice(-4),
            [
                ["commandServerEnabled", "0"],
                [
                    "commandServerAddress",
                    "http://192.168.1.20:8081/api/webhook/commands",
                ],
                ["commandServerToken", token],
                ["commandServerEnabled", "1"],
            ],
            "The real persist callback revokes before saving connection consent"
        );

        const generation = h.controller.status().generation;
        const writesBeforeNoop = h.writes.length;
        h.edit("address", "192.168.1.20:8081/");
        h.edit("token", "  " + token + "  ");
        h.edit("address", "cancelled.invalid", true);
        h.close();
        h.open();
        assert.equal(
            h.requests.length,
            1,
            "Equivalent edits, cancel and reopening do not reconnect"
        );
        assert.equal(h.controller.status().generation, generation);
        assert.equal(h.writes.length, writesBeforeNoop);
        assert.equal(h.requests[0].aborted, false);

        h.edit("address", "192.168.1.21");
        assert.equal(h.requests.length, 2);
        assert.equal(h.requests[0].aborted, true);
        assert.equal(h.requests[1].headers.Authorization, "Bearer " + token);
        assert.match(h.requests[1].url, /^http:\/\/192\.168\.1\.21:8081\//);
        h.requests[0].respond({
            commands: [{ command: "exit_player", id: "old-address" }],
        });
        assert.equal(
            h.delivered.length,
            0,
            "Old-address completion cannot dispatch after editing"
        );
        h.edit("token", nextToken);
        assert.equal(
            h.requests.length,
            3,
            "An access-code change reconnects once"
        );
        assert.equal(h.requests[1].aborted, true);
        assert.equal(
            h.requests[2].headers.Authorization,
            "Bearer " + nextToken
        );
        h.requests[1].respond({
            commands: [{ command: "exit_player", id: "old-token" }],
        });
        assert.equal(h.delivered.length, 0);

        const persisted = [...h.stored];
        const resumed = fixture(persisted);
        try {
            assert.equal(
                resumed.requests.length,
                1,
                "Actual settings load and boot configure resume saved consent"
            );
            assert.equal(
                resumed.requests[0].headers.Authorization,
                "Bearer " + nextToken
            );
            assert.equal(resumed.controller.status().enabled, true);
        } finally {
            resumed.destroy();
        }

        h.w.document.getElementById("commandServerConnect").click();
        assert.equal(h.controller.status().enabled, false);
        assert.equal(h.requests[2].aborted, true);
        assert.equal(h.stored.get("commandServerEnabled"), "0");
        const disconnectedGeneration = h.controller.status().generation;
        h.close();
        h.open();
        h.edit("address", "http://192.168.1.21:8081/");
        h.edit("token", " " + nextToken + " ");
        h.edit("token", token, true);
        assert.equal(h.controller.status().enabled, false);
        assert.equal(h.controller.status().generation, disconnectedGeneration);
        assert.equal(h.requests.length, 3);
        const disconnected = fixture([...h.stored]);
        try {
            assert.equal(
                disconnected.requests.length,
                0,
                "Explicit Disconnect survives persisted startup"
            );
            assert.equal(disconnected.controller.status().enabled, false);
        } finally {
            disconnected.destroy();
        }
        h.w.document.getElementById("commandServerConnect").click();
        assert.equal(
            h.requests.length,
            4,
            "Explicit Connect can resume the unchanged configuration"
        );
        assert.equal(h.controller.status().enabled, true);
        h.w.document.getElementById("commandServerConnect").click();
        h.edit("address", "192.168.1.22");
        assert.equal(
            h.requests.length,
            5,
            "A changed valid configuration resumes after Disconnect"
        );
        h.edit("address", "   ");
        assert.equal(h.controller.status().enabled, false);
        assert.equal(h.requests[4].aborted, true);
        assert.equal(h.requests.length, 5);
        assert.equal(
            h.jobs.size,
            0,
            "Clearing the address retires all request and retry timers"
        );
        assert.equal(h.stored.get("commandServerAddress"), "");
        assert.equal(h.stored.get("commandServerEnabled"), "0");
        h.requests[4].respond({
            commands: [{ command: "exit_player", id: "cleared" }],
        });
        assert.equal(h.delivered.length, 0);
        h.edit("address", "192.168.1.22");
        assert.equal(h.requests.length, 6);
        h.edit("token", "");
        assert.equal(h.requests.length, 6);
        assert.equal(h.requests[5].aborted, true);
        assert.equal(h.controller.status().enabled, false);
    } finally {
        h.destroy();
    }
}

for (const invalid of [
    { address: "https://host?token=secret", token },
    { address: "192.168.1.20", token: "short" },
]) {
    const h = fixture();
    try {
        h.open();
        h.edit("address", invalid.address);
        h.edit("token", invalid.token);
        assert.equal(
            h.requests.length,
            0,
            "Invalid complete credentials never send requests"
        );
        assert.equal(h.controller.status().state, "error");
        assert.equal(h.stored.get("commandServerEnabled"), "0");
        assert.notEqual(
            h.w.document.getElementById("commandServerStatus").textContent,
            "Disconnected"
        );
        h.edit("address", "192.168.1.20");
        h.edit("token", token);
        assert.equal(
            h.requests.length,
            1,
            "Correcting the invalid field connects without a separate button"
        );
        h.requests[0].respond({}, 401);
        assert.equal(h.controller.status().state, "error");
        assert.match(
            h.w.document.getElementById("commandServerStatus").textContent,
            /access code/i
        );
        const retryTimers = [...h.jobs.keys()];
        const retryGeneration = h.controller.status().generation;
        h.edit("address", "192.168.1.20:8081/");
        h.edit("token", " " + token + " ");
        assert.equal(
            h.requests.length,
            1,
            "No-op edits preserve an existing retry instead of polling again"
        );
        assert.deepEqual([...h.jobs.keys()], retryTimers);
        assert.equal(h.controller.status().generation, retryGeneration);
        assert.equal(h.controller.status().state, "error");
    } finally {
        h.destroy();
    }
}
console.log(
    "PASS command settings: real ES5 UI/controller/transport, authenticated auto-connect, no-op saves, revocation and persisted explicit disconnect"
);

(async () => {
    const h = fixture();
    try {
        h.w.__OTT_CONTROL_DISCOVERY_URL__ =
            "https://control.example/api/control-discovery";
        h.open();
        h.w.aboutKeyHandler(54);
        assert.equal(h.requests.length, 1, "shortcut 6 begins discovery");
        const server = {
            address: "https://control.example/ott-control",
            domain: "example",
            id: "home._ottplay-ctrl._tcp.example.",
        };
        h.requests[0].respond({
            servers: [
                server,
                {
                    ...server,
                    address: "https://other.example",
                    id: "other._ottplay-ctrl._tcp.example.",
                },
            ],
            version: 1,
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(h.requests[0].redirect, "error");
        assert.equal(h.requests[0].credentials, "omit");
        const choices = h.w.document.querySelectorAll(
            "#commandServerDiscoveryChoices button"
        );
        assert.equal(choices.length, 2);
        assert.equal(
            h.requests.length,
            1,
            "ambiguous discovery does not start pairing"
        );
        choices[1].focus();
        h.w.aboutKeyHandler(h.w.keys.ENTER);
        assert.equal(h.requests[1].url, "https://other.example/api/pairings");
        assert.equal(
            JSON.parse(h.requests[1].body).server_id,
            "other._ottplay-ctrl._tcp.example."
        );
        const secret = "s".repeat(32);
        h.requests[1].respond(
            { code: "ABC12345", expires_in: 600, id: "a".repeat(32), secret },
            201
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.match(
            h.w.document.getElementById("commandServerDiscoveryStatus")
                .textContent,
            /ABC12345/
        );
        assert.ok(!h.w.document.body.innerHTML.includes(secret));
        const poll = [...h.jobs].find(([, job]) => job.delay === 2000);
        assert.ok(poll);
        h.jobs.delete(poll[0]);
        poll[1].fn();
        const panel = h.w.document.getElementById("remoteSettingsContent");
        const focusedControl = h.w.document.getElementById("commandServerFind");
        focusedControl.focus();
        h.requests[2].respond({
            address: "https://other.example",
            device_id: "fixture-device",
            status: "approved",
            token,
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(h.stored.get("commandServerToken"), token);
        assert.equal(h.stored.get("commandServerEnabled"), "1");
        assert.equal(
            h.w.document.getElementById("remoteSettingsContent"),
            panel,
            "approval updates the existing settings panel"
        );
        assert.equal(
            h.w.document.activeElement,
            focusedControl,
            "approval retains the focused remote control"
        );
        assert.equal(
            h.w.document.getElementById("commandServerAddressValue")
                .textContent,
            "https://other.example/api/webhook/commands"
        );
        assert.equal(
            h.w.document.getElementById("commandServerTokenPresence")
                .textContent,
            "saved on this device"
        );
        assert.equal(h.requests[3].headers.Authorization, "Bearer " + token);
        assert.ok(
            ![...h.stored.values()].some((value) => value.includes(secret)),
            "pairing secret is never persisted"
        );
        assert.ok(!h.w.document.body.innerHTML.includes(token));
        h.w.aboutKeyHandler(54);
        assert.equal(h.w.__ottControlDiscovery.status().state, "discovering");
        h.edit("address", "https://manual.example");
        assert.equal(
            h.w.__ottControlDiscovery.status().state,
            "canceled",
            "manual editor revokes staged pairing"
        );
    } finally {
        h.destroy();
    }
    const editing = fixture();
    try {
        editing.w.__OTT_CONTROL_DISCOVERY_URL__ =
            "https://control.example/api/control-discovery";
        editing.open();
        editing.w.aboutKeyHandler(54);
        editing.requests[0].respond({
            servers: [
                {
                    address: "https://control.example/ott-control",
                    domain: "example",
                    id: "home._ottplay-ctrl._tcp.example.",
                },
            ],
            version: 1,
        });
        await new Promise((resolve) => setImmediate(resolve));
        const secret = "s".repeat(32);
        editing.requests[1].respond(
            { code: "ABC12345", expires_in: 600, id: "a".repeat(32), secret },
            201
        );
        await new Promise((resolve) => setImmediate(resolve));
        const panel = editing.w.document.getElementById(
            "remoteSettingsContent"
        );
        editing.w.document
            .getElementById("listPodval")
            .querySelectorAll("span[data-ott-key]")[1]
            .click();
        const input = editing.w.document.getElementById("editvar");
        const draft = "https://draft.example/local?unsaved=yes";
        input.value = draft;
        input.focus();
        const storedUrl = editing.stored.get("sLocalCmdUrl");
        const poll = [...editing.jobs].find(([, job]) => job.delay === 2000);
        assert.ok(poll);
        editing.jobs.delete(poll[0]);
        poll[1].fn();
        editing.requests[2].respond({
            address: "https://control.example/ott-control",
            device_id: "fixture-device",
            status: "approved",
            token,
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
            editing.w.document.getElementById("remoteSettingsContent"),
            panel
        );
        assert.equal(
            editing.w.document.getElementById("editvar"),
            input,
            "background approval does not recreate the active editor"
        );
        assert.equal(editing.w.document.activeElement, input);
        assert.equal(
            input.value,
            draft,
            "background approval preserves the unsaved local URL"
        );
        assert.equal(editing.stored.get("sLocalCmdUrl"), storedUrl);
        assert.equal(
            editing.w.document.getElementById("listAbout").style.display,
            "none"
        );
        assert.equal(
            editing.w.document.getElementById("commandServerAddressValue")
                .textContent,
            "https://control.example/ott-control/api/webhook/commands"
        );
        assert.equal(
            editing.w.document.getElementById("commandServerTokenPresence")
                .textContent,
            "saved on this device"
        );
        assert.ok(!editing.w.document.body.innerHTML.includes(token));
        assert.ok(!editing.w.document.body.innerHTML.includes(secret));
    } finally {
        editing.destroy();
    }
    console.log(
        "PASS discovery settings: shortcut/D-pad selection, visible approval code, private credentials, secure Fetch and manual revocation"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

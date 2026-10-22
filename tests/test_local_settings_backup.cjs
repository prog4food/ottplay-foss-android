const { cloudSource } = require("./helpers/cloud-source-fixture.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
function functions(file, names) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const nodes = ast.statements.filter(
        (node) =>
            ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
    );
    assert.equal(
        nodes.length,
        names.length,
        "Load every production function: " + file
    );
    return ts.transpileModule(
        nodes
            .map((node) => node.getText(ast).replace(/^export /, ""))
            .join("\n"),
        {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
}
const policy = functions("src/storage/index.ts", [
    "isPortableSettingsKey",
    "portableSettingsSnapshot",
    "restoreLocalSettingsSnapshot",
]);
const controller = functions("src/plugins/command-server.ts", [
    "normalizeCommandServerAddress",
    "createCommandServer",
]);
const cloud = cloudSource();
const ownToken = "a".repeat(48);
const copiedToken = "b".repeat(48);
const providerPayload = JSON.stringify({
    active: 0,
    M3Us: [
        { name: "Fixture <&> ", www: "https://example.invalid/list?x=1&y=2" },
    ],
});
for (const profile of ["typescript", "static-core"]) {
    for (const localConsent of ["0", "1"]) {
        const stored = new Map([
            [
                "commandServerAddress",
                "http://server.invalid:8081/api/webhook/commands",
            ],
            ["commandServerToken", ownToken],
            ["commandServerEnabled", "1"],
            ["sLocalHttpEnabled", localConsent],
            ["sLocalHttpDeviceCode", "this-device-code"],
            ["m3u:m3uArr", providerPayload],
            ["ottplayStorageFallback", "pending"],
            ["ottplayStorageFallback.0", "internal-marker-part"],
        ]);
        const jobs = new Map();
        const requests = [];
        const dispatched = [];
        let sequence = 0;
        let upload;
        const jquery = () => ({
            hide() {
                return this;
            },
            html() {
                return this;
            },
            show() {
                return this;
            },
        });
        jquery.ajax = (request) => {
            upload = request;
        };
        const c = vm.createContext({
            _: (value) => value,
            clearTimeout(id) {
                jobs.delete(id);
            },
            console: { error() {}, log() {}, warn() {} },
            curColor: "gold",
            host_ott: "fixture.invalid",
            host_ott_proto: "https://",
            jQuery: jquery,
            keys: { EXIT: 27, RETURN: 8 },
            localStorage: {
                getItem: (key) => stored.get(key) || null,
                setItem: (key, value) => stored.set(key, String(value)),
            },
            location: { protocol: "http:" },
            setTimeout(fn) {
                jobs.set(++sequence, fn);
                return sequence;
            },
            showShift() {},
            stbClearAllItems() {
                assert.equal(c.__ottCommandServer.status().enabled, false);
                stored.clear();
            },
            stbDelItem: (key) => stored.delete(key),
            stbGetAllItems: () => Object.fromEntries(stored),
            stbGetItem: (key) => stored.get(key) ?? null,
            stbSetItem: (key, value) => stored.set(key, String(value)),
            URL,
        });
        c.window = c;
        require("./helpers/shared-core-runtime.cjs")(c);
        Object.assign(c, require("./load-wire.cjs")());
        vm.runInContext(policy + controller + cloud, c);
        c.__ottCommandServer = c.createCommandServer(
            c,
            (request, complete) => {
                const pending = { complete, request };
                requests.push(pending);
                return () => {
                    pending.aborted = true;
                };
            },
            (config) => {
                stored.set("commandServerAddress", config.address);
                stored.set("commandServerToken", config.token);
                stored.set("commandServerEnabled", config.enabled ? "1" : "0");
            },
            (command) => dispatched.push(command)
        );
        c.__ottCommandServer.configure({
            address: stored.get("commandServerAddress"),
            enabled: true,
            token: ownToken,
        });
        const pending = requests[0];
        const generation = c.__ottCommandServer.status().generation;
        const names =
            profile === "typescript"
                ? ["saveAllOptions", "loadAllOptions"]
                : ["saveOpt", "loadOpt"];
        vm.runInContext(
            functions(
                profile === "typescript"
                    ? "src/core/index.ts"
                    : "devices/legacy-core.js",
                names
            ),
            c
        );
        // An old backup may already contain secrets, even before the safer save path runs.
        stored.set(
            "stb_settings_backup",
            JSON.stringify({
                commandServerEnabled: "1",
                commandServerToken: copiedToken,
            })
        );
        c.cloudSendSettings();
        assert(!upload.data.d.includes(ownToken));
        assert(!upload.data.d.includes(copiedToken));
        assert(!upload.data.d.includes("stb_settings_backup"));
        assert(!upload.data.d.includes("ottplayStorageFallback"));
        assert(!upload.data.d.includes("internal-marker-part"));
        c[names[0]]();
        const saved = JSON.parse(stored.get("stb_settings_backup"));
        assert.deepEqual(saved, { "m3u:m3uArr": providerPayload });
        assert.equal(
            c.__ottCommandServer.status().enabled,
            true,
            "Saving a backup must not revoke existing consent"
        );
        // Old or copied local snapshots cannot restore another device's authority.
        stored.set(
            "stb_settings_backup",
            JSON.stringify({
                commandServerAddress: "https://copied.invalid",
                commandServerEnabled: "1",
                commandServerToken: copiedToken,
                "m3u:m3uArr": providerPayload,
                ordinary: "restored",
                ottplayStorageFallback: "pending",
                "ottplayStorageFallback.0": "imported-marker-part",
                sLocalHttpDeviceCode: "copied-device-code",
                sLocalHttpEnabled: "1",
                stb_settings_backup: JSON.stringify({
                    commandServerToken: copiedToken,
                }),
            })
        );
        c[names[1]]();
        assert.equal(c.__ottCommandServer.status().enabled, false);
        assert(c.__ottCommandServer.status().generation > generation);
        assert.equal(pending.aborted, true);
        pending.complete({
            body: '{"commands":[{"id":"late","command":"set_volume","volume_step":5}]}',
            status: 200,
        });
        assert.deepEqual(
            dispatched,
            [],
            "A response started before restore cannot execute afterward"
        );
        assert.equal(stored.get("commandServerToken"), ownToken);
        assert.equal(
            stored.get("commandServerAddress"),
            "http://server.invalid:8081/api/webhook/commands"
        );
        assert.equal(stored.get("commandServerEnabled"), "0");
        assert.equal(stored.get("sLocalHttpEnabled"), localConsent);
        assert.equal(stored.get("sLocalHttpDeviceCode"), "this-device-code");
        assert.equal(stored.get("stb_settings_backup"), undefined);
        assert.equal(stored.get("m3u:m3uArr"), providerPayload);
        assert.equal(stored.get("ordinary"), "restored");
        assert.equal(stored.get("ottplayStorageFallback"), "pending");
        assert.equal(
            stored.get("ottplayStorageFallback.0"),
            "internal-marker-part"
        );
        if (profile === "static-core") {
            stored.set("stb_settings_backup", "{}");
            const before = JSON.stringify([...stored]);
            c.portableSettingsSnapshot = undefined;
            c.restoreLocalSettingsSnapshot = undefined;
            c.saveOpt();
            c.loadOpt();
            assert.equal(
                JSON.stringify([...stored]),
                before,
                "Standalone code fails closed if the shared policy has not loaded"
            );
        }
    }
}
console.log(
    "PASS local settings backups: real source/static save and restore, nested cloud exclusion, same-device credentials, unchanged listener consent and real command-generation revocation"
);

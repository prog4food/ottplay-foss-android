const { cloudSource } = require("./helpers/cloud-source-fixture.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "..");

function func(file, name) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const node = ast.statements.find(
        (item) => ts.isFunctionDeclaration(item) && item.name?.text === name
    );
    assert(node, "production cloud function exists: " + name);
    return ts.transpileModule(node.getText(ast).replace(/^export /, ""), {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
}

function fixture() {
    const dom = new JSDOM('<div id="listAbout" style="display:none"></div>', {
        runScripts: "dangerously",
        url: "https://localhost/index.html",
    });
    const w = dom.window;
    require("./helpers/shared-core-runtime.cjs")(dom.getInternalVMContext());
    w.eval(fs.readFileSync(path.join(root, "js/jquery-1.11.1.min.js"), "utf8"));
    Object.assign(w, {
        _: (value) => value,
        clearTimeout() {},
        curColor: "gold",
        keys: { EXIT: 27, RETURN: 8 },
        setTimeout: () => 1,
    });
    w.eval(func("src/storage/index.ts", "isPortableSettingsKey"));
    return w;
}

function test(name, run) {
    run();
    console.log("PASS HTTP remote cloud: " + name);
}

test("cloud export omits this device's consent and secret code", () => {
    const w = fixture();
    try {
        w.eval(cloudSource());
        w.host_ott = "fixture.invalid";
        w.host_ott_proto = "https://";
        w.stbGetAllItems = () => ({
            commandServerAddress: "https://private-server",
            commandServerEnabled: "1",
            commandServerToken: "private-server-code",
            fixture: "value",
            sLocalHttpDeviceCode: "private-device-code-do-not-upload",
            sLocalHttpEnabled: "1",
            stb_settings_backup: JSON.stringify({
                commandServerToken: "nested-secret-code",
            }),
        });
        let post;
        w.$.ajax = (options) => {
            post = options;
        };
        w.cloudSendSettings();
        assert.equal(post.url, "https://fixture.invalid/swop/a.php");
        assert.equal(
            w.__ottCloudSettingsCodec.read(post.data.d).fixture,
            "value"
        );
        for (const key of [
            "commandServerAddress",
            "commandServerToken",
            "commandServerEnabled",
            "private-server-code",
            "private-server",
        ])
            assert(!post.data.d.includes(key));
        assert(!post.data.d.includes("sLocalHttpEnabled"));
        assert(!post.data.d.includes("sLocalHttpDeviceCode"));
        assert(!post.data.d.includes("private-device-code-do-not-upload"));
        assert(!post.data.d.includes("stb_settings_backup"));
        assert(!post.data.d.includes("nested-secret-code"));
    } finally {
        w.close();
    }
});
test("cloud restore ignores injected local HTTP consent and credentials", () => {
    const w = fixture();
    try {
        w.eval(cloudSource());
        const stored = new Map([
            ["sLocalHttpEnabled", "1"],
            ["sLocalHttpDeviceCode", "old-local-code"],
            ["ordinary", "old-value"],
        ]);
        let revoked = false;
        w.__ottCommandServer = {
            configure(config) {
                assert.equal(config.enabled, false);
                revoked = true;
            },
        };
        let cleared = 0;
        let restarted = 0;
        let post;
        let poll;
        w.host_ott = "fixture.invalid";
        w.host_ott_proto = "https://";
        w.stbClearAllItems = () => {
            assert.equal(
                revoked,
                true,
                "disconnect before clearing credentials"
            );
            cleared++;
            stored.clear();
        };
        w.stbSetItem = (key, value) => stored.set(key, value);
        w.stbGetItem = (key) => stored.get(key) ?? null;
        w.stbDelItem = (key) => stored.delete(key);
        w.stbGetAllItems = () => Object.fromEntries(stored);
        w.restart = () => restarted++;
        w.setTimeout = (callback, delay) => {
            if (delay === 10000) poll = callback;
            return 1;
        };
        w.$.ajax = (options) => {
            post = options;
        };
        w.cloudLoadSettings();
        assert.equal(post.data.c, "get_code");
        post.success({ code: "transfer-code" });
        assert.equal(
            cleared,
            0,
            "requesting a cloud import must not change local consent"
        );
        poll();
        assert.equal(post.data.c, "get");
        assert.equal(post.data.d, "transfer-code");
        post.success({
            data:
                "<properties><comment>OTT-Play Preferences</comment>" +
                '<entry key="ordinary">restored-value</entry>' +
                '<entry key="commandServerAddress">https://injected</entry>' +
                '<entry key="commandServerToken">injected-code</entry>' +
                '<entry key="commandServerEnabled">1</entry>' +
                '<entry key="stb_settings_backup">{"commandServerToken":"nested-secret-code","commandServerEnabled":"1"}</entry>' +
                '<entry key="sLocalHttpEnabled">1</entry>' +
                '<entry key="sLocalHttpDeviceCode">injected-code</entry>' +
                "</properties>",
            status: "success",
        });
        assert.equal(cleared, 0, "restore never clears the storage wholesale");
        assert.equal(restarted, 1);
        for (const key of [
            "commandServerAddress",
            "commandServerToken",
            "commandServerEnabled",
            "stb_settings_backup",
        ])
            assert.equal(stored.has(key), false);
        assert.equal(stored.get("ordinary"), "restored-value");
        assert.equal(
            stored.has("sLocalHttpEnabled"),
            false,
            "cloud imports cannot enable a local listener"
        );
        assert.equal(
            stored.has("sLocalHttpDeviceCode"),
            false,
            "cloud imports cannot copy another device's code"
        );
    } finally {
        w.close();
    }
});

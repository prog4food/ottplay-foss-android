/* Exercise the actual boot and swop identity code with and without secure RNG APIs. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");
const { inlineScripts } = require("../scripts/html-scripts.cjs");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const scripts = inlineScripts(html);
assert(scripts.length > 0);
const identityScript = scripts
    .map((text) => ({ ast: acorn.parse(text, { ecmaVersion: 5 }), text }))
    .find(({ ast }) =>
        ast.body.some(
            (node) =>
                node.type === "FunctionDeclaration" &&
                node.id.name === "bootSecureDeviceId"
        )
    );
assert(
    identityScript,
    "Exercise the real identity declaration regardless of preceding scripts"
);
const identityStart = identityScript.ast.body.find(
    (node) =>
        node.type === "FunctionDeclaration" &&
        node.id.name === "bootSecureDeviceId"
).start;
const identityAssignment = identityScript.ast.body.find((node) => {
    const expression = node.type === "ExpressionStatement" && node.expression;
    const member =
        expression?.type === "AssignmentExpression" && expression.left;
    return (
        member?.type === "MemberExpression" &&
        !member.computed &&
        member.object.name === "window" &&
        member.property.name === "deviceUUID"
    );
});
assert(identityAssignment && identityAssignment.end > identityStart);
const bootIdentity = identityScript.text.slice(
    identityStart,
    identityAssignment.end
);

const file = path.join(root, "src/swop/index.ts");
const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
);
const swop = ts.transpileModule(
    source.statements
        .filter((node) => !ts.isImportDeclaration(node))
        .map((node) => node.getText(source).replace(/^export\s+/, ""))
        .join("\n"),
    {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
acorn.parse(swop, { ecmaVersion: 5 });

function fixture(options = {}) {
    const storage = { ...(options.storage || {}) };
    const requests = [];
    const alerts = [];
    const rngCalls = [];
    const timers = [];
    const messages = [];
    const qrUrls = [];
    const ui = {
        find() {
            return this;
        },
        hide() {
            return this;
        },
        html(value) {
            messages.push(value);
            return this;
        },
        show() {
            return this;
        },
        text(value) {
            messages.push(value);
            return this;
        },
    };
    const $ = () => ui;
    $.ajax = (request) => requests.push(request);
    const c = vm.createContext({
        ...require("./load-wire.cjs")(),
        _: (message) => message,
        $,
        alert: (message) => alerts.push(message),
        alerts,
        clearTimeout() {},
        console,
        curColor: "gold",
        document: {
            getElementById() {
                return null;
            },
        },
        keys: { EXIT: 27, RETURN: 8 },
        localStorage: {
            getItem: (key) => storage[key] || null,
            setItem: (key, value) => {
                storage[key] = value;
            },
        },
        makeQrSvg(url) {
            qrUrls.push(url);
            return "<svg></svg>";
        },
        messages,
        qrUrls,
        requests,
        rngCalls,
        saveSettings() {},
        setTimeout(callback, delay) {
            timers.push({ callback, delay });
            return timers.length;
        },
        settings: { deviceUuid: "", swopBaseUrl: "https://swop.test" },
        storage,
        timers,
    });
    c.window = c;
    if (options.storageBlocked) {
        Object.defineProperty(c, "localStorage", {
            get() {
                throw new Error("SecurityError");
            },
        });
    }
    vm.runInContext(
        "Array.from = undefined; Math.random = function () { throw new Error('Weak RNG must not generate credentials'); };",
        c
    );
    if (options.noTypedArrays) vm.runInContext("Uint8Array = undefined;", c);
    if (options.crypto) c.crypto = options.crypto;
    if (options.rng) {
        c[options.rng] = {
            getRandomValues(bytes) {
                assert.equal(
                    this,
                    c[options.rng],
                    "Preserve the crypto API receiver"
                );
                rngCalls.push(bytes.length);
                if (options.rngThrows) throw new Error("RNG unavailable");
                for (let i = 0; i < bytes.length; i++) bytes[i] = 0xa0 + i;
                return bytes;
            },
        };
    }
    vm.runInContext(bootIdentity, c, { filename: "real boot identity" });
    vm.runInContext(swop, c, { filename: "real swop module" });
    return c;
}

const expected = "dev_a0a1a2a3a4a5a6a7a8a9aaabacadaeaf";
for (const rng of ["crypto", "msCrypto"]) {
    const c = fixture({ rng });
    assert.equal(c.deviceUUID, expected, "Boot retains all 128 random bits");
    assert.equal(c.storage.ott_device_uuid, expected);
    assert.deepEqual(c.rngCalls, [16]);
    assert.equal(c.ensureDeviceClientId(), expected);
    assert.equal(c.storage.deviceId, expected);
    c.deviceUUID = "";
    delete c.storage.ott_device_uuid;
    delete c.storage.deviceId;
    c.settings.deviceUuid = "";
    assert.equal(
        c.ensureDeviceClientId(),
        expected,
        "Standalone swop generation uses the same secure contract"
    );
    assert.deepEqual(c.rngCalls, [16, 16]);
}
assert.equal(fixture({ crypto: {}, rng: "msCrypto" }).deviceUUID, expected);

for (const options of [
    {},
    { noTypedArrays: true },
    { noTypedArrays: true, rng: "crypto" },
    { rng: "crypto", rngThrows: true },
]) {
    const c = fixture(options);
    assert.equal(
        c.deviceUUID,
        "",
        "Basic startup continues without generating a weak credential"
    );
    assert.equal(c.storage.ott_device_uuid, undefined);
    assert.equal(c.ensureDeviceClientId(), "");
    assert.equal(c.storage.deviceId, undefined);
    c.swopLoadValue();
    assert.equal(
        c.requests.length,
        0,
        "No remote session request without an identity"
    );
    assert.equal(c.alerts.length, 1);

    let configured = false;
    c.applyLocalSwopConfig(() => {
        configured = true;
    });
    assert.equal(c.requests.length, 1);
    assert.equal(c.requests[0].url, "/local/swop.json");
    c.requests[0].success({
        clientId: "operator-provisioned-device",
        swopBaseUrl: "https://swop.test",
    });
    assert(configured);
    assert.equal(c.ensureDeviceClientId(), "operator-provisioned-device");
    c.swopLoadValue();
    const session = c.requests[1];
    assert.equal(session.url, "https://swop.test/session");
    assert.equal(
        session.headers["X-Swop-Client-Id"],
        "operator-provisioned-device"
    );
}

for (const storage of [
    { ott_device_uuid: "dev_existing_id" },
    { deviceId: "dev_previous_id" },
]) {
    const c = fixture({ noTypedArrays: true, storage });
    assert.equal(
        c.ensureDeviceClientId(),
        storage.ott_device_uuid || storage.deviceId
    );
    assert.deepEqual(c.rngCalls, []);
    const modern = fixture({ rng: "crypto", storage });
    assert.equal(
        modern.ensureDeviceClientId(),
        storage.ott_device_uuid || storage.deviceId
    );
    assert.deepEqual(
        modern.rngCalls,
        [],
        "An available RNG must not replace a stored identity"
    );
}
console.log(
    "PASS: secure 128-bit device IDs, msCrypto, ES5 API guards, preserved/provisioned IDs and swop fail-closed"
);

for (const rng of [undefined, "crypto", "msCrypto"]) {
    const c = fixture({ rng, storageBlocked: true });
    c.deviceUUID = "";
    c.settings.deviceUuid = "";
    assert.equal(c.ensureDeviceClientId(), rng ? expected : "");
    assert.equal(
        c.ensureDeviceClientId("operator-provisioned-device"),
        "operator-provisioned-device"
    );
}
console.log(
    "PASS: secure/provisioned identity remains usable when storage access throws"
);

{
    const c = fixture({ rng: "crypto" });
    c.applyLocalSwopConfig();
    c.requests[0].success({ swopBaseUrl: "/swop/" });
    assert.equal(
        c.getSwopBaseUrl(),
        "/swop",
        "Server relay replaces a saved direct Worker URL"
    );
    assert.equal(
        c.ensureDeviceClientId(),
        expected,
        "Installation config keeps each device identity"
    );
    c.swopLoadValue();
    const session = c.requests[1];
    assert.equal(session.url, "/swop/session");
    assert.equal(
        session.headers.Authorization,
        undefined,
        "Browser never has installation credentials"
    );
    const phoneUrl = "https://swop.test/?c=ABCDEF&t=phone-write-capability";
    session.success({
        code: "ABCDEF",
        entryCode: "ABCDEF-GHJKLM",
        entryUrl: "https://swop.test/",
        sessionToken: "private-read-capability",
        url: phoneUrl,
    });
    assert.deepEqual(
        c.qrUrls,
        [phoneUrl],
        "Preserve phone write token in QR URL"
    );
    const panel = JSDOM.fragment(c.messages.at(-1));
    const visible = panel.textContent;
    assert.deepEqual(
        Array.from(panel.querySelectorAll("span"), (span) => span.textContent),
        ["https://swop.test/", "ABCDEF-GHJKLM"],
        "Show exactly the short service address and complete manual entry code"
    );
    assert(
        !visible.includes("?c="),
        "Manual entry must not display the full QR URL"
    );
    assert(
        !visible.includes("phone-write-capability"),
        "QR write capability must not appear as TV text"
    );
    assert(
        !c.messages.join(" ").includes("private-read-capability"),
        "Poll token must not be displayed"
    );
    assert(
        !JSON.stringify(c.storage).includes("private-read-capability"),
        "Poll token must not be persisted"
    );
    c.timers.find((timer) => timer.delay === 3000).callback();
    const poll = c.requests[2];
    assert.equal(poll.url, "/swop/val");
    assert.equal(poll.type, "POST");
    assert.deepEqual(JSON.parse(poll.data), {
        clientId: expected,
        code: "ABCDEF",
        sessionToken: "private-read-capability",
    });
    assert.equal(poll.headers["X-Swop-Client-Id"], expected);
    poll.success({ status: "ready", value: "https://playlist.test/list.m3u" });
    assert.equal(c.editvar, "https://playlist.test/list.m3u");
}

{
    const c = fixture({ rng: "crypto" });
    c.swopLoadValue();
    c.requests[0].error({
        responseJSON: { error: "installation origin denied" },
        status: 403,
    });
    assert(
        c.messages.join(" ").includes("Check this server's SWOP configuration.")
    );
    assert(!c.messages.join(" ").includes("Allowlist this Device ID"));
}
console.log(
    "PASS: installation relay config, private per-session polling, unchanged phone QR and installation errors"
);

{
    const c = fixture({ noTypedArrays: true });
    c.applyLocalSwopConfig();
    c.requests[0].success({ swopBaseUrl: "/swop" });
    c.swopLoadValue();
    const session = c.requests[1];
    assert.equal(session.url, "/swop/session");
    assert.equal(session.headers["X-Swop-Client-Id"], "");
    session.success({
        clientId: "dev_server_generated_secure_id",
        code: "ABCDEF",
        sessionToken: "server-read-token",
        url: "https://swop.test/?c=ABCDEF&t=server-write-token",
    });
    const panel = JSDOM.fragment(c.messages.at(-1));
    assert.deepEqual(
        Array.from(panel.querySelectorAll("span"), (span) => span.textContent),
        ["https://swop.test/?c=ABCDEF&t=server-write-token", "ABCDEF"],
        "Older Worker responses retain their decoded manual URL and session code"
    );
    assert.equal(c.storage.ott_device_uuid, "dev_server_generated_secure_id");
    c.timers.find((timer) => timer.delay === 3000).callback();
    assert.equal(
        JSON.parse(c.requests[2].data).clientId,
        "dev_server_generated_secure_id"
    );
    assert.equal(c.alerts.length, 0);
}
console.log(
    "PASS: installation relay provisions legacy TVs without browser crypto"
);

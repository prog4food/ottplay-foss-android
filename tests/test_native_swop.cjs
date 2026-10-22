const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
// Capacitor's default debug bridge logger records options and results, including
// drafts and scoped tokens. Keep the shipping config safe in Debug as well.
const configModule = { exports: {} };
require("node:vm").runInNewContext(
    ts.transpileModule(fs.readFileSync("capacitor.config.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    { exports: configModule.exports, module: configModule }
);
const capacitorConfig = configModule.exports.default;
assert.equal(capacitorConfig.loggingBehavior, "none");
for (const platform of ["ios", "android"])
    assert(
        [undefined, "none"].includes(capacitorConfig[platform]?.loggingBehavior)
    );
const source = fs.readFileSync("src/plugins/native-http.ts", "utf8");
const script = ts
    .transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ES2015,
            target: ts.ScriptTarget.ES5,
        },
    })
    .outputText.replace(/^export /gm, "");
function fixture(platform = "tauri", responder) {
    const dom = new JSDOM("", {
        runScripts: "outside-only",
        url:
            platform === "tauri"
                ? "http://tauri.localhost/"
                : "capacitor://localhost/",
    });
    const w = dom.window;
    w.eval(
        fs.readFileSync(
            process.argv.includes("--jquery4")
                ? "node_modules/jquery/dist/jquery.min.js"
                : "js/jquery-1.11.1.min.js",
            "utf8"
        )
    );
    w.eval(script);
    const calls = [];
    const request = (command, args) => {
        calls.push({ args, command });
        return responder
            ? responder(args)
            : Promise.resolve({
                  body: '{"status":"ready","value":"Привет & <test> + 42"}',
                  headers: "Content-Type: application/json\r\n",
                  status: 200,
                  statusText: "OK",
              });
    };
    if (platform === "tauri") w.installTauriHttpTransport(w.$, request);
    else {
        w.Capacitor = { isNativePlatform: () => platform !== "web" };
        w.installCapacitorHttpTransport(w.$, {
            httpRequest: (args) => request("generic", args),
            swopRequest: (args) => request("swopRequest", args),
        });
    }
    return { calls, close: () => w.close(), w };
}
const options = (extra = {}) =>
    Object.assign(
        {
            contentType: "application/json",
            data: '{"draft":"Привет"}',
            dataType: "json",
            headers: { "X-Swop-Client-Id": "device-123" },
            swopNativeRequest: true,
            timeout: 1000,
            type: "POST",
            url: "https://relay.example/swop/session",
        },
        extra
    );
const settle = (xhr) =>
    new Promise((resolve) => {
        xhr.done((data, status, jq) => resolve({ data, jq, ok: true, status }));
        xhr.fail((jq, status) => resolve({ jq, ok: false, status }));
    });
(async () => {
    let groups = 0;
    for (const platform of ["tauri", "capacitor"]) {
        const f = fixture(platform);
        const result = await settle(f.w.$.ajax(options()));
        assert.equal(result.ok, true);
        assert.equal(result.data.value, "Привет & <test> + 42");
        assert.equal(
            f.calls[0].command,
            platform === "tauri" ? "swop_http" : "swopRequest"
        );
        assert.deepEqual(Object.keys(f.calls[0].args).sort(), [
            "body",
            "clientId",
            "url",
        ]);
        assert.equal(f.calls[0].args.clientId, "device-123");
        f.close();
        groups++;
    }
    for (const url of [
        "http://relay.example/swop/session",
        "https://user:pass@relay.example/swop/session",
        "https://relay.example/swop/session?q=x",
        "https://relay.example/swop/session#x",
        "https://relay.example/swop/%73ession",
        "https://relay.example/x/../swop/session",
        "https://relay.example/swop/val/",
        "https://relay.example:0/swop/session",
        "https://relay.example:65536/swop/session",
        "http://localhost/swop/session",
        "http://127.1/swop/session",
        "http://2130706433/swop/session",
        "https://relay.example\\@evil.example/swop/session",
        "/swop/session",
    ]) {
        const f = fixture();
        const r = await settle(f.w.$.ajax(options({ url })));
        assert.equal(r.ok, false, url);
        assert.equal(f.calls.length, 0, url);
        f.close();
        groups++;
    }
    for (const url of [
        "http://127.0.0.1:8443/swop/session",
        "http://[::1]:8443/swop/val",
    ]) {
        const f = fixture();
        assert.equal((await settle(f.w.$.ajax(options({ url })))).ok, true);
        f.close();
        groups++;
        const mobile = fixture("capacitor");
        assert.equal(
            (await settle(mobile.w.$.ajax(options({ url })))).ok,
            false
        );
        assert.equal(mobile.calls.length, 0);
        mobile.close();
        groups++;
    }
    for (const extra of [
        { type: "GET" },
        { data: "[]" },
        { data: "invalid" },
        { data: JSON.stringify({ draft: "я".repeat(32768) }) },
        {
            headers: {
                Authorization: "Bearer secret",
                "X-Swop-Client-Id": "device",
            },
        },
        { headers: { Cookie: "secret", "X-Swop-Client-Id": "device" } },
        {
            headers: {
                Origin: "https://spoof.example",
                "X-Swop-Client-Id": "device",
            },
        },
        { headers: { "X-Swop-Client-Id": "bad\r\nvalue" } },
    ]) {
        const f = fixture();
        const r = await settle(f.w.$.ajax(options(extra)));
        assert.equal(r.ok, false);
        assert.equal(f.calls.length, 0);
        f.close();
        groups++;
    }
    for (const value of ["界".repeat(8000), "\u0001".repeat(8000)]) {
        const body = JSON.stringify({ status: "ready", value });
        assert(
            Buffer.byteLength(body) > 16384 && Buffer.byteLength(body) <= 65536
        );
        const f = fixture("tauri", () =>
            Promise.resolve({
                body,
                headers: "Content-Type: application/json\r\n",
                status: 200,
                statusText: "OK",
            })
        );
        assert.equal(
            (
                await settle(
                    f.w.$.ajax(
                        options({
                            data: JSON.stringify({
                                draft: "\u0001".repeat(4000),
                            }),
                        })
                    )
                )
            ).data.value,
            value
        );
        f.close();
        groups++;
    }
    // Exercise the actual SWOP controller through real jQuery/native transport:
    // create session -> scoped native poll -> resume the original editor draft.
    const swopSource = ts.createSourceFile(
        "swop.ts",
        fs.readFileSync("src/swop/index.ts", "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const swopScript = ts.transpileModule(
        swopSource.statements
            .filter((n) => !ts.isImportDeclaration(n))
            .map((n) => n.getText(swopSource).replace(/^export\s+/, ""))
            .join("\n"),
        {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
    for (const platform of ["tauri", "capacitor"]) {
        const result = "界".repeat(8000);
        const f = fixture(platform, (args) =>
            Promise.resolve({
                body: JSON.stringify(
                    args.url.endsWith("/session")
                        ? {
                              code: "ABCDEF",
                              entryCode: "ABCDEF-123456",
                              sessionToken: "read-only-token",
                              url: "https://phone.example/",
                          }
                        : { status: "ready", value: result }
                ),
                headers: "Content-Type: application/json\r\n",
                status: 200,
                statusText: "OK",
            })
        );
        let resumed, cleanup;
        const owner = {
            active: () => true,
            own: (fn) => {
                cleanup = fn;
                return () => {};
            },
        };
        Object.assign(f.w, require("./load-wire.cjs")(), {
            _: (text) => text,
            __ottClassicScreenPort: { owner: () => owner },
            curColor: "gold",
            deviceUUID: "device-123",
            editCaption: "Search",
            editKey: () => {},
            editvar: "typed draft",
            makeQrSvg: () => "",
            renderButtonHint: () => "",
            saveSettings() {},
            settings: {},
            showEditKey: () => {
                resumed = f.w.editvar;
            },
            sSwopBaseUrl: "https://relay.example/swop",
            strRETURN: "Return",
        });
        f.w.document.body.innerHTML =
            '<div id="listEdit"></div><div id="listPodval"></div>';
        f.w.keys = { EXIT: 27, RETURN: 8 };
        const timer = f.w.setTimeout.bind(f.w);
        f.w.setTimeout = (fn, ms) => timer(fn, ms === 3000 ? 0 : ms);
        f.w.eval(swopScript);
        f.w.swopLoadValue();
        for (let i = 0; i < 30 && resumed === undefined; i++)
            await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(resumed, result);
        assert.equal(f.calls.length, 2);
        assert.equal(JSON.parse(f.calls[0].args.body).draft, "typed draft");
        assert.equal(
            JSON.parse(f.calls[1].args.body).sessionToken,
            "read-only-token"
        );
        cleanup();
        f.close();
        groups++;
    }
    const error = fixture("tauri", () =>
        Promise.resolve({
            body: '{"error":"denied"}',
            headers: "Content-Type: application/json\r\n",
            status: 403,
            statusText: "Forbidden",
        })
    );
    const denied = await settle(error.w.$.ajax(options()));
    assert.equal(denied.ok, false);
    assert.equal(denied.jq.status, 403);
    assert.equal(denied.jq.responseJSON.error, "denied");
    error.close();
    groups++;
    for (const action of ["abort", "timeout"]) {
        let resolve;
        const f = fixture(
            "tauri",
            () =>
                new Promise((r) => {
                    resolve = r;
                })
        );
        let successes = 0;
        const xhr = f.w.$.ajax(
            options({
                success: () => successes++,
                timeout: action === "timeout" ? 10 : 1000,
            })
        );
        const result = settle(xhr);
        if (action === "abort") xhr.abort();
        assert.equal((await result).status, action);
        resolve({ body: "{}", headers: "", status: 200, statusText: "OK" });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(successes, 0);
        f.close();
        groups++;
    }
    const old = fixture("tauri", () =>
        Promise.reject(
            new Error("Unknown swop_http: secret.example?token=SECRET")
        )
    );
    const unsupported = await settle(old.w.$.ajax(options()));
    assert.equal(unsupported.ok, false);
    assert.equal(old.calls.length, 1);
    assert.equal(unsupported.jq.responseText.includes("SECRET"), false);
    old.close();
    groups++;
    // Actual browser XMLHttpRequest path stays selected even with the explicit marker.
    const web = fixture("web");
    let browserCalls = 0;
    web.w.$.ajaxTransport("+*", () => ({
        abort() {},
        send: (_h, done) => {
            browserCalls++;
            done(
                200,
                "OK",
                { text: "{}" },
                "Content-Type: application/json\r\n"
            );
        },
    }));
    assert.equal((await settle(web.w.$.ajax(options()))).ok, true);
    assert.equal(web.calls.length, 0);
    assert.equal(browserCalls, 1);
    web.close();
    groups++;
    const plain = fixture();
    plain.w.$.ajaxTransport("+*", (opts) =>
        opts.swopNativeRequest
            ? undefined
            : {
                  abort() {},
                  send: (_h, done) => done(200, "OK", { text: "{}" }),
              }
    );
    assert.equal(
        (await settle(plain.w.$.ajax(options({ swopNativeRequest: false }))))
            .ok,
        true
    );
    assert.equal(plain.calls.length, 0);
    plain.close();
    groups++;
    console.log(`PASS ${groups} native SWOP transport groups`);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});

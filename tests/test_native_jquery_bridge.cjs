const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
function compile(file) {
    return ts
        .transpileModule(read(file), {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        })
        .outputText.replace(/^import[^;]*;\s*/gm, "")
        .replace(/^export\s*\{[^}]*\};?\s*/gm, "")
        .replace(/^export\s+/gm, "");
}
const helper = compile("src/plugins/jquery-bridge.ts");
acorn.parse(helper, { ecmaVersion: 5 });
const variants = [
    ["js/jquery-1.11.1.min.js", "1.11.1"],
    ["node_modules/jquery/dist/jquery.min.js", "4.0.0"],
];

function fixture(file, expectedVersion) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
        runScripts: "outside-only",
        url: "https://native.invalid/",
    });
    const w = dom.window;
    w.eval(read(file));
    assert.equal(w.$.fn.jquery, expectedVersion);
    w.eval(helper);
    w.eval(compile("src/plugins/native-bridge.ts"));
    return { close: () => w.close(), w };
}

function controlledThenable() {
    const pending = {};
    return {
        pending,
        thenable: {
            then(resolve, reject) {
                pending.resolve = resolve;
                pending.reject = reject;
            },
        },
    };
}

function callbackContract(w, reject) {
    const events = [];
    const value = reject ? "portal unavailable" : { body: "Native response" };
    const { pending, thenable } = controlledThenable();
    let returned;
    const opts = {
        complete(dfd, status) {
            assert.equal(this, opts);
            assert.equal(arguments.length, 2);
            assert.equal(dfd, returned);
            assert.equal(dfd.state(), "pending");
            events.push("complete:" + status);
            throw new Error("consumer complete failure");
        },
        // The old shims invoke option callbacks as opts methods, even when
        // context is present. Do not silently substitute $.ajax semantics.
        context: { unrelated: true },
        error(xhr, status, message) {
            assert.equal(this, opts);
            assert.equal(arguments.length, 3);
            assert.equal(xhr.status, 0);
            assert.equal(xhr.responseText, value);
            assert.equal(message, value);
            events.push(status);
            throw new Error("consumer error failure");
        },
        success(data, status, dfd) {
            assert.equal(this, opts);
            assert.equal(arguments.length, 3);
            assert.equal(data, value);
            assert.equal(dfd, returned);
            events.push(status);
            throw new Error("consumer success failure");
        },
    };
    returned = w.nativePromiseToJq(w.$, thenable, opts, "fallback");
    assert.equal(returned.state(), "pending");
    assert.equal(typeof returned.resolve, "function");
    returned
        .done(function (result) {
            assert.equal(arguments.length, 1);
            assert.equal(result, value);
            events.push("done");
        })
        .fail(function (result) {
            assert.equal(arguments.length, 1);
            assert.equal(result, value);
            events.push("fail");
        })
        .always(function (result) {
            assert.equal(arguments.length, 1);
            assert.equal(result, value);
            events.push("always");
        });
    pending[reject ? "reject" : "resolve"](value);
    assert.deepEqual(
        events,
        reject
            ? ["error", "complete:error", "fail", "always"]
            : ["success", "complete:success", "done", "always"]
    );
    assert.equal(returned.state(), reject ? "rejected" : "resolved");
    let late;
    returned[reject ? "fail" : "done"]((result) => {
        late = result;
    });
    assert.equal(late, value, "Deferred retains settlement for late listeners");
}

function synchronousBoundaries(w) {
    for (const error of [null, undefined, 0, false, "", new Error("native")]) {
        for (const fallback of ["proxy_fetch failed", "portalRequest failed"]) {
            const expected = error == null ? fallback : String(error);
            const jq = w.nativePromiseToJq(
                w.$,
                {
                    then(_resolve, reject) {
                        reject(error);
                    },
                },
                {},
                fallback
            );
            assert.equal(jq.state(), "rejected");
            jq.fail((message) => assert.equal(message, expected));
        }
    }
    const events = [];
    const opts = {
        complete() {
            events.push("complete");
        },
        get success() {
            throw new Error("success getter");
        },
    };
    const jq = w.nativePromiseToJq(
        w.$,
        {
            then(resolve) {
                events.push("then");
                resolve("value");
            },
        },
        opts,
        "fallback"
    );
    events.push("returned");
    assert.equal(jq.state(), "resolved");
    assert.deepEqual(events, ["then", "complete", "returned"]);

    const failure = new Error("then getter");
    assert.throws(
        () =>
            w.nativePromiseToJq(
                w.$,
                {
                    get then() {
                        throw failure;
                    },
                },
                {},
                "fallback"
            ),
        (error) => error === failure
    );
    // Only option callbacks are isolated. A synchronous Deferred listener
    // failure still propagates through the original thenable invocation.
    const controlled = controlledThenable();
    const deferred = w.nativePromiseToJq(
        w.$,
        controlled.thenable,
        {},
        "fallback"
    );
    deferred.done(() => {
        throw failure;
    });
    assert.throws(
        () => controlled.pending.resolve("value"),
        (error) => error === failure
    );
}

async function promiseTiming(w) {
    const events = [];
    const nativeResponse = { body: "native text", status: 200 };
    const jq = w.nativePromiseToJq(
        w.$,
        Promise.resolve(nativeResponse),
        {
            complete() {
                events.push("complete");
            },
            success(value) {
                assert.equal(value, nativeResponse);
                events.push("success");
            },
        },
        "fallback"
    );
    jq.done(() => events.push("done"));
    events.push("returned");
    assert.equal(jq.state(), "pending");
    await Promise.resolve();
    assert.deepEqual(events, ["returned", "success", "complete", "done"]);
}

function outcome(jq) {
    return new Promise((resolve) => {
        jq.done((value) => resolve({ ok: true, value }));
        jq.fail((value) => resolve({ ok: false, value }));
    });
}

async function tauriInvokeContract(w) {
    for (const mode of ["core", "legacy", "empty-core"]) {
        for (const outcome of ["resolve", "reject", "throw"]) {
            const args = { url: "https://portal.invalid/" };
            const failure = new Error("native fixture");
            const result =
                outcome === "reject"
                    ? Promise.reject(failure)
                    : Promise.resolve(args);
            const owner = {
                invoke(command, value) {
                    assert.equal(this, owner);
                    assert.equal(command, "fixture_command");
                    assert.equal(value, args);
                    if (outcome === "throw") throw failure;
                    return result;
                },
            };
            w.__TAURI__ =
                mode === "core"
                    ? {
                          core: owner,
                          invoke() {
                              assert.fail("core.invoke must take precedence");
                          },
                      }
                    : owner;
            if (mode === "empty-core") owner.core = {};
            if (outcome === "throw") {
                assert.throws(
                    () => w.tauriInvoke("fixture_command", args),
                    (error) => error === failure
                );
            } else {
                assert.equal(w.tauriInvoke("fixture_command", args), result);
                if (outcome === "reject")
                    await assert.rejects(result, (error) => error === failure);
                else assert.equal(await result, args);
            }
        }
    }
    delete w.__TAURI__;
}

async function nativeRoutes(w) {
    let response = {
        body: '{"channels":["fixture"]}',
        contentType: "application/json",
        status: 200,
    };
    const calls = [];
    const portal = {
        portalRequest(args) {
            calls.push(args);
            return Promise.resolve(response);
        },
    };
    w.resolveNativePlugin = (name) => {
        if (name === "StalkerPortal") return portal;
        assert.equal(name, "M3UProxy");
        return {
            proxyFetch(args) {
                calls.push(args);
                return Promise.resolve({ body: "#EXTM3U\nnative fixture" });
            },
        };
    };
    w.installCapacitorHttpTransport = () => {};
    w.eval(compile("src/plugins/stalker-portal.ts"));
    w.setupStalkerPortalShim();
    let result = await outcome(
        w.$.ajax({
            dataType: "json",
            url: "https://portal.invalid/stalker_portal/api/",
        })
    );
    assert.equal(result.ok, true);
    assert.equal(result.value.channels[0], "fixture");
    response = { body: "denied", contentType: "text/plain", status: 403 };
    result = await outcome(
        w.$.ajax({ url: "https://portal.invalid/stalker_portal/api/" })
    );
    assert.equal(result.ok, false);
    assert.match(result.value, /stalker HTTP 403: denied/);

    w.__TAURI__ = {
        core: {
            invoke(command, args) {
                assert.equal(command, "stalker_portal_fetch");
                calls.push(args);
                return Promise.resolve({
                    body: "native tauri text",
                    status: 200,
                });
            },
        },
    };
    result = await outcome(
        w.$.ajax({ url: "https://portal.invalid/stalker_portal/stream/" })
    );
    assert.deepEqual(result, { ok: true, value: "native tauri text" });
    delete w.__TAURI__;

    function invoke(command, args) {
        assert.equal(command, "stalker_portal_fetch");
        assert.ok(this === w.__TAURI__ || this === w.__TAURI__.core);
        calls.push(args);
        return Promise.resolve(response);
    }
    for (const transport of [null, { core: { invoke } }, { invoke }]) {
        if (transport) w.__TAURI__ = transport;
        else delete w.__TAURI__;
        w.__ottStalkerCookieJar = {};
        const url = "https://portal.invalid/stalker_portal/api/";
        for (const [status, body, contentType, expected] of [
            [200, '{"ok":true}', "application/json", { ok: true }],
            [201, "invalid JSON", "application/json", "invalid JSON"],
            [204, "", "text/plain", ""],
            [403, "denied", "text/plain", "Error: stalker HTTP 403: denied"],
        ]) {
            response = {
                body,
                contentType,
                setCookie: ["session=" + status + "; Path=/; HttpOnly"],
                status,
            };
            const events = [];
            const jq = w.$.ajax({
                complete() {
                    assert.equal(this.url, url);
                    events.push("complete");
                },
                data: { request: status },
                error() {
                    events.push("error");
                },
                success() {
                    events.push("success");
                },
                type: "POST",
                url,
            });
            events.push("returned");
            assert.equal(jq.state(), "pending");
            const result = await outcome(jq);
            assert.equal(result.ok, status < 300);
            assert.deepEqual(
                JSON.parse(JSON.stringify(result.value)),
                expected
            );
            assert.deepEqual(events, [
                "returned",
                status < 300 ? "success" : "error",
                "complete",
            ]);
            const request = calls[calls.length - 1];
            assert.equal(request.method, "POST");
            assert.equal(request.body, JSON.stringify({ request: status }));
            assert.equal(request.contentType, "application/json");
            await outcome(w.$.ajax({ url }));
            assert.equal(
                calls[calls.length - 1].headers.Cookie,
                "session=" + status,
                "the next request sends cookies even when the prior HTTP status rejected"
            );
            await outcome(
                w.$.ajax({
                    headers: {
                        Authorization: "Bearer fixture",
                        cookie: "caller=1",
                    },
                    url,
                })
            );
            const explicit = calls[calls.length - 1].headers;
            assert.equal(explicit.cookie, "caller=1");
            assert.equal(explicit.Cookie, undefined);
            assert.equal(explicit.Authorization, "Bearer fixture");
            await outcome(
                w.$.ajax({
                    url:
                        "https://other-" +
                        status +
                        ".invalid/stalker_portal/api/",
                })
            );
            assert.equal(
                calls[calls.length - 1].headers,
                undefined,
                "the cookie jar remains isolated by origin"
            );
        }
    }
    delete w.__TAURI__;
    const beforeProxy = calls.length;

    w.eval(compile("src/plugins/m3u-proxy.ts"));
    w.setupCapacitorCompanionShim();
    result = await outcome(
        w.$.ajax({
            data: { url: "https://stream.invalid/list.m3u" },
            url: "/m3u/cp.php",
        })
    );
    assert.deepEqual(result, { ok: true, value: "#EXTM3U\nnative fixture" });
    assert.equal(
        calls.length,
        beforeProxy + 1,
        "all response checks use actual native route wrappers"
    );
    assert.equal(calls[beforeProxy].url, "https://stream.invalid/list.m3u");
    const target = "https://stream.invalid/list.m3u";
    const encodedTarget = "url=" + encodeURIComponent(target);
    for (const [data, userAgent, referer] of [
        [
            {
                referer: "https://origin.invalid/a+b",
                ua: "Player + Test",
                url: target,
            },
            "Player + Test",
            "https://origin.invalid/a+b",
        ],
        [
            encodedTarget +
                "&ua=Player+%2B+Test&referer=https%3A%2F%2Forigin.invalid%2Fa%2Bb",
            "Player + Test",
            "https://origin.invalid/a+b",
        ],
        [{ referer: "", ua: "", url: target }, undefined, undefined],
        [encodedTarget + "&ua=&referer=", undefined, undefined],
        [{ referer: null, ua: null, url: target }, undefined, undefined],
        [{ referer: 3, ua: false, url: target }, undefined, undefined],
        [{ url: target }, undefined, undefined],
    ]) {
        const before = calls.length;
        const response = await outcome(w.$.ajax({ data, url: "/m3u/cp.php" }));
        assert.equal(response.ok, true);
        assert.equal(calls.length, before + 1);
        assert.equal(calls[before].url, target);
        assert.equal(calls[before].userAgent, userAgent);
        assert.equal(calls[before].referer, referer);
    }
    for (const data of [null, "", undefined]) {
        const before = calls.length;
        const response = await outcome(w.$.ajax({ data, url: "/m3u/cp.php" }));
        assert.equal(response.ok, false);
        assert.match(response.value, /missing url/);
        assert.equal(calls.length, before);
    }
    for (const throwing of [undefined, "ua", "referer"]) {
        const reads = [];
        const failure = new Error("header getter failed");
        const data = {};
        for (const [key, value] of [
            ["url", target],
            ["ua", "Stateful player"],
            ["referer", "https://origin.invalid/"],
        ]) {
            Object.defineProperty(data, key, {
                get() {
                    reads.push(key);
                    if (key === throwing) throw failure;
                    return value;
                },
            });
        }
        const before = calls.length;
        if (throwing) {
            assert.throws(
                () => w.$.ajax({ data, url: "/m3u/cp.php" }),
                (error) => error === failure
            );
            assert.equal(calls.length, before);
        } else {
            assert.equal(
                (await outcome(w.$.ajax({ data, url: "/m3u/cp.php" }))).ok,
                true
            );
            assert.equal(calls.length, before + 1);
            assert.equal(calls[before].userAgent, "Stateful player");
            assert.equal(calls[before].referer, "https://origin.invalid/");
        }
        assert.deepEqual(
            reads,
            throwing === "ua" ? ["url", "ua"] : ["url", "ua", "referer"]
        );
    }
    for (const field of ["ua", "referer"]) {
        const before = calls.length;
        assert.throws(
            () =>
                w.$.ajax({
                    data: encodedTarget + "&" + field + "=%",
                    url: "/m3u/cp.php",
                }),
            (error) => error.name === "URIError"
        );
        assert.equal(calls.length, before);
    }
    const decoded = [];
    const decode = w.decodeURIComponent;
    w.decodeURIComponent = (value) => {
        decoded.push(value);
        return decode(value);
    };
    const beforeInvalid = calls.length;
    try {
        assert.throws(
            () =>
                w.$.ajax({
                    data: encodedTarget + "&ua=%&referer=%E0%A4%A",
                    url: "/m3u/cp.php",
                }),
            (error) => error.name === "URIError"
        );
    } finally {
        w.decodeURIComponent = decode;
    }
    assert.deepEqual(decoded, [encodeURIComponent(target), "%"]);
    assert.equal(calls.length, beforeInvalid);
}

(async () => {
    for (const [file, version] of variants) {
        const { w, close } = fixture(file, version);
        try {
            callbackContract(w, false);
            callbackContract(w, true);
            synchronousBoundaries(w);
            await promiseTiming(w);
            await tauriInvokeContract(w);
            await nativeRoutes(w);
            console.log(
                "PASS native jQuery bridge " +
                    version +
                    ": callback order, receivers, failures, timing and native response routes"
            );
        } finally {
            close();
        }
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

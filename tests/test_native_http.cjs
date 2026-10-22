let testStage = "loading dependencies";
let testDeadline;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const compile = (source) =>
    ts
        .transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        })
        .outputText.replace(/^import .*\n/gm, "")
        .replace(/^export /gm, "");
function functions(file, names) {
    const source = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    );
    return names
        .map((name) => {
            const node = source.statements.find(
                (node) => node.name?.text === name
            );
            assert.ok(node, `${file}: missing ${name}`);
            return node.getText(source);
        })
        .join("\n");
}
const shim = compile(
    functions("src/index.ts", [
        "isTauriEmbedMode",
        "isRemoteHttpUrlForProxy",
        "setupTauriCompanionShim",
    ])
);
function response(body, status = 200, contentType = "application/json") {
    return {
        body,
        headers: `Content-Type: ${contentType}\r\nX-Upstream: yes\r\n`,
        status,
        statusText: status === 200 ? "OK" : "Forbidden",
    };
}
function runtime(
    invoke,
    native = true,
    platform = "tauri",
    url,
    capabilities = {}
) {
    const cancelled = [];
    const dom = new JSDOM(
        "<!doctype html><html><head></head><body></body></html>",
        {
            runScripts: "outside-only",
            url:
                url ||
                (platform === "tauri"
                    ? "http://tauri.localhost/"
                    : "capacitor://localhost/"),
        }
    );
    const w = dom.window;
    require("./helpers/shared-core-runtime.cjs")(dom.getInternalVMContext());
    require("./helpers/operator-fixture-host.cjs")(dom.getInternalVMContext());
    w.eval(read("js/jquery-1.11.1.min.js"));
    if (native && platform === "tauri") w.__TAURI__ = {};
    if (platform === "capacitor")
        w.Capacitor = {
            getPlatform: () => capabilities.platform || "ios",
            isNativePlatform: () => native,
            Plugins: capabilities.access ? { AccessMedia: {} } : {},
        };
    w.tauriInvoke = invoke;
    w.eval(compile(read("src/plugins/jquery-bridge.ts")));
    w.eval(compile(read("src/plugins/native-http.ts")));
    w.eval(shim);
    const originalAjax = w.$.ajax;
    if (native && platform === "capacitor") {
        w.installCapacitorHttpTransport(w.$, {
            cancelHttpRequest:
                capabilities.cancel === false
                    ? undefined
                    : ({ requestId }) => {
                          cancelled.push(requestId);
                          return Promise.reject(
                              new Error("optional cancellation rejected")
                          );
                      },
            httpRequest: (args) => invoke("proxy_http", args),
        });
    } else {
        w.setupTauriCompanionShim();
    }
    return { $: w.$, cancelled, close: () => w.close(), originalAjax, w };
}
function finished(xhr) {
    return new Promise((resolve) => {
        xhr.done(function (data, status, jqXHR) {
            resolve({
                count: arguments.length,
                data,
                ok: true,
                status,
                xhr: jqXHR,
            });
        });
        xhr.fail(function (jqXHR, status, error) {
            resolve({
                count: arguments.length,
                error,
                ok: false,
                status,
                xhr: jqXHR,
            });
        });
    });
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ordinary XHR is an in-memory fixture, so an unhandled VPortal POST cannot
// silently touch the network while the bridge-selection regression runs.
function fallbackXhr() {
    return {
        abort() {},
        getAllResponseHeaders() {
            return "Content-Type: application/json\r\n";
        },
        open() {},
        readyState: 0,
        responseText: "{}",
        send() {
            setTimeout(() => {
                this.readyState = 4;
                if (this.onreadystatechange) this.onreadystatechange();
            }, 0);
        },
        setRequestHeader() {},
        status: 200,
        statusText: "OK",
    };
}

async function testTauriOriginRouting() {
    const companionOrigins = ["127.0.0.1", "localhost"].flatMap((host) =>
        [8443, 8444, 8445, 8446].map((port) => `http://${host}:${port}/`)
    );
    const embeddedOrigins = [
        "http://tauri.localhost/",
        "https://tauri.localhost/",
        "http://asset.localhost/",
        "https://asset.localhost/",
        "tauri://localhost/",
        "asset://localhost/",
    ];
    const capabilities = JSON.parse(
        read("src-tauri/capabilities/default.json")
    );
    assert.deepEqual(
        capabilities.remote.urls.slice().sort(),
        [...companionOrigins, ...embeddedOrigins]
            .map((url) => url + "*")
            .sort(),
        "Native capabilities allow the four HTTP companion ports and embedded origins only"
    );
    const retainedNativeOrigins = [
        ...embeddedOrigins,
        "http://127.0.0.1:5173/",
        "http://localhost:5173/",
        "https://127.0.0.1:8443/",
        "http://provider.example:8443/",
        "http://localhost.example:8443/",
        "http://127.0.0.1:18443/",
        "http://127.0.0.1:8447/",
        "http://127.0.0.1:8095/",
    ];
    const cases = [
        ...companionOrigins.map((url) => ({
            embedded: false,
            native: true,
            url,
        })),
        ...retainedNativeOrigins.map((url) => ({
            embedded: true,
            native: true,
            url,
        })),
        ...[
            companionOrigins[0],
            embeddedOrigins[0],
            "http://localhost:5173/",
        ].map((url) => ({ embedded: false, native: false, url })),
    ];
    for (const { embedded, native, url } of cases) {
        const calls = [];
        const r = runtime(
            async (command, args) => {
                calls.push({ args, command });
                return "native-match";
            },
            native,
            "tauri",
            url
        );
        try {
            let ordinaryXhrs = 0;
            r.$.ajaxSettings.xhr = () => {
                ordinaryXhrs++;
                return fallbackXhr();
            };
            assert.equal(r.w.isTauriEmbedMode(), embedded, url);
            assert.equal(r.$.ajax === r.originalAjax, !embedded, url);
            const result = await finished(
                r.$.ajax({
                    data: "fixture-channels",
                    dataType: "text",
                    type: "POST",
                    url: "/m3u/match-channels",
                })
            );
            assert.equal(result.ok, true, url);
            assert.equal(result.data, embedded ? "native-match" : "{}", url);
            assert.equal(ordinaryXhrs, embedded ? 0 : 1, url);
            assert.equal(calls.length, embedded ? 1 : 0, url);
            if (embedded) {
                assert.equal(calls[0].command, "match_channels", url);
                assert.equal(calls[0].args.body, "fixture-channels", url);
                assert.equal(calls[0].args.url, "/m3u/match-channels", url);
            }
        } finally {
            r.close();
        }
    }
    console.log(
        "OK: Tauri HTTP companion origins retain real XHR; embedded and native dev origins retain IPC; browsers remain isolated"
    );
}

async function run(platform) {
    testStage = `${platform} jQuery setup`;
    const calls = [];
    let reply = () => response('{"epg_data":[{"name":"Programme"}]}');
    const r = runtime(
        async (command, args) => {
            calls.push({ args, command });
            return reply(args);
        },
        true,
        platform
    );
    const { $, w } = r;
    // Bound asynchronous callbacks after synchronous jsdom/dependency loading.
    // Slow filesystem/module startup must not consume the AJAX test deadline.
    testDeadline = setTimeout(() => {
        console.error(
            `Native HTTP regression timed out after 30s (${platform}): ${testStage}`
        );
        process.exit(1);
    }, 30000);
    try {
        const context = { request: "provider" };
        const order = [];
        const xhr = $.ajax("https://provider.example/api#fragment", {
            beforeSend(q) {
                q.setRequestHeader("X-Provider", "custom");
            },
            complete(q, status) {
                assert.equal(q, xhr);
                assert.equal(status, "success");
                order.push("complete");
            },
            context,
            data: {
                channel: "BBC + Мир",
                filter: { day: "today" },
                ids: [1, 2],
            },
            dataType: "json",
            headers: { Authorization: "Bearer test" },
            statusCode: {
                200() {
                    order.push("statusCode");
                },
            },
            success(data, status, q) {
                assert.equal(this, context);
                assert.equal(q, xhr);
                assert.equal(status, "success");
                assert.equal(data.epg_data[0].name, "Programme");
                order.push("success");
            },
            timeout: 1000,
            url: "https://must-not-override.example/",
        })
            .done(function () {
                assert.equal(this, context);
                assert.equal(arguments.length, 3);
                order.push("done");
            })
            .always(() => order.push("always"));
        let result = await finished(xhr);
        assert.equal(result.ok, true);
        assert.equal(result.count, 3);
        assert.equal(result.xhr.status, 200);
        assert.equal(result.xhr.readyState, 4);
        assert.equal(result.xhr.responseJSON.epg_data[0].name, "Programme");
        assert.equal(result.xhr.getResponseHeader("X-Upstream"), "yes");
        assert.deepEqual(order, [
            "success",
            "done",
            "always",
            "statusCode",
            "complete",
        ]);
        const request = calls.pop();
        assert.equal(request.command, "proxy_http");
        const sent = new URL(request.args.url);
        assert.equal(sent.hostname, "provider.example");
        assert.equal(sent.hash, "");
        assert.equal(sent.searchParams.get("channel"), "BBC + Мир");
        assert.deepEqual(sent.searchParams.getAll("ids[]"), ["1", "2"]);
        assert.equal(sent.searchParams.get("filter[day]"), "today");
        assert.equal(request.args.headers.Authorization, "Bearer test");
        assert.equal(request.args.headers["X-Provider"], "custom");
        assert.equal(request.args.body, undefined);

        // Real OTTCLUB provider: complete must see the object parsed in success.
        testStage = "OTTCLUB provider callbacks";
        w.ottwww = "ottclub.example";
        w.eval(functions("providers/ottclub/provider.js", ["getEPGchanel"]));
        const epg = await new Promise((resolve) =>
            w.getEPGchanel("bbc", (id, data) => resolve({ data, id }))
        );
        assert.equal(epg.id, "bbc");
        assert.equal(epg.data[0].name, "Programme");

        reply = () => response('{"error":"denied"}', 403);
        testStage = "HTTP status and conversion";
        result = await finished(
            $.ajax({ dataType: "json", url: "https://provider.example/api" })
        );
        assert.equal(result.ok, false);
        assert.equal(result.status, "error");
        assert.equal(result.xhr.status, 403);
        assert.equal(result.error, "Forbidden");
        assert.equal(result.xhr.responseJSON.error, "denied");
        assert.equal(result.xhr.responseText, '{"error":"denied"}');

        reply = () => response("{invalid-json");
        result = await finished(
            $.ajax({ dataType: "json", url: "https://provider.example/api" })
        );
        assert.equal(result.ok, false);
        assert.equal(result.status, "parsererror");
        assert.equal(result.xhr.status, 200);
        assert.equal(result.xhr.responseText, "{invalid-json");

        reply = () =>
            Promise.reject({
                code: "timeout",
                message: "Native socket timed out",
            });
        result = await finished(
            $.ajax({ dataType: "json", url: "https://provider.example/api" })
        );
        assert.equal(result.ok, false);
        assert.equal(result.status, "timeout");
        assert.equal(result.xhr.status, 0);

        // Some playlist requests omit dataType. Never infer executable script
        // from the upstream MIME type, including jQuery 1.x HTTP-error conversion.
        for (const status of [200, 403]) {
            reply = () =>
                response(
                    "window.remoteCodeExecuted = true",
                    status,
                    "text/javascript"
                );
            result = await finished(
                $.ajax({ url: "https://provider.example/playlist" })
            );
            assert.equal(result.ok, status === 200);
            assert.equal(
                result.xhr.responseText,
                "window.remoteCodeExecuted = true"
            );
            if (status === 200)
                assert.equal(result.data, "window.remoteCodeExecuted = true");
            assert.equal(w.remoteCodeExecuted, undefined);
        }

        // Actual Shura JSONP provider chains week + archive from complete().
        testStage = "Shura chained JSONP callbacks";
        const seenJsonp = [];
        reply = (args) => {
            const url = new URL(args.url);
            const callback = url.searchParams.get("callback");
            assert.ok(callback);
            assert.ok(url.searchParams.has("_"));
            seenJsonp.push(url.pathname);
            return response(
                `/**/${callback}(${JSON.stringify([{ duration: 60, name: url.pathname, start_time: 100, text: "Description" }])});`,
                200,
                "text/javascript"
            );
        };
        let scriptEvaluations = 0;
        $.globalEval = () => {
            scriptEvaluations++;
            throw Error("Native JSONP must never evaluate remote JavaScript");
        };
        w.shserver = 1;
        w.chanels = { bbc: { rec: "1" } };
        w.eval(functions("providers/shura/provider.js", ["getEPGchanel"]));
        const shura = await new Promise((resolve) =>
            w.getEPGchanel("bbc", (id, data) => resolve({ data, id }))
        );
        assert.deepEqual(seenJsonp, [
            "/bbc/epg/week.jsonp",
            "/bbc/epg/archive.jsonp",
        ]);
        assert.equal(shura.data.length, 2);
        assert.equal(shura.data[0].time_to, 160);
        assert.equal(shura.data[0].name, "/bbc/epg/archive.jsonp");

        // JSONP opts.data is serialized before callback/cache parameters are appended.
        reply = (args) => {
            const url = new URL(args.url);
            assert.equal(url.searchParams.get("type"), "jsonp");
            assert.equal(url.searchParams.get("uid"), "sh123");
            return response(
                `${url.searchParams.get("callback")}([]);`,
                200,
                "text/javascript"
            );
        };
        result = await finished(
            $.ajax({
                data: { type: "jsonp", uid: "sh123" },
                dataType: "jsonp",
                url: "http://pl.tvshka.net",
            })
        );
        assert.equal(result.ok, true);
        assert.equal(result.data.length, 0);
        reply = (args) =>
            response(
                `${new URL(args.url).searchParams.get("callback")}([]); window.compromised = true;`,
                200,
                "text/javascript"
            );
        result = await finished(
            $.ajax({ dataType: "jsonp", url: "https://provider.example/epg" })
        );
        assert.equal(result.ok, false);
        assert.equal(result.status, "parsererror");
        assert.equal(w.compromised, undefined);

        testStage =
            "literal dollar JSONP callback and rejected callback syntax";
        const dollarCallback = "$ott$jsonp_1";
        let dollarReplies = 0;
        const originalDollarCallback = (value) => {
            dollarReplies++;
            assert.equal(value.marker, "literal-dollar");
        };
        w[dollarCallback] = originalDollarCallback;
        reply = (args) => {
            const callback = new URL(args.url).searchParams.get("callback");
            assert.equal(callback, dollarCallback);
            return response(
                `${callback}({"marker":"literal-dollar"});`,
                200,
                "text/javascript"
            );
        };
        result = await finished(
            $.ajax({
                dataType: "jsonp",
                jsonpCallback: dollarCallback,
                url: "https://provider.example/epg",
            })
        );
        assert.equal(result.ok, true);
        assert.equal(result.data.marker, "literal-dollar");
        assert.equal(dollarReplies, 1);
        assert.equal(w[dollarCallback], originalDollarCallback);
        delete w[dollarCallback];

        let invalidReplies = 0;
        for (const callback of [
            "bad\\callback",
            "bad.callback",
            "bad[callback]",
            "bad(callback)",
            "bad|callback",
        ]) {
            const originalCallback = () => invalidReplies++;
            w[callback] = originalCallback;
            reply = () =>
                response(
                    `${callback}({"marker":"invalid"}); window.invalidJsonpExecuted = true;`,
                    200,
                    "text/javascript"
                );
            result = await finished(
                $.ajax({
                    dataType: "jsonp",
                    jsonpCallback: callback,
                    url: "https://provider.example/epg",
                })
            );
            assert.equal(result.ok, false, callback);
            assert.equal(result.status, "parsererror", callback);
            assert.match(
                result.error.message,
                /Unsupported JSONP callback name/,
                callback
            );
            assert.equal(w[callback], originalCallback);
            assert.equal(w.invalidJsonpExecuted, undefined);
            delete w[callback];
        }
        assert.equal(invalidReplies, 0);
        assert.equal(scriptEvaluations, 0);

        reply = () => response("#EXTM3U", 200, "text/plain");
        testStage = "companion proxy and external EPG matching";
        result = await finished(
            $.ajax({
                data: { url: "@http://provider.example/list?a=1&b=2" },
                type: "POST",
                url: "/m3u/cp.php",
            })
        );
        assert.equal(result.data, "#EXTM3U");
        assert.equal(
            calls.at(-1).args.url,
            `${platform === "tauri" ? "@" : ""}http://provider.example/list?a=1&b=2`
        );
        assert.equal(calls.at(-1).args.method, "GET");
        assert.equal(calls.at(-1).args.body, undefined);

        result = await finished(
            $.ajax({
                data: "{}\n\t\nchannels",
                processData: false,
                type: "POST",
                url: "https://epg.example/m3u/match-channels",
            })
        );
        assert.equal(result.ok, true);
        assert.equal(calls.at(-1).command, "proxy_http");
        assert.equal(
            calls.at(-1).args.url,
            "https://epg.example/m3u/match-channels"
        );
        assert.equal(calls.at(-1).args.body, "{}\n\t\nchannels");
        assert.equal(calls.at(-1).args.method, "POST");

        testStage = "VPortal opt-in through the installed native transport";
        let ordinaryXhrs = 0;
        const originalXhr = $.ajaxSettings.xhr;
        $.ajaxSettings.xhr = () => {
            ordinaryXhrs++;
            return fallbackXhr();
        };
        const nonPortalPosts = [
            {},
            { vportalRequest: "true" },
            { contentType: "text/plain", vportalRequest: true },
            { contentType: "application/jsonx", vportalRequest: true },
            { dataType: "text", vportalRequest: true },
            { type: "PUT", vportalRequest: true },
            { url: "/ordinary-local-post", vportalRequest: true },
        ];
        const beforeOrdinaryPosts = calls.length;
        for (const overrides of nonPortalPosts) {
            const fallback = await finished(
                $.ajax({
                    contentType: "application/json",
                    data: "{}",
                    dataType: "json",
                    type: "POST",
                    url: "https://portal.example/api/v1/",
                    ...overrides,
                })
            );
            assert.equal(fallback.ok, true);
        }
        assert.equal(
            calls.length,
            beforeOrdinaryPosts,
            "Unmarked/non-JSON POSTs keep their existing XHR transport"
        );
        assert.equal(ordinaryXhrs, nonPortalPosts.length);

        testStage = "Plex PIN form POST has a narrow explicit native opt-in";
        const pinRequest = {
            contentType: "application/x-www-form-urlencoded; charset=UTF-8",
            data: {
                strong: "false",
                "X-Plex-Client-Identifier": "fixture-client",
            },
            dataType: "json",
            plexAuthRequest: true,
            type: "POST",
            url: "https://plex.tv/api/v2/pins",
        };
        reply = (args) => {
            assert.equal(args.url, pinRequest.url);
            assert.equal(args.method, "POST");
            assert.equal(new URLSearchParams(args.body).get("strong"), "false");
            return response('{"id":123,"code":"1234","expiresIn":900}', 201);
        };
        result = await finished($.ajax(pinRequest));
        assert.equal(result.ok, true);
        assert.equal(result.xhr.status, 201);
        const beforeInvalidPins = calls.length;
        const invalidPins = [
            { plexAuthRequest: false },
            { plexAuthRequest: "true" },
            { url: "http://plex.tv/api/v2/pins" },
            { url: "https://plex.tv.evil.example/api/v2/pins" },
            { url: "https://plex.tv/api/v2/pins/123" },
            { url: "https://plex.tv/api/v2/user" },
            { contentType: "application/json" },
            { type: "PUT" },
        ];
        for (const overrides of invalidPins)
            await finished($.ajax({ ...pinRequest, ...overrides }));
        assert.equal(calls.length, beforeInvalidPins);
        const ordinaryBeforePortal = ordinaryXhrs;

        w.eval(
            compile(
                functions("src/utils/helpers.ts", [
                    "metadataText",
                    "metadataImageUrl",
                ])
            )
        );
        w.eval(compile(read("src/plugins/vportal.ts")));
        w._ = (text) => text;
        w.sPageSize = 30;
        w._mediaLoadState = {};
        w.keys = { EXIT: 2, RETURN: 1, STOP: 3 };
        w.alert = (message) => {
            throw Error(`Unexpected VPortal error: ${message}`);
        };
        reply = (args) => {
            assert.equal(args.url, "http://portal.example/api/v1/");
            assert.equal(args.method, "POST");
            assert.match(args.headers["Content-Type"], /^application\/json;/);
            assert.deepEqual(JSON.parse(args.body), {
                app: "ott-play",
                key: "fixture-portal-key",
                limit: 300,
            });
            return response(
                JSON.stringify({
                    items: [
                        {
                            title: "Native fixture film",
                            type: "stream",
                            url: "https://cdn.example/film.mp4",
                        },
                    ],
                    type: "videoportal",
                })
            );
        };
        const client = w.createVPortalClient(
            "portal::[key:fixture-portal-key]http://portal.example/api/v1/",
            {
                sourceId: `native-fixture-${platform}`,
            }
        );
        const beforePortal = calls.length;
        await new Promise((resolve) => client.load("", resolve));
        assert.equal(calls.length, beforePortal + 1);
        assert.equal(calls.at(-1).command, "proxy_http");
        assert.equal(
            ordinaryXhrs,
            ordinaryBeforePortal,
            "VPortal must not use WebView XHR"
        );
        assert.equal(w.mediaRecords.length, 1);
        assert.equal(w.mediaRecords[0].title, "Native fixture film");
        assert.equal(
            w.mediaRecords[0].stream_url,
            "https://cdn.example/film.mp4"
        );
        client.dispose();
        $.ajaxSettings.xhr = originalXhr;

        let settle;
        testStage = "abort and timeout callbacks";
        let successes = 0;
        let completions = 0;
        reply = () =>
            new Promise((resolve) => {
                settle = resolve;
            });
        const pending = $.ajax({
            complete() {
                completions++;
            },
            success() {
                successes++;
            },
            url: "https://provider.example/api",
        });
        const pendingResult = finished(pending);
        const cancelledRequest = calls.at(-1).args.requestId;
        pending.abort();
        pending.abort();
        result = await pendingResult;
        assert.equal(result.status, "abort");
        assert.equal(result.xhr.status, 0);
        settle(response("{}"));
        await delay(5);
        assert.equal(successes, 0);
        assert.equal(completions, 1);
        assert.deepEqual(
            r.cancelled,
            platform === "capacitor" ? [cancelledRequest] : [],
            "abort cancels only its native request, exactly once"
        );
        if (platform === "capacitor")
            assert.match(cancelledRequest, /^[A-Za-z0-9_-]{1,128}$/);
        result = await finished(
            $.ajax({
                complete() {
                    completions++;
                },
                timeout: 5,
                url: "https://provider.example/api",
            })
        );
        assert.equal(result.status, "timeout");
        if (platform === "capacitor") {
            const timeoutRequest = calls.at(-1).args.requestId;
            assert.notEqual(timeoutRequest, cancelledRequest);
            assert.deepEqual(r.cancelled, [cancelledRequest, timeoutRequest]);
        }
        settle(response("{}"));
        await delay(5);
        assert.equal(completions, 2);
        const count = calls.length;
        result = await finished(
            $.ajax({
                beforeSend() {
                    return false;
                },
                url: "https://provider.example/api",
            })
        );
        assert.equal(result.status, "canceled");
        assert.equal(calls.length, count);

        const held = [];
        reply = () => new Promise((resolve) => held.push(resolve));
        const first = $.ajax({ url: "https://provider.example/first" });
        const second = $.ajax({ url: "https://provider.example/second" });
        const firstID = calls.at(-2).args.requestId;
        const secondID = calls.at(-1).args.requestId;
        first.abort();
        const secondResult = finished(second);
        held[0](response("retired", 200, "text/plain"));
        held[1](response("active", 200, "text/plain"));
        assert.equal((await secondResult).data, "active");
        const cancelledCount = r.cancelled.length;
        second.abort();
        assert.equal(
            r.cancelled.length,
            cancelledCount,
            "settled request is not cancelled"
        );
        if (platform === "capacitor") {
            assert.notEqual(firstID, secondID);
            assert.equal(r.cancelled.at(-1), firstID);
            assert(
                !r.cancelled.includes(secondID),
                "other native consumers remain active"
            );
        }
    } finally {
        clearTimeout(testDeadline);
        r.close();
    }

    const browser = runtime(() => {
        throw Error("Browser must not invoke native transport");
    }, false);
    assert.equal(browser.$.ajax, browser.originalAjax);
    let webTransportInstalled = false;
    browser.w.Capacitor = { isNativePlatform: () => false };
    browser.$.ajaxTransport = () => {
        webTransportInstalled = true;
    };
    browser.w.installCapacitorHttpTransport(browser.$, {});
    assert.equal(webTransportInstalled, false);
    browser.close();
    console.log(
        `OK: ${platform} HTTP with real jQuery 1.11.1, provider JSON/JSONP, VPortal JSON POST opt-in, status, callbacks, abort/timeout and browser isolation`
    );
}
async function testCancellationCompatibility() {
    for (const capabilities of [{ cancel: false }, { platform: "android" }]) {
        let args;
        let settle;
        const r = runtime(
            (requestCommand, requestArgs) => {
                args = requestArgs;
                return new Promise((resolve) => {
                    settle = resolve;
                });
            },
            true,
            "capacitor",
            undefined,
            capabilities
        );
        try {
            const request = r.$.ajax({
                url: "https://provider.example/playlist",
            });
            const result = finished(request);
            request.abort();
            assert.equal((await result).status, "abort");
            assert.equal(args.requestId, undefined);
            assert.deepEqual(r.cancelled, []);
            settle(response("retired", 200, "text/plain"));
            await delay(0);
        } finally {
            r.close();
        }
    }
}
async function testAccessPlaylistLifetime() {
    const m3uFixture = require("./helpers/m3u-driver-fixture.cjs");
    const playlist = "#EXTM3U\n#EXTINF:-1,Fixture\nhttps://media.test/live\n";
    for (const jquery of [
        "js/jquery-1.11.1.min.js",
        "node_modules/jquery/dist/jquery.min.js",
    ]) {
        for (const access of [true, false]) {
            const f = m3uFixture({ native: true });
            const dom = new JSDOM("<!doctype html>", {
                runScripts: "outside-only",
                url: "https://localhost/",
            });
            const w = dom.window,
                calls = [],
                cancelled = [],
                outcomes = [];
            let now = 0,
                sequence = 0;
            const timers = new Map();
            try {
                w.Capacitor = {
                    getPlatform: () => "ios",
                    isNativePlatform: () => true,
                    Plugins: access ? { AccessMedia: {} } : {},
                };
                w.eval(read(jquery));
                w.eval(compile(read("src/plugins/native-http.ts")));
                w.eval(compile(read("src/plugins/jquery-bridge.ts")));
                w.setTimeout = (fn, delay) => {
                    const id = ++sequence;
                    timers.set(id, { at: now + delay, fn });
                    return id;
                };
                w.clearTimeout = (id) => timers.delete(id);
                async function advance(delta) {
                    const end = now + delta;
                    for (;;) {
                        const next = [...timers].sort(
                            (a, b) => a[1].at - b[1].at
                        )[0];
                        if (!next || next[1].at > end) break;
                        now = next[1].at;
                        timers.delete(next[0]);
                        next[1].fn();
                        await Promise.resolve();
                    }
                    now = end;
                    await Promise.resolve();
                }
                function request(route, args) {
                    return new Promise((resolve, reject) =>
                        calls.push({ args, reject, resolve, route })
                    );
                }
                function cancel(route, args) {
                    cancelled.push({ id: args.requestId, route });
                    return Promise.resolve({ cancelled: true });
                }
                w.StalkerPortal = {
                    cancelHttpRequest: (args) => cancel("http", args),
                    httpRequest: (args) => request("http", args),
                };
                w.M3UProxy = {
                    cancelProxyFetch: (args) => cancel("proxy", args),
                    proxyFetch: (args) => request("proxy", args),
                };
                // Guide matching is independent of this playlist/auth fixture.
                w.matchCapacitorM3u = () => Promise.resolve("{}\n\t\n");
                w.eval(
                    compile(
                        functions("src/plugins/m3u-proxy.ts", [
                            "setupCapacitorCompanionShim",
                        ])
                    )
                );
                w.setupCapacitorCompanionShim();
                f.host.host = "https://localhost";
                f.host.$.ajax = w.$.ajax.bind(w.$);
                const driver = f.start();
                const loaded = (catalog, error) =>
                    outcomes.push({ count: catalog.ids.length, error });
                driver.load(loaded);
                assert.equal(
                    calls[0].args.timeoutMs,
                    5000,
                    "Native network timeout remains five seconds"
                );
                await advance(5000);
                if (access) {
                    assert.equal(
                        cancelled.length,
                        0,
                        "A legitimate Access login must outlive the direct network budget"
                    );
                    assert.equal(
                        calls.length,
                        1,
                        "Do not retry the same login through the companion"
                    );
                    await advance(65000);
                    calls[0].resolve(response(playlist, 200, "text/plain"));
                    await advance(0);
                    assert.deepEqual(outcomes, [
                        { count: 1, error: undefined },
                    ]);
                    driver.load(loaded);
                    const old = calls.at(-1);
                    f.mount("demo");
                    assert.deepEqual(cancelled, [
                        { id: old.args.requestId, route: "http" },
                    ]);
                    old.resolve(response(playlist, 200, "text/plain"));
                    await advance(0);
                    assert.equal(
                        outcomes.length,
                        1,
                        "Late login completion cannot publish a retired provider"
                    );
                    const timed = w.$.ajax({
                        timeout: 5000,
                        url: "https://source.test/list",
                    });
                    const result = finished(timed);
                    await advance(305000);
                    assert.equal(
                        (await result).status,
                        "timeout",
                        "Interactive allowance is bounded"
                    );
                } else {
                    assert.equal(
                        cancelled.length,
                        1,
                        "No Access capability retains the five-second deadline"
                    );
                    const proxy = calls[1];
                    assert.equal(proxy.route, "proxy");
                    assert.equal(proxy.args.url, calls[0].args.url);
                    assert.notEqual(
                        proxy.args.requestId,
                        calls[0].args.requestId
                    );
                    await advance(65000);
                    assert.deepEqual(outcomes, [
                        { count: 0, error: "m3u-network" },
                    ]);
                    assert.deepEqual(cancelled[1], {
                        id: proxy.args.requestId,
                        route: "proxy",
                    });
                    proxy.resolve({ body: playlist });
                    await advance(0);
                    assert.equal(outcomes.length, 1);
                    driver.load(loaded);
                    calls.at(-1).reject(new Error("fixture unavailable"));
                    await advance(0);
                    const retired = calls.at(-1);
                    assert.equal(retired.route, "proxy");
                    f.mount("demo");
                    assert.deepEqual(cancelled.at(-1), {
                        id: retired.args.requestId,
                        route: "proxy",
                    });
                    retired.reject(new Error("late fixture failure"));
                    await advance(0);
                    assert.equal(outcomes.length, 1);
                }
                let successes = 0,
                    failures = 0,
                    completions = 0;
                const proxyRequest = w.$.ajax({
                    complete: () => completions++,
                    data: {
                        referer: "https://source.test/start?q=a+b",
                        ua: "webos",
                        url: "@https://source.test/list",
                    },
                    dataType: "text",
                    error: () => failures++,
                    success: () => successes++,
                    timeout: 65000,
                    type: "POST",
                    url: "/m3u/cp.php",
                });
                const proxy = calls.at(-1);
                assert.equal(proxy.route, "proxy");
                assert.equal(proxy.args.userAgent, "webos");
                assert.equal(
                    proxy.args.referer,
                    "https://source.test/start?q=a+b"
                );
                const rejected = finished(proxyRequest);
                proxy.reject(new Error("fixture proxy failure"));
                await advance(0);
                assert.equal((await rejected).ok, false);
                proxyRequest.abort();
                assert.deepEqual([successes, failures, completions], [0, 1, 1]);
                assert(
                    !cancelled.some(
                        (entry) => entry.id === proxy.args.requestId
                    ),
                    "Completed fallback needs no cancellation"
                );
                for (const [data, userAgent, referer] of [
                    [
                        {
                            referer: false,
                            ua: 3,
                            url: "https://source.test/list",
                        },
                        undefined,
                        undefined,
                    ],
                    [
                        "url=https%3A%2F%2Fsource.test%2Flist&ua=Custom%2BPlayer%2F1.0&referer=https%3A%2F%2Fsource.test%2Fa%3Fq%3Da%2Bb",
                        "Custom+Player/1.0",
                        "https://source.test/a?q=a+b",
                    ],
                ]) {
                    const headersRequest = w.$.ajax({
                        data,
                        dataType: "text",
                        type: "POST",
                        url: "/m3u/cp.php",
                    });
                    const headerCall = calls.at(-1);
                    assert.equal(headerCall.route, "proxy");
                    assert.equal(headerCall.args.userAgent, userAgent);
                    assert.equal(headerCall.args.referer, referer);
                    const headersResult = finished(headersRequest);
                    headerCall.resolve({ body: playlist });
                    await advance(0);
                    assert.equal((await headersResult).data, playlist);
                }
                const beforeMalformed = calls.length;
                assert.throws(
                    () =>
                        w.$.ajax({
                            data: "url=%XX",
                            type: "POST",
                            url: "/m3u/cp.php",
                        }),
                    (error) => error.name === "URIError",
                    "Malformed proxy data retains the existing synchronous failure"
                );
                assert.equal(
                    calls.length,
                    beforeMalformed,
                    "Malformed form data must not reach native code"
                );

                const plainHttp = w.$.ajax({
                    timeout: 5000,
                    url: "http://source.test/list",
                });
                const plainResult = finished(plainHttp);
                assert.equal(calls.at(-1).args.timeoutMs, 5000);
                await advance(5000);
                assert.equal(
                    (await plainResult).status,
                    "timeout",
                    "HTTP sources cannot use Access and keep their original deadline"
                );
            } finally {
                dom.window.close();
                f.dom.window.close();
            }
        }
    }
    console.log(
        "OK: actual M3U + jQuery + iOS bridges preserve auth allowance, fallback deadlines, cancellation and headers"
    );
}
testTauriOriginRouting()
    .then(() => run("tauri"))
    .then(() => run("capacitor"))
    .then(testCancellationCompatibility)
    .then(testAccessPlaylistLifetime)
    .then(
        () => clearTimeout(testDeadline),
        (error) => {
            clearTimeout(testDeadline);
            console.error(error);
            process.exitCode = 1;
        }
    );

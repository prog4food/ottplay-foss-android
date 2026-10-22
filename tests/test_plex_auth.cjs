const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { webcrypto } = require("node:crypto");
const { JSDOM } = require("jsdom");
const modules = ["plex.ts", "plex-auth.ts"].map((file) => {
    const source = ts.transpileModule(
        fs.readFileSync(path.join(__dirname, "../src/plugins", file), "utf8"),
        {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
    // The classic linker isolates each module. Cross-module calls must use
    // their published API, even before emitted-bundle browser acceptance.
    return "(function () {\n" + source + "\n})();";
});

function loadModules(w, run) {
    modules.forEach(run);
    assert.equal(w.plexContainer, undefined);
    assert.equal(typeof w.__ottPlex.parseContainer, "function");
}

function fixture() {
    let now = 100000;
    let timerId = 0;
    const timers = new Map();
    const storage = {};
    const calls = [];
    const output = { connected: [], errors: [], pins: [], servers: [] };
    const w = {
        $: {
            ajax(options) {
                const handlers = { always: [], done: [], fail: [] };
                const call = { aborted: false, options, settled: false };
                for (const event of Object.keys(handlers))
                    call[event] = function (handler) {
                        handlers[event].push(handler);
                        return call;
                    };
                call.abort = function () {
                    call.aborted = true;
                    if (!call.settled) call.reject(0);
                };
                call.resolve = function (value) {
                    call.settled = true;
                    handlers.done.forEach((handler) => handler(value));
                    handlers.always.forEach((handler) => handler());
                };
                call.reject = function (status) {
                    call.settled = true;
                    handlers.fail.forEach((handler) =>
                        handler({ responseText: "SECRET-RAW-ERROR", status })
                    );
                    handlers.always.forEach((handler) => handler());
                };
                calls.push(call);
                return call;
            },
        },
        clearTimeout: (id) => timers.delete(id),
        crypto: webcrypto,
        Date: class extends Date {
            static now() {
                return now;
            }
        },
        DOMParser: new JSDOM().window.DOMParser,
        localStorage: {
            getItem: (key) => storage[key] || null,
            setItem: (key, value) => {
                storage[key] = value;
            },
        },
        Promise: undefined,
        setTimeout: (handler, delay) => {
            timers.set(++timerId, { at: now + delay, handler });
            return timerId;
        },
        URL,
    };
    w.window = w;
    loadModules(w, (source) => vm.runInNewContext(source, w));
    const callbacks = {
        onConnected: (result) => output.connected.push(result),
        onError: (message) => output.errors.push(message),
        onPin: (pin) => output.pins.push(pin),
        onServers: (servers) => output.servers.push(servers),
    };
    function advance(ms) {
        const end = now + ms;
        for (let step = 0; step < 1000; step++) {
            const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
            if (!next || next[1].at > end) {
                now = end;
                return;
            }
            now = next[1].at;
            timers.delete(next[0]);
            next[1].handler();
        }
        throw Error("Unbounded timer loop");
    }
    return {
        advance,
        api: w.__ottPlexAuth,
        callbacks,
        calls,
        output,
        storage,
        timers,
    };
}

function jqueryFixture(file) {
    const dom = new JSDOM("", {
        runScripts: "outside-only",
        url: "https://player.test/",
    });
    const w = dom.window;
    const calls = [];
    const output = { connected: [], errors: [], pins: [], servers: [] };
    w.eval(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
    w.$.ajaxTransport("+*", (options) => {
        const call = { aborted: false, options };
        return {
            abort() {
                call.aborted = true;
            },
            send(headers, complete) {
                call.headers = headers;
                call.resolve = (value, contentType = "application/json") =>
                    complete(
                        200,
                        "OK",
                        {
                            text:
                                typeof value === "string"
                                    ? value
                                    : JSON.stringify(value),
                        },
                        "Content-Type: " + contentType + "\r\n"
                    );
                calls.push(call);
            },
        };
    });
    loadModules(w, (source) => w.eval(source));
    return {
        api: w.__ottPlexAuth,
        callbacks: {
            onConnected: (result) => output.connected.push(result),
            onError: (message) => output.errors.push(message),
            onPin: (pin) => output.pins.push(pin),
            onServers: (servers) => output.servers.push(servers),
        },
        calls,
        close: () => {
            w.__ottPlexAuth.cancel();
            w.close();
        },
        output,
    };
}

const resources = [
    {
        accessToken: "server-specific-secret",
        clientIdentifier: "server-one",
        connections: [
            { local: true, uri: "https://local.plex.direct:32400" },
            { local: false, uri: "https://remote.plex.direct:443" },
            { local: true, uri: "http://192.168.1.2:32400" },
            { relay: true, uri: "https://relay.plex.test" },
            { uri: "http://remote.test:32400" },
        ],
        name: "Fixture server",
        owned: true,
        provides: "server",
    },
];
function serverFromResources(f) {
    f.api.getServers("account-secret", f.callbacks);
    f.calls.at(-1).resolve(resources);
    return f.output.servers[0][0];
}

function test(name, run) {
    try {
        run();
        console.log("PASS " + name);
    } catch (error) {
        console.error("FAIL " + name, error);
        process.exitCode = 1;
    }
}

test("official PIN grant discovers server-specific credentials without persisting the account token", () => {
    const f = fixture();
    f.api.start(f.callbacks);
    const create = f.calls[0].options;
    assert.equal(create.url, "https://plex.tv/api/v2/pins");
    assert.equal(create.type, "POST");
    assert.equal(create.dataType, "json");
    assert.equal(create.plexAuthRequest, true);
    assert.equal(create.data.strong, "true");
    create.headers && assert.equal(create.headers["X-Plex-Token"], undefined);
    f.calls[0].resolve({ code: "strongcode123", expiresIn: 60, id: 7 });
    assert.match(f.output.pins[0].url, /^https:\/\/app\.plex\.tv\/auth#\?/);
    assert.ok(f.output.pins[0].url.includes("code=strongcode123"));
    assert.equal(f.output.pins[0].expiresAt, 160000);
    f.advance(1000);
    assert.equal(f.calls[1].options.url, "https://plex.tv/api/v2/pins/7");
    assert.equal(f.calls[1].options.dataType, "json");
    assert.equal(
        f.calls[1].options.data["X-Plex-Client-Identifier"],
        create.data["X-Plex-Client-Identifier"]
    );
    f.calls[1].resolve({ authToken: "account-secret" });
    assert.equal(
        f.calls[2].options.url,
        "https://clients.plex.tv/api/v2/resources"
    );
    assert.equal(f.calls[2].options.headers["X-Plex-Token"], "account-secret");
    assert.equal(f.calls[2].options.dataType, "json");
    f.calls[2].resolve(resources);
    assert.equal(f.output.servers[0][0].token, "server-specific-secret");
    assert.equal(f.output.servers[0][0].connections.length, 5);
    assert.equal(f.timers.size, 0);
    assert.equal(JSON.stringify(f.storage).includes("secret"), false);
    assert.equal(Object.keys(f.storage).length, 1);
    assert.equal(f.output.errors.length, 0);
});

test("TV link PIN expires and cancellation suppresses late responses and stale cancel handles", () => {
    const f = fixture();
    const cancelOld = f.api.start(f.callbacks, { code: true });
    assert.equal(f.calls[0].options.data.strong, "false");
    f.calls[0].resolve({ code: "1234", expiresIn: 2, id: 8 });
    assert.equal(f.output.pins[0].url, "https://plex.tv/link/?pin=1234");
    f.advance(2000);
    assert.equal(f.output.errors.length, 1);
    assert.equal(f.calls[1].aborted, true);
    f.calls[1].resolve({ authToken: "expired-secret" });
    assert.equal(f.calls.length, 2);
    f.api.start(f.callbacks);
    cancelOld();
    assert.equal(f.calls[2].aborted, false);
    f.api.cancel();
    f.calls[2].resolve({ code: "4321", expiresIn: 60, id: 9 });
    assert.equal(f.output.pins.length, 1);
    assert.equal(f.timers.size, 0);
});

test("PIN polling tolerates temporary failures without overlap or error-body disclosure", () => {
    const f = fixture();
    f.api.start(f.callbacks);
    f.calls[0].resolve({ code: "1234", expiresIn: 60, id: 1 });
    f.advance(1000);
    f.advance(10000);
    assert.equal(f.calls.length, 2, "Pending poll is never duplicated");
    f.calls[1].reject(429);
    f.advance(2000);
    f.calls[2].reject(503);
    f.advance(4000);
    f.calls[3].reject(401);
    assert.equal(f.output.errors.length, 1);
    assert.equal(f.output.errors[0].includes("SECRET"), false);
    assert.equal(f.timers.size, 0);
});

test("resources reject players, inaccessible servers and credential-bearing connection URLs", () => {
    const f = fixture();
    f.api.getServers("account-secret", f.callbacks);
    f.calls[0].resolve([
        { ...resources[0], provides: "player" },
        { ...resources[0], accessToken: null },
        {
            ...resources[0],
            connections: [
                { uri: "https://user:secret@host.test" },
                { uri: "javascript:alert(1)" },
                { uri: "https://host.test?token=secret" },
            ],
        },
        resources[0],
        resources[0],
    ]);
    assert.equal(f.output.servers[0].length, 1);
    assert.equal(f.output.servers[0][0].id, "server-one");
});

test("connection discovery prefers HTTPS and verifies identity before sending a server token", () => {
    const f = fixture();
    const server = serverFromResources(f);
    f.api.connect(server, f.callbacks);
    assert.equal(
        f.calls[1].options.url,
        "https://local.plex.direct:32400/identity"
    );
    assert.equal(f.calls[2].options.url, "https://remote.plex.direct/identity");
    assert.equal(f.calls[1].options.headers["X-Plex-Token"], undefined);
    assert.equal(f.calls[2].options.headers["X-Plex-Token"], undefined);
    f.calls[1].resolve({
        MediaContainer: { machineIdentifier: "different-server" },
    });
    assert.equal(f.calls[3].options.url, "http://192.168.1.2:32400/identity");
    f.calls[2].resolve({ MediaContainer: { machineIdentifier: "server-one" } });
    assert.equal(f.calls[4].options.headers["X-Plex-Token"], server.token);
    f.calls[4].resolve({ MediaContainer: {} });
    assert.equal(f.output.connected.length, 1);
    assert.equal(f.output.connected[0].url, "https://remote.plex.direct");
    assert.equal(f.output.connected[0].token, "server-specific-secret");
    assert.equal(f.calls[3].aborted, true);
    f.calls[3].resolve({ MediaContainer: { machineIdentifier: "server-one" } });
    assert.equal(f.calls.length, 5);
    assert.equal(f.timers.size, 0);
});

test("explicit connection selection never probes other URLs and errors do not leak credentials", () => {
    const f = fixture();
    const server = serverFromResources(f);
    f.api.connect(server, f.callbacks, "http://remote.test:32400");
    assert.equal(f.calls.length, 2);
    f.calls[1].resolve({ MediaContainer: { machineIdentifier: "server-one" } });
    f.calls[2].reject(403);
    assert.equal(f.output.errors.length, 1);
    assert.match(f.output.errors[0], /denied access/);
    assert.equal(f.output.errors[0].includes("secret"), false);
    f.api.connect(server, f.callbacks, "https://unadvertised.test");
    assert.equal(f.calls.length, 3);
    assert.equal(f.output.errors.length, 2);
});

test("connection timeout aborts bounded work and never revives a canceled choice", () => {
    const f = fixture();
    const server = serverFromResources(f);
    f.api.connect(server, f.callbacks);
    f.advance(20000);
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[1].aborted, true);
    assert.equal(f.calls[2].aborted, true);
    assert.equal(f.output.errors.length, 1);
    f.calls[1].resolve({ MediaContainer: { machineIdentifier: server.id } });
    assert.equal(f.calls.length, 3);
    assert.equal(f.output.connected.length, 0);
});

test("persisted routing strips credentials and rediscovers remote when the saved LAN endpoint is down", () => {
    const f = fixture();
    const server = serverFromResources(f);
    const routing = f.api.routing({
        ...server,
        accountToken: "must-not-be-saved",
        connections: [
            ...server.connections,
            { url: "https://user:secret@invalid.test" },
        ],
    });
    assert.deepEqual(Object.keys(routing).sort(), ["connections", "id"]);
    assert.equal(JSON.stringify(routing).includes("secret"), false);
    assert.equal(routing.connections.length, 5);
    f.api.connect({ ...routing, token: server.token }, f.callbacks);
    f.calls[1].reject(0);
    assert.equal(f.calls[2].options.headers["X-Plex-Token"], undefined);
    f.calls[2].resolve({ MediaContainer: { machineIdentifier: routing.id } });
    assert.equal(f.calls.at(-1).options.headers["X-Plex-Token"], server.token);
    f.calls.at(-1).resolve({ MediaContainer: {} });
    assert.equal(f.output.connected[0].url, "https://remote.plex.direct");
    assert.equal(f.output.errors.length, 0);
    assert.equal(f.timers.size, 0);
});

for (const jquery of [
    "js/jquery-1.11.1.min.js",
    "node_modules/jquery/dist/jquery.min.js",
]) {
    for (const xml of [false, true]) {
        test(
            "real jQuery accepts PMS " + (xml ? "XML" : "JSON") + ": " + jquery,
            () => {
                const f = jqueryFixture(jquery);
                try {
                    const server = serverFromResources(f);
                    const url = server.connections[0].url;
                    f.api.connect(server, f.callbacks, url);
                    assert.equal(f.calls[1].headers["X-Plex-Token"], undefined);
                    f.calls[1].resolve(
                        xml
                            ? '<MediaContainer machineIdentifier="server-one"/>'
                            : {
                                  MediaContainer: {
                                      machineIdentifier: server.id,
                                  },
                              },
                        xml ? "application/xml" : "application/json"
                    );
                    assert.equal(f.calls.length, 3);
                    assert.equal(
                        f.calls[2].options.url,
                        url + "/library/sections"
                    );
                    assert.equal(
                        f.calls[2].headers["X-Plex-Token"],
                        server.token
                    );
                    f.calls[2].resolve(
                        xml
                            ? '<MediaContainer size="1"><Directory key="7" title="Films"/></MediaContainer>'
                            : { MediaContainer: { Directory: [{ key: "7" }] } },
                        xml ? "application/xml" : "application/json"
                    );
                    assert.equal(f.output.connected.length, 1);
                    assert.equal(f.output.connected[0].url, url);
                    assert.equal(f.output.connected[0].serverId, server.id);
                    assert.equal(f.output.errors.length, 0);
                    assert.equal(f.calls[1].options.dataType, "text");
                    assert.equal(f.calls[2].options.dataType, "text");
                } finally {
                    f.close();
                }
            }
        );
    }

    test(
        "real jQuery rejects unsafe or mismatched PMS XML before sending a token: " +
            jquery,
        () => {
            for (const identity of [
                '<MediaContainer machineIdentifier="different-server"/>',
                '<WrongRoot machineIdentifier="server-one"/>',
                '<MediaContainer machineIdentifier="server-one">',
                '<!DOCTYPE MediaContainer><MediaContainer machineIdentifier="server-one"/>',
            ]) {
                const f = jqueryFixture(jquery);
                try {
                    const server = serverFromResources(f);
                    f.api.connect(
                        server,
                        f.callbacks,
                        server.connections[0].url
                    );
                    f.calls[1].resolve(identity, "application/xml");
                    assert.equal(f.calls.length, 2);
                    assert.equal(f.calls[1].headers["X-Plex-Token"], undefined);
                    assert.equal(f.output.connected.length, 0);
                    assert.equal(f.output.errors.length, 1);
                    assert.equal(
                        f.output.errors[0].includes(server.token),
                        false
                    );
                } finally {
                    f.close();
                }
            }
        }
    );

    test(
        "real jQuery rejects invalid PMS sections after a verified XML identity: " +
            jquery,
        () => {
            const f = jqueryFixture(jquery);
            try {
                const server = serverFromResources(f);
                f.api.connect(server, f.callbacks, server.connections[0].url);
                f.calls[1].resolve(
                    '<MediaContainer machineIdentifier="server-one"/>',
                    "application/xml"
                );
                f.calls[2].resolve(
                    "<Error>private server response</Error>",
                    "application/xml"
                );
                assert.equal(f.output.connected.length, 0);
                assert.equal(f.output.errors.length, 1);
                assert.equal(f.output.errors[0].includes("private"), false);
            } finally {
                f.close();
            }
        }
    );

    test(
        "real jQuery cancellation ignores a late XML identity: " + jquery,
        () => {
            const f = jqueryFixture(jquery);
            try {
                const server = serverFromResources(f);
                const cancel = f.api.connect(
                    server,
                    f.callbacks,
                    server.connections[0].url
                );
                cancel();
                assert.equal(f.calls[1].aborted, true);
                f.calls[1].resolve(
                    '<MediaContainer machineIdentifier="server-one"/>',
                    "application/xml"
                );
                assert.equal(f.calls.length, 2);
                assert.equal(f.output.connected.length, 0);
                assert.equal(f.output.errors.length, 0);
            } finally {
                f.close();
            }
        }
    );

    test("real jQuery keeps the Plex cloud API JSON-only: " + jquery, () => {
        const f = jqueryFixture(jquery);
        try {
            f.api.getServers("account-secret", f.callbacks);
            assert.equal(f.calls[0].options.dataType, "json");
            f.calls[0].resolve("<MediaContainer/>", "application/xml");
            assert.equal(f.output.servers.length, 0);
            assert.equal(f.output.errors.length, 1);
        } finally {
            f.close();
        }
    });
}

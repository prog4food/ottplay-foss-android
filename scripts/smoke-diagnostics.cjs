// Cross-repository acceptance: real TLS, Go control, TS transport and Python CLI.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const https = require("node:https");
const http = require("node:http");
const net = require("node:net");
const { createHash } = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const execFile = require("node:util").promisify(
    require("node:child_process").execFile
);
const ts = require("typescript");
const binary = process.env.OTT_CONTROL_BINARY;
const cli = process.env.OTT_DIAGNOSTICS_CLI;
assert(binary && cli, "Set OTT_CONTROL_BINARY and OTT_DIAGNOSTICS_CLI");
async function freePort() {
    const s = net.createServer();
    await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
    const port = s.address().port;
    await new Promise((resolve) => s.close(resolve));
    return port;
}
async function eventually(read, predicate, message) {
    const end = Date.now() + 12000;
    do {
        const value = await read();
        if (predicate(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < end);
    throw new Error(message);
}
function load(file, dependencies) {
    const context = { console, exports: {}, require: dependencies, URL };
    vm.runInNewContext(
        ts.transpileModule(
            fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
            {
                compilerOptions: {
                    module: ts.ModuleKind.CommonJS,
                    target: ts.ScriptTarget.ES5,
                },
            }
        ).outputText,
        context
    );
    return context.exports;
}
async function worker(dir) {
    const port = await freePort();
    const deviceToken = "b".repeat(48),
        operatorToken = "c".repeat(48);
    const conf = {
        admin_token: "a".repeat(48),
        devices: [
            {
                diagnostics: { enabled: true },
                id: "test-device",
                token: deviceToken,
            },
            {
                diagnostics: { enabled: true },
                id: "other-device",
                token: "d".repeat(48),
            },
        ],
        diagnostics: {
            operators: [
                {
                    actions: [
                        "runtimes.read",
                        "sessions.start",
                        "sessions.stop",
                        "sessions.read",
                        "runtimes.revoke",
                        "repairs.start",
                        "repairs.read",
                    ],
                    credential_sha256: createHash("sha256")
                        .update(operatorToken)
                        .digest("hex"),
                    device_ids: ["test-device"],
                    id: "fixture-operator",
                },
            ],
        },
        listen: "127.0.0.1:" + port,
    };
    const confPath = path.join(dir, "control.json");
    fs.writeFileSync(confPath, JSON.stringify(conf), { mode: 0o600 });
    const server = spawn(binary, ["serve", "--config", confPath], {
        stdio: "ignore",
    });
    const clients = [];
    const gateway = https.createServer(
        {
            cert: fs.readFileSync(path.join(dir, "cert.pem")),
            key: fs.readFileSync(path.join(dir, "key.pem")),
        },
        (req, res) => {
            if (!req.url.startsWith("/control/")) {
                res.writeHead(404).end();
                return;
            }
            const upstream = http.request(
                "http://127.0.0.1:" + port + req.url.slice("/control".length),
                { headers: req.headers, method: req.method },
                (incoming) => {
                    res.writeHead(incoming.statusCode, incoming.headers);
                    incoming.pipe(res);
                }
            );
            upstream.on("error", () => res.writeHead(502).end());
            req.pipe(upstream);
        }
    );
    try {
        await eventually(
            async () => {
                try {
                    return (await fetch("http://127.0.0.1:" + port + "/readyz"))
                        .ok;
                } catch {
                    return false;
                }
            },
            Boolean,
            "Go server did not become ready"
        );
        await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
        const base = "https://127.0.0.1:" + gateway.address().port + "/control";
        async function op(route, method = "GET", body) {
            const r = await fetch(base + "/api/v2/diagnostics" + route, {
                body: body && JSON.stringify(body),
                headers: {
                    Authorization: "Bearer " + operatorToken,
                    "Content-Type": "application/json",
                },
                method,
            });
            const value = await r.json();
            assert(
                r.ok,
                JSON.stringify({
                    code: value.error?.code,
                    route,
                    status: r.status,
                })
            );
            return value;
        }
        const wire = require("../tests/load-wire.cjs")();
        const transport = load("src/plugins/command-server.ts", () => wire);
        const buffer = load("src/plugins/diagnostic-buffer.ts", () => {});
        const restart = load("src/commands/remote-restart.ts", () => {});
        const remote = load("src/plugins/remote-diagnostics.ts", (name) =>
            name.includes("diagnostic-buffer") ? buffer : wire
        );
        const w = { AbortController, clearTimeout, fetch, Request, setTimeout };
        const sent = [],
            states = [];
        function player() {
            let captureCount = 0,
                releases = 0,
                droppedAck = false,
                streamRestarts = 0,
                reloads = 0;
            const lostRepairReplies = new Set();
            const play = () => {};
            const runtime = {
                __ottCoreBackend: () => ({
                    restart: () => {
                        streamRestarts++;
                        return { restarted: true };
                    },
                }),
                __ottCoreTransport: { play },
                restart: () => {
                    reloads++;
                },
                stbPlay: play,
            };
            const raw = transport.createCommandServerTransport(w);
            const instance = remote.createRemoteDiagnostics({
                capture: (emit) => {
                    captureCount++;
                    emit({
                        cat: "net",
                        data: {
                            status: 503,
                            token: "DUMMY_SECRET",
                            url: "https://private.invalid/DUMMY_SECRET",
                        },
                        msg: "xhr status",
                    });
                    return () => {
                        releases++;
                    };
                },
                clearTimeout,
                executeRepair: (action, complete, afterAck) => {
                    restart.executeRemoteRestart(
                        runtime,
                        {
                            target:
                                action === "reload_player"
                                    ? "player"
                                    : "stream",
                        },
                        (result) =>
                            complete(
                                result.status === "ok"
                                    ? action === "reload_player"
                                        ? "accepted"
                                        : "applied"
                                    : result.status
                            ),
                        afterAck
                    );
                },
                now: () => performance.now(),
                send: (request, complete) => {
                    sent.push({ body: request.body, url: request.url });
                    return raw(request, (response) => {
                        if (
                            request.url.endsWith("/events") &&
                            response?.status === 200 &&
                            !droppedAck
                        ) {
                            droppedAck = true;
                            complete();
                        } else if (
                            request.url.endsWith("/repairs/results") &&
                            response?.status === 200 &&
                            !lostRepairReplies.has(
                                JSON.parse(request.body).repair_id
                            )
                        ) {
                            lostRepairReplies.add(
                                JSON.parse(request.body).repair_id
                            );
                            complete();
                        } else complete(response);
                    });
                },
                setTimeout,
                snapshot: () => ({
                    available: true,
                    counters: { errors: 1 },
                    enabled: true,
                    token: "DUMMY_SECRET",
                    video: {
                        currentTime: 12,
                        paused: false,
                        src: "DUMMY_SECRET",
                        videoHeight: 1080,
                        videoWidth: 1920,
                    },
                }),
            });
            instance.configure({
                address: base,
                bootId: "same-boot",
                consentEpoch: "fixture-grant",
                enabled: true,
                instanceId: "same-instance",
                token: deviceToken,
            });
            clients.push(instance);
            const state = () => ({
                captureCount,
                droppedAck,
                releases,
                reloads,
                streamRestarts,
            });
            states.push(state);
            return instance;
        }
        const first = player(),
            second = player();
        const list = await eventually(
            () => op("/runtimes?device_id=test-device"),
            (r) => r.runtimes.length === 2,
            "Both runtime registrations missing"
        );
        await eventually(
            () => first.snapshot(),
            (s) => s.runtimeId,
            "First runtime missing"
        );
        assert.notEqual(
            first.snapshot().runtimeId,
            second.snapshot().runtimeId,
            "same token/metadata still means distinct runtime credentials"
        );
        const selected = first.snapshot().runtimeId;
        const startBody = {
            consent_epoch: "fixture-grant",
            device_id: "test-device",
            idempotency_key: "fixture-start",
            lease_ms: 60000,
            profile: "standard",
            runtime_id: selected,
            server_epoch: list.server_epoch,
        };
        const started = await op("/sessions", "POST", startBody);
        const replay = await op("/sessions", "POST", startBody);
        assert.equal(replay.session_id, started.session_id);
        await eventually(
            () => op("/sessions/" + started.session_id),
            (s) => s.state === "active",
            "Session never acknowledged start"
        );
        assert.equal(states[0]().captureCount, 1);
        assert.equal(states[1]().captureCount, 0);
        const page = await eventually(
            () =>
                op(
                    "/sessions/" +
                        started.session_id +
                        "/events?after_seq=0&limit=32"
                ),
            (p) => p.events.length > 0,
            "No structured events captured"
        );
        assert(!JSON.stringify(page).includes("DUMMY_SECRET"));
        assert(!JSON.stringify(sent).includes("DUMMY_SECRET"));
        await eventually(
            () => states[0](),
            (s) => s.droppedAck,
            "Lost ingest ACK not exercised"
        );
        await new Promise((r) => setTimeout(r, 1800));
        const stop = await op(
            "/sessions/" + started.session_id + "/stop",
            "POST",
            {
                idempotency_key: "fixture-stop",
                reason: "operator",
                server_epoch: list.server_epoch,
            }
        );
        assert.equal(stop.state, "stop_pending");
        await eventually(
            () => op("/sessions/" + started.session_id),
            (s) => s.device_stop_confirmed === true,
            "Server stop was never confirmed on exact runtime"
        );
        assert.equal(states[0]().releases, 1);
        assert.equal(states[1]().releases, 0);
        const env = {
            ...process.env,
            OTT_DIAGNOSTIC_TEST_TOKEN: operatorToken,
            SSL_CERT_FILE: path.join(dir, "cert.pem"),
        };
        const output = await execFile(
            "python3",
            [
                cli,
                "--server",
                base,
                "--token-env",
                "OTT_DIAGNOSTIC_TEST_TOKEN",
                "runtimes",
                "--device",
                "test-device",
            ],
            { env, timeout: 12000 }
        );
        assert.equal(JSON.parse(output.stdout).runtimes.length, 2);
        assert(!output.stdout.includes(operatorToken));
        async function mcpCall(name, args) {
            const child = spawn(
                "python3",
                [
                    path.join(path.dirname(cli), "diagnostics_mcp.py"),
                    "--server",
                    base,
                    "--token-env",
                    "OTT_DIAGNOSTIC_TEST_TOKEN",
                ],
                { env, stdio: ["pipe", "pipe", "pipe"] }
            );
            const messages = [
                {
                    id: 1,
                    jsonrpc: "2.0",
                    method: "initialize",
                    params: {
                        capabilities: {},
                        clientInfo: { name: "acceptance", version: "1" },
                        protocolVersion: "2025-11-25",
                    },
                },
                { jsonrpc: "2.0", method: "notifications/initialized" },
                {
                    id: 2,
                    jsonrpc: "2.0",
                    method: "tools/call",
                    params: { arguments: args, name },
                },
            ];
            let stdout = "",
                stderr = "";
            child.stdout.on("data", (data) => {
                stdout += data;
                if (stdout.length > 65536) child.kill();
            });
            child.stderr.on("data", (data) => {
                stderr += data;
                if (stderr.length > 65536) child.kill();
            });
            const timer = setTimeout(() => child.kill(), 15000);
            const completion = new Promise((resolve, reject) => {
                child.on("error", reject);
                child.on("exit", (code) =>
                    code === 0
                        ? resolve()
                        : reject(new Error("MCP failed: " + stderr))
                );
            });
            child.stdin.end(
                messages.map((m) => JSON.stringify(m)).join("\n") + "\n"
            );
            try {
                await completion;
            } finally {
                clearTimeout(timer);
            }
            assert(!stdout.includes(operatorToken));
            const result = stdout
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line))
                .find((m) => m.id === 2);
            assert(
                result?.result && !result.result.isError,
                JSON.stringify(result)
            );
            return result.result.structuredContent;
        }
        const repairArgs = {
            action: "restart_stream",
            consent_epoch: "fixture-grant",
            deadline_ms: 15000,
            device_id: "test-device",
            idempotency_key: "fixture-stream-repair",
            runtime_id: selected,
            server_epoch: list.server_epoch,
        };
        const repaired = await mcpCall("diagnostics_repair", repairArgs);
        const repairReplay = await mcpCall("diagnostics_repair", repairArgs);
        assert.equal(repairReplay.repair_id, repaired.repair_id);
        await eventually(
            () => op("/repairs/" + repaired.repair_id),
            (r) => r.state === "applied",
            "Stream repair was not applied"
        );
        assert.equal(states[0]().streamRestarts, 1);
        assert.equal(
            states[1]().streamRestarts,
            0,
            "Repair must never reach the other same-token runtime"
        );
        const reload = await mcpCall("diagnostics_repair", {
            ...repairArgs,
            action: "reload_player",
            idempotency_key: "fixture-reload-repair",
        });
        await eventually(
            () => op("/repairs/" + reload.repair_id),
            (r) => r.state === "accepted",
            "Reload intent was not acknowledged"
        );
        assert.equal(
            states[0]().reloads,
            0,
            "Lost first ACK must not dispatch reload before receipt retry"
        );
        await eventually(
            () => states[0](),
            (r) => r.reloads === 1,
            "Reload never followed the acknowledged receipt retry"
        );
        assert.equal(states[1]().reloads, 0);
        const observed = await mcpCall("diagnostics_repair_status", {
            repair_id: reload.repair_id,
        });
        assert.equal(
            observed.state,
            "accepted",
            "Reload acceptance is not proof of successful recovery"
        );
        const denied = await fetch(
            base + "/api/v2/diagnostics/runtimes?device_id=other-device",
            { headers: { Authorization: "Bearer " + operatorToken } }
        );
        assert.equal(denied.status, 404);
        first.stop("consent_revoked");
        second.stop("local_stop");
        assert.equal(first.snapshot().enabled, false);
        console.log(
            "PASS diagnostics integration: verified TLS, runtime isolation, scoped access, start/stop ACKs, redacted telemetry, lost ingest ACK retry, real Python CLI/MCP, exact-runtime repairs with lost result ACKs and local revoke"
        );
    } finally {
        clients.forEach((c) => c.stop());
        gateway.closeAllConnections();
        await new Promise((r) => gateway.close(r));
        server.kill("SIGTERM");
        if (server.exitCode === null)
            await new Promise((r) => {
                server.once("exit", r);
                setTimeout(() => {
                    server.kill("SIGKILL");
                    r();
                }, 3000).unref();
            });
    }
}
(async () => {
    if (process.argv[2] === "--worker") {
        await worker(process.argv[3]);
        return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ott-diagnostics-"));
    try {
        execFileSync(
            "openssl",
            [
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=127.0.0.1",
                "-addext",
                "subjectAltName=IP:127.0.0.1",
                "-keyout",
                path.join(dir, "key.pem"),
                "-out",
                path.join(dir, "cert.pem"),
            ],
            { stdio: "ignore" }
        );
        fs.chmodSync(path.join(dir, "key.pem"), 0o600);
        await new Promise((resolve, reject) => {
            const child = spawn(
                process.execPath,
                [__filename, "--worker", dir],
                {
                    env: {
                        ...process.env,
                        NODE_EXTRA_CA_CERTS: path.join(dir, "cert.pem"),
                    },
                    stdio: "inherit",
                }
            );
            child.on("error", reject);
            child.on("exit", (code) =>
                code === 0
                    ? resolve()
                    : reject(new Error("Diagnostics integration failed"))
            );
        });
    } finally {
        fs.rmSync(dir, { force: true, recursive: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

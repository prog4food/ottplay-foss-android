const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { configuration, probe } = require("../scripts/check-stalker-portal.cjs");

const mac = "02:00:00:00:00:01";
const channel = (id) => ({
    cmd: "https://media.fixture/secret/" + id,
    id: String(id),
    name: "Private channel " + id,
    tv_genre_id: "1",
    use_http_tmp_link: 0,
});

async function fixture(run, custom) {
    const requests = [];
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, "http://fixture");
        const action = url.searchParams.get("action");
        const send = (value, status = 200) => {
            response.writeHead(status, { "Content-Type": "application/json" });
            response.end(JSON.stringify(value));
        };
        requests.push({ action, headers: request.headers, url });
        if (
            custom &&
            custom({ action, request, requests, response, send, url })
        )
            return;
        const payload = {
            get_all_channels: {
                data: [channel(42), channel(43)],
                total_items: 2,
            },
            get_genres: [{ id: "1", title: "Private group" }],
            get_profile: { blocked: "0", id: "1", status: "0" },
            handshake: { token: "private-fixture-bearer-token" },
        };
        send({ js: payload[action] ?? null });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const portal = "http://127.0.0.1:" + server.address().port + "/c/";
    try {
        await run({ portal, requests });
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

test("classic account check uses player protocol and emits only redacted metadata", async () => {
    await fixture(async ({ portal, requests }) => {
        const result = await probe({ mac, portal });
        assert.equal(result.ok, true);
        assert.equal(result.authentication, "accepted");
        assert.equal(result.protocol, "classic");
        assert.equal(result.channels, 2);
        assert.equal(result.groups, 1);
        assert.equal(result.playback, "not_checked");
        assert.equal(result.requests, 4);
        assert.deepEqual(
            requests.map((row) => row.action),
            ["handshake", "get_profile", "get_genres", "get_all_channels"]
        );
        assert.match(
            requests[0].headers.cookie,
            /mac=02%3A00%3A00%3A00%3A00%3A01/
        );
        assert.equal(requests[0].headers.authorization, undefined);
        assert.equal(
            requests[1].headers.authorization,
            "Bearer private-fixture-bearer-token"
        );
        const output = JSON.stringify(result);
        for (const secret of [
            portal,
            mac,
            "private-fixture",
            "Private",
            "media.fixture",
            "Cookie",
        ])
            assert(!output.includes(secret));
    });
});

test("JSON-RPC handshake and channels are checked with the retained core", async () => {
    await fixture(
        async ({ portal, requests }) => {
            const result = await probe({
                mac,
                server: portal.replace(/c\/$/, ""),
            });
            assert.equal(result.ok, true);
            assert.equal(result.protocol, "legacy");
            assert.equal(result.channels, 1);
            assert.equal(result.requests, 2);
            assert(
                requests.every(
                    (row) => row.url.pathname === "/stalker_portal/api/"
                )
            );
        },
        ({ request, send }) => {
            let data = "";
            request.on("data", (chunk) => {
                data += chunk;
            });
            request.on("end", () => {
                const body = JSON.parse(data);
                assert.equal(body.params.mac, mac);
                send({
                    result:
                        body.method === "handshake"
                            ? {}
                            : [
                                  {
                                      id: 42,
                                      name: "Private",
                                      url: "https://media.fixture/live",
                                  },
                              ],
                });
            });
            return true;
        }
    );
});

test("authentication denial stops before the channel catalog", async () => {
    await fixture(
        async ({ portal, requests }) => {
            const result = await probe({ mac, portal });
            assert.equal(result.ok, false);
            assert.equal(result.code, "authentication_rejected");
            assert.equal(result.authentication, "rejected");
            assert.equal(requests.length, 2);
        },
        ({ action, send }) => {
            if (action !== "get_profile") return false;
            send({ js: { blocked: "1", status: "1" } });
            return true;
        }
    );
});

test("empty handshake retries once, without treating a token as account success", async () => {
    await fixture(
        async ({ portal, requests }) => {
            const result = await probe({ mac, portal });
            assert.equal(result.ok, false);
            assert.equal(result.authentication, "not_checked");
            assert.equal(result.code, "handshake_rejected");
            assert.equal(requests.length, 2);
        },
        ({ send }) => {
            send({ js: {} });
            return true;
        }
    );
});

test("catalog-stage denial clears the earlier authentication result", async () => {
    await fixture(
        async ({ portal }) => {
            const result = await probe({ mac, portal });
            assert.equal(result.ok, false);
            assert.equal(result.authentication, "rejected");
            assert.equal(result.code, "authentication_rejected");
        },
        ({ action, send }) => {
            if (action !== "get_all_channels") return false;
            send({ js: { error: "access_denied" } });
            return true;
        }
    );
});

test("empty catalog is distinct from a usable account", async () => {
    await fixture(
        async ({ portal }) => {
            const result = await probe({ mac, portal });
            assert.equal(result.authentication, "accepted");
            assert.equal(result.ok, false);
            assert.equal(result.code, "empty_catalog");
            assert.equal(result.channels, 0);
        },
        ({ action, send }) => {
            if (action !== "get_all_channels") return false;
            send({ js: { data: [], total_items: 0 } });
            return true;
        }
    );
});

test("unsupported bulk catalog falls back to bounded paging", async () => {
    await fixture(
        async ({ portal, requests }) => {
            const result = await probe({ mac, portal });
            assert.equal(result.ok, true);
            assert.equal(result.channels, 2);
            assert.equal(
                requests.filter((row) => row.action === "get_ordered_list")
                    .length,
                2
            );
        },
        ({ action, url, send }) => {
            if (action === "get_all_channels") {
                send({}, 404);
                return true;
            }
            if (action !== "get_ordered_list") return false;
            send({
                js: {
                    data: [channel(Number(url.searchParams.get("p")))],
                    max_page_items: 1,
                    total_items: 2,
                },
            });
            return true;
        }
    );
});

test("HTTP errors, redirects, HTML and large bodies never leak server content", async () => {
    for (const [kind, code] of [
        ["denied", "access_denied"],
        ["redirect", "redirect"],
        ["html", "invalid_json"],
        ["large", "response_too_large"],
    ]) {
        await fixture(
            async ({ portal, requests }) => {
                const result = await probe({ mac, portal });
                assert.equal(result.ok, false);
                assert.equal(result.code, code);
                assert.equal(result.reachable, true);
                assert.equal(requests.length, 1);
                assert(!JSON.stringify(result).includes("private-marker"));
            },
            ({ response }) => {
                response.writeHead(
                    kind === "denied" ? 403 : kind === "redirect" ? 302 : 200,
                    { Location: "http://127.0.0.1/private-marker" }
                );
                response.end(
                    kind === "large"
                        ? "x".repeat(8 * 1024 * 1024 + 1)
                        : "<html>private-marker</html>"
                );
                return true;
            }
        );
    }
});

test("per-request timeout, overall deadline and request limits bound the check", async () => {
    await fixture(
        async ({ portal, requests }) => {
            assert.equal(
                (await probe({ mac, portal }, { timeoutMs: 30 })).code,
                "timeout"
            );
            assert.equal(requests.length, 1);
        },
        () => true
    );
    await fixture(async ({ portal, requests }) => {
        assert.equal(
            (await probe({ mac, portal }, { maxRequests: 3 })).code,
            "request_limit"
        );
        assert.equal(requests.length, 3);
    });
    await fixture(
        async ({ portal }) => {
            const result = await probe(
                { mac, portal },
                { deadlineMs: 60, timeoutMs: 1000 }
            );
            assert.equal(result.code, "timeout");
            assert(result.elapsed_ms < 500);
        },
        ({ send, response }) => {
            const timer = setTimeout(
                () => send({ js: { token: "private" } }),
                40
            );
            response.on("close", () => clearTimeout(timer));
            return true;
        }
    );
});

test("a truncated response fails without waiting for the request timeout", async () => {
    await fixture(
        async ({ portal, requests }) => {
            const result = await probe({ mac, portal }, { timeoutMs: 1000 });
            assert.equal(result.code, "response_interrupted");
            assert.equal(result.reachable, true);
            assert.equal(requests.length, 1);
            assert(!JSON.stringify(result).includes("private-marker"));
        },
        ({ response }) => {
            response.writeHead(200, { "Content-Length": 1000 });
            response.write('{"private-marker":', () => response.destroy());
            return true;
        }
    );
});

test("synchronous request construction failure leaves no timeout behind", async () => {
    const timeoutCount = () =>
        process.getActiveResourcesInfo().filter((type) => type === "Timeout")
            .length;
    const before = timeoutCount();
    const request = http.request;
    try {
        http.request = () => {
            throw new Error("private-marker");
        };
        const result = await probe(
            { mac, portal: "http://127.0.0.1/c/" },
            { timeoutMs: 1000 }
        );
        assert.equal(result.code, "check_failed");
        assert.equal(result.reachable, false);
        assert(!JSON.stringify(result).includes("private-marker"));
        assert.equal(timeoutCount(), before);
    } finally {
        http.request = request;
    }
});

test("input selects exactly one saved profile and rejects invalid configuration", async () => {
    const input = {
        active: 1,
        portals: [
            { mac, portal: "http://first.fixture/c/" },
            { mac, portal: "http://second.fixture/c/" },
        ],
    };
    assert.equal(configuration(input).portal, "http://second.fixture/c/");
    assert.equal(configuration(input, 1).portal, "http://first.fixture/c/");
    assert.equal(
        configuration({
            provider: "stalker",
            settings: { mac, server: "https://fixture.test/c/" },
        }).portal,
        "https://fixture.test/c/"
    );
    for (const bad of [
        null,
        [],
        { mac, portal: "ftp://fixture.test" },
        { mac, portal: "https://user:pass@fixture.test" },
        { mac, portal: "https://fixture.test?token=secret" },
        { mac: "bad", portal: "https://fixture.test" },
        { active: 15, portals: input.portals },
    ])
        assert.equal((await probe(bad)).ok, false);
    assert.equal((await probe(input, { profile: 0 })).code, "invalid_profile");
    assert.equal(
        (await probe(input, { deadlineMs: Infinity })).code,
        "invalid_options"
    );
});

function cli(args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(
            process.execPath,
            [
                path.join(__dirname, "../scripts/check-stalker-portal.cjs"),
                ...args,
            ],
            { timeout: 5000, ...options }
        );
        let stdout = "",
            stderr = "";
        child.stdout.on("data", (data) => {
            stdout += data;
        });
        child.stderr.on("data", (data) => {
            stderr += data;
        });
        child.on("close", (code) => resolve({ code, stderr, stdout }));
    });
}

test("CLI reads a private file, leaves it unchanged and redacts parse failures", async () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "ottplay-stalker-check-")
    );
    const file = path.join(directory, "private-input.json");
    try {
        await fixture(async ({ portal }) => {
            const source = JSON.stringify({ mac, portal });
            fs.writeFileSync(file, source, { mode: 0o600 });
            const result = await cli(["--input", file]);
            assert.equal(result.code, 0);
            assert.equal(result.stderr, "");
            assert.equal(JSON.parse(result.stdout).channels, 2);
            assert.equal(fs.readFileSync(file, "utf8"), source);
            assert(!result.stdout.includes(mac));
        });
        fs.writeFileSync(file, "private-marker-not-json");
        const invalid = await cli(["--input", file]);
        assert.equal(invalid.code, 2);
        assert.equal(JSON.parse(invalid.stdout).code, "invalid_json_input");
        assert(!invalid.stdout.includes("private-marker"));
        assert.equal(invalid.stderr, "");
        assert.equal((await cli(["--unknown", "private-marker"])).code, 2);
    } finally {
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("CLI rejects invalid limits and protocols before opening the input", async () => {
    for (const args of [
        ["--profile", "0"],
        ["--profile", "16"],
        ["--timeout", "0"],
        ["--timeout", "61"],
        ["--deadline", "301"],
        ["--max-requests", "201"],
        ["--timeout", "1e1"],
        ["--protocol", "private-marker"],
    ]) {
        const result = await cli(["--input", "unused-private-input", ...args]);
        assert.equal(result.code, 2);
        assert.deepEqual(JSON.parse(result.stdout), {
            code: "invalid_arguments",
            ok: false,
            stage: "input",
        });
        assert.equal(result.stderr, "");
    }
});

test("CLI distinguishes missing option values from option-like filenames", async () => {
    for (const value of ["--input", "--profile", "--timeout", "--help"])
        assert.deepEqual(JSON.parse((await cli(["--input", value])).stdout), {
            code: "invalid_arguments",
            ok: false,
            stage: "input",
        });
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "ottplay-stalker-filename-")
    );
    try {
        for (const name of ["--private-fixture.json", "--profile", "--help"])
            fs.writeFileSync(path.join(directory, name), "null");
        for (const input of [
            "--private-fixture.json",
            "./--profile",
            "./--help",
        ]) {
            const result = await cli(["--input", input], { cwd: directory });
            assert.equal(result.code, 1);
            assert.equal(JSON.parse(result.stdout).code, "invalid_input");
        }
    } finally {
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("CLI rejects a FIFO without blocking for a writer", {
    skip: process.platform === "win32",
}, async () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "ottplay-stalker-fifo-")
    );
    const file = path.join(directory, "input-pipe");
    try {
        execFileSync("mkfifo", [file]);
        const result = await cli(["--input", file]);
        assert.equal(result.code, 2);
        assert.deepEqual(JSON.parse(result.stdout), {
            code: "invalid_input_file",
            ok: false,
            stage: "input",
        });
        assert.equal(result.stderr, "");
    } finally {
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

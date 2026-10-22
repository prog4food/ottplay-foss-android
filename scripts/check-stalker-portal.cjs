#!/usr/bin/env node
"use strict";

// One explicitly supplied account, using the same protocol core as the player.
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const vm = require("node:vm");

const MAX_INPUT = 256 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
let sharedCore;

class ProbeError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

function core() {
    if (!sharedCore) {
        require("./shared-core.cjs").check();
        const context = vm.createContext({});
        vm.runInContext(
            fs.readFileSync(
                path.join(__dirname, "../vendor/ottplay-core.js"),
                "utf8"
            ),
            context,
            { timeout: 5000 }
        );
        sharedCore = context["play.ott:ottplay-shared-core"];
    }
    return sharedCore;
}

function configuration(input, profile) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new ProbeError("invalid_input");
    let row = input;
    if (Array.isArray(input.portals)) {
        const index = profile === undefined ? (input.active ?? 0) : profile - 1;
        if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= 15 ||
            !input.portals[index]
        )
            throw new ProbeError("invalid_profile");
        row = input.portals[index];
    } else if (profile !== undefined) throw new ProbeError("invalid_profile");
    if (input.provider && input.provider !== "stalker")
        throw new ProbeError("invalid_input");
    if (!row || typeof row !== "object" || Array.isArray(row))
        throw new ProbeError("invalid_input");
    row = row.settings || row;
    if (typeof row !== "object" || Array.isArray(row))
        throw new ProbeError("invalid_input");
    const portal = row.portal ?? row.server ?? row.url;
    const mac = row.mac ?? row.username;
    if (
        typeof portal !== "string" ||
        typeof mac !== "string" ||
        !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(mac.trim())
    )
        throw new ProbeError("invalid_input");
    const url = endpoint(portal.trim());
    if (url.search || url.hash) throw new ProbeError("invalid_input");
    return { mac: mac.trim().toUpperCase(), portal: url.href };
}

function endpoint(value) {
    let url;
    try {
        url = new URL(value);
    } catch (_) {
        throw new ProbeError("invalid_input");
    }
    if (
        !/^https?:$/.test(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
    )
        throw new ProbeError("invalid_input");
    return url;
}

function classicUrl(value) {
    const clean = value.replace(/\/+$/, "");
    if (/\/stalker_portal$/i.test(clean)) return clean + "/c/";
    return /\/(?:c(?:\/index\.html)?|(?:server\/)?load\.php|portal\.php)$/i.test(
        clean
    )
        ? clean
        : "";
}

function requestJson(request, milliseconds, report) {
    return new Promise((resolve, reject) => {
        const url = endpoint(request.url);
        const controller = new AbortController();
        let timer;
        const done = (error, value) => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
        };
        const pending = (url.protocol === "https:" ? https : http).request(
            url,
            {
                headers: {
                    Accept: "application/json",
                    "Accept-Encoding": "identity",
                    "User-Agent": "OttPlay-Portal-Check/1",
                    ...request.headers,
                },
                method: request.body ? "POST" : "GET",
                signal: controller.signal,
            },
            (response) => {
                const status = response.statusCode;
                report.reachable = true;
                report.http_status = status;
                // Never forward account cookies or bearer tokens to a redirect target.
                if (status < 200 || status >= 300) {
                    response.destroy();
                    done(
                        new ProbeError(
                            status >= 300 && status < 400
                                ? "redirect"
                                : status === 401 || status === 403
                                  ? "access_denied"
                                  : "http_error"
                        )
                    );
                    return;
                }
                const chunks = [];
                let size = 0;
                response.on("data", (chunk) => {
                    size += chunk.length;
                    if (size > MAX_RESPONSE) {
                        response.destroy();
                        done(new ProbeError("response_too_large"));
                    } else chunks.push(chunk);
                });
                response.on("error", () =>
                    done(new ProbeError("response_interrupted"))
                );
                response.on("end", () => {
                    try {
                        done(
                            null,
                            JSON.parse(
                                Buffer.concat(chunks)
                                    .toString("utf8")
                                    .replace(/^\uFEFF/, "")
                            )
                        );
                    } catch (_) {
                        done(new ProbeError("invalid_json"));
                    }
                });
            }
        );
        pending.on("error", (error) =>
            done(
                new ProbeError(
                    controller.signal.aborted
                        ? "timeout"
                        : error.code === "ENOTFOUND" ||
                            error.code === "EAI_AGAIN"
                          ? "dns_error"
                          : /CERT|TLS|SSL/.test(String(error.code))
                            ? "tls_error"
                            : "connection_error"
                )
            )
        );
        timer = setTimeout(() => controller.abort(), milliseconds);
        pending.end(request.body);
    });
}

async function probe(input, options = {}) {
    const started = Date.now();
    const report = {
        authentication: "not_checked",
        channels: null,
        code: "invalid_input",
        elapsed_ms: 0,
        groups: null,
        http_status: null,
        ok: false,
        playback: "not_checked",
        protocol: null,
        reachable: false,
        requests: 0,
        stage: "input",
    };
    try {
        const config = configuration(input, options.profile);
        const timeout = options.timeoutMs ?? 15000;
        const deadline = options.deadlineMs ?? 60000;
        const limit = options.maxRequests ?? 32;
        if (
            ![timeout, deadline, limit].every(
                (value) => Number.isInteger(value) && value > 0
            ) ||
            timeout > 60000 ||
            deadline > 300000 ||
            limit > 200
        )
            throw new ProbeError("invalid_options");
        const protocol = options.protocol || "auto";
        if (!["auto", "classic", "legacy"].includes(protocol))
            throw new ProbeError("invalid_options");
        const classic =
            protocol === "classic" ||
            (protocol === "auto" && !!classicUrl(config.portal));
        report.protocol = classic ? "classic" : "legacy";
        report.stage = "runtime";
        const runtime = core();
        let client, operation;
        let retriedHandshake = false;
        if (classic) {
            const settings = {
                bulkCatalog: true,
                id: "check",
                language: "en",
                mac: config.mac,
                profile: { stb_type: "MAG250" },
                timezone: "Etc/UTC",
                url: classicUrl(config.portal) || config.portal,
            };
            const normalized = runtime.stalkerConfig(settings);
            if (normalized.failure) throw new ProbeError("invalid_input");
            Object.assign(settings, normalized);
            const absolute = (value) => new URL(value, settings.referer).href;
            client = new runtime.StalkerClient(
                settings,
                1,
                encodeURIComponent,
                absolute,
                absolute
            );
            operation = client.load();
        } else {
            client = new runtime.LegacyStalkerClient(config.portal, config.mac);
            operation = client;
        }
        for (;;) {
            const request = operation.request();
            if (!request) break;
            if (report.requests >= limit) throw new ProbeError("request_limit");
            const remaining = deadline - (Date.now() - started);
            if (remaining <= 0) throw new ProbeError("deadline");
            const action = classic
                ? new URL(request.url).searchParams.get("action")
                : request.method;
            report.stage =
                action === "handshake"
                    ? "handshake"
                    : action === "get_profile"
                      ? "profile"
                      : "catalog";
            report.requests++;
            let value;
            try {
                value = await requestJson(
                    classic
                        ? request
                        : {
                              body: JSON.stringify(request),
                              headers: { "Content-Type": "application/json" },
                              url: client.endpoint(),
                          },
                    Math.min(timeout, remaining),
                    report
                );
            } catch (error) {
                // Match the player's bounded fallback from bulk catalog to pages.
                if (
                    classic &&
                    error.code === "http_error" &&
                    operation.reject(report.http_status)
                )
                    continue;
                throw error;
            }
            const failure = operation.accept(value);
            if (failure) {
                const response =
                    value && value.js !== undefined ? value.js : value;
                if (
                    classic &&
                    action === "handshake" &&
                    !retriedHandshake &&
                    (response == null ||
                        (typeof response === "object" &&
                            Object.keys(response).length === 0))
                ) {
                    retriedHandshake = true;
                    operation = client.load();
                    continue;
                }
                if (classic && failure.failure === "HANDSHAKE")
                    throw new ProbeError("handshake_rejected");
                const denied =
                    failure.failure === "PORTAL_AUTH" ||
                    failure.failure === "PROFILE_AUTH" ||
                    report.stage === "profile" ||
                    report.stage === "handshake";
                if (denied) report.authentication = "rejected";
                throw new ProbeError(
                    denied ? "authentication_rejected" : "catalog_rejected"
                );
            }
            if (action === (classic ? "get_profile" : "handshake"))
                report.authentication = "accepted";
        }
        if (Date.now() - started >= deadline) throw new ProbeError("deadline");
        const channels = classic
            ? operation.result().channels.filter((row) => row.kind === "live")
            : client.channelCatalog();
        report.stage = "catalog";
        report.channels = channels.length;
        report.groups = new Set(
            channels.map((row) => (classic ? row.group : row.groupName))
        ).size;
        report.ok = channels.length > 0;
        report.code = report.ok ? "catalog_ok" : "empty_catalog";
    } catch (error) {
        if (error.code === "access_denied") report.authentication = "rejected";
        report.code =
            error instanceof ProbeError
                ? error.code
                : report.stage === "runtime"
                  ? "runtime_unavailable"
                  : "check_failed";
    }
    report.elapsed_ms = Date.now() - started;
    return report;
}

async function main(args) {
    if (args.length === 1 && args[0] === "--help") {
        console.log(
            "Usage: node scripts/check-stalker-portal.cjs --input FILE [--profile 1..15] [--protocol auto|classic|legacy] [--timeout 15] [--deadline 60] [--max-requests 32]\nChecks one supplied account; JSON output omits URLs, MACs, tokens and channel names. Does not play streams or modify profiles."
        );
        return 0;
    }
    try {
        const flags = {};
        const optionNames = [
            "--input",
            "--profile",
            "--protocol",
            "--timeout",
            "--deadline",
            "--max-requests",
        ];
        for (let index = 0; index < args.length; index += 2) {
            const key = args[index];
            if (
                !optionNames.includes(key) ||
                flags[key] !== undefined ||
                !args[index + 1] ||
                args[index + 1] === "--help" ||
                optionNames.includes(args[index + 1])
            )
                throw new ProbeError("invalid_arguments");
            flags[key] = args[index + 1];
        }
        if (!flags["--input"]) throw new ProbeError("input_required");
        const options = { protocol: flags["--protocol"] };
        if (
            options.protocol !== undefined &&
            !["auto", "classic", "legacy"].includes(options.protocol)
        )
            throw new ProbeError("invalid_arguments");
        for (const [key, name, scale, maximum] of [
            ["--profile", "profile", 1, 15],
            ["--timeout", "timeoutMs", 1000, 60],
            ["--deadline", "deadlineMs", 1000, 300],
            ["--max-requests", "maxRequests", 1, 200],
        ]) {
            if (flags[key] !== undefined) {
                const value = Number(flags[key]);
                if (!/^\d+$/.test(flags[key]) || value < 1 || value > maximum)
                    throw new ProbeError("invalid_arguments");
                options[name] = value * scale;
            }
        }
        const fd = fs.openSync(
            flags["--input"],
            fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0)
        );
        let source;
        try {
            if (!fs.fstatSync(fd).isFile())
                throw new ProbeError("invalid_input_file");
            const bytes = Buffer.alloc(MAX_INPUT + 1);
            const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
            if (length > MAX_INPUT) throw new ProbeError("input_too_large");
            source = bytes.subarray(0, length).toString("utf8");
        } finally {
            fs.closeSync(fd);
        }
        let input;
        try {
            input = JSON.parse(source.replace(/^\uFEFF/, ""));
        } catch (_) {
            throw new ProbeError("invalid_json_input");
        }
        const report = await probe(input, options);
        console.log(JSON.stringify(report, null, 2));
        return report.ok ? 0 : 1;
    } catch (error) {
        console.log(
            JSON.stringify({
                code:
                    error instanceof ProbeError
                        ? error.code
                        : "input_unavailable",
                ok: false,
                stage: "input",
            })
        );
        return 2;
    }
}

module.exports = { configuration, main, probe };
if (require.main === module)
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    });

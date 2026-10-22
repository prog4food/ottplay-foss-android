import { validDeviceId, validDeviceToken } from "../shared/wire-contracts";
import { CommandServerRequest, CommandServerResponse } from "./command-server";

/** Discovery carries addresses only. Pairing credentials exist only in this closure. */
export function createControlDiscovery(
    w: any,
    send: (
        request: CommandServerRequest,
        complete: (response?: CommandServerResponse) => void
    ) => () => void,
    readConfig: () => any,
    applyConfig: (value: any) => void,
    deviceId: () => string,
    nativeDiscover?: () => Promise<any>
): any {
    var generation = 0;
    var timer: any = null;
    var deadlineTimer: any = null;
    var abort: (() => void) | null = null;
    var listener: (() => void) | null = null;
    var snapshot = "";
    var device = "";
    var active = false;
    var attempted = false;
    var state = "idle";
    var message = "Command server discovery has not started.";
    var messageArgument = "";
    var code = "";
    var servers: any[] = [];
    var claim: { url: string; secret: string } | null = null;
    function releaseClaim(): void {
        var receipt = claim;
        claim = null;
        if (!receipt) return;
        try {
            send(
                {
                    headers: { Authorization: "Bearer " + receipt.secret },
                    method: "DELETE",
                    secureControl: true,
                    timeoutMs: 2000,
                    url: receipt.url,
                },
                function () {}
            );
        } catch (_error) {}
    }
    function identity(): string {
        var config = readConfig();
        return JSON.stringify([
            config.address,
            config.token,
            config.enabled,
            config.generation,
            deviceId(),
        ]);
    }
    function notify(next: string, text: string, argument?: string): void {
        state = next;
        message = text;
        messageArgument = argument || "";
        if (listener) listener();
    }
    function stop(keepClaim?: boolean): void {
        generation++;
        active = false;
        w.clearTimeout(timer);
        w.clearTimeout(deadlineTimer);
        timer = deadlineTimer = null;
        var old = abort;
        abort = null;
        if (old) {
            try {
                old();
            } catch (_error) {}
        }
        code = "";
        if (!keepClaim) releaseClaim();
    }
    function finish(next: string, text: string): void {
        stop();
        servers = [];
        notify(next, text);
    }
    function current(expected: number): boolean {
        if (!active || generation !== expected) return false;
        if (snapshot !== identity()) {
            finish("canceled", "Settings changed. Discovery was canceled.");
            return false;
        }
        return true;
    }
    function base(value: any): string {
        if (typeof value !== "string" || value.length > 2048) throw Error();
        var url = new URL(value);
        if (
            url.protocol !== "https:" ||
            !url.hostname ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            /[\s\\]/.test(value)
        )
            throw Error();
        return url.origin + url.pathname.replace(/\/+$/, "");
    }
    function request(
        url: string,
        method: string,
        data: any,
        secret: string,
        complete: (response?: CommandServerResponse) => void,
        discoveryRequest?: boolean
    ): void {
        var expected = generation;
        var finished = false;
        var headers: Record<string, string> = {};
        if (discoveryRequest && new URL(url).origin === w.location.origin)
            headers["X-Ottplay-Discovery"] = "1";
        if (secret) headers.Authorization = "Bearer " + secret;
        if (data) headers["Content-Type"] = "application/json";
        try {
            var release = send(
                {
                    body: data ? JSON.stringify(data) : undefined,
                    headers: headers,
                    method: method,
                    secureControl: new URL(url).protocol === "https:",
                    timeoutMs: 8000,
                    url: url,
                },
                function (response) {
                    finished = true;
                    if (!current(expected)) return;
                    abort = null;
                    if (
                        response &&
                        response.error === "secure_control_unavailable"
                    ) {
                        finish(
                            "error",
                            "This browser cannot safely pair automatically. Update it or enter the command server settings manually."
                        );
                        return;
                    }
                    complete(response);
                }
            );
            if (!finished && current(expected)) abort = release;
            else if (!finished && release) release();
        } catch (_error) {
            if (!finished && current(expected)) complete();
        }
    }
    function decode(response: CommandServerResponse | undefined): any {
        if (!response || response.body.length > 65536) throw Error();
        return JSON.parse(response.body);
    }
    function pair(index: number): void {
        var expected = generation;
        if (!current(expected) || state !== "choose" || !servers[index]) return;
        var selected = servers[index];
        servers = [];
        notify("pairing", "Requesting approval for %1", selected.address);
        if (!current(expected)) return;
        var endpoint = selected.address + "/api/pairings";
        request(
            endpoint,
            "POST",
            { device_id: device, server_id: selected.id },
            "",
            function (response) {
                var receipt: any;
                try {
                    receipt = decode(response);
                    if (
                        response!.status !== 201 ||
                        !receipt ||
                        typeof receipt.id !== "string" ||
                        !/^[a-f0-9]{32}$/.test(receipt.id) ||
                        typeof receipt.secret !== "string" ||
                        !validDeviceToken(receipt.secret) ||
                        typeof receipt.code !== "string" ||
                        !/^[A-Z0-9]{8}$/.test(receipt.code) ||
                        typeof receipt.expires_in !== "number" ||
                        !isFinite(receipt.expires_in) ||
                        receipt.expires_in <= 0 ||
                        receipt.expires_in > 600
                    )
                        throw Error();
                } catch (_error) {
                    finish(
                        "error",
                        "Could not create a pairing request. Find the server again to retry."
                    );
                    return;
                }
                claim = {
                    secret: receipt.secret,
                    url: endpoint + "?id=" + encodeURIComponent(receipt.id),
                };
                code = receipt.code;
                w.clearTimeout(deadlineTimer);
                deadlineTimer = w.setTimeout(function () {
                    if (current(expected))
                        finish(
                            "expired",
                            "Pairing expired. Find the server again to retry."
                        );
                }, receipt.expires_in * 1000);
                notify(
                    "waiting",
                    "Approve the code for %1 with ott approve NAME CODE:",
                    selected.address
                );
                var failures = 0;
                function poll(): void {
                    if (!current(expected)) return;
                    request(
                        endpoint + "?id=" + encodeURIComponent(receipt.id),
                        "GET",
                        null,
                        receipt.secret,
                        function (answer) {
                            if (!answer || answer.status >= 500) {
                                if (++failures >= 6) {
                                    finish(
                                        "error",
                                        "Pairing server is unavailable. Find the server again to retry."
                                    );
                                    return;
                                }
                                timer = w.setTimeout(
                                    poll,
                                    Math.min(10000, failures * 2000)
                                );
                                return;
                            }
                            var approval: any;
                            try {
                                approval = decode(answer);
                                if (
                                    answer.status === 202 &&
                                    approval &&
                                    approval.status === "pending"
                                ) {
                                    failures = 0;
                                    timer = w.setTimeout(poll, 2000);
                                    return;
                                }
                                if (
                                    answer.status !== 200 ||
                                    !approval ||
                                    approval.status !== "approved" ||
                                    approval.device_id !== device ||
                                    base(approval.address) !==
                                        selected.address ||
                                    typeof approval.token !== "string" ||
                                    !validDeviceToken(approval.token)
                                )
                                    throw Error();
                            } catch (_error) {
                                finish(
                                    "error",
                                    "Pairing was rejected or returned an invalid approval. Find the server again to retry."
                                );
                                return;
                            }
                            if (!current(expected)) return;
                            stop(true);
                            try {
                                applyConfig({
                                    address: selected.address,
                                    enabled: true,
                                    token: approval.token,
                                });
                                releaseClaim();
                                notify(
                                    "connected",
                                    "Pairing approved. Command server configured."
                                );
                            } catch (_error) {
                                notify(
                                    "error",
                                    "Could not save the approved command server settings."
                                );
                            }
                        }
                    );
                }
                if (current(expected)) timer = w.setTimeout(poll, 2000);
            }
        );
    }
    function accept(value: any): void {
        try {
            if (
                !value ||
                value.version !== 1 ||
                !Array.isArray(value.servers) ||
                value.servers.length > 16
            )
                throw Error();
            var seen: Record<string, boolean> = Object.create(null);
            servers = value.servers.map(function (server: any) {
                if (
                    !server ||
                    typeof server.id !== "string" ||
                    !server.id ||
                    server.id.length > 255 ||
                    typeof server.domain !== "string" ||
                    server.domain.length > 253
                )
                    throw Error();
                var address = base(server.address);
                if (seen[server.id]) throw Error();
                seen[server.id] = true;
                return {
                    address: address,
                    domain: server.domain,
                    id: server.id,
                };
            });
        } catch (_error) {
            finish("error", "The discovery response is invalid.");
            return;
        }
        w.clearTimeout(deadlineTimer);
        deadlineTimer = null;
        if (!servers.length) {
            finish(
                "unavailable",
                "No command server was found on this network."
            );
            return;
        }
        var expected = generation;
        var single = servers.length === 1;
        notify(
            "choose",
            single
                ? "Command server found."
                : "Several command servers were found. Select one below."
        );
        if (single && current(expected)) pair(0);
    }
    function browserDiscover(): void {
        var profile = w.__OTT_CONTROL_DISCOVERY_URL__;
        var url: URL;
        try {
            if (
                !profile &&
                /^(localhost|127\.0\.0\.1|\[::1\])$/.test(w.location.hostname)
            )
                profile = "/api/control-discovery";
            if (typeof profile !== "string" || !profile) {
                finish(
                    "unavailable",
                    "This browser has no discovery profile. Enter a server address or configure the deployment profile."
                );
                return;
            }
            url = new URL(profile, w.location.href);
            if (
                url.username ||
                url.password ||
                url.hash ||
                (url.protocol !== "https:" &&
                    !(
                        url.protocol === "http:" &&
                        url.origin === w.location.origin
                    ))
            )
                throw Error();
        } catch (_error) {
            finish("error", "The command server discovery URL is invalid.");
            return;
        }
        request(
            url.href,
            "GET",
            null,
            "",
            function (response) {
                try {
                    if (!response || response.status !== 200) throw Error();
                    accept(decode(response));
                } catch (_error) {
                    finish(
                        "unavailable",
                        "Command server discovery is unavailable. Use Find command server to retry."
                    );
                }
            },
            true
        );
    }
    return {
        cancel: function () {
            finish("canceled", "Command server discovery canceled.");
        },
        choose: pair,
        start: function (explicit?: boolean) {
            var config = readConfig();
            if (
                !explicit &&
                (attempted || config.address || config.token || config.enabled)
            )
                return;
            attempted = true;
            stop();
            device = deviceId();
            if (!validDeviceId(device)) {
                finish(
                    "error",
                    "Device UUID is not ready. Use Find command server to retry."
                );
                return;
            }
            snapshot = identity();
            active = true;
            servers = [];
            var expected = generation;
            notify("discovering", "Finding command servers...");
            if (!current(expected)) return;
            deadlineTimer = w.setTimeout(function () {
                if (current(expected))
                    finish("error", "Command server discovery timed out.");
            }, 15000);
            if (nativeDiscover) {
                try {
                    nativeDiscover().then(
                        function (value) {
                            if (current(expected)) accept(value);
                        },
                        function () {
                            if (current(expected)) browserDiscover();
                        }
                    );
                } catch (_error) {
                    browserDiscover();
                }
            } else browserDiscover();
        },
        status: function () {
            return {
                code: code,
                message: message,
                messageArgument: messageArgument,
                servers: servers.map(function (server) {
                    return {
                        address: server.address,
                        domain: server.domain,
                        id: server.id,
                    };
                }),
                state: state,
            };
        },
        subscribe: function (callback: (() => void) | null) {
            listener = callback;
        },
    };
}

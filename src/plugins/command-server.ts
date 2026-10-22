import {
    commandEndpointBase,
    validCommandEnvelope,
    validDeviceId,
    validDeviceToken,
    wire,
} from "../shared/wire-contracts";

/** Outbound command delivery. Independent of native HTTP listening and WebCrypto. */
export interface CommandServerConfig {
    address: string;
    enabled: boolean;
    token: string;
}

export interface CommandServerRequest {
    body?: string;
    headers: Record<string, string>;
    method: string;
    remoteControl?: boolean;
    requestId?: string;
    screenshotControl?: boolean;
    secureControl?: boolean;
    timeoutMs: number;
    url: string;
}

export interface CommandServerResponse {
    body: string;
    error?: string;
    status: number;
}

/** Accept an address or an old command endpoint; new connections always use ACK delivery. */
export function normalizeCommandServerAddress(value: string): string {
    var address = String(value || "").trim();
    if (!address || /[\s\\#]/.test(address))
        throw new Error("Enter a server address without spaces or a fragment.");
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) {
        if (
            /^[a-z][a-z0-9+.-]*:/i.test(address) &&
            !/^[^:]+:\d+(?:[/?]|$)/.test(address) &&
            address.charAt(0) !== "[" &&
            (address.match(/:/g) || []).length < 2
        )
            throw new Error("Use an HTTP or HTTPS server address.");
        // Add the default port to the authority, never to the device query.
        var suffix = address.search(/[/?]/);
        var host = suffix < 0 ? address : address.slice(0, suffix);
        var rest = suffix < 0 ? "" : address.slice(suffix);
        if (host.charAt(0) !== "[" && (host.match(/:/g) || []).length > 1)
            host = "[" + host + "]";
        if (!/:\d+$/.test(host)) host += ":8081";
        address = "http://" + host + rest;
    }
    var parsed: URL;
    try {
        parsed = new URL(address);
    } catch (_error) {
        throw new Error(
            "Enter a valid server address, for example 192.168.1.20:8081."
        );
    }
    if (
        !/^https?:$/.test(parsed.protocol) ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password
    )
        throw new Error(
            "Use HTTP or HTTPS without a username or password in the address."
        );
    var deviceQuery = "";
    if (parsed.search) {
        var parts = parsed.search.slice(1).split("&");
        if (parts.length !== 1 || parts[0].split("=")[0] !== "device_id")
            throw new Error(
                "Enter the access code separately, not in the server address."
            );
        var device = "";
        try {
            device = decodeURIComponent(parts[0].slice("device_id=".length));
        } catch (_error) {}
        if (!validDeviceId(device))
            throw new Error("The device ID in the address is invalid.");
        deviceQuery = "?device_id=" + encodeURIComponent(device);
    }
    var base = parsed.pathname.replace(/\/+$/, "");
    base = commandEndpointBase(base);
    return (
        parsed.protocol +
        "//" +
        parsed.host +
        base +
        wire.commandPath +
        deviceQuery
    );
}

/** Injectable transport keeps the same delivery rules for XHR and native HTTP. */
export function createCommandServer(
    w: any,
    send: (
        request: CommandServerRequest,
        complete: (response?: CommandServerResponse) => void
    ) => () => void,
    persist: (config: CommandServerConfig) => void,
    dispatch: (command: any) => string | void,
    execute?: (
        request: any,
        done: (result: any) => void,
        afterReply: (effect: () => void) => void
    ) => (() => void) | void,
    acceptRequest?: (request: any) => boolean
): any {
    var config: CommandServerConfig = {
        address: "",
        enabled: false,
        token: "",
    };
    var generation = 0;
    var timer: any = null;
    var cancel: (() => void) | null = null;
    var active = false;
    var failures = 0;
    var seen: Record<string, boolean> = Object.create(null);
    var seenOrder: string[] = [];
    var seenAddress = "";
    var seenToken = "";
    var pending: string[] = [];
    var deferredUntil: Record<string, number> = Object.create(null);
    var lastCommandMessage = "";
    var state = "disconnected";
    var message = "Disconnected";
    var listener: (() => void) | null = null;
    var responses: string[] = [];
    var responseHistory: Record<string, string> = Object.create(null);
    var responseOrder: string[] = [];
    var historySize = 0;
    // Images have a shorter lifetime than ordinary receipts. Small tombstones
    // prevent cache eviction or revocation from turning delivery replay into capture.
    var screenshotSeen: Record<string, string> = Object.create(null);
    var screenshotOrder: string[] = [];
    var screenshotImages: Record<
        string,
        { body: string; deadline: number; timer: any }
    > = Object.create(null);
    var activeScreenshotBody: string | null = null;
    var cancelScreenshotPost: (() => void) | null = null;
    var moreRequests = false;
    var cancelExecution: (() => void) | null = null;
    // Delivery effects are local capabilities, never part of JSON or replay history.
    var pendingEffect: {
        body: string;
        deadline: number;
        run: () => void;
    } | null = null;

    function screenshotTombstone(id: string): string {
        return JSON.stringify({
            data: {
                error: "Screenshot result expired or was revoked; request a new screenshot explicitly.",
            },
            id: id,
            status: "rejected",
        });
    }
    function retireScreenshot(id: string): boolean {
        var record = screenshotImages[id];
        if (!record) return false;
        w.clearTimeout(record.timer);
        delete screenshotImages[id];
        var replacement = screenshotSeen[id] || screenshotTombstone(id);
        if (responseHistory[id] === record.body) {
            historySize += replacement.length - record.body.length;
            responseHistory[id] = replacement;
        }
        responses = responses.map(function (body) {
            return body === record.body ? replacement : body;
        });
        if (activeScreenshotBody === record.body && cancelScreenshotPost) {
            cancelScreenshotPost();
            return true;
        }
        return false;
    }
    function purgeScreenshots(all: boolean, through: number): boolean {
        var aborted = false;
        Object.keys(screenshotImages).forEach(function (id) {
            if (
                all ||
                screenshotImages[id].deadline <= Math.max(through, Date.now())
            )
                aborted = retireScreenshot(id) || aborted;
        });
        return aborted;
    }
    function discardScreenshots(): void {
        if (purgeScreenshots(true, Date.now())) schedule(0);
    }
    function status(): any {
        return {
            address: config.address,
            enabled: config.enabled,
            generation: generation,
            message: message,
            state: state,
        };
    }
    function update(next: string, text: string): void {
        state = next;
        message = text;
        if (listener) listener();
    }
    function stop(): void {
        generation++;
        if (timer !== null) w.clearTimeout(timer);
        timer = null;
        var abort = cancel;
        cancel = null;
        activeScreenshotBody = null;
        cancelScreenshotPost = null;
        active = false;
        var abortWork = cancelExecution;
        cancelExecution = null;
        if (abortWork) {
            try {
                abortWork();
            } catch (_error) {}
        }
        responses = [];
        purgeScreenshots(true, Date.now());
        pendingEffect = null;
        moreRequests = false;
        if (abort) {
            try {
                abort();
            } catch (_error) {}
        }
        pending = [];
        deferredUntil = Object.create(null);
        lastCommandMessage = "";
        failures = 0;
    }
    function schedule(delay: number): void {
        if (!config.enabled) return;
        if (timer !== null) w.clearTimeout(timer);
        timer = w.setTimeout(function () {
            timer = null;
            poll();
        }, delay);
    }
    function failed(response?: CommandServerResponse): void {
        failures++;
        var denied =
            response && (response.status === 401 || response.status === 403);
        update(
            "error",
            denied
                ? "Access denied. Check the server access code."
                : "Server unavailable. Retrying automatically; check its address and network access."
        );
        schedule(
            Math.min(30000, 1000 * Math.pow(2, Math.min(failures, 5))) +
                Math.floor(Math.random() * 500)
        );
    }
    function request(
        method: string,
        ids?: string[],
        responseToSend?: string
    ): void {
        if (!config.enabled || active) return;
        var current = generation;
        var requestStarted = Date.now();
        active = true;
        var url = config.address;
        var queryIndex = url.indexOf("?");
        if (responseToSend)
            url =
                (queryIndex < 0 ? url : url.slice(0, queryIndex)).slice(
                    0,
                    -wire.commandPath.length
                ) + "/api/responses";
        else if (ids)
            url =
                (queryIndex < 0 ? url : url.slice(0, queryIndex)) +
                wire.ackPath.slice(wire.commandPath.length) +
                (queryIndex < 0 ? "" : url.slice(queryIndex));
        else url += (queryIndex < 0 ? "?" : "&") + "delivery=ack";
        var headers: Record<string, string> = {
            Authorization: "Bearer " + config.token,
        };
        if (ids || responseToSend) headers["Content-Type"] = "application/json";
        var finished = false;
        function complete(response?: CommandServerResponse): void {
            if (finished || current !== generation || !config.enabled) return;
            finished = true;
            active = false;
            cancel = null;
            activeScreenshotBody = null;
            cancelScreenshotPost = null;
            // The server may have restarted or expired a request during execution.
            if (responseToSend && response && response.status === 404) {
                responses.shift();
                pendingEffect = null;
                schedule(1000);
                return;
            }
            if (!response || response.status !== 200) {
                failed(response);
                return;
            }
            var data: any;
            try {
                data = JSON.parse(response.body);
            } catch (_error) {
                failed();
                return;
            }
            var waiting = false;
            if (responseToSend) {
                if (!data || data.status !== "ok") {
                    failed();
                    return;
                }
                responses.shift();
                var effect = pendingEffect;
                pendingEffect = null;
                if (
                    effect &&
                    effect.body === responseToSend &&
                    Date.now() < effect.deadline
                ) {
                    // Retire before invocation: lost ACKs or reentrant reloads cannot replay it.
                    try {
                        effect.run();
                    } catch (_error) {}
                    if (current !== generation || !config.enabled) return;
                }
            } else if (ids) {
                if (!data || data.status !== "ok") {
                    failed();
                    return;
                }
                pending = pending.filter(function (id) {
                    return ids.indexOf(id) === -1;
                });
            } else {
                if (!validCommandEnvelope(data)) {
                    failed();
                    return;
                }
                moreRequests = false;
                var now = Date.now();
                for (var j = 0; j < data.commands.length; j++) {
                    var command = data.commands[j];
                    if (!seen[command.id]) {
                        var deadline = deferredUntil[command.id];
                        if (!deadline) deadline = now + 60000;
                        if (
                            typeof command.expires_at === "number" &&
                            isFinite(command.expires_at) &&
                            typeof data.server_time === "number" &&
                            isFinite(data.server_time)
                        )
                            deadline = Math.min(
                                deadline,
                                requestStarted +
                                    Math.max(
                                        0,
                                        command.expires_at - data.server_time
                                    ) *
                                        1000
                            );
                        var result: string | void = "accepted";
                        // Mark before dispatch: an ACK retry must not repeat a volume step.
                        seen[command.id] = true;
                        seenOrder.push(command.id);
                        while (seenOrder.length > 2048)
                            delete seen[seenOrder.shift()!];
                        if (now >= deadline) {
                            lastCommandMessage =
                                "A command expired while the player was loading channels.";
                        } else {
                            try {
                                result = dispatch(command);
                            } catch (_error) {
                                result = "rejected";
                            }
                            if (current !== generation || !config.enabled)
                                return;
                            if (result === "deferred") {
                                delete seen[command.id];
                                seenOrder.splice(
                                    seenOrder.indexOf(command.id),
                                    1
                                );
                                deferredUntil[command.id] = deadline;
                                waiting = true;
                                break;
                            }
                            if (
                                result === "unsupported" ||
                                result === "rejected"
                            )
                                lastCommandMessage =
                                    "A command was rejected by the player. Check its provider and settings.";
                        }
                        delete deferredUntil[command.id];
                    }
                    if (current !== generation || !config.enabled) return;
                    if (pending.indexOf(command.id) === -1)
                        pending.push(command.id);
                }
                if (
                    execute &&
                    Array.isArray(data.requests) &&
                    data.requests.length
                ) {
                    var eligible = acceptRequest
                        ? data.requests.filter(function (request: any) {
                              return request && acceptRequest(request);
                          })
                        : data.requests;
                    var item = eligible[0];
                    if (
                        item &&
                        typeof item.id === "string" &&
                        /^[a-f0-9]{32}$/.test(item.id) &&
                        typeof item.expires_at === "number" &&
                        isFinite(item.expires_at) &&
                        typeof data.server_time === "number" &&
                        isFinite(data.server_time) &&
                        (item.expires_at - data.server_time) * 1000 >
                            Date.now() - requestStarted
                    ) {
                        // A replay does not prove the server made queue progress.
                        moreRequests =
                            eligible.length > 1 &&
                            !responseHistory[item.id] &&
                            !screenshotSeen[item.id];
                        if (responseHistory[item.id] || screenshotSeen[item.id])
                            responses.push(
                                responseHistory[item.id] ||
                                    screenshotSeen[item.id]
                            );
                        else {
                            if (item.action === "screenshot") {
                                screenshotSeen[item.id] = screenshotTombstone(
                                    item.id
                                );
                                screenshotOrder.push(item.id);
                                while (screenshotOrder.length > 2048)
                                    delete screenshotSeen[
                                        screenshotOrder.shift()!
                                    ];
                            }
                            var requestDeadline =
                                requestStarted +
                                (item.expires_at - data.server_time) * 1000;

                            active = true;
                            var completed = false;
                            var afterReplyEffect: (() => void) | null = null;
                            var executionMs = Math.min(
                                40000,
                                Math.max(
                                    1,
                                    (item.expires_at - data.server_time) *
                                        1000 -
                                        (Date.now() - requestStarted)
                                )
                            );
                            var executionDeadline = Date.now() + executionMs;
                            var executionError = function (
                                message: string,
                                libraryError: string
                            ): any {
                                return item.action === "favorites"
                                    ? {
                                          error: "timeout",
                                          op: item.params.op,
                                          runtime: item.params.runtime,
                                          state: "error",
                                          version: 1,
                                      }
                                    : item.action === "plex_library"
                                      ? {
                                            error: libraryError,
                                            op: item.params.op,
                                            runtime: item.params.runtime,
                                            state: "error",
                                            version: 1,
                                        }
                                      : { error: message };
                            };
                            var executionTimer = w.setTimeout(function () {
                                var abortWork = cancelExecution;
                                finishExecution({
                                    data: executionError(
                                        "Request timed out in the player.",
                                        "Plex queue request timed out."
                                    ),
                                    status: "rejected",
                                });
                                if (abortWork) {
                                    try {
                                        abortWork();
                                    } catch (_error) {}
                                }
                            }, executionMs);
                            var finishExecution = function (value: any): void {
                                if (
                                    completed ||
                                    current !== generation ||
                                    !config.enabled
                                )
                                    return;
                                completed = true;
                                w.clearTimeout(executionTimer);
                                active = false;
                                cancelExecution = null;
                                var serialized: string;
                                var error =
                                    "The player returned an invalid result.";
                                try {
                                    var resultStatus = value && value.status;
                                    if (
                                        resultStatus !== "ok" &&
                                        resultStatus !== "rejected" &&
                                        resultStatus !== "unsupported"
                                    )
                                        throw new Error();
                                    var data = JSON.stringify(value.data);
                                    if (typeof data !== "string")
                                        throw new Error();
                                    serialized =
                                        '{"data":' +
                                        data +
                                        ',"id":"' +
                                        item.id +
                                        '","status":"' +
                                        resultStatus +
                                        '"}';
                                    // Count actual UTF-8 bytes, including the envelope and
                                    // JSON escaping, so large ASCII catalogues can use the
                                    // same response budget as multibyte catalogues.
                                    if (
                                        encodeURIComponent(serialized).replace(
                                            /%[A-F\d]{2}/g,
                                            "x"
                                        ).length >
                                        2 * 1024 * 1024
                                    ) {
                                        error =
                                            "Result is too large. Narrow the search.";
                                        throw new Error();
                                    }
                                } catch (_error) {
                                    serialized = "";
                                }
                                if (!serialized) {
                                    resultStatus = "rejected";
                                    serialized = JSON.stringify({
                                        data: executionError(
                                            error,
                                            "Plex playback could not start."
                                        ),
                                        id: item.id,
                                        status: "rejected",
                                    });
                                }
                                if (current !== generation || !config.enabled)
                                    return;
                                if (
                                    afterReplyEffect &&
                                    resultStatus === "ok" &&
                                    Date.now() < executionDeadline
                                )
                                    pendingEffect = {
                                        body: serialized,
                                        deadline: executionDeadline,
                                        run: afterReplyEffect,
                                    };
                                afterReplyEffect = null;
                                responseHistory[item.id] = serialized;
                                historySize += serialized.length;
                                responseOrder.push(item.id);
                                if (
                                    item.action === "screenshot" &&
                                    resultStatus === "ok"
                                ) {
                                    var imageDeadline = Math.min(
                                        requestDeadline,
                                        Date.now() + 60000
                                    );
                                    screenshotImages[item.id] = {
                                        body: serialized,
                                        deadline: imageDeadline,
                                        // An independent timer also bounds lifetime when wall
                                        // time moves backward; polling never renews this lease.
                                        timer: w.setTimeout(
                                            function () {
                                                if (retireScreenshot(item.id))
                                                    schedule(0);
                                            },
                                            Math.max(
                                                0,
                                                imageDeadline - Date.now()
                                            )
                                        ),
                                    };
                                }
                                while (
                                    responseOrder.length > 50 ||
                                    historySize > 2 * 1024 * 1024
                                ) {
                                    var oldest = responseOrder.shift()!;
                                    retireScreenshot(oldest);
                                    historySize -=
                                        responseHistory[oldest].length;
                                    delete responseHistory[oldest];
                                }
                                responses.push(serialized);
                                purgeScreenshots(false, Date.now());
                                failures = 0;
                                schedule(0);
                            };
                            try {
                                var executionItem = item;
                                if (
                                    item.action === "plex_queue" ||
                                    item.action === "plex_library" ||
                                    item.action === "favorites" ||
                                    item.action === "playback"
                                )
                                    executionItem = Object.assign({}, item, {
                                        expires_at:
                                            Math.min(
                                                requestDeadline,
                                                executionDeadline
                                            ) / 1000,
                                    });
                                var cancelWork = execute(
                                    executionItem,
                                    finishExecution,
                                    function (effect: () => void) {
                                        if (
                                            !completed &&
                                            current === generation &&
                                            config.enabled &&
                                            !afterReplyEffect &&
                                            typeof effect === "function"
                                        )
                                            afterReplyEffect = effect;
                                    }
                                );
                                if (current !== generation || !config.enabled) {
                                    w.clearTimeout(executionTimer);
                                    if (cancelWork) {
                                        try {
                                            cancelWork();
                                        } catch (_error) {}
                                    }
                                } else if (!completed)
                                    cancelExecution = function () {
                                        w.clearTimeout(executionTimer);
                                        if (cancelWork) cancelWork();
                                    };
                            } catch (_error) {
                                finishExecution({
                                    data: executionError(
                                        "The player could not handle this request.",
                                        "Plex playback could not start."
                                    ),
                                    status: "rejected",
                                });
                            }
                            return;
                        }
                    }
                }
            }
            failures = 0;
            update(
                waiting ? "waiting" : "connected",
                waiting
                    ? "Connected. Waiting for the channel list..."
                    : lastCommandMessage || "Connected"
            );
            schedule(
                pending.length || responses.length || moreRequests ? 0 : 1000
            );
        }
        try {
            var screenshotResponse = !!(
                responseToSend &&
                Object.keys(screenshotImages).some(function (id) {
                    return screenshotImages[id].body === responseToSend;
                })
            );
            var abort = send(
                {
                    body: responseToSend
                        ? responseToSend
                        : ids
                          ? JSON.stringify({ ids: ids })
                          : undefined,
                    headers: headers,
                    method: method,
                    screenshotControl: screenshotResponse,
                    timeoutMs: 8000,
                    url: url,
                },
                complete
            );
            if (!finished && current === generation) {
                cancel = abort;
                if (screenshotResponse) {
                    activeScreenshotBody = responseToSend!;
                    cancelScreenshotPost = function () {
                        // Ignore a late native/XHR completion without resetting the
                        // connection or clearing unrelated command acknowledgements.
                        finished = true;
                        active = false;
                        cancel = null;
                        activeScreenshotBody = null;
                        cancelScreenshotPost = null;
                        responseToSend = undefined;
                        try {
                            abort();
                        } catch (_error) {}
                    };
                }
            }
        } catch (_error) {
            complete();
        }
    }
    function poll(): void {
        purgeScreenshots(false, Date.now());
        if (pending.length) request("POST", pending.slice(0, wire.ackBatchMax));
        else if (responses.length) request("POST", undefined, responses[0]);
        else request("GET");
    }
    function configure(next: CommandServerConfig): void {
        stop();
        config = {
            address: String(next.address || "").trim(),
            enabled: false,
            token: String(next.token || "").trim(),
        };
        // Keep completed IDs across reconnects to the same queue. Endpoint or
        // credential edits retire that private history, including while disabled.
        var normalizedAddress = "";
        try {
            normalizedAddress = normalizeCommandServerAddress(config.address);
        } catch (_error) {}
        if (
            !normalizedAddress ||
            normalizedAddress !== seenAddress ||
            config.token !== seenToken
        ) {
            seen = Object.create(null);
            seenOrder = [];
            responseHistory = Object.create(null);
            responseOrder = [];
            historySize = 0;
            screenshotSeen = Object.create(null);
            screenshotOrder = [];
        }
        seenAddress = normalizedAddress;
        seenToken = config.token;
        // Revoke locally before validation/storage. Invalid edits cannot retain a live connection.
        persist(config);
        if (!next.enabled) {
            update("disconnected", "Disconnected");
            return;
        }
        try {
            config.address =
                normalizedAddress ||
                normalizeCommandServerAddress(config.address);
            if (!validDeviceToken(config.token))
                throw new Error(
                    "Enter the server's device access code (32–256 letters, digits, _ or -)."
                );
            if (
                !w.__TAURI__ &&
                !(
                    w.Capacitor &&
                    (typeof w.Capacitor.isNativePlatform !== "function" ||
                        w.Capacitor.isNativePlatform())
                ) &&
                w.location &&
                w.location.protocol === "https:" &&
                /^http:/.test(config.address)
            )
                throw new Error(
                    "This HTTPS player cannot connect to an HTTP server. Use an HTTPS server or open the player over HTTP."
                );
            config.enabled = true;
            persist(config);
            update("connecting", "Connecting...");
            poll();
        } catch (error) {
            config.enabled = false;
            persist(config);
            update(
                "error",
                error instanceof Error
                    ? error.message
                    : "Could not connect to the server."
            );
        }
    }
    return {
        configure: configure,
        debugSnapshot: function () {
            return {
                controlActive: active,
                controlConsecutiveFailures: failures,
                controlPendingRequests: pending.length,
                controlPendingResponses: responses.length,
            };
        },
        discardScreenshots: discardScreenshots,
        poll: poll,
        status: status,
        subscribe: function (next: (() => void) | null): void {
            listener = next;
        },
    };
}

/** Browser XHR or an existing native HTTP bridge, with bounded cancellation. */
export function createCommandServerTransport(
    w: any,
    nativeRequest?: (
        request: CommandServerRequest
    ) => Promise<CommandServerResponse>,
    nativeCancel?: (requestId: string) => void
): any {
    var sequence = 0;
    return function (
        request: CommandServerRequest,
        complete: (response?: CommandServerResponse) => void
    ): () => void {
        request.remoteControl = true;
        var done = false;
        var xhr: any = null;
        var requestId =
            nativeRequest && request.screenshotControl && nativeCancel
                ? "ott_shot_" + Date.now() + "_" + ++sequence
                : null;
        function abortRequest(): void {
            if (xhr) xhr.abort();
            if (requestId && nativeCancel) {
                var id = requestId;
                requestId = null;
                try {
                    nativeCancel(id);
                } catch (_error) {}
            }
        }
        var timer = w.setTimeout(function () {
            finish();
            abortRequest();
        }, request.timeoutMs);
        function finish(response?: CommandServerResponse): void {
            if (done) return;
            done = true;
            w.clearTimeout(timer);
            complete(response);
        }
        if (nativeRequest) {
            try {
                if (requestId) request.requestId = requestId;
                nativeRequest(request).then(finish, function () {
                    finish();
                });
            } catch (_error) {
                finish();
            }
        } else if (request.secureControl || request.screenshotControl) {
            try {
                var target = new URL(request.url);
                if (
                    (target.protocol !== "https:" &&
                        !(
                            request.screenshotControl &&
                            !request.secureControl &&
                            target.protocol === "http:" &&
                            /^(localhost|127\.0\.0\.1|\[::1\])$/.test(
                                target.hostname
                            )
                        )) ||
                    target.username ||
                    target.password ||
                    target.hash
                )
                    throw new Error();
                if (
                    typeof w.fetch !== "function" ||
                    typeof w.Request !== "function" ||
                    typeof w.AbortController !== "function"
                ) {
                    finish({
                        body: "",
                        error: "secure_control_unavailable",
                        status: 0,
                    });
                } else {
                    xhr = new w.AbortController();
                    var fetchRequest = new w.Request(request.url, {
                        body: request.body,
                        cache: "no-store",
                        credentials: "omit",
                        headers: request.headers,
                        method: request.method,
                        redirect: "error",
                        signal: xhr.signal,
                    });
                    if (fetchRequest.redirect !== "error") {
                        finish({
                            body: "",
                            error: "secure_control_unavailable",
                            status: 0,
                        });
                    } else {
                        (fetchRequest as any).__ottRemoteControl = true;
                        w.fetch(fetchRequest)
                            .then(function (response: any) {
                                return response.text().then(function (
                                    body: string
                                ) {
                                    finish({
                                        body: body,
                                        status: response.status,
                                    });
                                });
                            })
                            .catch(function () {
                                finish();
                            });
                    }
                }
            } catch (_error) {
                finish();
            }
        } else {
            try {
                xhr = new w.XMLHttpRequest();
                xhr.__ottRemoteControl = true;
                xhr.open(request.method, request.url, true);
                xhr.timeout = request.timeoutMs;
                for (var name in request.headers)
                    if (
                        Object.prototype.hasOwnProperty.call(
                            request.headers,
                            name
                        )
                    )
                        xhr.setRequestHeader(name, request.headers[name]);
                xhr.onload = function () {
                    finish({ body: xhr.responseText, status: xhr.status });
                };
                xhr.onerror =
                    xhr.ontimeout =
                    xhr.onabort =
                        function () {
                            finish();
                        };
                xhr.send(request.body || null);
            } catch (_error) {
                finish();
            }
        }
        return function (): void {
            if (done) return;
            done = true;
            w.clearTimeout(timer);
            abortRequest();
        };
    };
}

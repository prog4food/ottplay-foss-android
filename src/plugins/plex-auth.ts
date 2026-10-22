/** Plex's documented PIN grant keeps account passwords on the Plex website. */
interface PlexAccountConnection {
    local: boolean;
    relay: boolean;
    secure: boolean;
    url: string;
}

interface PlexAccountServer {
    connections: PlexAccountConnection[];
    id: string;
    name: string;
    owned: boolean;
    token: string;
}

/** Persist only server routing metadata, never the Plex account credential. */
function plexAccountRouting(value: any): {
    id: string;
    connections: PlexAccountConnection[];
} | null {
    if (
        !value ||
        typeof value.id !== "string" ||
        !value.id ||
        value.id.length > 256 ||
        /[\s\u0000-\u001f\u007f]/.test(value.id) ||
        !Array.isArray(value.connections)
    )
        return null;
    var connections: PlexAccountConnection[] = [];
    value.connections.slice(0, 24).forEach(function (candidate: any) {
        var connection = plexConnection({
            local: candidate && candidate.local,
            relay: candidate && candidate.relay,
            uri: candidate && candidate.url,
        });
        if (
            connection &&
            !connections.some(function (known) {
                return known.url === connection!.url;
            })
        )
            connections.push(connection);
    });
    return connections.length
        ? { connections: connections, id: value.id }
        : null;
}

interface PlexAuthCallbacks {
    onError: (message: string) => void;
    onPin?: (pin: { url: string; code: string; expiresAt: number }) => void;
    onServers: (servers: PlexAccountServer[]) => void;
}

interface PlexConnectCallbacks {
    onConnected: (server: {
        url: string;
        token: string;
        serverId: string;
        serverName: string;
    }) => void;
    onError: (message: string) => void;
}

interface PlexAuthOperation {
    requests: any[];
    timers: ReturnType<typeof setTimeout>[];
}

var plexAuthOperation: PlexAuthOperation | null = null;
var plexAuthClient = "";

function plexAuthClientId(): string {
    if (plexAuthClient) return plexAuthClient;
    var key = "ottplay.plex.client";
    try {
        var stored = window.localStorage.getItem(key);
        if (stored && /^[a-z0-9-]{20,100}$/i.test(stored))
            plexAuthClient = stored;
    } catch (_storageError) {}
    if (!plexAuthClient) {
        var random: string[] = [];
        if (window.crypto && window.crypto.getRandomValues) {
            var bytes = new Uint8Array(16);
            window.crypto.getRandomValues(bytes);
            for (var i = 0; i < bytes.length; i++)
                random.push((bytes[i] + 256).toString(16).slice(1));
        } else {
            // The identifier identifies an installation; it is not an access token.
            for (var n = 0; n < 4; n++)
                random.push(
                    Math.floor(Math.random() * 0x100000000).toString(16)
                );
        }
        plexAuthClient = "ottplay-" + random.join("");
        try {
            window.localStorage.setItem(key, plexAuthClient);
        } catch (_storageError) {}
    }
    return plexAuthClient;
}

function cancelPlexAuth(): void {
    var previous = plexAuthOperation;
    plexAuthOperation = null;
    if (!previous) return;
    previous.timers.forEach(function (timer) {
        clearTimeout(timer);
    });
    previous.requests.slice().forEach(function (request) {
        if (request && typeof request.abort === "function") request.abort();
    });
    previous.timers = [];
    previous.requests = [];
}

function beginPlexAuth(): PlexAuthOperation {
    cancelPlexAuth();
    return (plexAuthOperation = { requests: [], timers: [] });
}

function plexAuthDelay(
    operation: PlexAuthOperation,
    callback: () => void,
    delay: number
): void {
    var timer = setTimeout(function () {
        operation.timers = operation.timers.filter(function (value) {
            return value !== timer;
        });
        if (operation === plexAuthOperation) callback();
    }, delay);
    operation.timers.push(timer);
}

function plexAuthRequest(
    operation: PlexAuthOperation,
    options: any,
    done: (value: any) => void,
    failed: (status: number) => void
): void {
    if (operation !== plexAuthOperation) return;
    options.dataType = options.dataType || "json";
    options.timeout = options.timeout || 15000;
    options.headers = options.headers || {};
    options.headers.Accept = "application/json";
    var request = (window as any).$.ajax(options);
    operation.requests.push(request);
    request
        .done(function (value: any) {
            if (operation === plexAuthOperation) done(value);
        })
        .fail(function (response: any) {
            if (operation === plexAuthOperation)
                failed(Number(response && response.status) || 0);
        })
        .always(function () {
            operation.requests = operation.requests.filter(function (value) {
                return value !== request;
            });
        });
}

function plexAuthFailure(
    operation: PlexAuthOperation,
    callback: (message: string) => void,
    message: string
): void {
    if (operation !== plexAuthOperation) return;
    cancelPlexAuth();
    callback(message);
}

function plexConnection(value: any): PlexAccountConnection | null {
    if (!value || typeof value.uri !== "string" || value.uri.length > 2048)
        return null;
    try {
        var url = new URL(value.uri);
        if (
            !/^https?:$/.test(url.protocol) ||
            !url.hostname ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
        )
            return null;
        return {
            local: value.local === true || value.local === 1,
            relay: value.relay === true || value.relay === 1,
            secure: url.protocol === "https:",
            url: url.href.replace(/\/+$/, ""),
        };
    } catch (_invalidUrl) {
        return null;
    }
}

function plexAccountServers(resources: any): PlexAccountServer[] {
    if (!Array.isArray(resources)) return [];
    var servers: PlexAccountServer[] = [];
    resources.slice(0, 128).forEach(function (resource: any) {
        if (
            !resource ||
            typeof resource.provides !== "string" ||
            resource.provides.split(",").indexOf("server") === -1 ||
            typeof resource.clientIdentifier !== "string" ||
            !resource.clientIdentifier ||
            resource.clientIdentifier.length > 256 ||
            typeof resource.accessToken !== "string" ||
            !resource.accessToken ||
            resource.accessToken.length > 8192 ||
            !Array.isArray(resource.connections) ||
            servers.some(function (server) {
                return server.id === resource.clientIdentifier;
            })
        )
            return;
        var connections: PlexAccountConnection[] = [];
        resource.connections.slice(0, 24).forEach(function (candidate: any) {
            var connection = plexConnection(candidate);
            if (!connection) return;
            var target = connection.url;
            if (
                !connections.some(function (known) {
                    return known.url === target;
                })
            )
                connections.push(connection);
        });
        if (!connections.length) return;
        servers.push({
            connections: connections,
            id: resource.clientIdentifier,
            name:
                typeof resource.name === "string" && resource.name
                    ? resource.name.slice(0, 256)
                    : "Plex Media Server",
            owned: resource.owned === true || resource.owned === 1,
            token: resource.accessToken,
        });
    });
    return servers;
}

function loadPlexAccountServers(
    operation: PlexAuthOperation,
    token: string,
    callbacks: Pick<PlexAuthCallbacks, "onServers" | "onError">
): void {
    plexAuthRequest(
        operation,
        {
            data: { includeHttps: 1, includeIPv6: 1, includeRelay: 1 },
            headers: {
                "X-Plex-Client-Identifier": plexAuthClientId(),
                "X-Plex-Product": "OTTPlay FOSS",
                "X-Plex-Token": token,
            },
            url: "https://clients.plex.tv/api/v2/resources",
        },
        function (resources) {
            var servers = plexAccountServers(resources);
            cancelPlexAuth();
            callbacks.onServers(servers);
        },
        function (status) {
            plexAuthFailure(
                operation,
                callbacks.onError,
                status === 401 || status === 403
                    ? "Plex sign-in expired. Sign in again."
                    : "Plex could not load your servers. Try again."
            );
        }
    );
}

function startPlexAuth(
    callbacks: PlexAuthCallbacks,
    options?: { code?: boolean }
): () => void {
    var operation = beginPlexAuth();
    var client = plexAuthClientId();
    plexAuthRequest(
        operation,
        {
            contentType: "application/x-www-form-urlencoded; charset=UTF-8",
            data: {
                strong: !(options && options.code) ? "true" : "false",
                "X-Plex-Client-Identifier": client,
                "X-Plex-Product": "OTTPlay FOSS",
            },
            plexAuthRequest: true,
            type: "POST",
            url: "https://plex.tv/api/v2/pins",
        },
        function (pin) {
            if (
                !pin ||
                !/^\d+$/.test(String(pin.id)) ||
                typeof pin.code !== "string" ||
                !/^[a-z0-9]{4,128}$/i.test(pin.code)
            ) {
                plexAuthFailure(
                    operation,
                    callbacks.onError,
                    "Plex sign-in could not start."
                );
                return;
            }
            var lifetime = Number(pin.expiresIn);
            if (!isFinite(lifetime)) lifetime = 1800;
            if (lifetime <= 0) {
                plexAuthFailure(
                    operation,
                    callbacks.onError,
                    "Plex sign-in expired. Start again."
                );
                return;
            }
            var expiresAt = Date.now() + Math.min(lifetime, 1800) * 1000;
            var url =
                options && options.code
                    ? "https://plex.tv/link/?pin=" +
                      encodeURIComponent(pin.code)
                    : "https://app.plex.tv/auth#?clientID=" +
                      encodeURIComponent(client) +
                      "&code=" +
                      encodeURIComponent(pin.code) +
                      "&context%5Bdevice%5D%5Bproduct%5D=OTTPlay%20FOSS";
            var failures = 0;
            function expired(): void {
                plexAuthFailure(
                    operation,
                    callbacks.onError,
                    "Plex sign-in expired. Start again."
                );
            }
            function poll(): void {
                if (Date.now() >= expiresAt) return expired();
                plexAuthRequest(
                    operation,
                    {
                        data: {
                            code: pin.code,
                            "X-Plex-Client-Identifier": client,
                        },
                        url: "https://plex.tv/api/v2/pins/" + pin.id,
                    },
                    function (result) {
                        failures = 0;
                        if (
                            result &&
                            typeof result.authToken === "string" &&
                            result.authToken
                        ) {
                            operation.timers.forEach(function (timer) {
                                clearTimeout(timer);
                            });
                            operation.timers = [];
                            loadPlexAccountServers(
                                operation,
                                result.authToken,
                                callbacks
                            );
                        } else plexAuthDelay(operation, poll, 2000);
                    },
                    function (status) {
                        if (status === 404 || status === 410) expired();
                        else if (
                            status === 0 ||
                            status === 408 ||
                            status === 429 ||
                            status >= 500
                        )
                            plexAuthDelay(
                                operation,
                                poll,
                                Math.min(10000, 2000 * ++failures)
                            );
                        else
                            plexAuthFailure(
                                operation,
                                callbacks.onError,
                                "Plex sign-in failed. Start again."
                            );
                    }
                );
            }
            plexAuthDelay(operation, expired, expiresAt - Date.now());
            if (callbacks.onPin)
                callbacks.onPin({
                    code: pin.code,
                    expiresAt: expiresAt,
                    url: url,
                });
            if (operation === plexAuthOperation)
                plexAuthDelay(operation, poll, 1000);
        },
        function () {
            plexAuthFailure(
                operation,
                callbacks.onError,
                "Plex sign-in is unavailable. Try again."
            );
        }
    );
    return function () {
        if (operation === plexAuthOperation) cancelPlexAuth();
    };
}

function connectPlexAccountServer(
    server: PlexAccountServer,
    callbacks: PlexConnectCallbacks,
    preferredUrl?: string
): () => void {
    var operation = beginPlexAuth();
    var parseContainer = (window as any).__ottPlex.parseContainer;
    var routing = plexAccountRouting(server);
    var candidates = (routing ? routing.connections : [])
        .slice(0, 24)
        .filter(function (connection) {
            return preferredUrl
                ? connection.url === preferredUrl
                : connection.secure || connection.local;
        });
    function rank(connection: PlexAccountConnection): number {
        return connection.secure
            ? connection.relay
                ? 3
                : connection.local
                  ? 0
                  : 1
            : 2;
    }
    candidates.sort(function (a, b) {
        return rank(a) - rank(b);
    });
    var index = 0;
    var pending = 0;
    var denied = false;
    function failed(): void {
        plexAuthFailure(
            operation,
            callbacks.onError,
            denied
                ? "Plex denied access to this server. Sign in again or check library access."
                : "Plex server is unavailable. Check Remote Access, HTTPS and local network permission."
        );
    }
    function next(): void {
        if (operation !== plexAuthOperation) return;
        if (index >= candidates.length && !pending) return failed();
        while (pending < 2 && index < candidates.length)
            probe(candidates[index++]);
    }
    function probe(connection: PlexAccountConnection): void {
        pending++;
        function miss(status: number): void {
            if (status === 401 || status === 403) denied = true;
            pending--;
            next();
        }
        // PMS can return XML despite Accept: JSON; use the shared bounded parser.
        // A stale LAN address must prove its server identity before receiving a token.
        plexAuthRequest(
            operation,
            {
                dataType: "text",
                timeout: 4000,
                url: connection.url + "/identity",
            },
            function (identity) {
                try {
                    identity = parseContainer(identity, window);
                } catch (_) {
                    miss(0);
                    return;
                }
                if (identity.machineIdentifier !== server.id) {
                    miss(0);
                    return;
                }
                plexAuthRequest(
                    operation,
                    {
                        dataType: "text",
                        headers: {
                            "X-Plex-Client-Identifier": plexAuthClientId(),
                            "X-Plex-Container-Size": "1",
                            "X-Plex-Container-Start": "0",
                            "X-Plex-Token": server.token,
                        },
                        timeout: 4000,
                        url: connection.url + "/library/sections",
                    },
                    function (result) {
                        try {
                            parseContainer(result, window);
                        } catch (_) {
                            miss(0);
                            return;
                        }
                        cancelPlexAuth();
                        callbacks.onConnected({
                            serverId: server.id,
                            serverName: server.name,
                            token: server.token,
                            url: connection.url,
                        });
                    },
                    miss
                );
            },
            miss
        );
    }
    plexAuthDelay(operation, failed, 20000);
    next();
    return function () {
        if (operation === plexAuthOperation) cancelPlexAuth();
    };
}

(window as any).__ottPlexAuth = {
    cancel: cancelPlexAuth,
    connect: connectPlexAccountServer,
    getServers: function (
        token: string,
        callbacks: Pick<PlexAuthCallbacks, "onServers" | "onError">
    ) {
        loadPlexAccountServers(beginPlexAuth(), token, callbacks);
    },
    routing: plexAccountRouting,
    start: startPlexAuth,
};

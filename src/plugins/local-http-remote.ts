/** Device-local consent and credentials for HTTP control on every player host. */
export function createLocalHttpRemote(
    w: any,
    configure: (enabled: boolean, code: string) => Promise<any>,
    persist: (enabled: boolean, code: string) => void
): any {
    var enabled = false;
    var ready = false;
    var code = "";
    var port = 0;
    var generation = 0;
    var error = "";
    var pending: Promise<void> | undefined;
    var request: XMLHttpRequest | null = null;
    var timer: ReturnType<typeof setInterval> | undefined;
    var initialized = false;
    var seen: Record<string, boolean> = {};

    function validCode(value: any): boolean {
        return (
            typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value)
        );
    }

    function generateCode(): string {
        // Never fall back to Math.random, the public UUID, or a shared default.
        var crypto = w.crypto || w.msCrypto;
        if (!crypto || typeof crypto.getRandomValues !== "function")
            throw new Error("Secure device code generation is unavailable");
        var bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        var value = "";
        for (var i = 0; i < bytes.length; i++)
            value += ("0" + bytes[i].toString(16)).slice(-2);
        return value;
    }

    function stopPolling(): void {
        if (timer !== undefined) w.clearInterval(timer);
        timer = undefined;
        if (request) request.abort();
        request = null;
    }

    function poll(): void {
        var url = String(w.sLocalCmdUrl || "").trim();
        if (!enabled || !validCode(code) || !url || request) return;
        // Explicit URL configuration chooses the proxy that receives this code.
        if (!/^(https?:\/\/|\/[^/])/i.test(url)) return;
        var current = generation;
        var currentCode = code;
        var xhr = new w.XMLHttpRequest();
        xhr.__ottRemoteControl = true;
        request = xhr;
        try {
            xhr.open(
                "GET",
                url + (url.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now(),
                true
            );
            xhr.timeout = 8000;
            xhr.setRequestHeader("Authorization", "Bearer " + currentCode);
        } catch (_error) {
            request = null;
            return;
        }
        xhr.onload = function (): void {
            if (request === xhr) request = null;
            if (
                !enabled ||
                generation !== current ||
                code !== currentCode ||
                String(w.sLocalCmdUrl || "").trim() !== url ||
                xhr.status !== 200
            )
                return;
            var commands: any;
            try {
                commands = JSON.parse(xhr.responseText);
            } catch (_error) {
                return;
            }
            if (!Array.isArray(commands))
                commands = commands && commands.commands;
            if (!Array.isArray(commands)) return;
            commands.forEach(function (command: any) {
                if (!enabled || generation !== current || !command) return;
                var key = String(
                    command.ts || command.command + JSON.stringify(command)
                );
                if (seen[key]) return;
                seen[key] = true;
                try {
                    if (
                        command.command &&
                        typeof w.handleCommand === "function"
                    )
                        w.handleCommand(command);
                    else if (
                        command.message &&
                        typeof w.showPopup === "function"
                    )
                        w.showPopup(
                            command.message,
                            command.popup_duration || 5
                        );
                } catch (_error) {
                    /* A bad command must not stop subsequent polls. */
                }
            });
            var keys = Object.keys(seen);
            if (keys.length > 200)
                for (var i = 0; i < keys.length - 100; i++)
                    delete seen[keys[i]];
        };
        xhr.onerror =
            xhr.ontimeout =
            xhr.onabort =
                function (): void {
                    if (request === xhr) request = null;
                };
        try {
            xhr.send();
        } catch (_error) {
            request = null;
        }
    }

    function change(next: boolean, savedCode?: string): Promise<void> {
        var revision = ++generation;
        enabled = false;
        ready = false;
        code = "";
        port = 0;
        error = "";
        stopPolling();
        seen = {};
        // Persist revocation before awaiting a slow native bridge operation.
        persist(false, "");
        var run = async function (): Promise<void> {
            if (revision !== generation) return;
            try {
                await configure(false, "");
                if (revision !== generation) return;
                if (!next) {
                    ready = true;
                    return;
                }
                var nextCode = validCode(savedCode)
                    ? savedCode!
                    : generateCode();
                var status = await configure(true, nextCode);
                if (revision !== generation) return;
                if (!status || status.httpEnabled !== true)
                    throw new Error("HTTP remote control could not be started");
                persist(true, nextCode);
                enabled = true;
                ready = true;
                code = nextCode;
                port = status.port || 0;
                timer = w.setInterval(poll, 10000);
                poll();
            } catch (_error) {
                // Even a failed/partially completed native start is revoked.
                var revoked = false;
                try {
                    await configure(false, "");
                    revoked = true;
                } catch (_stopError) {}
                if (revision === generation) {
                    ready = revoked;
                    enabled = false;
                    code = "";
                    port = 0;
                    error = "HTTP remote control could not be started";
                    persist(false, "");
                }
                throw new Error("HTTP remote control could not be started");
            }
        };
        pending = pending
            ? pending.then(run, run)
            : Promise.resolve().then(run);
        return pending;
    }

    return {
        init: function (): void {
            if (initialized) return;
            initialized = true;
            // Old settings/UUIDs/URLs do not constitute HTTP consent.
            if (w.sLocalHttpEnabled === 1 && validCode(w.sLocalHttpDeviceCode))
                change(true, w.sLocalHttpDeviceCode).catch(function () {});
            else if (w.__TAURI__ || w.Capacitor)
                change(false).catch(function () {});
            else {
                persist(false, "");
                ready = true;
            }
        },
        poll: poll,
        setEnabled: function (next: boolean): Promise<void> {
            return change(next === true);
        },
        status: function (): any {
            return {
                code: code,
                enabled: enabled,
                error: error,
                generation: generation,
                port: port,
                ready: ready,
            };
        },
    };
}

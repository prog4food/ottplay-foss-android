/**
 * Classic functions and the unchanged keypad render through one access owner.
 * Grants belong to the provider storage/configuration and PIN policy. A catalog
 * repaint retains the grant; replacing a provider or changing its policy revokes it.
 */
function createClassicAccess(host: any) {
    var context: any = null;
    var generation = 0;
    function revoke(): void {
        generation++;
        session.revoke();
    }
    function policy(kind: string): any {
        if (kind === "control") return true;
        var field =
            kind === "providers"
                ? "sPSprovs"
                : kind === "settings"
                  ? "sPSoptions"
                  : "sPSchannels";
        var setting =
            kind === "providers"
                ? "requirePinForProviderSelection"
                : kind === "settings"
                  ? "psOptions"
                  : "psChannels";
        return host.settings && host.settings[setting] !== undefined
            ? host.settings[setting]
            : host[field];
    }
    function scope(): any {
        var fingerprint = JSON.stringify([
            host.__ottSourceIdentity.current(host),
            host.parentPIN,
            policy("channels"),
            policy("settings"),
            policy("providers"),
            host.settingsStore &&
            typeof host.settingsStore.version === "function"
                ? host.settingsStore.version([
                      "parentPin",
                      "psChannels",
                      "psOptions",
                      "requirePinForProviderSelection",
                  ])
                : "",
        ]);
        if (
            !context ||
            context.fingerprint !== fingerprint ||
            context.get !== host.providerGetItem ||
            context.set !== host.providerSetItem
        )
            context = {
                fingerprint: fingerprint,
                get: host.providerGetItem,
                set: host.providerSetItem,
            };
        return context;
    }
    var session = host.__ottAccessSession.create({
        cancel: function (timer: any) {
            host.clearTimeout(timer);
        },
        context: scope,
        now: function () {
            return Date.now();
        },
        schedule: function (callback: () => void, delay: number) {
            return host.setTimeout(callback, delay);
        },
    });
    function notify(): void {
        if (typeof host.showShift === "function")
            host.showShift(host._("Wrong parental code !!!"));
    }
    function setAccess(granted: boolean, callback: () => void): void {
        if (!granted) {
            revoke();
            notify();
        } else if (session.grant(true)) callback();
    }
    function pin(
        prompt: string,
        callback: (value: string) => void,
        onRejected?: () => void
    ): void {
        generation++;
        var port = host.__ottClassicScreenPort;
        var element = host.$("#dialogbox");
        if (!element.length) {
            if (onRejected) onRejected();
            return;
        }
        var ticket = session.begin();
        var model = host.__ottAccessSession.createPin();
        var completing = false;
        var rejected = false;
        var highlighted = 1;
        var owner: any = null;
        function abandon(): void {
            ticket.cancel();
            if (rejected || !onRejected) return;
            rejected = true;
            // A replacement overlay is installed after the old owner's cleanup.
            // Settle later so rejection cannot repaint over that replacement.
            host.setTimeout(onRejected, 0);
        }
        function render(): void {
            if (!owner.active() || !ticket.active()) return;
            var state = model.snapshot();
            var old = host.document.getElementById("k" + highlighted);
            if (old) {
                old.style.backgroundColor = "";
                old.style.color = "";
            }
            highlighted = state.cursor;
            var next = host.document.getElementById("k" + highlighted);
            if (next) {
                next.style.backgroundColor = host.curColorB || "#668";
                next.style.color = host.curColor || "gold";
            }
            var mask = host.document.getElementById("pin");
            if (mask) mask.innerHTML = "# # # # ".slice(0, state.length * 2);
        }
        var handler = port.setOwnedCallback("dialog", function (code: number) {
            if (!ticket.active()) {
                port.close("dialog");
                return;
            }
            var kind = "";
            var value = 0;
            for (var digit = 0; digit < 10; digit++)
                if (code === host.keys["N" + digit]) {
                    kind = "digit";
                    value = digit;
                    break;
                }
            if (!kind) {
                if (code === host.keys.RETURN || code === host.keys.EXIT)
                    kind = "cancel";
                else if (code === host.keys.ENTER) kind = "accept";
                else if (code === host.keys.LEFT || code === host.keys.UP) {
                    kind = "move";
                    value = -1;
                } else if (
                    code === host.keys.RIGHT ||
                    code === host.keys.DOWN
                ) {
                    kind = "move";
                    value = 1;
                }
            }
            var result = model.input(kind, value);
            render();
            if (result === null) return;
            completing = true;
            port.close("dialog");
            if (ticket.complete()) callback(result);
            else abandon();
        });
        owner = handler.owner;
        if (!owner || !owner.active() || !ticket.active()) {
            abandon();
            return;
        }
        owner.own(function () {
            if (!completing) abandon();
        });
        var buttons = "";
        for (var position = 1; position <= 10; position++) {
            var digit = position % 10;
            buttons +=
                '<div id="k' +
                digit +
                '" style="display:inline-block;padding:6px;"><div class="btn">' +
                digit +
                "</div></div>";
        }
        element.html(
            prompt +
                '<br/><br/><span id="pin" style="font-size: 200%;">&nbsp;</span><br><br>' +
                buttons
        );
        if (!owner.active() || !ticket.active()) {
            abandon();
            return;
        }
        function click(digit: number): (event?: Event) => void {
            return function (event) {
                // Completing the PIN can close every overlay during this click.
                if (event) event.stopPropagation();
                if (owner.foreground()) handler(host.keys["N" + digit]);
            };
        }
        for (var digit = 0; digit < 10; digit++) {
            var cell = host.document.getElementById("k" + digit);
            if (cell && cell.firstChild) cell.firstChild.onclick = click(digit);
        }
        element.show();
        render();
    }
    function needs(kind: string): boolean {
        return !!policy(kind) && host.parentPIN !== "*" && !session.allowed();
    }
    function request(callback: () => void, onRejected?: () => void): void {
        var expected = scope();
        var secret = String(host.parentPIN);
        var settled = false;
        var security = host.__ottPinSecurity;
        function reject(): void {
            if (settled) return;
            settled = true;
            if (onRejected) onRejected();
        }
        pin(
            host._("Enter parental code"),
            function (value) {
                if (settled) return;
                if (!value || scope() !== expected || !security) {
                    reject();
                    return;
                }
                var operation = generation;
                var ticket = session.begin();
                function current(): boolean {
                    return (
                        !settled &&
                        generation === operation &&
                        ticket.active() &&
                        scope() === expected
                    );
                }
                function finish(matched: boolean): void {
                    if (!current()) {
                        reject();
                        return;
                    }
                    if (!ticket.complete()) {
                        reject();
                        return;
                    }
                    setAccess(matched, function () {
                        settled = true;
                        callback();
                    });
                    if (!settled) reject();
                }
                if (!security.record(secret)) {
                    finish(false);
                    return;
                }
                if (typeof host.showShift === "function")
                    host.showShift(host._("Loading. Please wait..."));
                security.verify(value, secret, current, finish);
            },
            onRejected ? reject : undefined
        );
    }
    function guard(channelId: number, callback: () => void): () => void {
        var expected = scope();
        var catalog = host.channels;
        var channel = catalog && catalog[channelId];
        return function () {
            if (
                channel &&
                scope() === expected &&
                host.channels === catalog &&
                catalog[channelId] === channel
            )
                callback();
        };
    }
    if (typeof host.addEventListener === "function") {
        host.addEventListener("pagehide", revoke);
        host.addEventListener("visibilitychange", function () {
            if (host.document && host.document.hidden) revoke();
        });
    }
    var initial = host.parentAccess === true;
    Object.defineProperty(host, "parentAccess", {
        configurable: true,
        get: session.allowed,
        set: function (value: boolean) {
            if (value === true) session.grant(true);
            else revoke();
        },
    });
    if (initial) session.grant(true);
    return {
        allowed: session.allowed,
        checkpoint: function (): () => boolean {
            var operation = generation;
            var source = host.__ottSourceIdentity.current(host);
            var read = host.providerGetItem,
                write = host.providerSetItem;
            return function () {
                return (
                    generation === operation &&
                    host.__ottSourceIdentity.current(host) === source &&
                    host.providerGetItem === read &&
                    host.providerSetItem === write
                );
            };
        },
        guard: guard,
        needs: needs,
        pin: pin,
        request: request,
        require: function (kind: string, callback: () => void): boolean {
            if (!needs(kind)) return false;
            // Retain the public prompt hook used by device/provider integrations.
            host.enterPinAndSetAccess(callback);
            return true;
        },
        revoke: revoke,
        setAccess: setAccess,
    };
}

(window as any).__ottParental = createClassicAccess(window);

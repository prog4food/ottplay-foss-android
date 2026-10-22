/** Authorization lifetime and PIN input state, independent of screens and storage. */
interface AccessSessionPorts {
    cancel(timer: any): void;
    context(): any;
    now(): number;
    schedule(callback: () => void, delay: number): any;
}

function createAccessSession(ports: AccessSessionPorts) {
    var scope: any = null;
    var revision = 0;
    var expires = 0;
    var timer: any = null;
    var challenge = 0;
    function reset(next: any): number {
        scope = next;
        var operation = ++revision;
        challenge++;
        expires = 0;
        var previous = timer;
        timer = null;
        if (previous !== null) ports.cancel(previous);
        return operation;
    }
    function current(): any {
        var next = ports.context();
        if (next !== scope) reset(next);
        return scope;
    }
    function allowed(): boolean {
        current();
        return expires > ports.now();
    }
    function grant(value: boolean): boolean {
        var expected = current();
        var operation = reset(expected);
        if (!value || current() !== expected || operation !== revision)
            return false;
        expires = ports.now() + 3600000;
        var scheduled = ports.schedule(function () {
            if (operation === revision) reset(ports.context());
        }, 3600000);
        if (operation === revision) timer = scheduled;
        else ports.cancel(scheduled);
        return allowed() && operation === revision;
    }
    return {
        allowed: allowed,
        begin: function () {
            var expected = current();
            var operation = ++challenge;
            function active(): boolean {
                return current() === expected && operation === challenge;
            }
            return {
                active: active,
                cancel: function () {
                    if (operation === challenge) challenge++;
                },
                complete: function (): boolean {
                    if (!active()) return false;
                    challenge++;
                    return true;
                },
            };
        },
        grant: grant,
        revoke: function () {
            reset(ports.context());
        },
    };
}

function createPinEntry() {
    var digits = "";
    var cursor = 1;
    var finished = false;
    return {
        input: function (kind: string, value?: number): string | null {
            if (finished) return null;
            if (kind === "cancel") {
                finished = true;
                return "";
            }
            if (kind === "move") cursor = (cursor + (value || 0) + 10) % 10;
            if (kind === "accept") value = cursor;
            if (
                (kind === "digit" || kind === "accept") &&
                typeof value === "number" &&
                value >= 0 &&
                value <= 9 &&
                Math.floor(value) === value
            ) {
                digits += String(value);
                if (digits.length === 4) {
                    finished = true;
                    return digits;
                }
            }
            return null;
        },
        snapshot: function () {
            return { cursor: cursor, length: digits.length };
        },
    };
}

(window as any).__ottAccessSession = {
    create: createAccessSession,
    createPin: createPinEntry,
};

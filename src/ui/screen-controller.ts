/** A screen owns its input, model and cleanup. Rendering is an injected effect. */
interface ScreenCommand {
    code?: number;
    event?: any;
    id: string;
    repeat?: boolean;
    text?: string;
}
interface ScreenOwner {
    active(): boolean;
    close(): void;
    foreground(): boolean;
    guard(callback: (...args: any[]) => any): (...args: any[]) => any;
    id: number;
    kind: string;
    model: any;
    own(cleanup: () => void): () => void;
}
interface ScreenDefinition {
    dispose?: () => void;
    handle(command: ScreenCommand, owner: ScreenOwner): any;
    kind: string;
    model?: any;
    priority?: number;
}
function createScreenController() {
    var sequence = 0;
    var revision = 0;
    var screens: Array<{ owner: ScreenOwner; definition: ScreenDefinition }> =
        [];
    function current(): ScreenOwner | null {
        var winner: any = null;
        screens.forEach(function (entry) {
            if (
                !winner ||
                (entry.definition.priority || 0) >=
                    (winner.definition.priority || 0)
            )
                winner = entry;
        });
        return winner ? winner.owner : null;
    }
    function open(definition: ScreenDefinition): ScreenOwner {
        var cleanups: Array<() => void> = [];
        var live = true;
        var owner: ScreenOwner = {
            active: function () {
                return (
                    live &&
                    screens.some(function (entry) {
                        return entry.owner === owner;
                    })
                );
            },
            close: function () {
                if (!live) return;
                live = false;
                revision++;
                screens = screens.filter(function (entry) {
                    return entry.owner !== owner;
                });
                var retired = cleanups.slice();
                cleanups.length = 0;
                retired.forEach(function (cleanup) {
                    try {
                        cleanup();
                    } catch (error) {
                        console.error(error);
                    }
                });
            },
            foreground: function () {
                return live && current() === owner;
            },
            guard: function (callback) {
                return function () {
                    if (owner.active())
                        return callback.apply(null, arguments as any);
                };
            },
            id: ++sequence,
            kind: definition.kind,
            model: definition.model || {},
            own: function (cleanup) {
                var pending = true;
                function release() {
                    if (!pending) return;
                    pending = false;
                    var index = cleanups.indexOf(release);
                    if (index >= 0) cleanups.splice(index, 1);
                    cleanup();
                }
                if (owner.active()) cleanups.push(release);
                else release();
                return release;
            },
        };
        screens.push({ definition: definition, owner: owner });
        revision++;
        if (definition.dispose) owner.own(definition.dispose);
        return owner;
    }
    function invalidate() {
        // Detach the whole old stack before cleanup can open a replacement.
        var retired = screens.slice().reverse();
        screens = [];
        revision++;
        retired.forEach(function (entry) {
            entry.owner.close();
        });
    }
    function dispatch(command: ScreenCommand): boolean {
        var owner = current();
        if (!owner) return false;
        var entry = screens.filter(function (item) {
            return item.owner === owner;
        })[0];
        if (!entry) return false;
        entry.definition.handle(command, owner);
        return true;
    }
    return {
        current: current,
        dispatch: dispatch,
        invalidate: invalidate,
        open: open,
        revision: function () {
            return revision;
        },
    };
}
(window as any).__ottScreenController = { create: createScreenController };

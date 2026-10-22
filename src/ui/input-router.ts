/** Hardware identities terminate here; screen policy receives semantic commands. */
function createInputRouter(ports: any) {
    var names: Array<[string, string]> = [
        ["POWER", "power"],
        ["MUTE", "mute"],
        ["VOL_UP", "volume-up"],
        ["VOL_DOWN", "volume-down"],
        ["ENTER", "accept"],
        ["EXIT", "exit"],
        ["RETURN", "back"],
        ["UP", "up"],
        ["DOWN", "down"],
        ["LEFT", "left"],
        ["RIGHT", "right"],
        ["RW", "rewind"],
        ["FF", "forward"],
        ["CH_UP", "channel-up"],
        ["CH_DOWN", "channel-down"],
        ["PREV", "previous"],
        ["NEXT", "next"],
        ["PLAY", "play"],
        ["PAUSE", "pause"],
        ["STOP", "stop"],
        ["RED", "red"],
        ["GREEN", "green"],
        ["YELLOW", "yellow"],
        ["BLUE", "blue"],
        ["INFO", "info"],
        ["EPG", "guide"],
        ["MENU", "menu"],
        ["TOOLS", "tools"],
        ["PIP", "picture-in-picture"],
        ["ASPECT", "aspect"],
        ["ZOOM", "zoom"],
        ["AUDIO", "audio"],
        ["SUBTITLE", "subtitle"],
        ["SETUP", "settings"],
        ["CH_LIST", "channels"],
        ["PRECH", "previous-channel"],
        ["LANG", "language"],
    ];
    function normalize(code: number, event?: any): ScreenCommand {
        var keys = ports.keys();
        if (code === keys.PLAYPAUSE && keys.PLAY) code = keys.PLAY;
        var id = "unknown";
        for (var i = 0; i <= 9; i++)
            if (keys["N" + i] === code) id = "digit-" + i;
        for (var n = 0; n < names.length; n++) {
            if (keys[names[n][0]] && keys[names[n][0]] === code) {
                id = names[n][1];
                break;
            }
        }
        return {
            code: code,
            event: event,
            id: id,
            repeat: !!(event && event.repeat),
            text:
                event &&
                event.key &&
                (event.key.length === 1 ||
                    /^[\ud800-\udbff][\udc00-\udfff]$/.test(event.key))
                    ? event.key
                    : undefined,
        };
    }
    function dispatch(command: ScreenCommand): boolean {
        // Overlays are modal. Global volume remains available over ordinary lists.
        ports.reconcile();
        var owner = ports.screens.current();
        if (owner && owner.kind !== "list") {
            // A loading operation may be retired before the ordinary power/quit
            // action. Editors and confirmation dialogs remain modal.
            if (
                command.id === "power" &&
                typeof owner.model?.cancelOnPower === "function"
            ) {
                owner.model.cancelOnPower();
                if (ports.global(command)) return true;
            }
            return ports.screens.dispatch(command);
        }
        if (ports.global(command)) return true;
        if (owner) return ports.screens.dispatch(command);
        ports.main(command);
        return true;
    }
    return {
        dispatch: dispatch,
        fromKey: function (code: number, event?: any) {
            return dispatch(normalize(code, event));
        },
        normalize: normalize,
    };
}
(window as any).__ottInputRouter = {
    binding: function (value: number): string | undefined {
        // Read-only import of saved numeric remote-button choices.
        return [
            "archive.records",
            "menu.open",
            "channel.previous",
            "archive.seek",
            "information.channel",
            "video.aspect",
            "audio.track",
            "pip.toggle",
            "pip.close",
            "channels.categories",
            "guide.open",
            "media.open",
            "navigation.quick",
            "volume.increase",
            "volume.decrease",
            "navigation.forward",
            "navigation.backward",
            "subtitle.track",
            "archive.minute-back",
            "archive.minute-forward",
            "program.previous",
            "program.next",
        ][value];
    },
    create: createInputRouter,
};

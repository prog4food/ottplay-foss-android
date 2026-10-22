/** Device identity/key codecs are read-only ports; retained STB scripts keep their ABI. */
function createDeviceAdapter(ports: any) {
    var timer: any = null;
    var previous: any = null;
    var measuredAt = 0;
    var position = 0;
    function describe() {
        var keys: any = {};
        var raw = ports.keys() || {};
        Object.keys(raw).forEach(function (key) {
            keys[key] = raw[key];
        });
        return {
            capabilities: ports.capabilities(),
            keys: keys,
            route: ports.route(),
            transport: ports.isManaged() ? "media-backend" : "classic-device",
        };
    }
    function sampleLegacy() {
        if (ports.isManaged()) {
            previous = null;
            return;
        }
        // This is the explicit ingress for external retained device writers.
        var state = ports.importLegacy();
        var now = ports.now();
        if (!state.target || state.phase === "stopped") {
            previous = null;
            return;
        }
        var playing = ports.playing();
        if (!previous || state.generation !== previous.generation) {
            position = state.position;
            measuredAt = now;
        } else {
            // A retained device may seek through an explicit position command
            // without opening a new playback generation.
            if (state.position !== previous.position) position = state.position;
            if (previous.playing)
                position += Math.max(0, now - measuredAt) / 1000;
        }
        measuredAt = now;
        var mediaPosition = ports.position();
        if (
            state.target.kind === "vod" &&
            isFinite(mediaPosition) &&
            mediaPosition >= 0
        )
            position = mediaPosition;
        if (state.target.kind !== "live")
            ports.command({
                duration: ports.duration(),
                generation: state.generation,
                position: position,
                type: "position",
            });
        ports.command({
            generation: state.generation,
            type: playing ? "playing" : "pause",
        });
        previous = {
            generation: state.generation,
            playing: playing,
            position: position,
        };
    }
    return {
        describe: describe,
        dispose: function () {
            if (timer !== null) ports.clearInterval(timer);
            timer = null;
            previous = null;
        },
        eventToKeyCode: function (event: any) {
            return ports.key(event);
        },
        sampleLegacy: sampleLegacy,
        start: function () {
            if (timer !== null || ports.isManaged()) return;
            timer = ports.setInterval(sampleLegacy, 1000);
        },
    };
}
(window as any).__ottDeviceAdapter = { create: createDeviceAdapter };

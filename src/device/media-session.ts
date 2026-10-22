/** OS metadata follows backend lifecycle; transport functions are never replaced. */
function createOsMediaSession(ports: any) {
    var current: any = null;
    var refresh: any = null;
    var positionTimer: any = null;
    var alive = true;
    var revision = 0;
    var paused = false;
    function clear() {
        if (refresh !== null) ports.clearTimeout(refresh);
        if (positionTimer !== null) ports.clearInterval(positionTimer);
        refresh = positionTimer = null;
    }
    function send(type: string) {
        var expected = revision;
        var metadata = ports.metadata();
        if (!alive || expected !== revision) return false;
        ports.send(type, metadata);
        return alive && expected === revision;
    }
    function active(handle: any) {
        return alive && current === handle && handle.active();
    }
    function ticking(handle: any) {
        if (!active(handle)) return;
        if (positionTimer !== null) ports.clearInterval(positionTimer);
        positionTimer = ports.setInterval(function () {
            if (!active(handle) || handle.snapshot().phase !== "playing")
                return;
            var expected = revision;
            var metadata = ports.metadata();
            if (metadata.seekable && expected === revision && active(handle))
                ports.send("update", metadata);
        }, 2000);
    }
    var unsubscribe = ports.backend.subscribe(function (event: any) {
        if (!alive || event.lane !== "main") return;
        var handle = event.handle;
        if (event.type === "open" && handle.active()) {
            revision++;
            clear();
            current = handle;
            paused = false;
            if (!send("start") || !active(handle)) return;
            refresh = ports.setTimeout(function () {
                if (!active(handle) || handle.snapshot().phase === "paused")
                    return;
                refresh = null;
                if (send("update")) ticking(handle);
            }, 1500);
        } else if (
            handle === current &&
            (event.type === "dispose" || event.type === "ended")
        ) {
            revision++;
            current = null;
            clear();
            send("stop");
        } else if (active(handle) && event.type === "pause" && !paused) {
            revision++;
            paused = true;
            clear();
            send("pause");
        } else if (
            active(handle) &&
            paused &&
            (event.type === "resume" || event.type === "playing")
        ) {
            revision++;
            paused = false;
            if (send("resume")) ticking(handle);
        }
    });
    return {
        dispose: function () {
            if (!alive) return;
            alive = false;
            unsubscribe();
            clear();
            current = null;
        },
    };
}
(window as any).__ottOsMediaSession = { create: createOsMediaSession };

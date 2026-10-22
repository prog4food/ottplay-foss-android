/** Own each gesture, allowing only information and an admitted media-footer seek. */
export function createStrictKioskInput(w: any, active: () => boolean): any {
    var gesture: any = null;
    var lastTouch = -10000;
    var lastPointer = -10000;
    function now(): number {
        return w.performance && w.performance.now
            ? w.performance.now()
            : Date.now();
    }
    function consume(event: any): void {
        if (event.preventDefault) event.preventDefault();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    }
    function info(): void {
        if (typeof w.showChannelInfo === "function") w.showChannelInfo(5);
    }
    function stopCapture(event: any): boolean {
        if (!w.document || !w.document.getElementById) return false;
        var button = w.document.getElementById("remoteDiagnosticsIndicator");
        if (!button || button.nodeName !== "BUTTON" || event.target !== button)
            return false;
        // Stop only the active diagnostic capture, preserving controller access.
        w.__ottKiosk.stopDiagnostics();
        return true;
    }
    function key(event: any, code?: number): void {
        if (!active()) return;
        consume(event);
        if (event.type && event.type !== "keydown") return;
        var keys = w.keys || {};
        if (code === undefined) {
            var device = w.__ottDevice;
            code =
                device && device.eventToKeyCode
                    ? device.eventToKeyCode(event)
                    : event.keyCode || event.which;
        }
        if (code && code === keys.INFO) info();
        else if (code && code === keys.STOP) w.__ottKiosk.stopDiagnostics();
        else if (event.key === "Enter" || event.key === " ") stopCapture(event);
    }
    function footerSeek(event: any, point: any): any {
        try {
            var bar = w.document.getElementById("progress_div");
            if (!bar || !bar.contains(event.target) || !w.__ottKiosk.beginSeek)
                return null;
            var rect = bar.getBoundingClientRect();
            if (
                rect.width <= 0 ||
                rect.height <= 0 ||
                point.clientX < rect.left ||
                point.clientX > rect.right ||
                point.clientY < rect.top ||
                point.clientY > rect.bottom
            )
                return null;
            var commit = w.__ottKiosk.beginSeek();
            return commit ? { bar: bar, commit: commit, rect: rect } : null;
        } catch (_) {
            return null;
        }
    }
    function start(point: any, kind: string, id: any, event: any): void {
        gesture = {
            id: id,
            kind: kind,
            moved: false,
            seek: footerSeek(event, point),
            time: now(),
            x: point.clientX,
            y: point.clientY,
        };
        if (gesture.seek) info();
    }
    function move(point: any): void {
        if (gesture && gesture.seek && point) {
            var dx = Math.abs(point.clientX - gesture.x);
            var dy = Math.abs(point.clientY - gesture.y);
            if (dy > 32 || (dy > 12 && dy > dx)) gesture.cancelled = true;
            if (!gesture.cancelled) info();
        }
        if (
            gesture &&
            point &&
            (Math.abs(point.clientX - gesture.x) > 12 ||
                Math.abs(point.clientY - gesture.y) > 12)
        )
            gesture.moved = true;
    }
    function finish(point: any): void {
        move(point);
        var finished = gesture;
        gesture = null;
        if (finished && finished.seek) {
            var seek = finished.seek;
            try {
                var rect = seek.bar.getBoundingClientRect();
                if (
                    !finished.cancelled &&
                    now() - finished.time < 10000 &&
                    seek.bar === w.document.getElementById("progress_div") &&
                    rect.width === seek.rect.width &&
                    rect.left === seek.rect.left &&
                    rect.top === seek.rect.top &&
                    rect.width > 0 &&
                    rect.height > 0 &&
                    seek.commit((point.clientX - rect.left) / rect.width)
                )
                    info();
            } catch (_) {
                // A retired footer or player cancels the already-consumed gesture.
            }
        } else if (finished && !finished.moved && now() - finished.time < 600)
            info();
    }
    function input(event: any): void {
        if (!active()) return;
        consume(event);
        var type = event.type;
        var time = now();
        if (type.indexOf("key") === 0) {
            key(event);
            return;
        }
        if (type === "touchstart") {
            lastTouch = time;
            if (stopCapture(event)) gesture = null;
            else if (event.touches.length === 1 && !gesture)
                start(
                    event.touches[0],
                    "touch",
                    event.touches[0].identifier,
                    event
                );
            else gesture = null;
        } else if (type === "touchmove") {
            if (gesture && gesture.kind === "touch") move(event.touches[0]);
        } else if (type === "touchend") {
            lastTouch = time;
            if (
                gesture &&
                gesture.kind === "touch" &&
                !event.touches.length &&
                event.changedTouches[0].identifier === gesture.id
            )
                finish(event.changedTouches[0]);
            else gesture = null;
        } else if (type === "pointerdown" || type === "mousedown") {
            if (event.pointerType === "touch" || time - lastTouch < 800) return;
            if (type === "mousedown" && w.PointerEvent) return;
            if (stopCapture(event)) gesture = null;
            else if (
                (event.button === undefined || event.button === 0) &&
                !gesture
            )
                start(event, "pointer", event.pointerId, event);
            else gesture = null;
        } else if (type === "pointermove" || type === "mousemove") {
            if (gesture && gesture.kind === "pointer") move(event);
        } else if (type === "pointerup" || type === "mouseup") {
            if (event.pointerType === "touch" || time - lastTouch < 800) return;
            if (type === "mouseup" && w.PointerEvent) return;
            lastPointer = time;
            if (
                gesture &&
                gesture.kind === "pointer" &&
                event.pointerId === gesture.id
            )
                finish(event);
        } else if (type === "click") {
            // Keyboard/accessibility clicks have no pointer sequence. Compatibility
            // clicks following touch/pointer releases must not show the footer twice.
            if (
                time - lastTouch >= 800 &&
                time - lastPointer >= 800 &&
                event.detail <= 1 &&
                !stopCapture(event)
            )
                info();
        } else if (
            type === "pointercancel" ||
            type === "touchcancel" ||
            type === "contextmenu"
        ) {
            gesture = null;
        }
    }
    var target = w.addEventListener ? w : w.document;
    if (target && target.addEventListener) {
        [
            "keydown",
            "keyup",
            "keypress",
            "click",
            "dblclick",
            "contextmenu",
            "pointerdown",
            "pointermove",
            "pointerup",
            "pointercancel",
            "mousedown",
            "mousemove",
            "mouseup",
            "touchstart",
            "touchmove",
            "touchend",
            "touchcancel",
            "wheel",
            "dragstart",
            "selectstart",
        ].forEach(function (name) {
            target.addEventListener(name, input, {
                capture: true,
                passive: false,
            });
        });
    }
    return {
        key: key,
        sync: function (): void {
            gesture = null;
            var root = w.document && w.document.documentElement;
            if (root && root.classList) {
                root.classList.toggle("ott-kiosk-strict", active());
                if (active()) {
                    var focused = w.document.activeElement;
                    if (focused && focused.blur) focused.blur();
                }
            }
        },
    };
}

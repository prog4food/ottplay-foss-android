(function (window, document) {
    "use strict";

    var overlay;
    var mode;
    try {
        if (!/^https?:$/.test(window.location.protocol) ||
            typeof window.__TAURI__ !== "undefined" ||
            typeof window.__TAURI_INTERNALS__ !== "undefined" ||
            typeof window.Capacitor !== "undefined" ||
            typeof window.__ottNativeRuntime !== "undefined" ||
            typeof window.Android !== "undefined" ||
            !window.navigator.windowControlsOverlay ||
            typeof window.matchMedia !== "function" ||
            typeof window.MutationObserver !== "function") return;
        overlay = window.navigator.windowControlsOverlay;
        mode = window.matchMedia("(display-mode: window-controls-overlay)");
    } catch (_unsupported) {
        return;
    }

    function setClass(element, name, enabled) {
        var words = (element.className || "").split(/\s+/);
        var next = [];
        var i;
        for (i = 0; i < words.length; i++) {
            if (words[i] && words[i] !== name) next.push(words[i]);
        }
        if (enabled) next.push(name);
        var value = next.join(" ");
        if (element.className !== value) element.className = value;
    }

    function start() {
        var root = document.documentElement;
        if (!document.body || document.getElementById("window-drag-region")) return;

        var drag = document.createElement("div");
        drag.id = "window-drag-region";
        drag.setAttribute("aria-hidden", "true");
        // A root child keeps the browser's CSS-pixel drag rectangle independent
        // of any legacy transform applied to the player's body.
        root.appendChild(drag);

        var videoBox = null;
        var videoObserver = new window.MutationObserver(updatePreview);

        function updatePreview() {
            if (!videoBox) return;
            // The browser adapter explicitly releases the bottom edge in list
            // preview mode. Full video pins it to zero, including on resize.
            var preview = videoBox.style.bottom === "auto" &&
                parseFloat(videoBox.style.top) > 0;
            setClass(videoBox, "ott-window-controls-preview", preview);
        }

        function findVideo() {
            var next = document.getElementById("vdiv");
            if (next === videoBox) return;
            videoObserver.disconnect();
            videoBox = next;
            if (videoBox) {
                videoObserver.observe(videoBox, {
                    attributes: true,
                    attributeFilter: ["style"]
                });
                updatePreview();
            }
        }

        function updateOverlay() {
            var fullscreen = document.fullscreenElement ||
                document.webkitFullscreenElement;
            setClass(root, "ott-window-controls", !!(
                overlay.visible && mode.matches && !fullscreen
            ));
        }

        // The player creates or replaces #vdiv directly under body. Observe
        // those child changes only; list rows and media events need no scan.
        var bodyObserver = new window.MutationObserver(findVideo);
        bodyObserver.observe(document.body, { childList: true });
        findVideo();
        updateOverlay();

        if (typeof overlay.addEventListener === "function") {
            overlay.addEventListener("geometrychange", updateOverlay);
        }
        if (typeof mode.addEventListener === "function") {
            mode.addEventListener("change", updateOverlay);
        } else if (typeof mode.addListener === "function") {
            mode.addListener(updateOverlay);
        }
        document.addEventListener("fullscreenchange", updateOverlay);
        document.addEventListener("webkitfullscreenchange", updateOverlay);
        window.addEventListener("resize", updateOverlay);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})(window, document);

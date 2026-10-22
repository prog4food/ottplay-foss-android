/* Dedicated Tauri PiP document. Engine assets are the same bundled files as main. */
(function () {
    "use strict";
    if (window.__ottplayPip) return;

    var instance = Number(window.location.hash.slice(1));
    var current = null;
    var teardowns = [];
    var teardownFailed = false;
    var lastSession = 0;
    var lifecycle = 0;
    var libraries = {};
    var booted = false;
    var labels = {
        loading: "Loading…",
        playback: "Stream could not be played",
        startup: "Player could not start",
        runtime:
            "Compatibility runtime could not load. Reopen the player to retry.",
    };

    function updateLabels(value) {
        if (!value || typeof value !== "object") return;
        Object.keys(labels).forEach(function (key) {
            if (
                Object.prototype.hasOwnProperty.call(value, key) &&
                typeof value[key] === "string" &&
                value[key].trim() &&
                value[key].length <= 512
            )
                labels[key] = value[key];
        });
    }
    // The native window receives a bounded text-only snapshot before runtime boot,
    // including when the compatibility script itself could not load.
    try {
        var initialLabels = /[?&]labels=([^&]*)/.exec(window.location.search);
        if (initialLabels && initialLabels[1].length <= 24000)
            updateLabels(
                JSON.parse(
                    decodeURIComponent(initialLabels[1].replace(/\+/g, " "))
                )
            );
    } catch (_) {}

    function invoke(command, args) {
        return window.__TAURI__.core.invoke(command, args);
    }

    function status(message) {
        var el = document.getElementById("ottplay-pip-status");
        if (el) {
            el.textContent = message;
            el.hidden = !message;
        }
    }

    function active(state) {
        return current === state && !state.failed;
    }

    function report(state, event) {
        // Do not expose provider URLs, credentials or decoder error objects.
        try {
            invoke("pip_player_event", {
                event: event,
                instance: instance,
                session: state.session,
            }).catch(function () {});
        } catch (_) {}
    }

    function release(state) {
        if (!state) return Promise.resolve();
        var teardown = Promise.resolve();
        var failed = false;
        try { if (state.autoCancel) state.autoCancel(); } catch (_) { failed = true; }
        state.autoCancel = null;
        state.autoNative = false;
        state.playbackEpoch++;
        state.video.onplaying = null;
        state.video.onerror = null;
        if (state.hls) {
            try {
                state.hls.destroy();
            } catch (_) { failed = true; }
            state.hls = null;
        }
        if (state.shaka) {
            try {
                var destroyed = state.shaka.destroy();
                if (destroyed && destroyed.then) {
                    teardown = destroyed;
                    teardown.catch(function () {});
                }
            } catch (_) { failed = true; }
            state.shaka = null;
        }
        try {
            state.video.pause();
            state.video.removeAttribute("src");
            state.video.load();
        } catch (_) { failed = true; }
        if (failed) teardown = Promise.reject(new Error("PiP teardown failed"));
        // A replaced/failed engine can still own requests while the new one plays.
        // Keep every asynchronous teardown in the window-wide drain boundary.
        teardowns.push(teardown);
        function retired() {
            var index = teardowns.indexOf(teardown);
            if (index >= 0) teardowns.splice(index, 1);
        }
        teardown.then(retired, function () {
            teardownFailed = true;
            retired();
        });
        return teardown;
    }

    function stop(session) {
        if (typeof session === "number") {
            if (session < lastSession) return;
            lastSession = Math.max(lastSession, session);
        } else lifecycle++;
        var previous = current;
        current = null;
        release(previous);
        status("");
        if (typeof session === "number") {
            Promise.all(teardowns.slice()).then(function () {
                report({ session: session }, teardownFailed ? "stop_error" : "stopped");
            }, function () { report({ session: session }, "stop_error"); });
        }
    }

    function fail(state) {
        if (!active(state)) return;
        state.failed = true;
        release(state);
        status(labels.playback);
        report(state, "error");
    }

    function playVideo(state) {
        if (!active(state)) return;
        var epoch = state.playbackEpoch;
        function rejected(error) {
            if (!active(state) || state.playbackEpoch !== epoch) return;
            // Unsupported native HLS can reject play before its media error
            // event. The Auto watchdog owns that one fallback decision.
            var code = state.video.error && state.video.error.code;
            if (
                state.autoNative &&
                (code === 3 ||
                    code === 4 ||
                    (error && error.name === "NotSupportedError"))
            )
                return;
            fail(state);
        }
        try {
            var playing = state.video.play();
            if (playing && playing.catch) {
                playing.catch(rejected);
            }
        } catch (error) {
            rejected(error);
        }
    }

    function configureHlsWorker() {
        if (window.Hls && window.Hls.DefaultConfig) {
            window.Hls.DefaultConfig.workerPath = new URL(
                "./js/hls.worker.js?v=" + window.__ottMediaRuntimeVersion,
                window.location.href
            ).href;
        }
    }

    function library(name, path) {
        if (libraries[name]) return libraries[name];
        libraries[name] = new Promise(function (resolve, reject) {
            var script = document.createElement("script");
            script.src = new URL(
                path +
                    (name === "hls"
                        ? "?v=" + window.__ottMediaRuntimeVersion
                        : ""),
                window.location.href
            ).href;
            script.onload = function () {
                if (name === "hls") configureHlsWorker();
                resolve();
            };
            script.onerror = function () {
                delete libraries[name];
                script.remove();
                reject(new Error("Bundled player unavailable"));
            };
            document.head.appendChild(script);
        });
        return libraries[name];
    }

    function direct(state) {
        if (!active(state)) return;
        state.video.src = state.url;
        playVideo(state);
    }

    function hls(state, nativeFallback) {
        function start() {
            configureHlsWorker();
            if (!active(state)) return;
            if (!window.Hls || !window.Hls.isSupported()) {
                if (
                    nativeFallback !== false &&
                    state.video.canPlayType("application/vnd.apple.mpegurl")
                )
                    direct(state);
                else fail(state);
                return;
            }
            try {
                var player = new window.Hls();
                state.hls = player;
                player.on(window.Hls.Events.MANIFEST_PARSED, function () {
                    if (active(state) && state.hls === player) playVideo(state);
                });
                player.on(window.Hls.Events.ERROR, function (_, data) {
                    if (active(state) && data && data.fatal) fail(state);
                });
                player.loadSource(state.url);
                player.attachMedia(state.video);
            } catch (_) {
                fail(state);
            }
        }
        if (window.Hls) start();
        else
            library("hls", "./js/hls.min.js").then(start, function () {
                if (!active(state)) return;
                if (
                    nativeFallback !== false &&
                    state.video.canPlayType("application/vnd.apple.mpegurl")
                )
                    direct(state);
                else fail(state);
            });
    }

    function autoHls(state) {
        if (!state.video.canPlayType("application/vnd.apple.mpegurl")) {
            hls(state, false);
            return;
        }
        state.autoNative = true;
        // Existing native-compatible channels start without waiting for JS.
        direct(state);
        function nativeOnly() {
            if (!active(state) || !state.autoNative) return;
            state.autoNative = false;
            if (state.video.error) fail(state);
        }
        function watch() {
            configureHlsWorker();
            if (!active(state) || !state.autoNative) return;
            if (
                !window.Hls ||
                !window.Hls.isSupported() ||
                typeof watchAutoNativePlayback !== "function"
            ) {
                nativeOnly();
                return;
            }
            function stillNative() {
                return active(state) && state.autoNative;
            }
            function switchEngine(fallback) {
                if (!stillNative()) return;
                state.autoCancel = null; // The shared helper self-cleans first.
                state.autoNative = false;
                state.playbackEpoch++;
                try {
                    state.video.pause();
                    state.video.removeAttribute("src");
                    state.video.load();
                } catch (_) {}
                status(labels.loading);
                if (fallback) hls(state, false);
                else direct(state);
            }
            state.autoCancel = watchAutoNativePlayback(
                state.video,
                state.url,
                window.Hls,
                {
                    active: stillNative,
                    fallback: function () {
                        switchEngine(true);
                    },
                    restore: function () {
                        switchEngine(false);
                    },
                }
            );
        }
        if (window.Hls) watch();
        else library("hls", "./js/hls.min.js").then(watch, nativeOnly);
    }

    function dash(state) {
        function start() {
            if (!active(state)) return;
            try {
                if (window.shaka && window.shaka.polyfill)
                    window.shaka.polyfill.installAll();
                if (
                    !window.shaka ||
                    !window.shaka.Player.isBrowserSupported()
                ) {
                    fail(state);
                    return;
                }
                var player = new window.shaka.Player();
                state.shaka = player;
                player.addEventListener("error", function (event) {
                    if (
                        active(state) &&
                        event.detail &&
                        event.detail.severity === 2
                    )
                        fail(state);
                });
                Promise.resolve(player.attach(state.video))
                    .then(function () {
                        if (active(state) && state.shaka === player)
                            return player.load(state.url);
                    })
                    .then(
                        function () {
                            if (active(state) && state.shaka === player)
                                playVideo(state);
                        },
                        function () {
                            if (active(state)) fail(state);
                        }
                    );
            } catch (_) {
                fail(state);
            }
        }
        if (window.shaka) start();
        else
            library("shaka", "./js/shaka-player.compiled.js").then(
                start,
                function () {
                    if (active(state)) fail(state);
                }
            );
    }

    function play(request) {
        // A delayed ready response cannot replace a newer Rust command or revive stop.
        if (
            !request ||
            request.instance !== instance ||
            request.session <= lastSession
        )
            return;
        lastSession = request.session;
        updateLabels(request.labels);
        stop();
        var previous = document.getElementById("ottplay-pip-video");
        var video = document.createElement("video");
        video.id = "ottplay-pip-video";
        video.autoplay = true;
        video.loop = request.loop === true;
        video.muted = true;
        video.defaultMuted = true;
        video.setAttribute("muted", "");
        video.controls = false;
        video.playsInline = true;
        video.setAttribute("playsinline", "");
        if (previous) previous.parentNode.replaceChild(video, previous);
        else document.body.appendChild(video);
        var state = {
            session: request.session,
            url: request.url,
            video: video,
            hls: null,
            shaka: null,
            failed: false,
            started: false,
            autoNative: false,
            autoCancel: null,
            playbackEpoch: 0,
        };
        current = state;
        status(labels.loading);
        video.onplaying = function () {
            if (!active(state)) return;
            status("");
            if (state.started) return;
            state.started = true;
            report(state, "playing");
        };
        video.onerror = function () {
            var code = video.error && video.error.code;
            if (state.autoNative && (code === 3 || code === 4)) return;
            if (active(state)) fail(state);
        };
        // Explicit native mode is retained. Otherwise DASH/HLS use main's engines.
        if (request.engine === 0) direct(state);
        else if (request.engine === 3) {
            if (/\.mpd(?:[?#]|$)/i.test(state.url)) dash(state);
            else if (/\.m3u8(?:[?#]|$)/i.test(state.url)) autoHls(state);
            else direct(state);
        } else if (request.engine === 2 || /\.mpd(?:[?#]|$)/i.test(state.url))
            dash(state);
        else if (request.engine === 1 || /\.m3u8(?:[?#]|$)/i.test(state.url))
            hls(state);
        else direct(state);
    }

    window.__ottplayPip = { play: play, stop: stop };

    function boot() {
        if (booted) return;
        status(labels.loading);
        if (
            window.__ottRuntimePolyfillsReady !== true ||
            !/^[a-f0-9]{16}$/.test(window.__ottMediaRuntimeVersion || "")
        ) {
            status(labels.runtime);
            return;
        }
        booted = true;
        document.addEventListener("mousedown", function (event) {
            if (event.button !== 0) return;
            event.preventDefault();
            try {
                window.__TAURI__.window
                    .getCurrentWindow()
                    .startDragging()
                    .catch(function () {});
            } catch (_) {}
        });
        window.addEventListener("pagehide", stop);
        try {
            var readyLifecycle = lifecycle;
            invoke("pip_player_event", {
                event: "ready",
                instance: instance,
                session: 0,
            }).then(
                function (request) {
                    if (lifecycle === readyLifecycle) play(request);
                },
                function () {
                    if (lifecycle === readyLifecycle) status(labels.startup);
                }
            );
        } catch (_) {
            status(labels.startup);
        }
    }
    if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
})();

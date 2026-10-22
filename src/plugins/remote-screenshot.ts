/** Connected-controller screenshots. Discovery never captures an image. */
export interface ScreenshotImage {
    height: number;
    image: string;
    source: string;
    video: "unknown" | "excluded";
    width: number;
}
interface ScreenshotConfig {
    address: string;
    enabled: boolean;
    token: string;
}
interface ScreenshotDependencies {
    getConfig: () => ScreenshotConfig;
    mobile?: {
        capabilities: () => Promise<any>;
        capture: () => Promise<any>;
    };
    onStatus?: (status: any) => void;
}

/** Only this application's native view or a browser source chosen through the OS. */
export function installRemoteScreenshot(
    w: any,
    deps: ScreenshotDependencies
): any {
    var maxBytes = 1048576;
    var maxWidth = 1280;
    var maxHeight = 720;
    var supported = false;
    var source: string | null = null;
    var nativeCapture: (() => Promise<any>) | null = null;
    var nativeCurrent: (() => boolean) | null = null;
    var activeConfig: ScreenshotConfig | null = null;
    var binding: ScreenshotConfig | null = null;
    var generation = 0;
    var pending = false;
    var probing = false;
    var capturing = false;
    var disposed = false;
    var cancelBrowser: (() => void) | null = null;
    var stream: any = null;
    var frameCapture: any = null;
    var subscriber: ((status: any) => void) | null = null;
    var message = "";
    var hook: any;

    function currentConfig(): ScreenshotConfig | null {
        try {
            var config = deps.getConfig();
            if (
                disposed ||
                !config ||
                config.enabled !== true ||
                typeof config.address !== "string" ||
                typeof config.token !== "string" ||
                !/^[A-Za-z0-9_-]{32,256}$/.test(config.token)
            )
                return null;
            var url = new URL(config.address);
            if (
                url.username ||
                url.password ||
                url.hash ||
                (url.protocol !== "https:" &&
                    !(
                        url.protocol === "http:" &&
                        /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)
                    ))
            )
                return null;
            return {
                address: config.address,
                enabled: true,
                token: config.token,
            };
        } catch (_) {
            return null;
        }
    }
    function sameConfig(
        first: ScreenshotConfig | null,
        second: ScreenshotConfig | null
    ): boolean {
        return (
            first === second ||
            !!(
                first &&
                second &&
                first.address === second.address &&
                first.token === second.token &&
                first.enabled === second.enabled
            )
        );
    }
    function stopTracks(value: any): void {
        if (!value || typeof value.getTracks !== "function") return;
        value.getTracks().forEach(function (track: any) {
            track.stop();
        });
    }
    function invalidate(): void {
        if (cancelBrowser) cancelBrowser();
        generation++;
        binding = null;
        pending = false;
        var old = stream;
        stream = null;
        frameCapture = null;
        if (!nativeCapture) source = null;
        message = "";
        stopTracks(old);
    }
    function syncConfig(): ScreenshotConfig | null {
        var config = currentConfig();
        if (!sameConfig(activeConfig, config)) {
            invalidate();
            activeConfig = config;
        }
        return config;
    }
    function ready(config: ScreenshotConfig | null): boolean {
        if (!config || !supported || w.__ottRemoteScreenshot !== hook)
            return false;
        if (nativeCapture) return !!(nativeCurrent && nativeCurrent());
        return !!(
            sameConfig(binding, config) &&
            stream &&
            stream.active &&
            frameCapture &&
            stream.getVideoTracks().length === 1 &&
            stream.getVideoTracks()[0].readyState === "live" &&
            !stream.getVideoTracks()[0].muted
        );
    }
    function status(): any {
        var config = syncConfig();
        var available = ready(config);
        var browserSelectionSupported = supported && !nativeCapture;
        var text = message;
        if (!config)
            text = "Connect an HTTPS command server to use screenshots.";
        else if (available)
            text = nativeCapture
                ? "Screenshots are available while remote control is connected."
                : "The browser screenshot source is ready.";
        else if (!text)
            text =
                "Select the player tab or window in the browser sharing dialog.";
        return {
            browserSelectionSupported: browserSelectionSupported,
            connected: !!config,
            enabled: available,
            message: text,
            needsSourceSelection:
                browserSelectionSupported && !!config && !available,
            pending: pending,
            source: source,
            state: !supported
                ? "unsupported"
                : available
                  ? "ready"
                  : "permission_required",
        };
    }
    // Pure observation for doctor: never synchronize configuration or release
    // a selected source. A stale binding is unknown until normal lifecycle sync.
    function peek(): any {
        var config = currentConfig();
        var current =
            !disposed &&
            w.__ottRemoteScreenshot === hook &&
            sameConfig(config, activeConfig);
        var available = current && ready(config);
        return {
            busy: capturing || pending || probing,
            connected: !!config,
            known: current && !probing,
            needsSourceSelection:
                current &&
                !!config &&
                supported &&
                !nativeCapture &&
                !available,
            ready: available,
            source: current ? source : null,
            state: !supported
                ? "unsupported"
                : available
                  ? "ready"
                  : "permission_required",
            supported: supported,
        };
    }
    function notify(): void {
        var view = status();
        if (deps.onStatus) deps.onStatus(view);
        if (subscriber) subscriber(view);
    }
    function stop(): void {
        invalidate();
        notify();
    }
    function failSelection(text: string): void {
        invalidate();
        message = text;
        notify();
    }
    function selectSource(local: boolean): void {
        var config = syncConfig();
        if (
            local !== true ||
            w.__ottRemoteInputActive ||
            pending ||
            !supported ||
            nativeCapture ||
            !config ||
            w.__ottRemoteScreenshot !== hook
        )
            return;
        invalidate();
        binding = config;
        var epoch = generation;
        pending = true;
        message =
            "Select the player tab or window in the browser sharing dialog.";
        notify();
        // Keep the mandatory OS picker in the local gesture stack, never an RPC.
        var selection: any;
        try {
            selection = w.navigator.mediaDevices.getDisplayMedia({
                audio: false,
                preferCurrentTab: true,
                selfBrowserSurface: "include",
                surfaceSwitching: "exclude",
                video: {
                    height: { ideal: maxHeight },
                    width: { ideal: maxWidth },
                },
            });
        } catch (_) {
            failSelection("Screen sharing was cancelled or is unavailable.");
            return;
        }
        selection.then(
            function (selected: any) {
                var current = syncConfig();
                if (
                    generation !== epoch ||
                    !pending ||
                    !sameConfig(config, current) ||
                    w.__ottRemoteScreenshot !== hook
                ) {
                    stopTracks(selected);
                    return;
                }
                try {
                    var tracks = selected.getVideoTracks();
                    var surface =
                        tracks.length === 1 &&
                        tracks[0].getSettings().displaySurface;
                    var kind =
                        surface === "browser"
                            ? "browser-tab"
                            : surface === "window"
                              ? "window"
                              : surface === "monitor"
                                ? "display"
                                : null;
                    if (
                        !kind ||
                        !selected.active ||
                        tracks[0].readyState !== "live" ||
                        selected.getAudioTracks().length
                    ) {
                        stopTracks(selected);
                        failSelection(
                            "This browser cannot identify the selected screenshot source."
                        );
                        return;
                    }
                    stream = selected;
                    source = kind;
                    tracks[0].addEventListener("ended", function () {
                        if (stream === selected) stop();
                    });
                    frameCapture = new w.ImageCapture(tracks[0]);
                    pending = false;
                    message = "";
                    notify();
                } catch (_) {
                    if (stream !== selected) stopTracks(selected);
                    failSelection("Screen sharing could not start.");
                }
            },
            function () {
                if (generation === epoch)
                    failSelection(
                        "Screen sharing was cancelled or is unavailable."
                    );
            }
        );
    }
    function validImage(value: any): value is ScreenshotImage {
        if (
            !value ||
            Object.keys(value).length !== 5 ||
            typeof value.image !== "string" ||
            value.image.length > 1398104 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(value.image) ||
            value.image.length % 4 !== 0 ||
            value.source !== source ||
            (value.video !== "unknown" && value.video !== "excluded") ||
            typeof value.width !== "number" ||
            value.width % 1 ||
            value.width < 1 ||
            value.width > maxWidth ||
            typeof value.height !== "number" ||
            value.height % 1 ||
            value.height < 1 ||
            value.height > maxHeight
        )
            return false;
        try {
            var raw = w.atob(value.image);
            if (
                raw.length > maxBytes ||
                raw.slice(0, 8) !== "\x89PNG\r\n\x1a\n" ||
                raw.slice(12, 16) !== "IHDR"
            )
                return false;
            var int = function (at: number): number {
                return (
                    raw.charCodeAt(at) * 16777216 +
                    raw.charCodeAt(at + 1) * 65536 +
                    raw.charCodeAt(at + 2) * 256 +
                    raw.charCodeAt(at + 3)
                );
            };
            return int(16) === value.width && int(20) === value.height;
        } catch (_) {
            return false;
        }
    }
    function browserImage(bitmap: any): ScreenshotImage {
        if (
            !bitmap ||
            !bitmap.width ||
            !bitmap.height ||
            !stream ||
            !stream.active ||
            stream.getVideoTracks()[0].readyState !== "live" ||
            stream.getVideoTracks()[0].muted
        )
            throw new Error();
        var canvas = w.document.createElement("canvas");
        var scale = Math.min(
            1,
            maxWidth / bitmap.width,
            maxHeight / bitmap.height
        );
        for (var attempt = 0; attempt < 8; attempt++) {
            canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
            canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
            canvas
                .getContext("2d")
                .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            var encoded = canvas.toDataURL("image/png");
            if (encoded.indexOf("data:image/png;base64,") !== 0)
                throw new Error();
            var result: ScreenshotImage = {
                height: canvas.height,
                image: encoded.slice(22),
                source: source!,
                video: "unknown",
                width: canvas.width,
            };
            if (validImage(result)) return result;
            scale *= 0.75;
        }
        throw new Error();
    }
    function capture(done: (result: any) => void): () => void {
        var cancelled = false;
        var config = syncConfig();
        if (!ready(config) || capturing) {
            done({
                data: {
                    error: "Screenshot source is unavailable. Check the controller connection or browser sharing.",
                },
                status: "rejected",
            });
            return function () {};
        }
        var epoch = generation;
        var timeout: any;
        var renderTimeout: any;
        var renderFrame: any = null;
        capturing = true;
        function clearRenderWait(): void {
            w.clearTimeout(renderTimeout);
            if (
                renderFrame !== null &&
                typeof w.cancelAnimationFrame === "function"
            )
                w.cancelAnimationFrame(renderFrame);
            renderFrame = null;
        }
        function cleanup(): void {
            w.clearTimeout(timeout);
            clearRenderWait();
        }
        var cancel = function (): void {
            cancelled = true;
            cleanup();
        };
        function finish(value?: any): void {
            capturing = false;
            cleanup();
            if (cancelled) return;
            cancelled = true;
            if (
                !value ||
                !sameConfig(config, syncConfig()) ||
                epoch !== generation ||
                !ready(config) ||
                !validImage(value)
            ) {
                done({
                    data: {
                        error: "Screenshot unavailable or the controller connection changed. No image was returned.",
                    },
                    status: "rejected",
                });
                return;
            }
            done({ data: value, status: "ok" });
        }
        timeout = w.setTimeout(function () {
            if (!cancelled) {
                cancelled = true;
                cleanup();
                done({
                    data: { error: "Screenshot capture timed out." },
                    status: "rejected",
                });
            }
            if (cancelBrowser) {
                cancelBrowser();
                stop();
            }
            // Retain busy until the native callback drains: no accumulating captures.
        }, 12000);
        try {
            if (nativeCapture)
                nativeCapture().then(finish, function () {
                    finish();
                });
            else {
                // grabFrame requests a new snapshot from the live source. Never use
                // a cached <video> frame that could predate the current player UI.
                var browserCapture = frameCapture;
                var baseCancel = cancel;
                cancel = function () {
                    baseCancel();
                    capturing = false;
                    if (cancelBrowser === cancel) cancelBrowser = null;
                };
                cancelBrowser = cancel;
                var grabbed = false;
                var grab = function (): void {
                    if (cancelled || grabbed) return;
                    grabbed = true;
                    clearRenderWait();
                    if (
                        !sameConfig(config, syncConfig()) ||
                        epoch !== generation ||
                        !ready(config)
                    ) {
                        finish();
                        return;
                    }
                    try {
                        browserCapture.grabFrame().then(
                            function (bitmap: any) {
                                if (cancelled) {
                                    if (bitmap && bitmap.close) bitmap.close();
                                    return;
                                }
                                if (cancelBrowser === cancel)
                                    cancelBrowser = null;
                                try {
                                    finish(browserImage(bitmap));
                                } catch (_) {
                                    finish();
                                } finally {
                                    if (bitmap && bitmap.close) bitmap.close();
                                }
                            },
                            function () {
                                if (cancelled) return;
                                if (cancelBrowser === cancel)
                                    cancelBrowser = null;
                                finish();
                            }
                        );
                    } catch (_) {
                        if (cancelBrowser === cancel) cancelBrowser = null;
                        finish();
                    }
                };
                // Let a visible page's latest DOM updates reach the compositor.
                // Background capture stays valid even when animation frames pause.
                if (
                    !w.document.hidden &&
                    typeof w.requestAnimationFrame === "function"
                ) {
                    renderTimeout = w.setTimeout(grab, 100);
                    try {
                        renderFrame = w.requestAnimationFrame(function () {
                            if (cancelled || grabbed) return;
                            if (w.document.hidden) grab();
                            else renderFrame = w.requestAnimationFrame(grab);
                        });
                    } catch (_) {
                        grab();
                    }
                } else grab();
            }
        } catch (_) {
            finish();
        }
        return cancel;
    }
    hook = {
        capture: capture,
        configurationChanged: function () {
            stop();
        },
        peek: peek,
        selectSource: selectSource,
        snapshot: function () {
            var view = status();
            return { source: view.source, state: view.state };
        },
        status: status,
        stop: stop,
        subscribe: function (listener: any) {
            subscriber = listener;
            if (listener) listener(status());
        },
    };
    w.__ottRemoteScreenshot = hook;
    function nativeProbe(
        probe: () => Promise<any>,
        capture: () => Promise<any>,
        current: () => boolean
    ): void {
        nativeCurrent = current;
        probing = true;
        try {
            probe().then(
                function (caps: any) {
                    probing = false;
                    // Discovery is read-only and can settle while this page is
                    // suspended; connection authority stays disabled until resume.
                    if (w.__ottRemoteScreenshot !== hook || !current()) return;
                    if (
                        caps &&
                        caps.supported === true &&
                        (caps.source === "player-window" ||
                            caps.source === "player-view")
                    ) {
                        supported = true;
                        source = caps.source;
                        nativeCapture = capture;
                    }
                    notify();
                },
                function () {
                    probing = false;
                    notify();
                }
            );
        } catch (_) {
            probing = false;
            /* Older shell: remain unsupported. */
        }
    }
    var tauri = w.__TAURI__;
    var cap = w.Capacitor;
    if (tauri) {
        var owner = tauri.core || tauri;
        var invoke = owner.invoke;
        if (typeof invoke === "function")
            nativeProbe(
                function () {
                    return invoke.call(owner, "screenshot_capabilities", {});
                },
                function () {
                    return invoke.call(owner, "capture_screenshot", {});
                },
                function () {
                    return (
                        w.__TAURI__ === tauri &&
                        (tauri.core || tauri) === owner &&
                        owner.invoke === invoke
                    );
                }
            );
    } else if (
        cap &&
        typeof cap.isNativePlatform === "function" &&
        cap.isNativePlatform()
    ) {
        var mobile = deps.mobile;
        if (
            mobile &&
            typeof cap.isPluginAvailable === "function" &&
            cap.isPluginAvailable("RemoteScreenshot")
        )
            nativeProbe(
                function () {
                    return mobile!.capabilities();
                },
                function () {
                    return mobile!.capture();
                },
                function () {
                    return (
                        w.Capacitor === cap &&
                        cap.isNativePlatform() &&
                        cap.isPluginAvailable("RemoteScreenshot")
                    );
                }
            );
    } else
        supported = !!(
            w.isSecureContext &&
            w.navigator &&
            w.navigator.mediaDevices &&
            typeof w.navigator.mediaDevices.getDisplayMedia === "function" &&
            typeof w.ImageCapture === "function" &&
            typeof w.ImageCapture.prototype.grabFrame === "function"
        );
    if (w.addEventListener) {
        w.addEventListener("pagehide", function () {
            disposed = true;
            stop();
        });
        w.addEventListener("pageshow", function () {
            if (w.__ottRemoteScreenshot !== hook || !disposed) return;
            disposed = false;
            notify();
        });
    }
    notify();
    return hook;
}

/** Native lifecycle capabilities; command dispatch owns consent and ACK ordering. */
export interface RemoteLifecycle {
    exit?: () => void;
    platform: string;
    reboot?: () => void;
    restart?: () => void;
}

interface LifecycleDependencies {
    mobileMedia?: { exitApp: () => Promise<unknown> };
    prepare: () => void;
}

/** Install once per page. No native lifecycle effect runs during discovery. */
export function installRemoteLifecycle(
    w: any,
    deps: LifecycleDependencies
): RemoteLifecycle {
    var hook: RemoteLifecycle = { platform: "browser" };
    w.__ottRemoteLifecycle = hook;

    function failed(): void {
        if (w.console && typeof w.console.warn === "function")
            w.console.warn("Remote lifecycle request failed.");
    }

    function nativeAndroidExit(cap: any): boolean {
        var headers = cap.PluginHeaders;
        if (!Array.isArray(headers)) return false;
        for (var i = 0; i < headers.length; i++) {
            var header = headers[i];
            if (
                header &&
                header.name === "MobileNativeMedia" &&
                Array.isArray(header.methods)
            )
                for (var j = 0; j < header.methods.length; j++)
                    if (
                        header.methods[j].name === "exitApp" &&
                        header.methods[j].rtype === "promise"
                    )
                        return true;
        }
        return false;
    }

    function effect(current: () => boolean, run: () => any): () => void {
        return function (): void {
            if (w.__ottRemoteLifecycle !== hook || !current()) return;
            try {
                deps.prepare();
            } catch (_) {
                // Optional persistence must not prevent an acknowledged exit.
            }
            if (w.__ottRemoteLifecycle !== hook || !current()) return;
            try {
                var result = run();
                if (result && typeof result.then === "function")
                    result.then(function (value: any): void {
                        if (
                            value &&
                            (value.ok === false || value.unsupported === true)
                        )
                            failed();
                    }, failed);
            } catch (_) {
                failed();
            }
        };
    }

    try {
        var tauri = w.__TAURI__;
        if (tauri) {
            hook.platform = "tauri";
            var owner = tauri.core || tauri;
            var invoke = owner.invoke;
            var currentTauri = function (): boolean {
                return (
                    w.__TAURI__ === tauri &&
                    (tauri.core || tauri) === owner &&
                    owner.invoke === invoke
                );
            };
            if (typeof invoke === "function") {
                // New hosted code may run in an older shell without these
                // commands. Do not claim support until its read-only probe ACK.
                var pending = invoke.call(owner, "lifecycle_capabilities", {});
                if (pending && typeof pending.then === "function")
                    pending.then(
                        function (caps: any): void {
                            if (
                                w.__ottRemoteLifecycle !== hook ||
                                !currentTauri() ||
                                !caps ||
                                Object.keys(caps).length !== 3 ||
                                caps.exit !== true ||
                                caps.restart !== true ||
                                caps.reboot !== false
                            )
                                return;
                            hook.exit = effect(currentTauri, function () {
                                return invoke.call(owner, "exit_app", {});
                            });
                            hook.restart = effect(currentTauri, function () {
                                return invoke.call(owner, "restart_app", {});
                            });
                        },
                        function (): void {}
                    );
            }
            return hook;
        }

        var cap = w.Capacitor;
        if (cap) {
            if (
                typeof cap.isNativePlatform !== "function" ||
                !cap.isNativePlatform() ||
                typeof cap.getPlatform !== "function"
            )
                return hook;
            var platform = cap.getPlatform();
            if (platform !== "android" && platform !== "ios") return hook;
            hook.platform = platform;
            var media = deps.mobileMedia;
            if (
                platform === "android" &&
                typeof cap.isPluginAvailable === "function" &&
                cap.isPluginAvailable("MobileNativeMedia") &&
                nativeAndroidExit(cap) &&
                media &&
                typeof media.exitApp === "function"
            ) {
                var exit = media.exitApp;
                hook.exit = effect(
                    function (): boolean {
                        return (
                            w.Capacitor === cap &&
                            cap.isNativePlatform() &&
                            cap.getPlatform() === "android" &&
                            cap.isPluginAvailable("MobileNativeMedia") &&
                            nativeAndroidExit(cap) &&
                            media!.exitApp === exit
                        );
                    },
                    function () {
                        // Native implementation retires media and its service
                        // before finishing the Android Activity/task.
                        return exit.call(media);
                    }
                );
            }
            // iOS has no supported graceful application-exit operation.
            return hook;
        }

        var tizen = w.tizen;
        if (
            tizen &&
            tizen.application &&
            typeof tizen.application.getCurrentApplication === "function"
        ) {
            var app = tizen.application.getCurrentApplication();
            if (app && typeof app.exit === "function") {
                var tizenExit = app.exit;
                hook.platform = "tizen";
                hook.exit = effect(
                    function (): boolean {
                        return w.tizen === tizen && app.exit === tizenExit;
                    },
                    function () {
                        return tizenExit.call(app);
                    }
                );
            }
            return hook;
        }

        var palm = w.PalmSystem;
        var webos = w.webOS;
        if (
            palm &&
            typeof palm.identifier === "string" &&
            webos &&
            typeof webos.fetchAppId === "function" &&
            typeof w.close === "function"
        ) {
            var appId = webos.fetchAppId();
            // Browser windows can expose webOS globals too. Require a native
            // caller identity for a non-system packaged app, not a UA hint.
            if (
                typeof appId === "string" &&
                /^[a-zA-Z0-9][a-zA-Z0-9.-]{1,254}$/.test(appId) &&
                !/^com\.(palm|webos|lge|palmdts)(\.|$)/.test(appId) &&
                palm.identifier.split(" ")[0] === appId
            ) {
                var close = w.close;
                hook.platform = "webos";
                hook.exit = effect(
                    function (): boolean {
                        return (
                            w.PalmSystem === palm &&
                            w.webOS === webos &&
                            webos.fetchAppId() === appId &&
                            palm.identifier.split(" ")[0] === appId &&
                            w.close === close
                        );
                    },
                    function () {
                        return close.call(w);
                    }
                );
            }
        }
    } catch (_) {
        // Discovery failures leave unsupported actions absent.
    }
    return hook;
}

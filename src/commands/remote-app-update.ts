import { resolveNativePlugin } from "../plugins/native-bridge";

/** Capability discovery does not download or invoke the installer. */
export function remoteAppUpdateAvailable(w: any): boolean {
    var cap = w.Capacitor;
    return !!(
        cap &&
        cap.isNativePlatform &&
        cap.isNativePlatform() &&
        cap.getPlatform &&
        cap.getPlatform() === "android" &&
        cap.isPluginAvailable &&
        cap.isPluginAvailable("AppUpdate")
    );
}

export function executeRemoteAppUpdate(
    w: any,
    params: any,
    done: (result: any) => void,
    afterReply?: (effect: () => void) => void
): void {
    function fail(status: string, error: string): void {
        done({ data: { error: error }, status: status });
    }
    var operation = params && params.operation;
    var fields =
        operation === "prepare"
            ? ["operation", "url", "sha256"]
            : operation === "install"
              ? ["operation", "sha256"]
              : ["operation"];
    if (
        !params ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        ["status", "prepare", "install"].indexOf(operation) < 0 ||
        Object.keys(params).length !== fields.length ||
        Object.keys(params).some(function (key) {
            return fields.indexOf(key) < 0;
        }) ||
        (operation !== "status" &&
            (typeof params.sha256 !== "string" ||
                !/^[a-f0-9]{64}$/.test(params.sha256)))
    ) {
        fail("rejected", "Invalid app update request.");
        return;
    }
    if (operation === "prepare") {
        try {
            if (
                typeof params.url !== "string" ||
                params.url.length > 2048 ||
                /[\s\\\u0000-\u001f\u007f]/.test(params.url)
            )
                throw new Error();
            var url = new URL(params.url);
            if (
                url.protocol !== "https:" ||
                !url.hostname ||
                url.username ||
                url.password ||
                url.hash
            )
                throw new Error();
        } catch (_) {
            fail("rejected", "Use an HTTPS APK URL without credentials.");
            return;
        }
    }
    if (!remoteAppUpdateAvailable(w)) {
        fail("unsupported", "This player has no Android app updater.");
        return;
    }
    function locked(): boolean {
        return !!(
            (w.__ottKiosk && w.__ottKiosk.enabled()) ||
            (w.__ottParental
                ? w.__ottParental.needs("settings")
                : w.sPSoptions && w.parentPIN !== "*" && !w.parentAccess)
        );
    }
    if (operation !== "status" && locked()) {
        fail("rejected", "Unlock settings and disable kiosk before updating.");
        return;
    }
    var native = resolveNativePlugin<any>("AppUpdate", function () {
        return null;
    });
    if (!native) {
        fail("unsupported", "This player has no Android app updater.");
        return;
    }
    if (operation === "install") {
        if (!afterReply) {
            fail("unsupported", "Installation requires acknowledged delivery.");
            return;
        }
        var hash = params.sha256;
        native.status().then(
            function (state: any) {
                if (
                    locked() ||
                    state.sha256 !== hash ||
                    ["ready", "awaiting_permission"].indexOf(state.phase) < 0
                ) {
                    fail("rejected", "The requested APK is not ready.");
                    return;
                }
                afterReply!(function () {
                    if (locked() || !remoteAppUpdateAvailable(w)) return;
                    native.install({ sha256: hash }).catch(function () {
                        // The durable native status reports installer failures.
                    });
                });
                done({
                    data: { accepted: true, operation: "install" },
                    status: "ok",
                });
            },
            function () {
                fail("rejected", "Cannot read app update status.");
            }
        );
        return;
    }
    var pending =
        operation === "status"
            ? native.status()
            : native.prepare({ sha256: params.sha256, url: params.url });
    pending.then(
        function (state: any) {
            done({ data: state, status: "ok" });
        },
        function () {
            fail("rejected", "App update operation failed.");
        }
    );
}

/** Android supplies power/lifecycle state even when Fire OS reports a visible WebView. */
export function bindKioskScreen(w: any): void {
    var cap = w.Capacitor;
    var plugin = cap && cap.Plugins && cap.Plugins.MobileNativeMedia;
    if (
        !cap ||
        typeof cap.getPlatform !== "function" ||
        cap.getPlatform() !== "android" ||
        !plugin ||
        typeof plugin.getScreenState !== "function" ||
        typeof plugin.addListener !== "function"
    )
        return;
    var revision = -1;
    var kiosk = w.__ottKiosk;
    kiosk.setScreenAwake(false);
    function update(state: any): void {
        if (
            !state ||
            state.ok !== true ||
            typeof state.awake !== "boolean" ||
            typeof state.revision !== "number" ||
            !isFinite(state.revision) ||
            state.revision < revision
        )
            return;
        revision = state.revision;
        kiosk.setScreenAwake(state.awake);
    }
    // Subscribe before reading: a delayed initial reply cannot undo SCREEN_OFF.
    Promise.resolve(plugin.addListener("screenStateChanged", update))
        .then(function () {
            return plugin.getScreenState();
        })
        .then(function (state: any) {
            if (state && state.ok === true) update(state);
            else if (revision < 0) kiosk.setScreenAwake(true);
        })
        .catch(function () {
            // Older installed APKs do not expose this bridge yet.
            if (revision < 0) kiosk.setScreenAwake(true);
        });
}

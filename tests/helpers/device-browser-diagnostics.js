// Opt-in local test-server diagnostics. Read current runtime values without
// changing detection, key handling, storage, settings or the user agent.
(function () {
    "use strict";
    var attempts = 0;
    var timer = setInterval(function () {
        attempts++;
        if (attempts > 300) {
            clearInterval(timer);
            return;
        }
        var keys = window.keys;
        var settings = window.settings || {};
        var alFun =
            typeof settings.alFun === "number" ? settings.alFun : window.sALfun;
        var arFun =
            typeof settings.arFun === "number" ? settings.arFun : window.sARfun;
        if (
            !keys ||
            typeof keys.LEFT !== "number" ||
            typeof keys.RIGHT !== "number" ||
            typeof keys.RETURN !== "number" ||
            typeof window.onkeydown !== "function" ||
            typeof alFun !== "number" ||
            typeof arFun !== "number"
        )
            return;
        clearInterval(timer);
        var snapshot = {
            alFun: alFun,
            arFun: arFun,
            back: keys.RETURN,
            device: String(window.ott_device || ""),
            left: keys.LEFT,
            right: keys.RIGHT,
            userAgent: navigator.userAgent,
        };
        var badge = document.createElement("div");
        badge.id = "ott-device-test-diagnostics";
        badge.style.cssText =
            "position:fixed;top:0;left:25%;z-index:2147483647;padding:5px 10px;background:rgba(0,0,0,0.85);color:#fff;font:14px monospace;pointer-events:none;";
        badge.textContent =
            "Profile: " +
            snapshot.device +
            " | keys L/R/Back: " +
            snapshot.left +
            "/" +
            snapshot.right +
            "/" +
            snapshot.back +
            " | actions L/R: " +
            snapshot.alFun +
            "/" +
            snapshot.arFun;
        document.body.appendChild(badge);
        var json = JSON.stringify(snapshot);
        if (window.console && typeof console.log === "function")
            console.log("Device runtime: " + json);
        var request = new XMLHttpRequest();
        request.open(
            "GET",
            "/__device_test_runtime?data=" + encodeURIComponent(json),
            true
        );
        request.send();
    }, 100);
})();

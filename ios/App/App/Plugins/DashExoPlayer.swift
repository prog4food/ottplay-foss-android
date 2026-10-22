import Capacitor
import Foundation

/// Honest iOS stub: WKWebView has no MSE, and this project does not ship a
/// working AVPlayer/AVFoundation DASH path. Prefer clear unsupported over
/// claiming ExoPlayer (Android-only) or faking success.
@objc(DashExoPlayer)
public class DashExoPlayer: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DashExoPlayerPlugin"
    public let jsName = "DashExoPlayer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPlaybackState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seekDash", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isDashSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pauseDash", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playDash", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeDash", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDash", returnType: CAPPluginReturnPromise),
    ]

    @objc func getPlaybackState(_ call: CAPPluginCall) {
        call.resolve([
            "ok": false, "unsupported": true,
            "position": 0, "duration": 0, "playing": false, "ended": false,
        ])
    }

    @objc func seekDash(_ call: CAPPluginCall) {
        call.resolve(["ok": false, "unsupported": true])
    }

    @objc func isDashSupported(_ call: CAPPluginCall) {
        call.resolve([
            "ok": false,
            "unsupported": true,
        ])
    }

    @objc func playDash(_ call: CAPPluginCall) {
        call.resolve([
            "ok": false,
            "unsupported": true,
            "error": "DASH not supported on iOS Capacitor (no MSE; no AVPlayer DASH path)",
        ])
    }

    @objc func pauseDash(_ call: CAPPluginCall) {
        call.resolve([
            "ok": false,
            "unsupported": true,
        ])
    }

    @objc func resumeDash(_ call: CAPPluginCall) {
        call.resolve([
            "ok": false,
            "unsupported": true,
        ])
    }

    @objc func stopDash(_ call: CAPPluginCall) {
        call.resolve([
            "ok": false,
            "unsupported": true,
        ])
    }
}

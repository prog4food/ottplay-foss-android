import UIKit
import Capacitor
import CapApp_SPM
import WebKit

private func preferredLanguageOrigin(_ url: URL) -> String? {
    guard let scheme = url.scheme?.lowercased(),
          let host = url.host?.lowercased(), !host.isEmpty,
          !["file", "data", "about", "javascript", "blob"].contains(scheme) else {
        return nil
    }
    let authority = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    var origin = "\(scheme)://\(authority)"
    if let port = url.port,
       !(scheme == "http" && port == 80), !(scheme == "https" && port == 443) {
        origin += ":\(port)"
    }
    return origin
}

class MainViewController: CAPBridgeViewController {
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        .landscape
    }

    override var shouldAutorotate: Bool {
        true // Allow both landscape directions without enabling portrait.
    }

    override func capacitorDidLoad() {
        // This hook runs before Capacitor's first loadWebView(). WebKit exposes
        // only its primary language to JS; retain the full native preference order.
        let origins = [bridge?.config.localURL, bridge?.config.serverURL]
            .compactMap { $0 }
            .compactMap(preferredLanguageOrigin)
        if let data = try? JSONSerialization.data(withJSONObject: Locale.preferredLanguages),
           let json = String(data: data, encoding: .utf8),
           let originsData = try? JSONSerialization.data(withJSONObject: origins),
           let originsJson = String(data: originsData, encoding: .utf8) {
            let script = WKUserScript(
                source: """
                (function () {
                    if (window !== window.top) return;
                    var origin = window.location.protocol + "//" + window.location.host;
                    if (\(originsJson).indexOf(origin) === -1) return;
                    window.__ottPreferredLanguages = \(json);
                }());
                """,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            webView?.configuration.userContentController.addUserScript(script)
        }
        bridge?.registerPluginInstance(AccessMediaPlugin())
        bridge?.registerPluginInstance(NativeBackground())
        MobileXmltvEpg.cancellableRequestHandler = { request, completion in
            let task = AccessMedia.fetch(request, discoverOnFailure: false, completion: completion)
            return { task.cancel() }
        }
        bridge?.registerPluginInstance(MobileCommandQueue())
        bridge?.registerPluginInstance(M3UProxyPlugin())
        bridge?.registerPluginInstance(LocalMedia())
        bridge?.registerPluginInstance(MobileXmltvEpg())
        bridge?.registerPluginInstance(MobileNativeMedia())
        bridge?.registerPluginInstance(DashExoPlayer())
        bridge?.registerPluginInstance(StalkerPortalPlugin())
        bridge?.registerPluginInstance(RemoteScreenshot())
        bridge?.registerPluginInstance(RuntimeDiagnostics())
    }

    override var prefersStatusBarHidden: Bool {
        MobileNativeMedia.sharedFullscreenActive
    }

    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation {
        .slide
    }

    open override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for press in presses {
            let jsCode: Int?
            switch press.type {
            case .playPause:
                jsCode = 80 // keys.PLAY / keys.PAUSE
            case .menu:
                jsCode = 27 // keys.EXIT (Android BACK parity)
            case .select:
                // Some remotes send select as UIPress without a keydown.
                jsCode = 13 // keys.ENTER
            default:
                jsCode = nil
            }
            if let code = jsCode {
                injectDoKey(code)
                handled = true
            }
        }
        if !handled {
            super.pressesBegan(presses, with: event)
        }
    }

    private func injectDoKey(_ code: Int) {
        bridge?.webView?.evaluateJavaScript(
            "window._doKey && window._doKey(\(code))",
            completionHandler: nil
        )
    }
}

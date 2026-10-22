import Capacitor
import UIKit
import WebKit

/// Captures only this player's visible web view. Native video and overlays are
/// deliberately outside this API; no display recording permission is requested.
@objc(RemoteScreenshot)
public class RemoteScreenshot: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RemoteScreenshotPlugin"
    public let jsName = "RemoteScreenshot"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capture", returnType: CAPPluginReturnPromise),
    ]

    private static let maxBytes = 1024 * 1024
    private static let maxWidth = 1280
    private static let maxHeight = 720
    private let encoder = DispatchQueue(label: "play.ott.screenshot.encode", qos: .utility)
    private var pending: Request?
    private var backgroundObserver: NSObjectProtocol?
    private var navigationObserver: NSKeyValueObservation?

    // Remains occupied after timeout until WebKit/encoding returns. An
    // uncancellable native capture must not permit unbounded queued bitmaps.
    private final class Request {
        var call: CAPPluginCall?
        var deadline: DispatchWorkItem?
        weak var webView: WKWebView?
        weak var window: UIWindow?
        let url: URL?

        init(_ call: CAPPluginCall, _ webView: WKWebView) {
            self.call = call
            self.webView = webView
            self.window = webView.window
            self.url = webView.url
        }

        func reject(_ message: String, _ code: String) {
            deadline?.cancel()
            deadline = nil
            call?.reject(message, code)
            call = nil
        }

        deinit {
            deadline?.cancel()
            call?.reject("Screenshot owner was destroyed", "unavailable")
        }
    }

    public override func load() {
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.pending?.reject("Player is not in the foreground", "unavailable")
        }
        navigationObserver = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] _, change in
            if change.newValue == true {
                self?.pending?.reject("Player navigation interrupted screenshot", "unavailable")
            }
        }
    }

    deinit {
        if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }
        navigationObserver?.invalidate()
    }

    @objc func capabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let supported = self?.bridge?.webView != nil
            call.resolve(["supported": supported, "source": supported ? "player-view" : NSNull()])
        }
    }

    @objc func capture(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let webView = self.bridge?.webView else {
                call.reject("Screenshot owner is unavailable", "unavailable"); return
            }
            guard self.pending == nil else {
                call.reject("A screenshot is already in progress", "busy"); return
            }
            guard self.isVisible(webView), !webView.isLoading else {
                call.reject("Player view is not ready in the foreground", "unavailable"); return
            }

            let request = Request(call, webView)
            self.pending = request
            let deadline = DispatchWorkItem { [weak request] in
                request?.reject("Screenshot timed out", "timeout")
            }
            request.deadline = deadline
            DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: deadline)

            let config = WKSnapshotConfiguration()
            config.rect = webView.bounds
            // snapshotWidth is in points; account for the destination screen's
            // scale to keep WebKit's native bitmap allocation bounded as well.
            let size = Self.outputSize(webView.bounds.size)
            let screenScale = max(1, webView.window?.screen.scale ?? 1)
            config.snapshotWidth = NSNumber(value: Double(size.width / screenScale))
            // Wait for the current web view updates to reach pixels.
            config.afterScreenUpdates = true
            webView.takeSnapshot(with: config) { [weak self, request] image, error in
                guard let self = self else {
                    request.reject("Screenshot owner was destroyed", "unavailable"); return
                }
                guard self.isCurrent(request) else {
                    self.finish(request, error: "Player view changed during screenshot", code: "unavailable"); return
                }
                guard error == nil, let image = image else {
                    self.finish(request, error: "Player view could not be captured", code: "capture-failed"); return
                }
                self.encoder.async { [weak self, request] in
                    let result = autoreleasepool { Self.encode(image) }
                    DispatchQueue.main.async {
                        guard let self = self else {
                            request.reject("Screenshot owner was destroyed", "unavailable"); return
                        }
                        guard self.isCurrent(request) else {
                            self.finish(request, error: "Player view changed during screenshot", code: "unavailable"); return
                        }
                        guard let result = result else {
                            self.finish(request, error: "Screenshot could not fit the image limit", code: "capture-failed"); return
                        }
                        request.deadline?.cancel()
                        request.deadline = nil
                        let call = request.call
                        request.call = nil
                        self.pending = nil
                        call?.resolve([
                            "image": result.data.base64EncodedString(),
                            "width": result.width,
                            "height": result.height,
                            "source": "player-view",
                            "video": "excluded",
                        ])
                    }
                }
            }
        }
    }

    private func isVisible(_ view: WKWebView) -> Bool {
        guard UIApplication.shared.applicationState == .active,
              let window = view.window, window.isKeyWindow, !window.isHidden,
              window.windowScene?.activationState == .foregroundActive,
              view.bounds.width.isFinite, view.bounds.height.isFinite,
              view.bounds.width > 0, view.bounds.height > 0 else { return false }
        // Reject a hidden web view or a view behind a native modal. Capturing it
        // would misrepresent the display and may reveal obscured configuration.
        if bridge?.viewController?.presentedViewController != nil { return false }
        var ancestor: UIView? = view
        while let current = ancestor {
            if current.isHidden || current.alpha <= 0 { return false }
            ancestor = current.superview
        }
        return true
    }

    private func isCurrent(_ request: Request) -> Bool {
        guard pending === request, request.call != nil,
              let view = request.webView, bridge?.webView === view,
              view.window === request.window, view.url == request.url,
              !view.isLoading, isVisible(view) else { return false }
        return true
    }

    private func finish(_ request: Request, error: String, code: String) {
        request.reject(error, code)
        if pending === request { pending = nil }
    }

    private static func outputSize(_ size: CGSize) -> CGSize {
        let scale = min(1, CGFloat(maxWidth) / size.width, CGFloat(maxHeight) / size.height)
        return CGSize(width: max(1, floor(size.width * scale)), height: max(1, floor(size.height * scale)))
    }

    private struct Encoded {
        let data: Data
        let width: Int
        let height: Int
    }

    private static func encode(_ image: UIImage) -> Encoded? {
        guard image.size.width.isFinite, image.size.height.isFinite,
              image.size.width > 0, image.size.height > 0 else { return nil }
        var size = outputSize(CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        format.preferredRange = .standard
        // At most 11 bounded resizes (1280x720 -> 1x1); never encode an
        // arbitrary screen-size bitmap or return oversized base64 to JavaScript.
        while true {
            let data: Data? = autoreleasepool {
                UIGraphicsImageRenderer(size: size, format: format).image { context in
                    UIColor.black.setFill()
                    context.fill(CGRect(origin: .zero, size: size))
                    image.draw(in: CGRect(origin: .zero, size: size))
                }.pngData()
            }
            guard let data = data else { return nil }
            if data.count <= maxBytes {
                return Encoded(data: data, width: Int(size.width), height: Int(size.height))
            }
            if size.width <= 1 && size.height <= 1 { return nil }
            size = CGSize(width: max(1, floor(size.width / 2)), height: max(1, floor(size.height / 2)))
        }
    }
}

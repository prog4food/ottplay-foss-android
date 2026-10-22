#!/usr/bin/env python3
"""Compile the shipped Swift looping PiP helpers with small media doubles.

No simulator, mobile build or actual decoder is used. Foundation parses real
URLs; media doubles observe URL passthrough, loop readiness and teardown only.
"""

import pathlib
import subprocess
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "ios/App/App/Plugins/MobileNativeMedia.swift"


def method(source, signature):
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


STUBS = r'''
import Foundation
enum ObserveOption { case initial, new }
class ObservationToken {
    let cancel: () -> Void
    init(_ cancel: @escaping () -> Void) { self.cancel = cancel }
    deinit { cancel() }
}
enum ItemStatus { case unknown, readyToPlay, failed }
class AVPlayerItem {
    let url: URL
    var status = ItemStatus.unknown { didSet { Array(observers.values).forEach { $0(self, ()) } } }
    var error: NSError?
    var observers: [UUID: (AVPlayerItem, Void) -> Void] = [:]
    init(url: URL) { self.url = url }
    func observe(_ keyPath: KeyPath<AVPlayerItem, ItemStatus>, options: [ObserveOption],
                 changeHandler: @escaping (AVPlayerItem, Void) -> Void) -> ObservationToken {
        let id = UUID()
        observers[id] = changeHandler
        if options.contains(.initial) { changeHandler(self, ()) }
        return ObservationToken { [weak self] in self?.observers[id] = nil }
    }
}
class AVPlayer {
    let url: URL?
    var paused = false
    var itemCleared = false
    var currentItem: AVPlayerItem? { didSet { Array(observers.values).forEach { $0(self, ()) } } }
    var observers: [UUID: (AVPlayer, Void) -> Void] = [:]
    init(url: URL? = nil) { self.url = url }
    func play() { paused = false }
    func pause() { paused = true }
    func replaceCurrentItem(with item: AVPlayerItem?) { itemCleared = item == nil; currentItem = item }
    func observe(_ keyPath: KeyPath<AVPlayer, AVPlayerItem?>, options: [ObserveOption],
                 changeHandler: @escaping (AVPlayer, Void) -> Void) -> ObservationToken {
        let id = UUID()
        observers[id] = changeHandler
        if options.contains(.initial) { changeHandler(self, ()) }
        return ObservationToken { [weak self] in self?.observers[id] = nil }
    }
}
class AVQueuePlayer: AVPlayer {
    var items: [AVPlayerItem] = []
    init() { super.init() }
    func removeAllItems() { items = []; currentItem = nil }
}
class AVPlayerLooper {
    let player: AVQueuePlayer
    let templateItem: AVPlayerItem
    var enabled = true
    init(player: AVQueuePlayer, templateItem: AVPlayerItem) {
        self.player = player
        self.templateItem = templateItem
        // The real looper may not populate currentItem until duration loads.
    }
    func disableLooping() { enabled = false }
}
class PipController {
    var isPictureInPictureActive = true
    var isPictureInPicturePossible = true
    var startRequests = 0
    func startPictureInPicture() { startRequests += 1 }
    func stopPictureInPicture() { isPictureInPictureActive = false }
}
typealias AVPictureInPictureController = PipController
class PipLayer {
    var removed = false
    func removeFromSuperlayer() { removed = true }
}
class PipCall {
    var results: [[String: Any]] = []
    func resolve(_ result: [String: Any]) { results.append(result) }
}
class TestWebView {
    var scripts: [String] = []
    var completions: [(Any?, Error?) -> Void] = []
    func evaluateJavaScript(_ script: String, completionHandler: @escaping (Any?, Error?) -> Void) {
        scripts.append(script); completions.append(completionHandler)
    }
}
class TestBridge { var webView: TestWebView? = TestWebView() }
class Harness {
    var bridge: TestBridge? = TestBridge()
    var pipPlayer: AVPlayer?
    var pipLooper: AVPlayerLooper?
    var pipController: PipController?
    var pipLayer: PipLayer?
    var pipCurrentItemObservation: Any?
    var pipItemObservation: Any?
    var pipPossibleObservation: Any?
    var pendingPipCall: PipCall?
    var pipResolved = false
    var startRequests: Int { pipController?.startRequests ?? 0 }
    private func configurePlaybackSession() -> Bool { true }
    private func drainCallbacks() { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
'''


TESTS = r'''
    func run() {
        NativeWork.shared.setStandby(false)
        let view = bridge!.webView!
        evalVideoJS("retired")
        assert(NativeWork.shared.snapshot["pending"] as! Int == 1)
        NativeWork.shared.setStandby(true)
        NativeWork.shared.setStandby(false)
        drainCallbacks()
        assert(view.scripts.isEmpty && NativeWork.shared.snapshot["pending"] as! Int == 0)
        NativeWork.shared.setStandby(true)
        evalVideoJS("blocked"); drainCallbacks()
        assert(view.scripts.isEmpty)
        NativeWork.shared.setStandby(false)
        evalVideoJS("current"); drainCallbacks()
        assert(view.scripts == ["current"] && NativeWork.shared.snapshot["pending"] as! Int == 1)
        view.completions.removeFirst()(nil, nil)
        assert(NativeWork.shared.snapshot["pending"] as! Int == 0)
        print("PASS iOS system controls: queued command retires across standby/wake; native completion remains pending")
        assert(pipSubtitle("Картинка в картинке") == "Картинка в картинке")
        assert(pipSubtitle("Image dans l’image") == "Image dans l’image")
        assert(pipSubtitle(nil) == "Picture in Picture")
        assert(pipSubtitle("  ") == "Picture in Picture")
        assert(pipSubtitle(String(repeating: "x", count: 513)) == "Picture in Picture")
        let remoteDemo = URL(string: "https://media.example.invalid/demo/pattern.mp4?cache=1#preview")!
        for text in [
            remoteDemo.absoluteString,
            "https://media.example.invalid/clip.mp4",
            "https://provider.example.invalid/channel.m3u8?token=fixture",
            "capacitor://localhost/demo/pattern.mp4",
        ] {
            let input = URL(string: text)!
            let player = makePipPlayer(url: input, loop: false)
            assert(!(player is AVQueuePlayer) && player.url == input && pipLooper == nil)
            pipPlayer = player
            releasePipPlayer()
            assert(player.paused && player.itemCleared)

            pipPlayer = makePipPlayer(url: input, loop: true)
            let queue = pipPlayer as! AVQueuePlayer
            let looper = pipLooper!
            assert(looper.templateItem.url == input, "Caller URL is preserved without a bundled file mapping")
            releasePipPlayer()
            assert(!looper.enabled && queue.paused && pipLooper == nil)
        }
        print("PASS iOS PiP: explicit loop flag, exact remote URL passthrough, no filename-based routing")

        pipPlayer = makePipPlayer(url: remoteDemo, loop: true)
        let queue = pipPlayer as! AVQueuePlayer
        let looper = pipLooper!
        assert(looper.enabled && looper.player === queue && looper.templateItem.url == remoteDemo)
        pipController = PipController()
        queue.play()
        observePipPlayerItem(queue)
        drainCallbacks()
        assert(startRequests == 0 && queue.currentItem == nil)
        let delayedItem = AVPlayerItem(url: remoteDemo)
        queue.items = [delayedItem]
        queue.currentItem = delayedItem
        drainCallbacks()
        assert(controlNativePipPlayer(play: false) && queue.paused)
        NativeWork.shared.setStandby(true)
        assert(!controlNativePipPlayer(play: true) && queue.paused)
        delayedItem.status = .readyToPlay
        drainCallbacks()
        assert(startRequests == 0, "Readiness cannot start PiP during standby")
        NativeWork.shared.setStandby(false)
        delayedItem.status = .readyToPlay
        drainCallbacks()
        assert(startRequests == 1, "Late looper item readiness must reach PiP startup")
        assert(queue.paused, "Readiness must preserve Pause requested while PiP was starting")
        tryStartPip()
        assert(queue.paused, "A subsequent PiP-possible callback must also preserve Pause")
        assert(controlNativePipPlayer(play: true) && !queue.paused)
        tryStartPip()
        assert(!queue.paused, "Explicit Play resumes playback during startup")
        let oldItemCallbacks = Array(delayedItem.observers.values)
        let pending = PipCall()
        pendingPipCall = pending
        let controller = PipController()
        let layer = PipLayer()
        pipController = controller
        pipLayer = layer
        teardownPip(keepCall: false)
        assert(!looper.enabled && queue.paused && queue.items.isEmpty)
        assert(pipPlayer == nil && pipLooper == nil)
        assert(!controlNativePipPlayer(play: true), "Retired native player cannot be resumed")
        assert(!controller.isPictureInPictureActive && layer.removed)
        assert(pending.results.count == 1 && pending.results[0]["ok"] as? Bool == false)
        assert(pendingPipCall == nil && !pipResolved)
        assert(pipCurrentItemObservation == nil && pipItemObservation == nil)
        teardownPip(keepCall: false) // Repeated stop is safe.
        assert(pending.results.count == 1, "Cancelled native play settles exactly once")
        let remoteURL = URL(string: "https://external.invalid/channel.m3u8?token=fixture")!
        pipPlayer = makePipPlayer(url: remoteURL, loop: false)
        let ordinary = pipPlayer!
        assert(!(ordinary is AVQueuePlayer) && ordinary.url == remoteURL && pipLooper == nil)
        delayedItem.status = .failed
        oldItemCallbacks.forEach { $0(delayedItem, ()) }
        drainCallbacks()
        assert(pipPlayer === ordinary && !ordinary.paused, "Retired demo item must not tear down replacement")
        let replacementController = PipController()
        pipController = replacementController
        let replacementCall = PipCall()
        pendingPipCall = replacementCall
        pictureInPictureControllerDidStartPictureInPicture(controller)
        pictureInPictureController(controller, failedToStartPictureInPictureWithError: NSError(domain: "retired", code: 1))
        pictureInPictureControllerDidStopPictureInPicture(controller)
        assert(replacementCall.results.isEmpty && !pipResolved && pipPlayer === ordinary)
        assert(pipController === replacementController, "Retired controller callbacks must preserve the replacement")
        pictureInPictureControllerDidStartPictureInPicture(replacementController)
        pictureInPictureControllerDidStartPictureInPicture(replacementController)
        assert(replacementCall.results.count == 1 && replacementCall.results[0]["ok"] as? Bool == true)
        releasePipPlayer()
        assert(ordinary.paused && ordinary.itemCleared)
        print("PASS iOS PiP: delayed readiness preserves Pause; explicit Play; cancellation, queue release and stale item/controller guards")
    }
}
Harness().run()
'''


def main():
    source = SOURCE.read_text()
    helpers = [
        method(source, "private func pipSubtitle("),
        method(source, "private func makePipPlayer("),
        method(source, "private func releasePipPlayer("),
        method(source, "private func observePipPlayerItem("),
        method(source, "private func controlNativePipPlayer("),
        method(source, "private func evalVideoJS("),
        method(source, "private func tryStartPip("),
        method(source, "private func resolvePipOnce("),
        method(source, "private func teardownPip("),
        method(source, "public func pictureInPictureControllerDidStartPictureInPicture(").replace("public func", "func"),
        method(source, "public func pictureInPictureController(").replace("public func", "func"),
        method(source, "public func pictureInPictureControllerDidStopPictureInPicture(").replace("public func", "func"),
    ]
    play = method(source, "@objc func playPip(")
    teardown = method(source, "private func teardownPip(")
    assert 'let loop = call.getBool("loop", false)' in play
    assert 'let subtitle = pipSubtitle(call.getString("subtitle"))' in play
    assert 'artist: subtitle, rate: 1.0, seekable: false' in play
    assert "self.makePipPlayer(url: url, loop: loop)" in play
    assert "bundledDemoURL" not in source
    assert "bridge.config.appLocation" not in play
    assert "bridge.config.localURL" not in play
    assert "releasePipPlayer()" in teardown
    assert "self.pipPlayer === player" in play, "Retired timeout must not stop a replacement"
    assert "self.pipController === controller" in play
    assert source.count("self.pipController === pictureInPictureController") == 3
    with tempfile.TemporaryDirectory(prefix="ottplay-ios-demo-") as temp:
        temp = pathlib.Path(temp)
        swift = temp / "DemoMediaTests.swift"
        native_work = (ROOT / "ios/App/App/Plugins/NativeBackground.swift").read_text().split("@objc(NativeBackground)", 1)[0].replace("import Capacitor", "")
        swift.write_text(native_work + STUBS + "\n".join(helpers) + TESTS)
        subprocess.run(
            ["swift", "-module-cache-path", str(temp / "module-cache"), str(swift)],
            check=True,
            cwd=temp,
        )
    print("PASS iOS PiP integration: default loop=false, URL passthrough, teardown and stale callback guards")


if __name__ == "__main__":
    main()

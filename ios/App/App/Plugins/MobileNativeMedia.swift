import Capacitor
import UIKit
import AVFoundation
import AVKit
import MediaPlayer
import WebKit

@objc(MobileNativeMedia)
public class MobileNativeMedia: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MobileNativeMediaPlugin"
    public let jsName = "MobileNativeMedia"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playPip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopPip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setFullscreen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "allowSleep", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "preventSleep", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startBackgroundAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pauseBackgroundAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeBackgroundAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopBackgroundAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateBackgroundAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exitApp", returnType: CAPPluginReturnPromise),
    ]

    private var pipController: AVPictureInPictureController?
    private var pipPlayer: AVPlayer?
    private var pipLooper: AVPlayerLooper?
    private var pipLayer: AVPlayerLayer?
    private var pipCurrentItemObservation: NSKeyValueObservation?
    private var pipItemObservation: NSKeyValueObservation?
    private var pipPossibleObservation: NSKeyValueObservation?
    private var pendingPipCall: CAPPluginCall?
    private var pipResolved = false
    private var fullscreenActive = false
    private var remoteCommandsConfigured = false
    private var backgroundAudioActive = false
    private var mediaSeekable = false
    private var artworkURLString: String?
    private var artworkLoadID = 0
    private var artworkTask: URLSessionDataTask?

    /// Shared flag read by MainViewController (avoids Cap bridge plugin-lookup API drift).
    private(set) static var sharedFullscreenActive = false

    /// Read by MainViewController for status-bar / home-indicator chrome.
    var isFullscreenActive: Bool { fullscreenActive }

    private var removeStandbyObserver: (() -> Void)?
    public override func load() {
        removeStandbyObserver = NativeWork.shared.onStandbyAsync { [weak self] done in
            DispatchQueue.main.async { [weak self] in
                defer { done() }
                guard let self else { return }
                self.teardownPip(keepCall: false)
                self.artworkLoadID += 1
                self.artworkTask?.cancel(); self.artworkTask = nil
                self.artworkURLString = nil
                self.backgroundAudioActive = false
                MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            }
        }
        // Configure playback session early so WKWebView HLS/<video> can continue
        // when backgrounded (pairs with Info.plist UIBackgroundModes: audio).
        _ = configurePlaybackSession()
    }

    @objc func exitApp(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // Cap iOS has no Activity.finish; exit(0) matches App.exitApp semantics.
            call.resolve(["ok": true])
            exit(0)
        }
    }

    @objc func getVolume(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setActive(true)
        } catch {
            call.resolve([
                "ok": false,
                "volume": 0,
                "unsupported": true,
            ])
            return
        }

        let vol = Int(round(session.outputVolume * 100))
        call.resolve([
            "ok": true,
            "volume": vol,
        ])
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        let volume = call.getInt("volume", 0)
        let clamped = max(0, min(100, volume))
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setActive(true)
        } catch {
            call.resolve([
                "ok": false,
                "volume": clamped,
                "unsupported": true,
            ])
            return
        }

        // `outputVolume` on iOS is read-only without private APIs.
        // Use MPVolumeView as the only public set path; hide it in a zero-size container.
        let picker = MPVolumeView(frame: CGRect(x: -100, y: -100, width: 0, height: 0))
        picker.showsVolumeSlider = true

        guard let slider = picker.subviews.compactMap({ $0 as? UISlider }).first else {
            call.resolve([
                "ok": false,
                "volume": clamped,
                "unsupported": true,
            ])
            return
        }

        // Post to main run loop so the slider actually drives the system volume.
        DispatchQueue.main.async {
            slider.value = Float(clamped) / 100.0
            call.resolve([
                "ok": true,
                "volume": clamped,
            ])
        }
    }

    private func makePipPlayer(url: URL, loop: Bool) -> AVPlayer {
        if loop {
            let player = AVQueuePlayer()
            pipLooper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
            return player
        }
        return AVPlayer(url: url)
    }

    private func releasePipPlayer() {
        pipLooper?.disableLooping()
        pipLooper = nil
        pipPlayer?.pause()
        if let queue = pipPlayer as? AVQueuePlayer {
            queue.removeAllItems()
        } else {
            pipPlayer?.replaceCurrentItem(with: nil)
        }
        pipPlayer = nil
    }

    private func observePipPlayerItem(_ player: AVPlayer) {
        // AVPlayerLooper can populate its queue after loading the template duration.
        pipCurrentItemObservation = player.observe(\.currentItem, options: [.initial, .new]) {
            [weak self, weak player] _, _ in
            DispatchQueue.main.async { [weak self, weak player] in
                guard let self = self, let player = player, self.pipPlayer === player else { return }
                self.pipItemObservation = player.currentItem?.observe(\.status, options: [.initial, .new]) {
                    [weak self, weak player] item, _ in
                    DispatchQueue.main.async { [weak self, weak player] in
                        guard let self = self, let player = player,
                              self.pipPlayer === player, player.currentItem === item else { return }
                        if item.status == .failed {
                            self.resolvePipOnce([
                                "ok": false,
                                "error": item.error?.localizedDescription ?? "player item failed",
                            ])
                            self.teardownPip(keepCall: true)
                        } else if item.status == .readyToPlay {
                            self.tryStartPip()
                        }
                    }
                }
            }
        }
    }

    private func pipSubtitle(_ value: String?) -> String {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.utf16.count <= 512 else { return "Picture in Picture" }
        return value
    }

    @objc func playPip(_ call: CAPPluginCall) {
        guard !NativeWork.shared.isStandby else { call.reject("Player is in standby", "standby"); return }
        guard let urlString = call.getString("url"), !urlString.isEmpty else {
            call.resolve([
                "ok": false,
                "error": "missing url",
            ])
            return
        }

        guard let url = URL(string: urlString) else {
            call.resolve([
                "ok": false,
                "error": "invalid url",
            ])
            return
        }

        guard AVPictureInPictureController.isPictureInPictureSupported() else {
            call.resolve([
                "ok": false,
                "unsupported": true,
            ])
            return
        }
        let loop = call.getBool("loop", false)
        let subtitle = pipSubtitle(call.getString("subtitle"))

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard !NativeWork.shared.isStandby else { call.reject("Player is in standby", "standby"); return }

            self.teardownPip(keepCall: false)
            self.pendingPipCall = call
            self.pipResolved = false

            guard let bridge = self.bridge else {
                self.resolvePipOnce([
                    "ok": false,
                    "error": "bridge unavailable",
                ])
                return
            }

            _ = self.configurePlaybackSession()

            let container: UIView? =
                bridge.webView ??
                bridge.viewController?.view

            guard let targetView = container else {
                self.resolvePipOnce([
                    "ok": false,
                    "error": "no container view",
                ])
                return
            }

            let player = self.makePipPlayer(url: url, loop: loop)
            self.pipPlayer = player
            let layer = AVPlayerLayer(player: player)

            // Small 16:9 layer in hierarchy (required for AVPictureInPictureController).
            let size = CGSize(width: 160, height: 90)
            layer.frame = CGRect(
                x: max(8, targetView.bounds.width - size.width - 8),
                y: max(8, targetView.bounds.height - size.height - 8),
                width: size.width,
                height: size.height
            )
            layer.videoGravity = .resizeAspect
            layer.isHidden = false
            targetView.layer.addSublayer(layer)

            guard let pipController = AVPictureInPictureController(playerLayer: layer) else {
                layer.removeFromSuperlayer()
                self.resolvePipOnce([
                    "ok": false,
                    "error": "pip controller unavailable",
                ])
                self.teardownPip(keepCall: true)
                return
            }
            pipController.delegate = self
            if #available(iOS 14.0, *) {
                pipController.requiresLinearPlayback = false
            }
            if #available(iOS 14.2, *) {
                pipController.canStartPictureInPictureAutomaticallyFromInline = true
            }

            self.pipLayer = layer
            self.pipController = pipController

            self.configureRemoteCommandsIfNeeded()
            self.updateNowPlaying(title: "OTT-play FOSS", artist: subtitle, rate: 1.0, seekable: false)
            self.backgroundAudioActive = true

            player.play()

            // Observe item readiness + pip-possible; hop to main before Cap/UIKit work.
            self.observePipPlayerItem(player)

            self.pipPossibleObservation = pipController.observe(
                \.isPictureInPicturePossible,
                options: [.initial, .new]
            ) { [weak self] controller, _ in
                DispatchQueue.main.async { [weak self] in
                    guard let self = self, self.pipController === controller else { return }
                    if controller.isPictureInPicturePossible {
                        self.tryStartPip()
                    }
                }
            }

            // Honest timeout — never leave the Cap call hanging, never fake ok:true.
            DispatchQueue.main.asyncAfter(deadline: .now() + 5.0) { [weak self, weak player] in
                guard let self = self, let player = player,
                      self.pipPlayer === player, !self.pipResolved else { return }
                self.resolvePipOnce([
                    "ok": false,
                    "error": "pip not possible",
                ])
                self.teardownPip(keepCall: true)
            }
        }
    }

    @objc func stopPip(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.teardownPip(keepCall: false)
            call.resolve(["ok": true])
        }
    }

    @objc func setFullscreen(_ call: CAPPluginCall) {
        let target = call.getBool("fullscreen", false)
        fullscreenActive = target
        MobileNativeMedia.sharedFullscreenActive = target

        guard let viewController = bridge?.viewController else {
            call.resolve([
                "ok": false,
                "unsupported": true,
            ])
            return
        }

        DispatchQueue.main.async {
            viewController.setNeedsStatusBarAppearanceUpdate()
            if #available(iOS 11.0, *) {
                viewController.setNeedsUpdateOfHomeIndicatorAutoHidden()
            }
            call.resolve(["ok": true])
        }
    }

    @objc func allowSleep(_ call: CAPPluginCall) {
        UIApplication.shared.isIdleTimerDisabled = false
        call.resolve(["ok": true])
    }

    @objc func preventSleep(_ call: CAPPluginCall) {
        UIApplication.shared.isIdleTimerDisabled = true
        call.resolve(["ok": true])
    }

    /// Activate AVAudioSession category `.playback` and publish Now Playing metadata
    /// so WKWebView video audio can continue in background (UIBackgroundModes: audio).
    @objc func startBackgroundAudio(_ call: CAPPluginCall) {
        guard !NativeWork.shared.isStandby else { call.reject("Player is in standby", "standby"); return }
        applyBackgroundAudio(call: call, rate: 1.0, requireSession: true)
    }

    @objc func pauseBackgroundAudio(_ call: CAPPluginCall) {
        if backgroundAudioActive {
            let info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
            var next = info
            next[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
            MPNowPlayingInfoCenter.default().nowPlayingInfo = next
        }
        call.resolve(["ok": true])
    }

    @objc func resumeBackgroundAudio(_ call: CAPPluginCall) {
        guard !NativeWork.shared.isStandby else { call.reject("Player is in standby", "standby"); return }
        applyBackgroundAudio(call: call, rate: 1.0, requireSession: true)
    }

    @objc func updateBackgroundAudio(_ call: CAPPluginCall) {
        // Refresh metadata/timeline without requiring a new audio session.
        guard backgroundAudioActive else { call.resolve(["ok": true]); return }
        let rate = MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate] as? Double ?? 0.0
        applyBackgroundAudio(call: call, rate: rate, requireSession: false)
    }

    @objc func stopBackgroundAudio(_ call: CAPPluginCall) {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        backgroundAudioActive = false
        mediaSeekable = false
        artworkURLString = nil
        artworkLoadID += 1
        artworkTask?.cancel()
        artworkTask = nil
        setSeekCommandEnabled(false)
        // Keep session category as playback for the next channel; do not deactivate
        // aggressively (other Cap audio paths may still need the session).
        call.resolve(["ok": true])
    }

    private func applyBackgroundAudio(call: CAPPluginCall, rate: Double, requireSession: Bool) {
        let title = call.getString("title") ?? "OTT-play FOSS"
        let artist = call.getString("artist") ?? "Now playing"
        let artworkUrl = call.getString("artworkUrl")
        let durationSec = call.getDouble("durationSec")
        let positionSec = call.getDouble("positionSec")
        let seekable = call.getBool("seekable") ?? false

        if requireSession {
            guard configurePlaybackSession() else {
                call.resolve([
                    "ok": false,
                    "error": "AVAudioSession setCategory/setActive failed",
                ])
                return
            }
        } else if !backgroundAudioActive {
            call.resolve(["ok": true])
            return
        }

        configureRemoteCommandsIfNeeded()
        mediaSeekable = seekable
        setSeekCommandEnabled(seekable)
        backgroundAudioActive = true
        updateNowPlaying(
            title: title,
            artist: artist,
            rate: rate,
            durationSec: durationSec,
            positionSec: positionSec,
            seekable: seekable,
            artworkUrl: artworkUrl
        )
        backgroundAudioActive = true
        call.resolve(["ok": true])
    }

    private func configurePlaybackSession() -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playback,
                mode: .moviePlayback,
                options: [.allowAirPlay, .allowBluetoothA2DP]
            )
            try session.setActive(true, options: [])
            return true
        } catch {
            return false
        }
    }

    private func updateNowPlaying(
        title: String,
        artist: String,
        rate: Double,
        durationSec: Double? = nil,
        positionSec: Double? = nil,
        seekable: Bool = false,
        artworkUrl: String? = nil
    ) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: artist,
            MPNowPlayingInfoPropertyPlaybackRate: rate,
        ]
        // Live IPTV: do not advertise a scrubbable timeline.
        if seekable, let durationSec, durationSec.isFinite, durationSec > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = durationSec
            if let positionSec, positionSec.isFinite, positionSec >= 0 {
                info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = positionSec
            }
        }
        // Preserve prior artwork while a new fetch is in flight.
        if let existing = MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyArtwork] {
            info[MPMediaItemPropertyArtwork] = existing
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        maybeLoadArtwork(artworkUrl)
    }

    private func maybeLoadArtwork(_ artworkUrl: String?) {
        guard !NativeWork.shared.isStandby else { return }
        guard let artworkUrl else { return }
        if artworkUrl.isEmpty {
            artworkLoadID += 1
            artworkTask?.cancel(); artworkTask = nil
            artworkURLString = nil
            var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
            info.removeValue(forKey: MPMediaItemPropertyArtwork)
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            return
        }
        if artworkURLString == artworkUrl {
            return
        }
        artworkURLString = artworkUrl
        artworkLoadID += 1
        artworkTask?.cancel(); artworkTask = nil
        let loadID = artworkLoadID

        if artworkUrl.hasPrefix("data:"), let comma = artworkUrl.firstIndex(of: ",") {
            guard let ticket = NativeWork.shared.begin() else { return }
            defer { ticket.finish() }
            guard artworkUrl.utf8.count <= 2 * 1024 * 1024 * 4 / 3 + 1024 else { return }
            let b64 = String(artworkUrl[artworkUrl.index(after: comma)...])
            if let data = Data(base64Encoded: b64), data.count <= 2 * 1024 * 1024, let image = UIImage(data: data) {
                guard (try? ticket.check()) != nil else { return }
                applyArtwork(image, loadID: loadID)
            }
            return
        }
        guard let url = URL(string: artworkUrl) else { return }
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
        guard let ticket = NativeWork.shared.begin() else { return }
        let task = URLSession.shared.dataTask(with: URLRequest(url: url, timeoutInterval: 10)) { [weak self] data, _, _ in
            guard (try? ticket.check()) != nil,
                  let data, data.count <= 2 * 1024 * 1024, let image = UIImage(data: data) else { ticket.finish(); return }
            DispatchQueue.main.async { [weak self] in
                defer { ticket.finish() }
                guard (try? ticket.check()) != nil else { return }
                self?.applyArtwork(image, loadID: loadID)
            }
        }
        ticket.cancelWith { task.cancel() }
        artworkTask = task
        task.resume()
    }

    private func applyArtwork(_ image: UIImage, loadID: Int) {
        guard backgroundAudioActive, artworkLoadID == loadID else { return }
        let art = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPMediaItemPropertyArtwork] = art
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func setSeekCommandEnabled(_ enabled: Bool) {
        let center = MPRemoteCommandCenter.shared()
        center.changePlaybackPositionCommand.isEnabled = enabled
    }

    /// Lock-screen / Control Center remote commands.
    /// When native AVPlayer PiP (#316) is active, drive `pipPlayer`.
    /// Otherwise drive WKWebView `<video>` via evaluateJavaScript (in-app web path).
    private func configureRemoteCommandsIfNeeded() {
        if remoteCommandsConfigured { return }
        remoteCommandsConfigured = true
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.togglePlayPauseCommand.isEnabled = true
        center.stopCommand.isEnabled = true
        center.nextTrackCommand.isEnabled = true
        center.previousTrackCommand.isEnabled = true

        center.playCommand.addTarget { [weak self] _ in
            guard !NativeWork.shared.isStandby else { return .noActionableNowPlayingItem }
            guard let self = self else { return .commandFailed }
            if self.controlNativePipPlayer(play: true) {
                self.updateNowPlayingRate(1.0)
                return .success
            }
            self.evalVideoJS("if(typeof window.stbResume==='function')window.stbResume();else if(window.stbContinue&&window.stbIsPlaying&&!window.stbIsPlaying())window.stbContinue(); true;")
            self.updateNowPlayingRate(1.0)
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.controlNativePipPlayer(play: false) {
                self.updateNowPlayingRate(0.0)
                return .success
            }
            self.evalVideoJS("if(window.stbPause)window.stbPause(); true;")
            self.updateNowPlayingRate(0.0)
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard !NativeWork.shared.isStandby else { return .noActionableNowPlayingItem }
            guard let self = self else { return .commandFailed }
            if let player = self.pipPlayer, self.isNativePipControllable {
                let shouldPlay = player.rate == 0
                _ = self.controlNativePipPlayer(play: shouldPlay)
                self.updateNowPlayingRate(shouldPlay ? 1.0 : 0.0)
                return .success
            }
            self.evalVideoJS(
                "if(window.stbIsPlaying&&window.stbPause&&window.stbContinue){if(window.stbIsPlaying())window.stbPause();else window.stbContinue();} true;"
            )
            return .success
        }
        center.stopCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.isNativePipControllable {
                self.teardownPip(keepCall: false)
                MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
                self.backgroundAudioActive = false
                return .success
            }
            self.evalVideoJS(
                "if(window.stbStop)window.stbStop(); true;"
            )
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            self.backgroundAudioActive = false
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            guard !NativeWork.shared.isStandby else { return .noActionableNowPlayingItem }
            self?.evalVideoJS("(function(){if(window._doKey&&window.keys)window._doKey(window.keys.NEXT);})();")
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            guard !NativeWork.shared.isStandby else { return .noActionableNowPlayingItem }
            self?.evalVideoJS("(function(){if(window._doKey&&window.keys)window._doKey(window.keys.PREV);})();")
            return .success
        }
        // Live: leave disabled. VOD/archive: scrub via <video>/stbSetPosTime.
        center.changePlaybackPositionCommand.isEnabled = false
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard !NativeWork.shared.isStandby else { return .noActionableNowPlayingItem }
            guard let self = self else { return .commandFailed }
            guard self.mediaSeekable else {
                // Honest live behavior: do not claim success.
                return .noActionableNowPlayingItem
            }
            guard let seekEvent = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            let t = seekEvent.positionTime
            guard t.isFinite, t >= 0 else { return .commandFailed }
            if let player = self.pipPlayer, self.isNativePipControllable {
                let time = CMTime(seconds: t, preferredTimescale: 600)
                player.seek(to: time)
                self.updateNowPlayingRate(player.rate == 0 ? 0.0 : 1.0)
                return .success
            }
            let js = String(
                format: "(function(){var t=%f; if(window.stbSetPosTime){window.stbSetPosTime(t);} else {var v=document.querySelector('video'); if(v && isFinite(v.duration)){v.currentTime=t;}} })();",
                t
            )
            self.evalVideoJS(js)
            var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = t
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            return .success
        }
    }

    /// True when native AVPlayer PiP resources exist (active or starting).
    private var isNativePipControllable: Bool {
        pipPlayer != nil
    }

    /// Play/pause the native PiP AVPlayer when present. Returns false if web path should be used.
    @discardableResult
    private func controlNativePipPlayer(play: Bool) -> Bool {
        guard !play || !NativeWork.shared.isStandby else { return false }
        guard let player = pipPlayer else { return false }
        if play {
            player.play()
        } else {
            player.pause()
        }
        return true
    }

    private func updateNowPlayingRate(_ rate: Double) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyPlaybackRate] = rate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func evalVideoJS(_ script: String) {
        guard let ticket = NativeWork.shared.begin() else { return }
        DispatchQueue.main.async { [weak self] in
            guard (try? ticket.check()) != nil, let webView = self?.bridge?.webView else { ticket.finish(); return }
            webView.evaluateJavaScript(script) { _, _ in ticket.finish() }
        }
    }

    private func tryStartPip() {
        guard !NativeWork.shared.isStandby else { return }
        guard !pipResolved else { return }
        guard let controller = pipController, controller.isPictureInPicturePossible else { return }
        guard let player = pipPlayer, player.currentItem?.status == .readyToPlay else { return }

        _ = configurePlaybackSession()
        // playPip already requested playback. Readiness must preserve a later
        // Pause from the lock screen or Control Center while startup is pending.
        // Do not resolve ok:true here — wait for didStart / failedToStart / timeout.
        controller.startPictureInPicture()
    }

    private func resolvePipOnce(_ result: [String: Any]) {
        guard !pipResolved else { return }
        pipResolved = true
        pendingPipCall?.resolve(result)
        pendingPipCall = nil
        pipCurrentItemObservation = nil
        pipItemObservation = nil
        pipPossibleObservation = nil
    }

    /// Tear down native PiP resources. When `keepCall` is true, leave pending resolve alone
    /// (caller already resolved or will resolve).
    private func teardownPip(keepCall: Bool) {
        if !keepCall, pendingPipCall != nil {
            resolvePipOnce(["ok": false, "error": "PiP playback cancelled"])
        }
        pipCurrentItemObservation = nil
        pipItemObservation = nil
        pipPossibleObservation = nil
        if pipController?.isPictureInPictureActive == true {
            pipController?.stopPictureInPicture()
        }
        releasePipPlayer()
        pipLayer?.removeFromSuperlayer()
        pipController = nil
        pipLayer = nil
        if !keepCall {
            pendingPipCall = nil
            pipResolved = false
        }
    }

    deinit {
        removeStandbyObserver?()
        artworkTask?.cancel()
        if backgroundAudioActive { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }
        teardownPip(keepCall: false)
    }
}

extension MobileNativeMedia: AVPictureInPictureControllerDelegate {
    public func pictureInPictureControllerDidStartPictureInPicture(
        _ pictureInPictureController: AVPictureInPictureController
    ) {
        guard self.pipController === pictureInPictureController else { return }
        resolvePipOnce(["ok": true])
    }

    public func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        failedToStartPictureInPictureWithError error: Error
    ) {
        guard self.pipController === pictureInPictureController else { return }
        resolvePipOnce([
            "ok": false,
            "error": error.localizedDescription,
        ])
        teardownPip(keepCall: true)
    }

    public func pictureInPictureControllerDidStopPictureInPicture(
        _ pictureInPictureController: AVPictureInPictureController
    ) {
        guard self.pipController === pictureInPictureController else { return }
        teardownPip(keepCall: false)
    }
}

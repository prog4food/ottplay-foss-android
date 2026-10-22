#!/usr/bin/env python3
"""Execute production Kotlin service lifecycle and Swift Now Playing methods.

Small dispatch/decoder doubles let stopped and stale callbacks run deliberately.
This is deterministic source-derived behavior verification, not an Android/iOS
OS, background entitlement, notification renderer or decoder runtime test.
"""

import argparse
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from native_standby_work_cases import KOTLIN_SOURCE, run_native_work

ROOT = Path(__file__).resolve().parents[1]
ANDROID = (ROOT / "android/app/src/main/java/play/ott/foss/MediaPlaybackService.kt").read_text()
IOS = (ROOT / "ios/App/App/Plugins/MobileNativeMedia.swift").read_text()


def method(source, signature):
    begin = source.index(signature)
    end = source.index("{", begin) + 1
    depth = 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[begin:end]


KOTLIN = r"""
import play.ott.foss.NativeWork
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.FutureTask
import java.util.concurrent.Future
class Intent(val action: String?, val extras: Map<String, Any> = emptyMap()) {
    fun hasExtra(key: String) = extras.containsKey(key)
    fun getLongExtra(key: String, fallback: Long) = extras[key] as? Long ?: fallback
    fun getBooleanExtra(key: String, fallback: Boolean) = extras[key] as? Boolean ?: fallback
    fun getStringExtra(key: String) = extras[key] as? String
}
class WebView
class Bitmap(val name: String)
class Connection { var closed = false; fun disconnect() { closed = true } }
class Executor { val tasks = mutableListOf<FutureTask<Unit>>(); fun execute(task: FutureTask<Unit>) { tasks.add(task) } }
class Handler {
    val callbacks = mutableListOf<() -> Unit>()
    fun post(block: () -> Unit) { callbacks.add(block) }
    fun removeCallbacksAndMessages(token: Any?) { callbacks.clear() }
}
class NotificationManager { var notices = 0; var cancels = 0; fun notify(id: Int, text: String) { notices++ }; fun cancel(id: Int) { cancels++ } }
class Session { var isActive = true }
class MediaPlaybackService {
    val START_NOT_STICKY = 2; val START_STICKY = 1; val NOTIFICATION_SERVICE = "notification"
    private var stopped = false
    private var playbackAllowed = false
    private val playbackGeneration = AtomicLong()
    private var webViewRef: WeakReference<WebView>? = null
    private var serviceRef = WeakReference(this)
    private val artworkGeneration = AtomicLong()
    private val mainHandler = Handler()
    private val artworkExecutor = Executor()
    private var artworkTask: Future<*>? = null
    private var artworkConnection: Connection? = null
    private var artworkBitmap: Bitmap? = null
    private var artworkUrl: String? = null
    private var playing = false
    private var title = ""; private var artist = ""; private var seekable = false
    private var durationMs = -1L; private var positionMs = 0L
    private var mediaSession: Session? = Session()
    private val manager = NotificationManager()
    private var foregrounds = 0; private var stops = 0; private var stateUpdates = 0
    private var playCalls = 0; private var pauseCalls = 0; private var stopCalls = 0
    private fun getSystemService(name: String): Any = manager
    private fun buildNotification() = title
    private fun promoteForeground() { if (canControl()) foregrounds++ }
    private fun updatePlaybackState() { if (canControl()) stateUpdates++ }
    private fun stopForegroundCompat() {}
    private fun stopSelf() { stops++ }
    private fun drivePlay() { playCalls++ }
    private fun drivePause() { pauseCalls++ }
    private fun driveStop() { stopCalls++ }
    private fun driveNext() {}
    private fun drivePrev() {}
    private fun decodeArtwork(url: String, ticket: NativeWork.Ticket): Bitmap { ticket.check(); return Bitmap(url) }
    private fun canControl(): Boolean = !stopped && isPlaybackAllowed()
    fun currentGeneration(): Long = playbackGeneration.get()
    fun isPlaybackAllowed() = playbackAllowed && webViewRef?.get() != null
    fun run() {
        val owner = WebView()
        allowPlayback(owner)
        check(onStartCommand(Intent(ACTION_START), 0, 1) == START_NOT_STICKY)
        check(foregrounds == 1 && playing)
        onStartCommand(Intent(ACTION_PAUSE, mapOf(EXTRA_SESSION_ONLY to true)), 0, 2)
        check(!playing && pauseCalls == 0 && canControl())
        onStartCommand(Intent(ACTION_PLAY), 0, 3)
        check(playing && playCalls == 1)
        // A queued bitmap is held independently of Handler cancellation to model
        // a callback already obtained by the main loop when Stop runs.
        loadArtworkAsync("old")
        artworkExecutor.tasks.last().run()
        val late = mainHandler.callbacks.last()
        onStartCommand(Intent(ACTION_STOP, mapOf(EXTRA_SESSION_ONLY to true)), 0, 4)
        val notices = manager.notices; val states = stateUpdates
        late()
        check(manager.notices == notices && stateUpdates == states && artworkBitmap == null)
        check(!isPlaybackAllowed() && mainHandler.callbacks.isEmpty() && stops > 0)
        onStartCommand(Intent(ACTION_UPDATE), 0, 5)
        check(manager.notices == notices && !isPlaybackAllowed())
        // Stopped predecessor requests cannot tear down a newly started session.
        val oldEpoch = currentGeneration()
        allowPlayback(owner)
        onStartCommand(Intent(ACTION_START, mapOf(EXTRA_GENERATION to currentGeneration())), 0, 6)
        val activeStops = stops
        onStartCommand(Intent(ACTION_STOP, mapOf(EXTRA_GENERATION to oldEpoch)), 0, 7)
        check(stops == activeStops && canControl())
        loadArtworkAsync("A"); artworkExecutor.tasks.last().run()
        val oldArt = mainHandler.callbacks.last()
        loadArtworkAsync("B"); artworkExecutor.tasks.last().run()
        mainHandler.callbacks.last()(); oldArt()
        check(artworkBitmap?.name == "B")
        loadArtworkAsync("decoder-still-running")
        val inFlight = artworkExecutor.tasks.last()
        retirePlayback(); inFlight.run()
        check(mainHandler.callbacks.isEmpty() && inFlight.isCancelled)
        allowPlayback(owner)
        onStartCommand(null, 0, 8)
        check(!isPlaybackAllowed())
        val newOwner = WebView(); allowPlayback(newOwner)
        check(!clearWebView(owner) && isPlaybackAllowed())
        check(clearWebView(newOwner) && !isPlaybackAllowed())
        val before = foregrounds
        NativeWork.setStandby(true)
        onStartCommand(Intent(ACTION_START), 0, 9)
        check(foregrounds == before && !canControl())
        NativeWork.setStandby(false)
        onStartCommand(Intent(ACTION_START), 0, 9)
        check(foregrounds == before && !canControl())
        println("PASS Android service: nonsticky/no-backend/null-intent; pause/resume; old command epochs; stop and late/current artwork; owner replacement/destroy")
    }
"""
functions = [
    "fun allowPlayback(",
    "fun retirePlayback(",
    "fun bindWebView(",
    "fun clearWebView(",
    "private fun retireSession(",
    "override fun onStartCommand(",
    "private fun applyMetaFromIntent(",
    "private fun loadArtworkAsync(",
    "private fun updateNotification(",
    "private fun stopSelfSafe(",
]
constants = "\n".join(
    re.findall(r"^\s*(?:(?:private )?const val (?:ACTION_\w+|EXTRA_\w+|NOTIFICATION_ID) = .*)$", ANDROID, re.MULTILINE)
)
KOTLIN += (
    constants.replace("const val", "val")
    + "\n"
    + "\n".join(method(ANDROID, name).replace("override fun", "fun", 1) if name.startswith("override ") else method(ANDROID, name) for name in functions)
)
KOTLIN += "\n}\nfun main() { MediaPlaybackService().run() }\n"

SWIFT = r"""
import Foundation
let MPMediaItemPropertyArtwork = "artwork"
let MPNowPlayingInfoPropertyPlaybackRate = "rate"
class UIImage { let size = 1 }
class MPMediaItemArtwork { init(boundsSize: Int, requestHandler: (Int) -> UIImage) {} }
class MPNowPlayingInfoCenter {
    static let center = MPNowPlayingInfoCenter()
    static func `default`() -> MPNowPlayingInfoCenter { center }
    var nowPlayingInfo: [String: Any]?
}
class CAPPluginCall { func resolve(_ data: [String: Any]) {} }
class Task { var canceled = false; func cancel() { canceled = true } }
class Harness {
    var artworkLoadID = 1
    var artworkTask: Task?
    var artworkURLString: String?
    var backgroundAudioActive = true
    var mediaSeekable = true
    var seekEnabled = true
    var metadataRequests = 0
    var lastRate = -1.0
    func setSeekCommandEnabled(_ value: Bool) { seekEnabled = value }
    func applyBackgroundAudio(call: CAPPluginCall, rate: Double, requireSession: Bool) { metadataRequests += 1; lastRate = rate }
"""
SWIFT += "\n".join(
    method(IOS, name).replace("@objc ", "")
    for name in ["@objc func stopBackgroundAudio(", "@objc func updateBackgroundAudio(", "private func applyArtwork("]
)
SWIFT += r"""
    func run() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPNowPlayingInfoPropertyPlaybackRate: 0.0]
        updateBackgroundAudio(CAPPluginCall())
        assert(metadataRequests == 1 && lastRate == 0.0, "Metadata must preserve Pause")
        let task = Task(); artworkTask = task
        let oldID = artworkLoadID
        stopBackgroundAudio(CAPPluginCall())
        assert(task.canceled && artworkTask == nil && !backgroundAudioActive && !seekEnabled)
        applyArtwork(UIImage(), loadID: oldID)
        updateBackgroundAudio(CAPPluginCall())
        assert(MPNowPlayingInfoCenter.default().nowPlayingInfo == nil && metadataRequests == 1)
        backgroundAudioActive = true
        applyArtwork(UIImage(), loadID: oldID)
        assert(MPNowPlayingInfoCenter.default().nowPlayingInfo == nil)
        applyArtwork(UIImage(), loadID: artworkLoadID)
        assert(MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyArtwork] != nil)
        print("PASS iOS Now Playing: pause metadata preserves rate; stop cancels/invalidate artwork; stale callbacks/metadata cannot reactivate; current artwork accepted")
    }
}
Harness().run()
"""
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--platform", choices=["android", "ios", "all"], default="all")
platform = parser.parse_args().platform
required = (["kotlinc", "java"] if platform in ["android", "all"] else []) + (
    ["swiftc"] if platform in ["ios", "all"] else []
)
for compiler in required:
    if not shutil.which(compiler):
        raise SystemExit(f"Required native lifecycle test tool is missing: {compiler}")
with tempfile.TemporaryDirectory(prefix="ott-native-media-") as directory:
    temp = Path(directory)
    if platform in ["android", "all"]:
        (temp / "Main.kt").write_text(KOTLIN)
        java = str(Path(os.environ["JAVA_HOME"]) / "bin/java") if os.environ.get("JAVA_HOME") else "java"
        subprocess.run(
            ["kotlinc", str(KOTLIN_SOURCE), str(temp / "Main.kt"), "-include-runtime", "-d", str(temp / "media.jar")], check=True
        )
        subprocess.run([java, "-jar", str(temp / "media.jar")], check=True)
        run_native_work("android", temp, java)
    if platform in ["ios", "all"]:
        (temp / "main.swift").write_text(SWIFT)
        subprocess.run(
            [
                "swiftc",
                "-module-cache-path",
                str(temp / "module-cache"),
                "-swift-version",
                "5",
                str(temp / "main.swift"),
                "-o",
                str(temp / "media"),
            ],
            check=True,
        )
        subprocess.run([str(temp / "media")], check=True)
        run_native_work("ios", temp)

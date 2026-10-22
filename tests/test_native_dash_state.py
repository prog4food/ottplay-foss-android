#!/usr/bin/env python3
"""Compile the actual DASH state/seek methods with a minimal Media3/Capacitor harness.
Requires kotlinc and java. No Android SDK, emulator or Gradle build is needed.
"""
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
source = (ROOT / 'android/app/src/main/java/play/ott/foss/DashExoPlayerPlugin.kt').read_text()
start = source.index('    @PluginMethod\n    fun getPlaybackState(')
end = source.index('    @PluginMethod\n    fun stopDash(', start)
methods = source[start:end]
assert 'fun seekDash(' in methods
harness = r'''
annotation class PluginMethod
class JSObject : HashMap<String, Any?>()
class PluginCall(val position: Double? = null) {
    var result: JSObject? = null
    fun getDouble(key: String): Double? = position
    fun resolve(value: JSObject) { check(result == null); result = value }
}
object Player { const val STATE_ENDED = 4 }
class TestPlayer {
    var currentPosition = 12500L
    var duration = 120000L
    var isPlaying = true
    var playbackState = 3
    var lastSeek = -1L
    fun seekTo(value: Long) { lastSeek = value }
}
class TestActivity {
    val pending = mutableListOf<() -> Unit>()
    fun runOnUiThread(action: () -> Unit) { pending.add(action) }
    fun flush() { val batch = pending.toList(); pending.clear(); batch.forEach { it() } }
}
class Harness {
    var activity: TestActivity? = TestActivity()
    var player: TestPlayer? = TestPlayer()
METHODS
}
fun main() {
    val h = Harness()
    val state = PluginCall()
    h.getPlaybackState(state)
    check(state.result == null) // Reads are serialized onto the player thread.
    h.activity!!.flush()
    check(state.result!!["position"] == 12.5)
    check(state.result!!["duration"] == 120.0)
    check(state.result!!["playing"] == true)
    check(state.result!!["ended"] == false)
    h.player!!.duration = Long.MIN_VALUE + 1
    h.player!!.playbackState = Player.STATE_ENDED
    val live = PluginCall(); h.getPlaybackState(live); h.activity!!.flush()
    check(live.result!!["duration"] == 0.0 && live.result!!["ended"] == true)
    for ((position, millis) in listOf(3.125 to 3125L, -5.0 to 0L, 200.0 to 120000L)) {
        h.player!!.duration = 120000L
        val seek = PluginCall(position); h.seekDash(seek)
        check(seek.result == null)
        h.activity!!.flush()
        check(seek.result!!["ok"] == true && h.player!!.lastSeek == millis)
    }
    for (position in listOf(null, Double.NaN, Double.POSITIVE_INFINITY)) {
        val invalid = PluginCall(position); h.seekDash(invalid)
        check(invalid.result!!["ok"] == false && h.activity!!.pending.isEmpty())
    }
    // A stop queued ahead of the UI-thread read/seek must not use a released player.
    val stale = PluginCall(2.0); h.seekDash(stale); h.player = null; h.activity!!.flush()
    check(stale.result!!["ok"] == false)
    val absent = PluginCall(); h.getPlaybackState(absent); h.activity!!.flush()
    check(absent.result!!["ok"] == false && absent.result!!["position"] == 0.0)
    h.activity = null
    val noActivity = PluginCall(); h.getPlaybackState(noActivity)
    check(noActivity.result!!["ok"] == false)
    val noActivitySeek = PluginCall(2.0); h.seekDash(noActivitySeek)
    check(noActivitySeek.result!!["ok"] == false)
    println("PASS native DASH methods: seconds, unknown duration, ended, bounded seek, UI-thread ownership and invalid/unavailable states")
}
'''.replace('METHODS', methods)
with tempfile.TemporaryDirectory(prefix='ottplay-native-dash-') as directory:
    temp = pathlib.Path(directory)
    (temp/'DashState.kt').write_text(harness)
    subprocess.run(['kotlinc', 'DashState.kt', '-nowarn', '-include-runtime', '-d', 'state.jar'], cwd=temp, check=True)
    subprocess.run(['java', '-jar', 'state.jar'], cwd=temp, check=True)

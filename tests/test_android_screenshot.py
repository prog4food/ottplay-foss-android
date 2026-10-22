#!/usr/bin/env python3
"""Compile the compatible Capacitor screenshot bridge against Android API 36,
then execute lifecycle/security/resource tests with controlled platform callbacks.

Requires kotlinc, Java and ANDROID_SDK_ROOT (or ANDROID_HOME). This repository's
Android sources are archived bridge fixtures, not a buildable Android application.
No device, Gradle sync, screenshot or SDK modification is performed.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "android/app/src/main/java/play/ott/foss/RemoteScreenshotPlugin.kt"
SDK = Path(os.environ.get("ANDROID_SDK_ROOT", os.environ.get("ANDROID_HOME", "/opt/homebrew/share/android-commandlinetools")))
ANDROID_JAR = SDK / "platforms/android-36/android.jar"
KOTLINC = shutil.which("kotlinc")
assert KOTLINC, "kotlinc is required"
assert ANDROID_JAR.is_file(), ANDROID_JAR

CAPACITOR = r'''
package com.getcapacitor
import android.app.Activity
import android.net.Uri
open class Plugin {
    var activity: Activity? = null
    open fun shouldOverrideLoad(url: Uri): Boolean? = null
    open fun handleOnPause() {}
    open fun handleOnResume() {}
    open fun handleOnDestroy() {}
}
class JSObject {
    val values = HashMap<String, Any?>()
    fun put(key: String, value: Any?): JSObject { values[key] = value; return this }
}
class PluginCall {
    var resolutions = 0
    var rejections = 0
    var code: String? = null
    var result: JSObject? = null
    fun resolve(value: JSObject) { result = value; resolutions++ }
    fun reject(message: String, value: String) { code = value; rejections++ }
}
annotation class PluginMethod
'''
ANNOTATION = '''package com.getcapacitor.annotation
annotation class CapacitorPlugin(val name: String)
'''

PLATFORM = {
    "OS.kt": r'''
package android.os
object Build { object VERSION { var SDK_INT = 36 }; object VERSION_CODES { const val O = 26 } }
class Looper {
    companion object {
        private val main = Looper()
        private val owner = Thread.currentThread()
        fun getMainLooper() = main
        fun myLooper(): Looper? = if (Thread.currentThread() === owner) main else null
    }
}
class Handler(looper: Looper) {
    fun post(action: Runnable): Boolean { synchronized(queue) { queue.add(action) }; return true }
    fun postDelayed(action: Runnable, delay: Long): Boolean { delayed.add(action); return true }
    fun removeCallbacks(action: Runnable) { delayed.remove(action) }
    companion object {
        private val queue = java.util.ArrayDeque<Runnable>()
        private val delayed = ArrayList<Runnable>()
        fun drain() { while (true) { (synchronized(queue) { queue.poll() } ?: break).run() } }
        fun hasPending() = synchronized(queue) { queue.isNotEmpty() }
        fun timeout() { val work = delayed.toList(); delayed.clear(); work.forEach { it.run() } }
    }
}
''',
    "Uri.kt": "package android.net\nclass Uri\n",
    "JSON.kt": "package org.json\nclass JSONObject { companion object { val NULL = Any() } }\n",
    "Base64.kt": r'''
package android.util
object Base64 {
    const val NO_WRAP = 2
    fun encodeToString(value: ByteArray, options: Int) = java.util.Base64.getEncoder().encodeToString(value)
}
''',
    "Activity.kt": r'''
package android.app
import android.view.Window
open class Activity {
    var window = Window()
    var isFinishing = false
    var isDestroyed = false
    var focused = true
    fun hasWindowFocus() = focused
}
''',
    "View.kt": r'''
package android.view
import android.graphics.Bitmap
import android.os.Handler
class View {
    var width = 1920
    var height = 1080
    var isAttachedToWindow = true
    var isShown = true
    var windowVisibility = 0
    fun postOnAnimation(action: Runnable) { if (automaticAnimation) action.run() else frames.add(action) }
    companion object {
        const val VISIBLE = 0
        var automaticAnimation = true
        val frames = java.util.ArrayDeque<Runnable>()
        fun frame() { val current = frames.toList(); frames.clear(); current.forEach { it.run() } }
    }
}
class Window { val decorView = View(); val attributes = WindowManager.LayoutParams() }
class WindowManager { class LayoutParams {
    var flags = 0
    companion object { const val FLAG_SECURE = 0x2000 }
} }
object PixelCopy {
    const val SUCCESS = 0
    var requests = 0
    var fail = false
    var callback: ((Int) -> Unit)? = null
    var target: Bitmap? = null
    fun request(window: Window, bitmap: Bitmap, listener: (Int) -> Unit, handler: Handler) {
        if (fail) throw IllegalArgumentException("Unavailable surface")
        check(callback == null) { "Unbounded native capture requests" }
        requests++; target = bitmap; callback = listener
    }
    fun complete(code: Int = SUCCESS) { val callback = callback!!; this.callback = null; callback(code) }
}
''',
    "Bitmap.kt": r'''
package android.graphics
import java.io.OutputStream
class Bitmap(val width: Int, val height: Int) {
    var recycled = false
    enum class Config { ARGB_8888 }
    enum class CompressFormat { PNG }
    fun compress(format: CompressFormat, quality: Int, output: OutputStream): Boolean {
        check(!recycled)
        encodingStarted?.countDown()
        check(encodingRelease?.await(5, java.util.concurrent.TimeUnit.SECONDS) != false)
        if (failEncoding) throw IllegalStateException("Encoder failed")
        // Incompressible pixels force production downscaling through its real
        // encoder loop, while this JVM fixture never pretends to render pixels.
        output.write(ByteArray(width * height * 4 + 32)); return true
    }
    fun recycle() { check(!recycled); recycled = true }
    companion object {
        val allocated = java.util.Collections.synchronizedList(ArrayList<Bitmap>())
        var failEncoding = false
        var failAllocation = false
        var encodingStarted: java.util.concurrent.CountDownLatch? = null
        var encodingRelease: java.util.concurrent.CountDownLatch? = null
        fun createBitmap(width: Int, height: Int, config: Config): Bitmap {
            if (failAllocation) throw OutOfMemoryError("Fixture allocation failure")
            return Bitmap(width, height).also { allocated.add(it) }
        }
        fun createScaledBitmap(source: Bitmap, width: Int, height: Int, filter: Boolean) =
            createBitmap(width, height, Config.ARGB_8888)
    }
}
''',
}

MAIN = r'''
package fixture
import android.app.Activity
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.view.PixelCopy
import android.view.Window
import android.view.View
import android.view.WindowManager
import com.getcapacitor.*
import play.ott.foss.RemoteScreenshotPlugin

fun plugin(): RemoteScreenshotPlugin = RemoteScreenshotPlugin().also { it.activity = Activity() }
fun capture(plugin: RemoteScreenshotPlugin) = PluginCall().also { plugin.capture(it) }
fun waitFor(call: PluginCall) {
    val deadline = System.nanoTime() + 5_000_000_000L
    while (call.resolutions + call.rejections == 0 && System.nanoTime() < deadline) {
        Handler.drain(); Thread.sleep(1)
    }
    Handler.drain()
    check(call.resolutions + call.rejections == 1) { "Promise not settled exactly once" }
}
fun rejected(call: PluginCall, code: String) {
    check(call.resolutions == 0 && call.rejections == 1 && call.code == code)
}
fun main() {
    val supported = plugin()
    val caps = PluginCall(); supported.capabilities(caps)
    check(caps.result!!.values == mapOf("supported" to true, "source" to "player-window"))
    Build.VERSION.SDK_INT = 25
    val old = PluginCall(); supported.capabilities(old)
    check(old.result!!.values["supported"] == false)
    rejected(capture(supported), "unavailable")
    check(PixelCopy.requests == 0)
    Build.VERSION.SDK_INT = 36

    val success = capture(supported)
    check(PixelCopy.target!!.width == 1280 && PixelCopy.target!!.height == 720)
    rejected(capture(supported), "busy")
    PixelCopy.complete(); waitFor(success)
    val image = success.result!!.values
    check(image["width"] == 640 && image["height"] == 360)
    check(java.util.Base64.getDecoder().decode(image["image"] as String).size <= 1024 * 1024)
    check(image["source"] == "player-window" && image["video"] == "unknown")
    check(Bitmap.allocated.all { it.recycled })
    println("PASS Android API gating, concurrency, image bounds, downscaling and resource release")

    View.automaticAnimation = false
    val beforePaint = PixelCopy.requests
    val painted = capture(supported)
    check(PixelCopy.requests == beforePaint)
    View.frame(); check(PixelCopy.requests == beforePaint)
    View.frame(); check(PixelCopy.requests == beforePaint + 1)
    PixelCopy.complete(); waitFor(painted)
    val hiddenBeforePaint = capture(supported)
    supported.handleOnPause(); View.frame(); View.frame()
    rejected(hiddenBeforePaint, "unavailable")
    check(PixelCopy.requests == beforePaint + 1)
    supported.handleOnResume(); View.automaticAnimation = true
    println("PASS native copy waits for two paint frames and rechecks foreground before dispatch")

    val timeout = capture(supported); Handler.timeout(); rejected(timeout, "timeout")
    rejected(capture(supported), "busy")
    PixelCopy.complete(); rejected(timeout, "timeout")
    check(Bitmap.allocated.all { it.recycled })
    val recovered = capture(supported); PixelCopy.complete(); waitFor(recovered)
    check(recovered.resolutions == 1)
    println("PASS timeout settles once, late native completion drops pixels and busy slot drains")

    val secure = supported.activity!!.window
    secure.attributes.flags = WindowManager.LayoutParams.FLAG_SECURE
    val count = PixelCopy.requests
    rejected(capture(supported), "unavailable")
    check(PixelCopy.requests == count)
    secure.attributes.flags = 0
    val lateSecure = capture(supported)
    secure.attributes.flags = WindowManager.LayoutParams.FLAG_SECURE
    PixelCopy.complete(); rejected(lateSecure, "capture-failed")
    secure.attributes.flags = 0
    supported.activity!!.focused = false
    rejected(capture(supported), "unavailable")
    supported.activity!!.focused = true
    println("PASS protected or unfocused windows never expose pixels")

    val background = capture(supported); supported.handleOnPause()
    rejected(background, "unavailable")
    PixelCopy.complete(); rejected(background, "unavailable")
    rejected(capture(supported), "unavailable")
    supported.handleOnResume()
    val navigation = capture(supported)
    supported.shouldOverrideLoad(Uri()); PixelCopy.complete()
    rejected(navigation, "unavailable")
    val replaced = capture(supported)
    supported.activity!!.window = Window(); PixelCopy.complete()
    rejected(replaced, "capture-failed")
    println("PASS navigation, background and window replacement suppress stale results")

    Bitmap.encodingStarted = java.util.concurrent.CountDownLatch(1)
    Bitmap.encodingRelease = java.util.concurrent.CountDownLatch(1)
    val encodingCancelled = capture(supported); PixelCopy.complete()
    check(Bitmap.encodingStarted!!.await(5, java.util.concurrent.TimeUnit.SECONDS))
    supported.handleOnPause(); rejected(encodingCancelled, "unavailable")
    supported.handleOnResume(); rejected(capture(supported), "busy")
    Bitmap.encodingRelease!!.countDown()
    val encodingDeadline = System.nanoTime() + 5_000_000_000L
    while (!Handler.hasPending() && System.nanoTime() < encodingDeadline) Thread.sleep(1)
    check(Handler.hasPending()) { "Encoder did not release its busy slot" }
    check(Bitmap.allocated.all { it.recycled })
    // The final callback is queued only after encode() releases its bitmap.
    Handler.drain()
    rejected(encodingCancelled, "unavailable")
    Bitmap.encodingStarted = null; Bitmap.encodingRelease = null
    println("PASS foreground revocation during encoding drops late PNG and keeps worker bounded")

    val nativeError = capture(supported); PixelCopy.complete(3)
    rejected(nativeError, "capture-failed")
    PixelCopy.fail = true
    rejected(capture(supported), "capture-failed")
    PixelCopy.fail = false
    Bitmap.failEncoding = true
    val encoding = capture(supported); PixelCopy.complete(); waitFor(encoding)
    rejected(encoding, "capture-failed")
    Bitmap.failEncoding = false
    Bitmap.failAllocation = true
    rejected(capture(supported), "capture-failed")
    Bitmap.failAllocation = false
    check(Bitmap.allocated.all { it.recycled })
    println("PASS platform, encoder and allocation errors settle without leaking bitmaps")

    val destroyed = capture(supported); supported.handleOnDestroy()
    rejected(destroyed, "unavailable"); PixelCopy.complete()
    rejected(destroyed, "unavailable"); rejected(capture(supported), "unavailable")
    val ended = PluginCall(); supported.capabilities(ended)
    check(ended.result!!.values["supported"] == false)
    check(Bitmap.allocated.all { it.recycled })
    println("PASS destruction cancels promise once and rejects late platform results")
}
'''

with tempfile.TemporaryDirectory(prefix="ott-screenshot-jvm-") as tmp:
    work = Path(tmp)
    cap = work / "Capacitor.kt"
    cap.write_text(CAPACITOR)
    annotation = work / "Annotation.kt"
    annotation.write_text(ANNOTATION)
    subprocess.run([KOTLINC, str(SOURCE), str(cap), str(annotation), "-classpath", str(ANDROID_JAR),
                    "-d", str(work / "android-api.jar")], check=True)
    print("PASS real Android API 36 signatures compile", flush=True)
    fixtures = []
    for name, content in PLATFORM.items():
        fixture = work / name
        fixture.write_text(content)
        fixtures.append(str(fixture))
    main = work / "Main.kt"
    main.write_text(MAIN)
    executable = work / "test.jar"
    subprocess.run([KOTLINC, str(SOURCE), str(cap), str(annotation), *fixtures, str(main),
                    "-include-runtime", "-d", str(executable)], check=True)
    subprocess.run(["java", "-jar", str(executable)], check=True, timeout=30)

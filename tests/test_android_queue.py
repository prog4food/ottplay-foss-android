#!/usr/bin/env python3
"""Execute the shipped queue on JVM with real coroutines, Android JSON and sockets.

Requires kotlinc, Java, Android SDK 36, and ANDROID_JSON_JAR pointing to the AOSP JSON artifact
com.vaadin.external.google:android-json:0.0.20131108.vaadin1. KOTLIN_HOME may select
the Kotlin installation; it must contain lib/kotlinx-coroutines-core-jvm.jar.
Android/Capacitor lifecycle dispatch is replaced by small JVM test doubles.

Portable CI setup (after Java 21 and Android SDK setup):
  curl -fsSL https://github.com/JetBrains/kotlin/releases/download/v2.3.0/kotlin-compiler-2.3.0.zip -o /tmp/kotlin.zip
  unzip -q /tmp/kotlin.zip -d /tmp/ott-queue-kotlin
  curl -fsSL https://repo.maven.apache.org/maven2/com/vaadin/external/google/android-json/0.0.20131108.vaadin1/android-json-0.0.20131108.vaadin1.jar -o /tmp/android-json.jar
  PATH=/tmp/ott-queue-kotlin/kotlinc/bin:$PATH ANDROID_JSON_JAR=/tmp/android-json.jar python3 tests/test_android_queue.py
The test respects JAVA_HOME and ANDROID_SDK_ROOT (or ANDROID_HOME), and leaves
the SDK, project sources and existing app build outputs unchanged.
"""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
JSON_JAR = Path(os.environ["ANDROID_JSON_JAR"]).resolve()
KOTLINC = Path(shutil.which("kotlinc") or "kotlinc").resolve()
KOTLIN_HOME = Path(os.environ.get("KOTLIN_HOME", KOTLINC.parent.parent))
if (KOTLIN_HOME / "libexec").is_dir():
    KOTLIN_HOME /= "libexec"
COROUTINES = KOTLIN_HOME / "lib/kotlinx-coroutines-core-jvm.jar"
ANDROID_SDK = Path(os.environ.get("ANDROID_SDK_ROOT", os.environ.get("ANDROID_HOME", "/opt/homebrew/share/android-commandlinetools")))
ANDROID_API = ANDROID_SDK / "platforms/android-36/android.jar"
assert JSON_JAR.is_file(), JSON_JAR
assert COROUTINES.is_file(), COROUTINES
assert ANDROID_API.is_file(), ANDROID_API

CAPACITOR = r'''
package com.getcapacitor
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
class Activity { fun runOnUiThread(action: Runnable) { action.run() } }
class Bridge { val activity = Activity() }
open class Plugin {
    val bridge = Bridge()
    open fun load() {}
    open fun handleOnDestroy() {}
    fun notifyListeners(event: String, data: JSObject) {}
}
class PluginCall(val data: JSObject = JSObject()) {
    val done = CountDownLatch(1)
    var result = JSObject()
    var error: String? = null
    fun getBoolean(key: String, fallback: Boolean): Boolean = if (data.has(key)) data.getBoolean(key) else fallback
    fun getString(key: String): String? = if (data.has(key)) data.getString(key) else null
    fun resolve(value: JSObject = JSObject()) { result = value; done.countDown() }
    fun reject(value: String) { error = value; done.countDown() }
    fun await(): JSObject {
        check(done.await(5, TimeUnit.SECONDS)) { "Plugin promise did not settle" }
        check(error == null) { error!! }
        return result
    }
}
annotation class PluginMethod
'''

MAIN = r'''
package fixture
import com.getcapacitor.*
import kotlinx.coroutines.*
import kotlinx.coroutines.internal.MainDispatcherFactory
import kotlin.coroutines.CoroutineContext
import play.ott.foss.MobileCommandQueuePlugin
import java.net.*
import java.io.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

@OptIn(InternalCoroutinesApi::class)
class ImmediateMainFactory : MainDispatcherFactory {
    override val loadPriority = Int.MAX_VALUE
    override fun createDispatcher(allFactories: List<MainDispatcherFactory>): MainCoroutineDispatcher =
        object : MainCoroutineDispatcher() {
            override val immediate: MainCoroutineDispatcher get() = this
            override fun isDispatchNeeded(context: CoroutineContext) = false
            override fun dispatch(context: CoroutineContext, block: Runnable) { block.run() }
        }
    override fun hintOnError() = "JVM queue test dispatcher"
}

private fun job(plugin: MobileCommandQueuePlugin): Job {
    val field = plugin.javaClass.getDeclaredField("scope").apply { isAccessible = true }
    return (field.get(plugin) as CoroutineScope).coroutineContext[Job]!!
}

private const val TOKEN = "0123456789abcdefghijklmnopqrstuvwxyz_AB"
private fun startHttp(plugin: MobileCommandQueuePlugin) {
    val call = PluginCall(JSObject().put("httpEnabled", true).put("token", TOKEN))
    plugin.start(call); check(call.await().getBoolean("httpEnabled"))
}
private fun assertPortBusy(port: Int) {
    try {
        ServerSocket(port, 8, InetAddress.getByName("127.0.0.1")).use {
            error("A live HTTP listener must prevent binding its port")
        }
    } catch (_: BindException) { }
}

private suspend fun stopWaitsForCleanup(plugin: MobileCommandQueuePlugin, port: Int) {
    val field = plugin.javaClass.getDeclaredField("serverJob").apply { isAccessible = true }
    val listenerJob = field.get(plugin) as Job
    val started = CompletableDeferred<Unit>()
    val cleanupStarted = CompletableDeferred<Unit>()
    val releaseCleanup = CompletableDeferred<Unit>()
    // Hold a listener child in cleanup to reproduce delayed native I/O teardown
    // without relying on the OS scheduler or adding a sleep/rebind retry.
    CoroutineScope(listenerJob + Dispatchers.IO).launch {
        try {
            started.complete(Unit)
            awaitCancellation()
        } finally {
            withContext(NonCancellable) {
                cleanupStarted.complete(Unit)
                releaseCleanup.await()
            }
        }
    }
    withTimeout(5000) { started.await() }
    val stopped = PluginCall()
    val stoppedAgain = PluginCall()
    try {
        plugin.stop(stopped)
        withTimeout(5000) { cleanupStarted.await() }
        plugin.stop(stoppedAgain)
        check(stopped.done.count == 1L) { "stop resolved before listener cleanup finished" }
        check(stoppedAgain.done.count == 1L) { "Repeated stop skipped pending cleanup" }
        val prematureStart = PluginCall(JSObject().put("httpEnabled", true).put("token", TOKEN))
        plugin.start(prematureStart)
        check(prematureStart.error == "HTTP control is still stopping")
    } finally {
        releaseCleanup.complete(Unit)
    }
    stopped.await(); stoppedAgain.await()
    check(listenerJob.isCompleted) { "stop must settle only after all listener workers finish" }
    ServerSocket(port, 8, InetAddress.getByName("127.0.0.1")).close()
    startHttp(plugin)
    assertPortBusy(port)
}

private fun request(port: Int, request: String, fragments: Boolean = false): String {
    return Socket("127.0.0.1", port).use { socket ->
        socket.soTimeout = 6500
        val bytes = request.toByteArray(Charsets.UTF_8)
        if (fragments) for (byte in bytes) { socket.getOutputStream().write(byte.toInt()); socket.getOutputStream().flush() }
        else socket.getOutputStream().write(bytes)
        socket.getInputStream().readBytes().toString(Charsets.UTF_8)
    }
}

// A parsed request can outlive cancellation: socket.close() cannot erase bytes
// already buffered on its worker. Pause the final read to make this interleaving
// deterministic, then run the real private HTTP handler after stop/restart.
private fun assertRemoteClosed(source: InputStream) {
    // A peer close may arrive as FIN/EOF or RST; a timeout or data is not closure.
    val next = try { source.read() } catch (_: SocketException) { return }
    check(next == -1) { "Closed peer unexpectedly returned data" }
}

private fun verifyRemoteCloseAssertion() {
    assertRemoteClosed(ByteArrayInputStream(byteArrayOf()))
    assertRemoteClosed(object : InputStream() {
        override fun read(): Int = throw SocketException("Connection reset")
    })
    check(runCatching { assertRemoteClosed(ByteArrayInputStream(byteArrayOf(1))) }
        .exceptionOrNull() is IllegalStateException)
    check(runCatching { assertRemoteClosed(object : InputStream() {
        override fun read(): Int = throw SocketTimeoutException("still open")
    }) }.exceptionOrNull() is SocketTimeoutException)
}

private class PausedRequestSocket(request: String) : Socket() {
    val paused = CountDownLatch(1)
    val resume = CountDownLatch(1)
    val response = ByteArrayOutputStream()
    private val bytes = request.toByteArray(Charsets.UTF_8)
    private var offset = 0
    private val source = object : InputStream() {
        override fun read(): Int {
            if (offset >= bytes.size) return -1
            if (offset == bytes.lastIndex) {
                paused.countDown()
                check(resume.await(5, TimeUnit.SECONDS)) { "Request continuation was not released" }
            }
            return bytes[offset++].toInt() and 255
        }
        override fun read(buffer: ByteArray, start: Int, length: Int): Int {
            if (length == 0) return 0
            val value = read()
            if (value < 0) return -1
            buffer[start] = value.toByte()
            return 1
        }
    }
    override fun getInputStream(): InputStream = source
    override fun getOutputStream(): OutputStream = response
    override fun setSoTimeout(timeout: Int) {}
    override fun close() {}
}

private fun revokedContinuation(plugin: MobileCommandQueuePlugin, method: String, replacementToken: String?) {
    val listenerField = plugin.javaClass.getDeclaredField("serverSocket").apply { isAccessible = true }
    val oldListener = listenerField.get(plugin) as ServerSocket
    val body = if (method == "POST") """{"command":"exit_player"}""" else ""
    val incoming = PausedRequestSocket("$method /api/webhook/commands HTTP/1.1\r\nAuthorization: Bearer $TOKEN\r\nContent-Length: ${body.length}\r\n\r\n$body")
    val handler = plugin.javaClass.getDeclaredMethod("handleClient", Socket::class.java, String::class.java, ServerSocket::class.java)
        .apply { isAccessible = true }
    val failure = java.util.concurrent.atomic.AtomicReference<Throwable?>()
    val worker = thread(start = true) {
        try { handler.invoke(plugin, incoming, TOKEN, oldListener) }
        catch (error: Throwable) { failure.set(error) }
    }
    try {
        check(incoming.paused.await(5, TimeUnit.SECONDS)) { "Handler did not reach parser pause" }
        val stopped = PluginCall(); plugin.stop(stopped); stopped.await()
        if (replacementToken != null) {
            val start = PluginCall(JSObject().put("httpEnabled", true).put("token", replacementToken))
            plugin.start(start); start.await()
        }
        val sentinel = PluginCall(JSObject().put("data", JSObject().put("command", "popup_message").put("text", "new internal command")))
        plugin.post(sentinel); sentinel.await()
    } finally {
        incoming.resume.countDown()
        worker.join(5000)
    }
    check(!worker.isAlive) { "Old request did not terminate" }
    check(failure.get() == null) { failure.get().toString() }
    check(incoming.response.toString("UTF-8").startsWith("HTTP/1.1 401")) { "Revoked $method was accepted" }
    val remaining = PluginCall(); plugin.get(remaining)
    val commands = remaining.await().getJSONArray("commands")
    check(commands.length() == 1 && commands.getJSONObject(0).getString("text") == "new internal command") {
        "Revoked $method must neither enqueue old commands nor drain new internal commands"
    }
    val stop = PluginCall(); plugin.stop(stop); stop.await()
    startHttp(plugin)
}

fun main() = runBlocking {
    verifyRemoteCloseAssertion()
    val port = System.getenv("OTTPLAY_QUEUE_PORT")!!.toInt()
    val plugin = MobileCommandQueuePlugin()
    plugin.load()
    val initial = PluginCall(); plugin.start(initial)
    check(initial.await().getInt("port") == 0)
    ServerSocket(port, 8, InetAddress.getByName("127.0.0.1")).close()
    val nativePost = PluginCall(JSObject().put("data", JSObject().put("type", "popup_message").put("text", "internal")))
    plugin.post(nativePost); check(nativePost.await().getInt("queued") == 1)
    val nativeGet = PluginCall(); plugin.get(nativeGet)
    check(nativeGet.await().getJSONArray("commands").getJSONObject(0).getString("text") == "internal")
    val invalidStart = PluginCall(JSObject().put("httpEnabled", true))
    plugin.start(invalidStart); check(invalidStart.error != null)
    ServerSocket(port, 8, InetAddress.getByName("127.0.0.1")).close()
    startHttp(plugin)
    assertPortBusy(port)
    stopWaitsForCleanup(plugin, port)
    val body = """{"type":"popup_message","text":"Привет ✓"}"""
    val path = "/api/webhook/commands"
    fun header(extra: String = "") = "POST $path HTTP/1.1\r\nAuthorization: Bearer $TOKEN\r\n$extra"
    val denied = request(port, "POST $path HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}")
    check(denied.startsWith("HTTP/1.1 401")); check(!denied.contains("Access-Control-Allow-Origin"))
    check(request(port, "GET $path HTTP/1.1\r\nAuthorization: Bearer wrong\r\n\r\n").startsWith("HTTP/1.1 401"))
    val ok = request(port, header("content-length: ${body.toByteArray().size}\r\n") + "\r\n$body", true)
    check(ok.startsWith("HTTP/1.1 200")) { ok }
    val getCall = PluginCall(); plugin.get(getCall)
    val result = getCall.await()
    check(result.get("commands") is JSArray)
    check(org.json.JSONObject(result.toString()).getJSONArray("commands").getJSONObject(0).getString("text") == "Привет ✓")
    val emptyCall = PluginCall(); plugin.get(emptyCall); check(emptyCall.await().getJSONArray("commands").length() == 0)
    for (malformed in listOf("Content-Length: -1\r\n", "Content-Length: NaN\r\n", "Transfer-Encoding: chunked\r\n", "Content-Length: 2\r\ncontent-length: 3\r\n")) {
        check(request(port, header(malformed) + "\r\n").startsWith("HTTP/1.1 400"))
    }
    check(request(port, header("Content-Length: 65537\r\n") + "\r\n").startsWith("HTTP/1.1 413"))
    check(request(port, header("X-Large: " + "a".repeat(8192) + "\r\n") + "\r\n").startsWith("HTTP/1.1 431"))
    check(request(port, header("Content-Length: 3\r\n") + "\r\nBAD").startsWith("HTTP/1.1 400"))
    val afterBad = PluginCall(); plugin.get(afterBad); check(afterBad.await().getJSONArray("commands").length() == 0)
    var accepted = 0
    repeat(20) {
        val large = PluginCall(JSObject().put("data", JSObject().put("text", "x".repeat(65000))))
        plugin.post(large)
        if (large.error == null) accepted++
    }
    check(accepted in 1..16)
    val drainLarge = PluginCall(); plugin.get(drainLarge)
    check(drainLarge.await().getJSONArray("commands").length() == accepted)
    // Absolute deadline closes slow/idle requests, without affecting the accept loop.
    val idleTimeout = request(port, "G")
    check(idleTimeout.startsWith("HTTP/1.1 408"))
    check(request(port, "GET /api/webhook/health HTTP/1.1\r\nAuthorization: Bearer $TOKEN\r\n\r\n").startsWith("HTTP/1.1 200"))
    for (replacement in listOf(null, "b".repeat(64), TOKEN)) {
        revokedContinuation(plugin, "POST", replacement)
        revokedContinuation(plugin, "GET", replacement)
    }
    // Turning off closes the socket, clears commands, and a new code revokes the old one.
    val pending = PluginCall(JSObject().put("data", JSObject().put("text", "must clear")))
    plugin.post(pending); pending.await()
    val stopped = PluginCall(); plugin.stop(stopped); stopped.await()
    ServerSocket(port, 8, InetAddress.getByName("127.0.0.1")).close()
    val afterStop = PluginCall(); plugin.get(afterStop)
    check(afterStop.await().getJSONArray("commands").length() == 0)
    val rotatedToken = "b".repeat(64)
    val rotated = PluginCall(JSObject().put("httpEnabled", true).put("token", rotatedToken))
    plugin.start(rotated); check(rotated.await().getBoolean("httpEnabled"))
    check(request(port, "GET $path HTTP/1.1\r\nAuthorization: Bearer $TOKEN\r\n\r\n").startsWith("HTTP/1.1 401"))
    check(request(port, "GET $path HTTP/1.1\r\nAuthorization: Bearer $rotatedToken\r\n\r\n").startsWith("HTTP/1.1 200"))
    val idleClient = Socket("127.0.0.1", port)
    val clientsField = plugin.javaClass.getDeclaredField("activeClients").apply { isAccessible = true }
    withTimeout(5000) { while ((clientsField.get(plugin) as Set<*>).isEmpty()) delay(10) }
    val runningJob = job(plugin)
    plugin.handleOnDestroy()
    withTimeout(5000) { runningJob.join() }
    idleClient.soTimeout = 1000
    idleClient.use { assertRemoteClosed(it.getInputStream()) }
    check(!runningJob.isActive)
    repeat(20) {
        val transient = MobileCommandQueuePlugin(); val transientJob = job(transient)
        transient.load(); startHttp(transient); transient.handleOnDestroy()
        withTimeout(5000) { transientJob.join() }
        ServerSocket(port, 8, InetAddress.getByName("127.0.0.1")).close()
    }
    println("PASS Android queue: default has no socket; internal API; explicit authenticated HTTP; Unicode fragmented body; auth/size/framing failures; deadline; six revoked GET/POST continuations; stop awaits worker cleanup and permits immediate rebind; racing destroy closes clients and bind")
}
'''

with tempfile.TemporaryDirectory(prefix="ott-android-queue-") as directory:
    temp = Path(directory)
    classes = temp / "classes"
    classes.mkdir()
    java_sources = []
    cap_src = ROOT / "node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor"
    for name in ["JSObject", "JSArray"]:
        target = temp / f"{name}.java"
        target.write_text((cap_src / f"{name}.java").read_text())
        java_sources.append(target)
    nullable = temp / "Nullable.java"
    nullable.write_text("package androidx.annotation; public @interface Nullable {}")
    java_sources.append(nullable)
    java_bin = Path(os.environ["JAVA_HOME"]) / "bin" if os.environ.get("JAVA_HOME") else Path("/usr/bin")
    subprocess.run([str(java_bin / "javac"), "--release", "17", "-cp", str(ANDROID_API), "-d", str(classes), *map(str, java_sources)], check=True)
    sources = {
        "Capacitor.kt": CAPACITOR,
        "Log.kt": "package android.util\nobject Log { fun d(tag: String, msg: String)=0; fun w(tag: String, msg: String)=0; fun e(tag: String, msg: String)=0 }",
        "Annotation.kt": 'package com.getcapacitor.annotation\nannotation class CapacitorPlugin(val name: String)',
        "Main.kt": MAIN,
    }
    for name, source in sources.items():
        (temp / name).write_text(source)
    service = classes / "META-INF/services/kotlinx.coroutines.internal.MainDispatcherFactory"
    service.parent.mkdir(parents=True)
    service.write_text("fixture.ImmediateMainFactory")
    jar = temp / "queue.jar"
    classpath = os.pathsep.join(map(str, [classes, JSON_JAR, COROUTINES]))
    # Compile against the real modern Android API (including Iterator<String>),
    # then use AOSP's executable JSON implementation instead of SDK stubs at runtime.
    compile_classpath = os.pathsep.join(map(str, [classes, ANDROID_API, COROUTINES]))
    subprocess.run([str(KOTLINC), "-jvm-target", "17", "-cp", compile_classpath,
        *map(str, temp.glob("*.kt")), str(ROOT / "android/app/src/main/java/play/ott/foss/MobileCommandQueuePlugin.kt"),
        "-include-runtime", "-d", str(jar)], check=True)
    with socket.socket() as port_probe:
        port_probe.bind(("127.0.0.1", 0))
        port = port_probe.getsockname()[1]
    subprocess.run([str(java_bin / "java"), "-cp", str(jar) + os.pathsep + classpath, "fixture.MainKt"],
        env={**os.environ, "OTTPLAY_QUEUE_PORT": str(port)}, check=True, timeout=45)

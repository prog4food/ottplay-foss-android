#!/usr/bin/env python3
"""Compile real Android HTTP plugins and test edition policy against a local server.

Reuses the queue test's small Capacitor double without importing/running its test.
Uses Java, kotlinc, SDK36, ANDROID_JSON_JAR and ANDROID_HTTP_CLASSPATH
(real OkHttp/Okio jars); no app artifact mutation.
"""
import ast
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
module=ast.parse((ROOT/'tests/test_android_queue.py').read_text())
CAP=next(ast.literal_eval(node.value) for node in module.body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='CAPACITOR' for t in node.targets))
CAP=CAP.replace('    var error: String? = null','    var error: String? = null\n    var code: String? = null')
CAP=CAP.replace('    fun getString(key: String): String?', '    fun getInt(key: String): Int? = if (data.has(key)) data.getInt(key) else null\n    fun getObject(key: String): JSObject? = data.optJSONObject(key)?.let { JSObject.fromJSONObject(it) }\n    fun getString(key: String): String?')
CAP=CAP.replace('fun reject(value: String) { error = value; done.countDown() }','fun reject(value: String, errorCode: String? = null) { error = value; code = errorCode; done.countDown() }')
MAIN=r'''
package fixture
import com.getcapacitor.*
import play.ott.foss.*
import java.net.*
import java.util.concurrent.*
import java.lang.ref.WeakReference
fun wait(call: PluginCall) { check(call.done.await(5, TimeUnit.SECONDS)); }
object Log { fun w(tag: String, message: String, error: Exception? = null) {} }
class TestWebView {
    val queued = mutableListOf<() -> Unit>()
    val scripts = mutableListOf<String>()
    val completions = mutableListOf<(String) -> Unit>()
    var accepting = true
    fun post(action: () -> Unit): Boolean { if (accepting) queued.add(action); return accepting }
    fun evaluateJavascript(script: String, callback: (String) -> Unit) { scripts.add(script); completions.add(callback) }
}
object SystemMediaControl {
    private const val TAG = "fixture"
    private var webViewRef: WeakReference<TestWebView>? = null
    // ACTUAL_EVAL_ON_WEB_VIEW
    fun run() {
        val view = TestWebView(); webViewRef = WeakReference(view)
        evalOnWebView("retired")
        check(NativeWork.pendingCount == 1)
        NativeWork.setStandby(true); NativeWork.setStandby(false)
        view.queued.removeAt(0)()
        check(view.scripts.isEmpty() && NativeWork.pendingCount == 0)
        NativeWork.setStandby(true); evalOnWebView("blocked")
        check(view.queued.isEmpty())
        NativeWork.setStandby(false); evalOnWebView("current")
        view.queued.removeAt(0)()
        check(view.scripts == listOf("current") && NativeWork.pendingCount == 1)
        view.completions.removeAt(0)("null")
        check(NativeWork.pendingCount == 0)
        view.accepting = false; evalOnWebView("detached")
        check(NativeWork.pendingCount == 0)
        println("PASS Android system controls: retired queued command, standby admission, actual JS completion and detached WebView")
    }
}
object DestroyedLocalOwner {
    // ACTUAL_QUEUED_WORK
    fun run() {
        val executor = Executors.newSingleThreadExecutor()
        val started = CountDownLatch(1)
        val hold = CountDownLatch(1)
        val active = NativeWork.begin()!!
        executor.execute(QueuedWork({
            started.countDown()
            try { hold.await() } catch (_: InterruptedException) { }
            finally { active.finish() }
        }, { active.finish() }))
        check(started.await(5, TimeUnit.SECONDS))
        val waiting = NativeWork.begin()!!
        var ran = false
        var discarded = 0
        val queued = QueuedWork({ ran = true; waiting.finish() }, { discarded++; waiting.finish() })
        executor.execute(queued)
        waiting.cancel(); active.cancel()
        check(!NativeWork.isStandby && runCatching { waiting.check() }.isFailure)
        val removed = executor.shutdownNow()
        check(removed.size == 1)
        removed.forEach { (it as? QueuedWork)?.discardBeforeStart() }
        check(executor.awaitTermination(5, TimeUnit.SECONDS))
        queued.run(); queued.discardBeforeStart()
        check(!ran && discarded == 1 && NativeWork.pendingCount == 0)
        val next = NativeWork.begin()!!; next.check(); next.finish()
        println("PASS Android local owner destruction: running cancellation, queued discard exactly once, no leaked pending tickets")
    }
}
fun backgroundStandby() {
    BuildConfig.FLAVOR = "full"
    val generic = StalkerPortalPlugin()
    val playlist = M3UProxyPlugin()
    fun send(kind: String, url: String, control: Boolean = false): PluginCall {
        val call = PluginCall(JSObject().put("url", url).put("remoteControl", control).put("timeoutMs", 2000))
        when (kind) {
            "playlist" -> playlist.proxyFetch(call)
            "portal" -> generic.portalRequest(call)
            else -> generic.httpRequest(call)
        }
        return call
    }
    for (kind in listOf("playlist", "portal", "http")) {
        val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val started = CountDownLatch(1)
        val closed = CountDownLatch(1)
        val worker = Thread {
            server.accept().use { socket ->
                socket.soTimeout = 4000
                val input = socket.getInputStream().bufferedReader()
                while (input.readLine().orEmpty().isNotEmpty()) { }
                socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n".toByteArray())
                started.countDown()
                try { if (input.read() == -1) closed.countDown() }
                catch (_: java.net.SocketException) { closed.countDown() }
            }
        }.apply { start() }
        val url = "http://127.0.0.1:${server.localPort}/portal.php?held"
        val pending = send(kind, url)
        check(started.await(5, TimeUnit.SECONDS)) { "$kind did not reach server: ${pending.error}" }
        check(NativeWork.pendingCount > 0)
        NativeWork.setStandby(true)
        val rejected = send(kind, url); wait(rejected)
        check(rejected.code == "standby")
        // Wake immediately: the retired request may only fail, never become current again.
        NativeWork.setStandby(false)
        wait(pending); check(pending.error != null)
        check(closed.await(5, TimeUnit.SECONDS)) { "$kind did not close cancelled HTTP" }
        worker.join(5000); server.close(); check(!worker.isAlive)
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
        while (NativeWork.pendingCount != 0 && System.nanoTime() < deadline) Thread.sleep(1)
        check(NativeWork.pendingCount == 0)
    }
    NativeWork.setStandby(true)
    val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    val worker = Thread {
        server.accept().use { socket ->
            val input = socket.getInputStream().bufferedReader()
            while (input.readLine().orEmpty().isNotEmpty()) { }
            socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".toByteArray())
        }
    }.apply { start() }
    val control = send("http", "http://127.0.0.1:${server.localPort}/api/requests", true)
    wait(control); check(control.error == null && control.result.getInt("status") == 200)
    worker.join(5000); server.close(); check(!worker.isAlive)
    check(NativeWork.snapshot().quiescent)
    NativeWork.setStandby(false)

    // HttpURLConnection did not follow cross-protocol redirects. Keep that
    // boundary when using cancel-sticky OkHttp, including the HTTPS-only edition.
    for (kind in listOf("playlist", "portal", "http")) {
        val origin = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val receiver = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val originWorker = Thread {
            origin.accept().use { socket ->
                val input = socket.getInputStream().bufferedReader()
                while (input.readLine().orEmpty().isNotEmpty()) { }
                socket.getOutputStream().write(("HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1:${receiver.localPort}/redirected\r\n" +
                    "Content-Length: 0\r\nConnection: close\r\n\r\n").toByteArray())
            }
        }.apply { start() }
        val result = send(kind, "http://127.0.0.1:${origin.localPort}/portal.php?origin")
        wait(result)
        if (kind == "playlist") check(result.error != null) else check(result.result.getInt("status") == 302)
        receiver.soTimeout = 150
        try { receiver.accept().close(); error("$kind followed cross-protocol redirect") }
        catch (_: SocketTimeoutException) { }
        originWorker.join(5000); origin.close(); receiver.close(); check(!originWorker.isAlive)
    }
    println("PASS provider standby: blocked admission, active socket cancellation, retired request after wake, control exemption and cross-protocol redirect boundary")
}
fun providerResponseBounds() {
    class GeneratedInput(private val length: Int) : java.io.InputStream() {
        var count = 0
        var closed = false
        override fun read(): Int = if (count == length) -1 else { count++; 65 }
        override fun read(bytes: ByteArray, offset: Int, size: Int): Int {
            if (count == length) return -1
            val taken = minOf(size, length - count)
            java.util.Arrays.fill(bytes, offset, offset + taken, 65.toByte())
            count += taken
            return taken
        }
        override fun close() { closed = true }
    }
    val limit = ProviderHttpResponse.MAX_BYTES
    val exact = GeneratedInput(limit)
    check(ProviderHttpResponse.read(exact, limit.toLong()).length == limit && exact.closed)
    val unknown = GeneratedInput(limit + 100000)
    try { ProviderHttpResponse.read(unknown, -1); error("Oversized stream accepted") }
    catch (_: ProviderHttpResponse.TooLarge) { }
    check(unknown.closed && unknown.count == limit + 1)
    val declared = GeneratedInput(1)
    try { ProviderHttpResponse.read(declared, 92L * 1024 * 1024); error("Oversized declaration accepted") }
    catch (_: ProviderHttpResponse.TooLarge) { }
    check(declared.closed && declared.count == 0)
    val text = "Винни-Пух 🐻"
    check(ProviderHttpResponse.read(text.toByteArray().inputStream(), -1) == text)
    check(ProviderHttpResponse.read(null, -1) == "")

    BuildConfig.FLAVOR = "full"
    val plugin = StalkerPortalPlugin()
    val playlist = M3UProxyPlugin()
    for (kind in listOf("http", "portal", "playlist")) {
        val modes = listOf("declared", "chunked", "error", "small") + if (kind == "playlist") emptyList() else listOf("head")
        for (mode in modes) {
            val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
            var closedByClient = false
            val worker = Thread {
                server.soTimeout = 4000
                server.accept().use { socket ->
                    val input = socket.getInputStream().bufferedReader()
                    val requestLine = input.readLine()
                    check(requestLine.startsWith(if (mode == "head") "HEAD " else "GET "))
                    while (input.readLine().orEmpty().isNotEmpty()) { }
                    val output = socket.getOutputStream()
                    val status = if (mode == "error") "500 Error" else "200 OK"
                    val framing = when (mode) {
                        "declared", "head" -> "Content-Length: 96468992\r\n"
                        "chunked" -> "Transfer-Encoding: chunked\r\n"
                        else -> ""
                    }
                    try {
                        output.write("HTTP/1.1 $status\r\n${framing}Connection: close\r\n\r\n".toByteArray())
                        when (mode) {
                            "small" -> output.write(text.toByteArray())
                            "head" -> { }
                            "declared" -> {
                                // Keep the server side open; only the client's
                                // rejection/cleanup may terminate this socket.
                                socket.soTimeout = 2000
                                closedByClient = try { input.read() == -1 }
                                    catch (_: java.net.SocketException) { true }
                            }
                            else -> {
                                val chunk = ByteArray(8192) { 65 }
                                repeat(limit / chunk.size + 1) {
                                    if (mode == "chunked") output.write("2000\r\n".toByteArray())
                                    output.write(chunk)
                                    if (mode == "chunked") output.write("\r\n".toByteArray())
                                }
                                if (mode == "chunked") output.write("0\r\n\r\n".toByteArray())
                            }
                        }
                    } catch (_: java.io.IOException) { /* Oversized response closed early. */ }
                }
            }.apply { start() }
            val call = PluginCall(JSObject().put("url", "http://127.0.0.1:${server.localPort}/portal.php?token=private")
                .put("method", if (mode == "head") "HEAD" else "GET"))
            when (kind) {
                "http" -> plugin.httpRequest(call)
                "portal" -> plugin.portalRequest(call)
                else -> playlist.proxyFetch(call)
            }
            wait(call); worker.join(5000); server.close(); check(!worker.isAlive)
            if (mode == "small" || mode == "head") check(call.error == null && call.result.getString("body") == if (mode == "head") "" else text)
            else {
                check(call.code == "response_too_large") { "$kind $mode: ${call.error}" }
                check(!call.error!!.contains("private") && !call.error!!.contains("127.0.0.1"))
                if (mode == "declared") check(closedByClient) { "$kind: client did not close oversized response" }
            }
        }
    }
    println("PASS provider HTTP: 8 MiB boundary, UTF-8, early length rejection, chunked/error body bounds, socket cleanup and recovery")
}
fun screenshotTransport() {
    BuildConfig.FLAVOR = "full"
    val plugin = StalkerPortalPlugin()
    fun shot(url: String, id: String = "shot_test", body: String = "{}", headers: JSObject = JSObject().put("Authorization", "Bearer fixture")): PluginCall {
        val call = PluginCall(JSObject().put("url", url).put("requestId", id).put("body", body)
            .put("method", "POST").put("headers", headers).put("timeoutMs", 2000).put("screenshotControl", true))
        plugin.httpRequest(call); return call
    }
    fun readRequest(socket: Socket): String {
        val input = socket.getInputStream().bufferedReader()
        val headers = StringBuilder()
        var length = 0
        while (true) {
            val line = input.readLine() ?: error("missing request")
            if (line.isEmpty()) break
            headers.append(line).append('\n')
            if (line.startsWith("Content-Length:", true)) length = line.substringAfter(':').trim().toInt()
        }
        repeat(length) { check(input.read() >= 0) }
        return headers.toString()
    }
    fun exchange(response: ByteArray): Pair<PluginCall, String> {
        val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
        var request = ""
        val worker = Thread {
            server.soTimeout = 4000
            server.accept().use { socket ->
                request = readRequest(socket)
                try { socket.getOutputStream().write(response) } catch (_: java.io.IOException) { }
            }
        }.apply { start() }
        val call = shot("http://127.0.0.1:${server.localPort}/api/responses")
        wait(call); worker.join(5000); server.close(); check(!worker.isAlive)
        return call to request
    }
    val cookieManager = CookieManager()
    CookieHandler.setDefault(cookieManager)
    cookieManager.cookieStore.add(URI("http://127.0.0.1"), HttpCookie("private", "must-not-send"))
    val (ok, request) = exchange("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nSet-Cookie: private=secret\r\nConnection: close\r\n\r\n{}".toByteArray())
    check(ok.error == null && ok.result.getInt("status") == 200)
    check(request.contains("Authorization: Bearer fixture"))
    check(!request.lines().any { it.startsWith("Cookie:", true) })
    check(!ok.result.getString("headers")!!.contains("Cookie", true))
    CookieHandler.setDefault(null)
    for (url in listOf("http://192.168.1.1/api/responses", "http://127.1/api/responses", "http://localhost.example/api/responses", "https://user:secret@controller.example/api/responses")) {
        val bad = shot(url); wait(bad); check(bad.code == "invalid_request")
    }
    for (headers in listOf(JSObject().put("Cookie", "private=value"), JSObject().put("Authorization", "Bearer x\r\nX-Bad: y"))) {
        val bad = shot("https://controller.example/api/responses", headers = headers); wait(bad); check(bad.code == "invalid_request")
    }
    val largeUpload = shot("https://controller.example/api/responses", body = "я".repeat(1048577))
    wait(largeUpload); check(largeUpload.code == "invalid_request")
    val receiver = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    val (redirect, _) = exchange("HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:${receiver.localPort}/target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
    check(redirect.error != null)
    receiver.soTimeout = 200
    try { receiver.accept(); error("Screenshot redirect followed") } catch (_: SocketTimeoutException) { }
    receiver.close()
    val (large, _) = exchange("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".toByteArray() + ByteArray(2097153) { 65 })
    check(large.error != null)
    val (utf8, _) = exchange("HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\n".toByteArray() + byteArrayOf(-1))
    check(utf8.error != null)
    println("PASS screenshot HTTP lane: exact-loopback/HTTPS, no global cookies, header/upload/streaming bounds, no redirected destination request")

    val held = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    val started = CountDownLatch(1)
    val release = CountDownLatch(1)
    val worker = Thread {
        held.accept().use { socket ->
            readRequest(socket)
            socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n".toByteArray())
            started.countDown(); release.await(5, TimeUnit.SECONDS)
        }
    }.apply { start() }
    val pending = shot("http://127.0.0.1:${held.localPort}/api/responses", "cancel_this")
    check(started.await(5, TimeUnit.SECONDS))
    val duplicate = shot("http://127.0.0.1:${held.localPort}/api/responses", "cancel_this")
    wait(duplicate); check(duplicate.code == "busy")
    val cancel = PluginCall(JSObject().put("requestId", "cancel_this"))
    plugin.cancelHttpRequest(cancel); wait(cancel); wait(pending)
    check(cancel.result.getBoolean("cancelled") && pending.error != null)
    release.countDown(); worker.join(5000); held.close(); check(!worker.isAlive)
    val again = PluginCall(JSObject().put("requestId", "cancel_this"))
    plugin.cancelHttpRequest(again); wait(again); check(!again.result.getBoolean("cancelled"))
    plugin.handleOnDestroy()
    val destroyed = shot("https://controller.example/api/responses")
    wait(destroyed); check(destroyed.code == "busy")
    println("PASS screenshot HTTP lane: requestId ownership, active socket cancellation and destroyed-owner rejection")
    // OkHttp's dispatcher is idle but has a keepalive thread; release it so this
    // standalone JVM regression does not wait a minute after all assertions pass.
    val clientField = plugin.javaClass.getDeclaredField("swopClient").apply { isAccessible = true }
    val client = clientField.get(plugin) as okhttp3.OkHttpClient
    client.dispatcher.executorService.shutdown()
    client.connectionPool.evictAll()
}
fun main() {
    val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
    val endpoint = "http://127.0.0.1:${server.localPort}/stalker_portal/api/?token=fixture"
    val generic = StalkerPortalPlugin(); val playlist = M3UProxyPlugin()
    for (flavor in listOf("play", "full")) {
        BuildConfig.FLAVOR = flavor
        for (url in listOf("http://127.0.0.1:${server.localPort}/swop/session", "https://user:secret@relay.example/swop/val", "https://relay.example/swop/val?token=secret", "https://relay.example/x/../swop/val")) {
            val swop = PluginCall(JSObject().put("url", url).put("body", "{}").put("clientId", "device"))
            generic.swopRequest(swop); wait(swop)
            check(swop.error == "Native remote text entry request failed")
        }
    }
    BuildConfig.FLAVOR = "play"
    val portal = PluginCall(JSObject().put("url",endpoint)); generic.portalRequest(portal); wait(portal)
    val http = PluginCall(JSObject().put("url",endpoint)); generic.httpRequest(http); wait(http)
    val m3u = PluginCall(JSObject().put("url","@$endpoint")); playlist.proxyFetch(m3u); wait(m3u)
    for (call in listOf(portal,http,m3u)) {
        check(call.code == "https_required")
        check(call.error!!.contains("HTTPS") && !call.error!!.contains(endpoint))
    }
    server.soTimeout=150
    try { server.accept(); error("Play attempted plaintext network before rejection") } catch (_: SocketTimeoutException) {}
    BuildConfig.FLAVOR = "full"
    var forwardedHeaders: Map<String, String>? = null
    val worker = Thread {
        repeat(2) { requestIndex ->
            server.soTimeout=4000
            server.accept().use { socket ->
                val input=socket.getInputStream().bufferedReader()
                input.readLine() // request line
                val captured = linkedMapOf<String, String>()
                while (true) {
                    val line = input.readLine().orEmpty()
                    if (line.isEmpty()) break
                    val colon = line.indexOf(':')
                    if (colon > 0) captured[line.substring(0, colon).lowercase(java.util.Locale.ROOT)] = line.substring(colon + 1).trim()
                }
                if (requestIndex == 0) forwardedHeaders = captured
                socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}".toByteArray())
            }
        }
    }.apply { start() }
    val headerValues = JSObject().put("X-String", "fixture").put("X-Empty", "")
        .put("X-Number", 7).put("X-Boolean", true).put("X-Json-Null", org.json.JSONObject.NULL)
        .put("X-Object", JSObject().put("nested", "value"))
        .put("X-Removed", "old").put("X-Removed", null)
    val fullHttp = PluginCall(JSObject().put("url",endpoint).put("headers", headerValues)); generic.httpRequest(fullHttp); wait(fullHttp)
    check(fullHttp.error == null && fullHttp.result.getInt("status")==200)
    val fullM3u = PluginCall(JSObject().put("url",endpoint)); playlist.proxyFetch(fullM3u); wait(fullM3u)
    check(fullM3u.error == null && fullM3u.result.getString("body")=="{}")
    worker.join(5000); server.close(); check(!worker.isAlive)
    val forwarded = checkNotNull(forwardedHeaders)
    check(forwarded["x-string"] == "fixture" && forwarded["x-empty"] == "")
    check(forwarded["x-number"] == "7" && forwarded["x-boolean"] == "true")
    check(forwarded["x-json-null"] == "null" && forwarded["x-object"] == "{\"nested\":\"value\"}")
    check("x-removed" !in forwarded && "x-absent" !in forwarded)
    println("PASS actual HTTP header coercion: strings, empty, number, boolean, JSON null/object, removed and absent keys")
    val failure = PluginCall(JSObject().put("url",endpoint)); generic.httpRequest(failure); wait(failure)
    check(failure.error != null && !failure.error!!.contains("token") && !failure.error!!.contains("127.0.0.1"))
    println("PASS actual Android HTTP plugins: SWOP refuses plaintext/credentials/query/normalized paths in both editions; Play rejects HTTP before network; Full native HTTP/M3U retain requests; errors omit provider URLs")
    screenshotTransport()
    providerResponseBounds()
    backgroundStandby()
    SystemMediaControl.run()
    DestroyedLocalOwner.run()
}
'''
service=(ROOT/'android/app/src/main/java/play/ott/foss/MediaPlaybackService.kt').read_text()
start=service.index('private fun evalOnWebView(')
end=service.index('{',start)+1
depth=1
while depth:
    depth+=(service[end]=='{')-(service[end]=='}')
    end+=1
MAIN=MAIN.replace('// ACTUAL_EVAL_ON_WEB_VIEW', service[start:end])
local=(ROOT/'android/app/src/main/java/play/ott/foss/LocalMediaPlugin.kt').read_text()
start=local.index('private class QueuedWork(')
end=local.index('{',start)+1
depth=1
while depth:
    depth+=(local[end]=='{')-(local[end]=='}')
    end+=1
MAIN=MAIN.replace('// ACTUAL_QUEUED_WORK', local[start:end])
assert 'ownedWork.forEach { it.cancel() }' in local
assert '(clients.shutdownNow() + worker.shutdownNow()).forEach { (it as? QueuedWork)?.discardBeforeStart() }' in local
SDK=Path(os.environ.get('ANDROID_SDK_ROOT',os.environ.get('ANDROID_HOME','/opt/homebrew/share/android-commandlinetools')))/'platforms/android-36/android.jar'
JSON=Path(os.environ['ANDROID_JSON_JAR'])
HTTP_JARS=[Path(p) for p in os.environ['ANDROID_HTTP_CLASSPATH'].split(os.pathsep)]
assert HTTP_JARS and all(p.is_file() for p in HTTP_JARS), 'Real OkHttp and Okio jars are required'
JAVA=Path(os.environ['JAVA_HOME'])/'bin' if os.environ.get('JAVA_HOME') else Path('/usr/bin')
with tempfile.TemporaryDirectory(prefix='ott-http-policy-') as directory:
    temp=Path(directory); classes=temp/'classes';classes.mkdir()
    files=[]
    for name in ['JSObject','JSArray']:
        path=temp/(name+'.java'); path.write_text((ROOT/f'node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/{name}.java').read_text());files.append(str(path))
    annotation=temp/'Nullable.java'; annotation.write_text('package androidx.annotation; public @interface Nullable {}');files.append(str(annotation))
    subprocess.run([str(JAVA/'javac'),'--release','17','-cp',str(SDK),'-d',str(classes),*files],check=True)
    (temp/'Capacitor.kt').write_text(CAP)
    (temp/'BuildConfig.kt').write_text('package play.ott.foss\nobject BuildConfig { var FLAVOR = "play" }')
    (temp/'Annotation.kt').write_text('package com.getcapacitor.annotation\nannotation class CapacitorPlugin(val name: String)')
    (temp/'Main.kt').write_text(MAIN)
    sources=[str(ROOT/f'android/app/src/main/java/play/ott/foss/{name}.kt') for name in ['StalkerPortalPlugin','M3UProxyPlugin','ProviderHttpResponse','NativeWork']]
    subprocess.run([shutil.which('kotlinc') or 'kotlinc','-jvm-target','17','-cp',os.pathsep.join(map(str,[classes,SDK,*HTTP_JARS])),*map(str,temp.glob('*.kt')),*sources,'-include-runtime','-d',str(temp/'test.jar')],check=True)
    subprocess.run([str(JAVA/'java'),'-Xmx64m','-cp',os.pathsep.join(map(str,[temp/'test.jar',classes,JSON,*HTTP_JARS])),'fixture.MainKt'],check=True,timeout=30)

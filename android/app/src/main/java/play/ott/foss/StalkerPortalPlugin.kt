// Mode B native HTTP for Stalker /stalker_portal/api/, host_ott/swop/a.php,
// and Mag path-shaped /load.php|/c/portal URLs (allowlist + header forward only).
package play.ott.foss

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.HttpURLConnection
import java.net.URL
import okhttp3.OkHttpClient
import okhttp3.CookieJar
import okhttp3.Authenticator
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

@CapacitorPlugin(name = "StalkerPortal")
class StalkerPortalPlugin : Plugin() {
    private val screenshotRequests = HashMap<String, ScreenshotRequest>()
    private var screenshotDestroyed = false
    private class ScreenshotRequest(val call: PluginCall, val task: okhttp3.Call) {
        val settled = AtomicBoolean(false)
        fun cancel() {
            task.cancel()
            if (settled.compareAndSet(false, true)) call.reject("Screenshot transport cancelled", "cancelled")
        }
    }

    private val swopClient = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false)
        .cookieJar(CookieJar.NO_COOKIES)
        .authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE)
        .proxy(java.net.Proxy.NO_PROXY)
        .callTimeout(10, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS)
        .build()


    /** Archived bridge fixture; the standalone Android app has its own transport. */
    @PluginMethod
    fun swopRequest(call: PluginCall) {
        Thread {
            try {
                val raw = call.getString("url") ?: error("missing url")
                require(Regex("^https://([A-Za-z0-9.-]+|\\[[0-9a-fA-F:]+\\])(:[0-9]{1,5})?/swop/(session|val)$").matches(raw))
                val uri = java.net.URI(raw)
                require(uri.host != null && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null)
                require(uri.port == -1 || uri.port in 1..65535)
                val body = call.getString("body") ?: error("missing body")
                val bytes = body.toByteArray(Charsets.UTF_8)
                require(bytes.size <= 65536)
                val json = org.json.JSONTokener(body)
                require(json.nextValue() is org.json.JSONObject && json.nextClean() == '\u0000')
                val clientId = call.getString("clientId") ?: error("missing identity")
                require(Regex("^[A-Za-z0-9._:-]{1,128}$").matches(clientId))
                // Explicit native assertion about the relay, not browser proof/auth.
                val origin = "https://" + uri.host + if (uri.port != -1 && uri.port != 443) ":${uri.port}" else ""
                val request = Request.Builder().url(raw)
                    .header("Origin", origin).header("Accept", "application/json")
                    .header("X-Swop-Client-Id", clientId)
                    .post(bytes.toRequestBody("application/json".toMediaType())).build()
                swopClient.newCall(request).execute().use { response ->
                    require(response.code !in 300..399)
                    // API 22 uses OkHttp 4 (nullable body); current devices use OkHttp 5.
                    val responseBody = checkNotNull(response.body) { "missing response" }
                    require(responseBody.contentLength() <= 65536)
                    val output = ByteArrayOutputStream()
                    responseBody.byteStream().use { stream ->
                        val buffer = ByteArray(4096)
                        while (true) {
                            val read = stream.read(buffer)
                            if (read == -1) break
                            require(output.size() + read <= 65536)
                            output.write(buffer, 0, read)
                        }
                    }
                    val text = Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(output.toByteArray())).toString()
                    call.resolve(JSObject().put("status", response.code).put("statusText", response.message)
                        .put("body", text).put("headers", "Content-Type: application/json\r\n"))
                }
            } catch (error: Exception) {
                call.reject("Native remote text entry request failed",
                    if (error is java.io.InterruptedIOException) "timeout" else null)
            }
        }.start()
    }

    private fun isAllowedUrl(url: String): Boolean {
        return url.contains("/stalker_portal/api/") ||
            url.contains("/stalker_portal/stream/") ||
            url.contains("/swop/a.php") ||
            url.contains("/load.php") ||
            url.contains("/portal.php") ||
            url.contains("/c/portal")
    }

    private fun isForbiddenHeader(name: String): Boolean {
        val n = name.lowercase()
        return n == "host" || n == "content-length" || n == "connection" ||
            n == "transfer-encoding" || n == "upgrade"
    }

    @PluginMethod
    fun portalRequest(call: PluginCall) {
        val rawUrl = call.getString("url") ?: run {
            call.reject("missing url")
            return
        }
        if (!isAllowedUrl(rawUrl)) {
            call.reject("url is not an allowed stalker/swop/load.php/c/portal path")
            return
        }
        performRequest(call, rawUrl)
    }

    @PluginMethod
    fun httpRequest(call: PluginCall) {
        val rawUrl = call.getString("url") ?: run {
            call.reject("missing url")
            return
        }
        if (call.getBoolean("screenshotControl", false) == true) screenshotRequest(call, rawUrl)
        else performRequest(call, rawUrl)
    }

    @PluginMethod
    fun cancelHttpRequest(call: PluginCall) {
        val id = call.getString("requestId").orEmpty()
        if (!Regex("^[A-Za-z0-9_-]{1,128}$").matches(id)) {
            call.reject("Invalid HTTP request identifier"); return
        }
        val pending = synchronized(screenshotRequests) { screenshotRequests.remove(id) }
        pending?.cancel()
        call.resolve(JSObject().put("cancelled", pending != null))
    }

    override fun handleOnDestroy() {
        val pending = synchronized(screenshotRequests) {
            screenshotDestroyed = true
            screenshotRequests.values.toList().also { screenshotRequests.clear() }
        }
        pending.forEach { it.cancel() }
        super.handleOnDestroy()
    }

    private fun screenshotRequest(call: PluginCall, raw: String) {
        try {
            val limit = 2 * 1024 * 1024
            require(raw.length <= 8192 && raw.none { it <= ' ' || it == '\u007f' || it == '\\' })
            val uri = java.net.URI(raw)
            require(uri.host != null && uri.rawUserInfo == null && uri.rawFragment == null)
            require(uri.port == -1 || uri.port in 1..65535)
            val loopback = uri.host.lowercase() in listOf("localhost", "127.0.0.1", "[::1]", "::1")
            require(uri.scheme == "https" || (uri.scheme == "http" && loopback))
            if (BuildConfig.FLAVOR == "play" && uri.scheme != "https") {
                call.reject("This edition requires HTTPS for screenshots", "https_required"); return
            }
            val id = call.getString("requestId") ?: "screenshot_" + java.util.UUID.randomUUID()
            require(Regex("^[A-Za-z0-9_-]{1,128}$").matches(id))
            val method = call.getString("method") ?: "GET"
            val body = (call.getString("body") ?: "").toByteArray(Charsets.UTF_8)
            val timeout = call.getInt("timeoutMs") ?: 15000
            require(method in listOf("GET", "POST") && body.size <= limit && (method != "GET" || body.isEmpty()))
            require(timeout in 1..60000)
            val builder = Request.Builder().url(raw).header("Content-Type", "application/json")
            val headers = call.getObject("headers")
            val seen = HashSet<String>()
            headers?.keys()?.forEach { name ->
                val key = name.lowercase()
                val value = headers.opt(name)
                require(key in listOf("authorization", "accept", "content-type") && seen.add(key))
                require(value is String && value.toByteArray(Charsets.UTF_8).size <= 1024 && value.none { it < ' ' || it == '\u007f' })
                builder.header(name, value)
            }
            if (method == "POST") builder.post(body.toRequestBody("application/json".toMediaType()))
            else builder.get()
            // swopClient has no redirects, cookie jar, authenticator, proxy or
            // provider interceptor. A derived client changes only this timeout.
            val client = swopClient.newBuilder().callTimeout(timeout.toLong(), TimeUnit.MILLISECONDS).build()
            val task = client.newCall(builder.build())
            val pending = ScreenshotRequest(call, task)
            synchronized(screenshotRequests) {
                if (screenshotDestroyed || screenshotRequests.size >= 8 || screenshotRequests.containsKey(id)) {
                    call.reject("Screenshot transport is busy or unavailable", "busy"); return
                }
                screenshotRequests[id] = pending
            }
            val callback = object : okhttp3.Callback {
                private fun finish(result: JSObject?, code: String = "transport_failed") {
                    synchronized(screenshotRequests) {
                        if (screenshotRequests[id] === pending) screenshotRequests.remove(id)
                    }
                    if (!pending.settled.compareAndSet(false, true)) return
                    if (result != null) call.resolve(result)
                    else call.reject("Screenshot transport failed", code)
                }
                override fun onFailure(call: okhttp3.Call, e: IOException) {
                    finish(null, if (e is java.io.InterruptedIOException) "timeout" else "transport_failed")
                }
                override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                    try {
                        response.use {
                            require(response.code !in 300..399)
                            val responseBody = checkNotNull(response.body) { "Empty HTTP response" }
                            require(responseBody.contentLength() <= limit)
                            val output = ByteArrayOutputStream()
                            responseBody.byteStream().use { stream ->
                                val buffer = ByteArray(8192)
                                while (true) {
                                    val read = stream.read(buffer)
                                    if (read == -1) break
                                    require(output.size() + read <= limit)
                                    output.write(buffer, 0, read)
                                }
                            }
                            val text = Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(output.toByteArray())).toString()
                            finish(JSObject().put("status", response.code).put("statusText", response.message)
                                .put("body", text).put("headers", "Content-Type: application/json\r\n"))
                        }
                    } catch (_: Exception) { finish(null) }
                }
            }
            try { task.enqueue(callback) }
            catch (_: Exception) {
                synchronized(screenshotRequests) {
                    if (screenshotRequests[id] === pending) screenshotRequests.remove(id)
                }
                pending.cancel()
            }
        } catch (_: Exception) {
            call.reject("Invalid screenshot transport request", "invalid_request")
        }
    }

    // API22 uses OkHttp4 (nullable body); modern shells use OkHttp5.
    private fun readBody(body: okhttp3.ResponseBody?, head: Boolean): String =
        ProviderHttpResponse.read(body?.byteStream(), if (head) -1 else body?.contentLength() ?: -1)

    private fun performRequest(call: PluginCall, rawUrl: String) {
        val urlStr = rawUrl
        val method = (call.getString("method") ?: "GET").uppercase()
        val bodyString = call.getString("body") ?: ""
        val contentType = call.getString("contentType") ?: "application/json"
        val headersObj = call.getObject("headers")

        val control = call.getBoolean("remoteControl", false) == true ||
            call.getBoolean("secureControl", false) == true
        val ticket = if (control) null else NativeWork.begin()
        if (!control && ticket == null) { call.reject("Player is in standby", "standby"); return }
        Thread {
            try {
                ticket?.check()
                val url = URL(urlStr)
                require(url.protocol == "http" || url.protocol == "https")
                if (BuildConfig.FLAVOR == "play" && url.protocol == "http") {
                    call.reject("OTT-play FOSS Play requires HTTPS sources. Use an HTTPS provider URL or the Full edition for HTTP sources.", "https_required")
                    return@Thread
                }
                val timeout = (call.getInt("timeoutMs") ?: 15000).coerceAtLeast(1)
                val builder = Request.Builder().url(urlStr)
                var contentTypeFromHeaders = false
                if (headersObj != null) {
                    val keys = headersObj.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        if (isForbiddenHeader(key)) continue
                        val value = headersObj.opt(key)?.toString() ?: continue
                        if (key.equals("content-type", ignoreCase = true)) contentTypeFromHeaders = true
                        builder.header(key, value)
                    }
                }
                if (!contentTypeFromHeaders && bodyString.isNotEmpty()) builder.header("Content-Type", contentType)
                val body = if (method in listOf("GET", "HEAD")) null
                    else bodyString.toRequestBody(null)
                builder.method(method, body)
                val client = OkHttpClient.Builder().connectTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
                    .followSslRedirects(false)
                    .readTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
                    .callTimeout(timeout.toLong(), TimeUnit.MILLISECONDS).build()
                val task = client.newCall(builder.build())
                ticket?.cancelWith { task.cancel() }
                ticket?.check()
                task.execute().use { response ->
                    val text = readBody(response.body, method == "HEAD")
                    ticket?.check()
                    val cookies = JSArray()
                    response.headers.values("Set-Cookie").forEach { cookies.put(it) }
                    val responseHeaders = StringBuilder()
                    response.headers.forEach { (key, value) -> responseHeaders.append(key).append(": ").append(value).append("\r\n") }
                    call.resolve(JSObject().put("status", response.code).put("statusText", response.message)
                        .put("headers", responseHeaders.toString()).put("body", text)
                        .put("contentType", response.header("Content-Type") ?: "application/octet-stream").put("setCookie", cookies))
                }
            } catch (e: Exception) {
                val code = when (e) {
                    is ProviderHttpResponse.TooLarge -> "response_too_large"
                    is java.net.SocketTimeoutException -> "timeout"
                    else -> null
                }
                val message = when (e) {
                    is ProviderHttpResponse.TooLarge -> "Provider response exceeds the 8 MiB limit; use a smaller or paginated source"
                    is java.net.SocketTimeoutException -> "Provider request timed out"
                    is javax.net.ssl.SSLException -> "Provider TLS connection failed; check its HTTPS certificate"
                    is java.net.UnknownHostException -> "Provider hostname could not be resolved"
                    else -> "Provider request failed or cancelled"
                }
                call.reject(message, code)
            } finally { ticket?.finish() }
        }.start()
    }
}

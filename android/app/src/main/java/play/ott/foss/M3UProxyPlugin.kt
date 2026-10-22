package play.ott.foss

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit
import java.net.URL

@CapacitorPlugin(name = "M3UProxy")
class M3UProxyPlugin : Plugin() {

    override fun load() {
        // no-op
    }

    @PluginMethod
    fun proxyFetch(call: PluginCall) {
        val rawUrl = call.getString("url") ?: run {
            call.reject("missing url")
            return
        }

        var urlStr = rawUrl
        if (urlStr.startsWith("@")) urlStr = urlStr.substring(1)

        val referer = call.getString("referer") ?: ""
        val userAgent = call.getString("userAgent") ?: ""

        val ua = if (userAgent.isEmpty()) {
            DEFAULT_UA
        } else {
            UA_PRESETS[userAgent.lowercase()] ?: userAgent
        }

        val origin = try {
            val u = URL(urlStr)
            "${u.protocol}://${u.host}"
        } catch (_: Exception) { "" }

        val effectiveReferer = if (referer.isNotEmpty()) referer else origin

        val ticket = NativeWork.begin() ?: run { call.reject("Player is in standby", "standby"); return }
        Thread {
            try {
                ticket.check()
                val address = URL(urlStr)
                if (BuildConfig.FLAVOR == "play" && address.protocol == "http") {
                    call.reject("OTT-play FOSS Play requires HTTPS sources. Use an HTTPS playlist URL or the Full edition for HTTP sources.", "https_required")
                    return@Thread
                }
                val request = Request.Builder().url(address).header("User-Agent", ua)
                if (effectiveReferer.isNotEmpty()) request.header("Referer", effectiveReferer)
                val task = client.newCall(request.build())
                ticket.cancelWith { task.cancel() }
                ticket.check()
                task.execute().use { response ->
                    val body = readBody(response.body)
                    ticket.check()
                    if (!response.isSuccessful) { call.reject("Playlist provider returned HTTP ${response.code}"); return@Thread }
                    call.resolve(JSObject().put("body", body))
                }
            } catch (e: Exception) {
                val message = when (e) {
                    is ProviderHttpResponse.TooLarge -> "Playlist response exceeds the 8 MiB limit; use a smaller playlist"
                    is java.net.SocketTimeoutException -> "Playlist request timed out"
                    is javax.net.ssl.SSLException -> "Playlist TLS connection failed; check its HTTPS certificate"
                    else -> "Playlist request failed"
                }
                call.reject(message, if (e is ProviderHttpResponse.TooLarge) "response_too_large" else null)
            } finally {
                ticket.finish()
            }
        }.start()
    }

    companion object {
        // API22 uses OkHttp4 (nullable body); modern shells use OkHttp5.
        private fun readBody(body: okhttp3.ResponseBody?): String =
            ProviderHttpResponse.read(body?.byteStream(), body?.contentLength() ?: -1)
        private val client = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
            .followSslRedirects(false)
            .readTimeout(15, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS).build()
        private const val DEFAULT_UA = "OTT-play-FOSS/1.0"

        private val UA_PRESETS: Map<String, String> = mapOf(
            "webos" to "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36 LG Browser/9.00.00",
            "tizen" to "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) SamsungTV/3.0 Chrome/76.0.3809.146 Safari/537.36",
            "viera" to "Mozilla/5.0 (Unknown; Linux; Viera/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36",
            "mag" to "Mozilla/5.0 (STB; Infomir MAG524) Maple 6.0 QtWebKit/3.0",
            "dune" to "Mozilla/5.0 (Dune HD; DuneOS) AppleWebKit/537.36 (KHTML, like Gecko) DuneHD/1.0 Chrome/68.0.3440.106 Safari/537.36"
        )
    }
}

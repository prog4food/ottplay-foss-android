package play.ott.foss

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.webkit.WebView
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

/** On-demand host-process observations. Never creates a player, listener or network request. */
@CapacitorPlugin(name = "RuntimeDiagnostics")
class RuntimeDiagnosticsPlugin : Plugin() {
    private val startedAt = SystemClock.elapsedRealtime()
    private val main = Handler(Looper.getMainLooper())
    private var foreground: Boolean? = null
    private var destroyed = false

    companion object {
        private const val MAX_SAFE_INTEGER = 9007199254740991L
        private val VERSION = Regex("[A-Za-z0-9_.+-]{1,64}")

        internal fun version(value: String?): Any =
            if (value != null && VERSION.matches(value)) value else JSONObject.NULL

        internal fun number(metrics: JSObject, key: String, value: Long) {
            if (value in 0..MAX_SAFE_INTEGER) metrics.put(key, value)
        }
    }

    @PluginMethod
    fun snapshot(call: PluginCall) {
        main.post {
            if (destroyed) {
                call.reject("Runtime diagnostics owner was destroyed", "unavailable")
                return@post
            }
            val metrics = JSObject()
            val now = SystemClock.elapsedRealtime()
            number(metrics, "uptimeMs", now - startedAt)
            number(metrics, "systemUptimeMs", now)
            val runtime = Runtime.getRuntime()
            number(metrics, "heapUsedBytes", runtime.totalMemory() - runtime.freeMemory())
            number(metrics, "heapLimitBytes", runtime.maxMemory())
            number(metrics, "logicalProcessors", runtime.availableProcessors().toLong())
            foreground?.let { metrics.put("foreground", it) }

            // PSS is proportional shared memory, not RSS. WebView renderer processes
            // and protected GPU allocations are outside this host-process sample.
            try {
                val memory = Debug.MemoryInfo()
                Debug.getMemoryInfo(memory)
                number(metrics, "pssBytes", memory.totalPss.toLong() * 1024)
            } catch (_: Exception) { /* Omit unavailable observations. */ }
            try {
                val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
                if (manager != null) {
                    val memory = ActivityManager.MemoryInfo()
                    manager.getMemoryInfo(memory)
                    number(metrics, "systemAvailableBytes", memory.availMem)
                    number(metrics, "systemTotalBytes", memory.totalMem)
                    metrics.put("lowMemory", memory.lowMemory)
                }
            } catch (_: Exception) { /* Omit unavailable observations. */ }
            try {
                val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
                if (power != null) {
                    metrics.put("lowPower", power.isPowerSaveMode)
                    if (Build.VERSION.SDK_INT >= 29) {
                        val thermal = power.currentThermalStatus
                        if (thermal in 0..6) number(metrics, "thermalState", thermal.toLong())
                    }
                }
            } catch (_: Exception) { /* Omit unavailable observations. */ }
            var webview: String? = null
            if (Build.VERSION.SDK_INT >= 26) {
                try {
                    webview = WebView.getCurrentWebViewPackage()?.versionName
                } catch (_: Exception) { /* Package metadata may be unavailable. */ }
            }
            call.resolve(JSObject().apply {
                put("version", 1)
                put("platform", "android")
                put("appVersion", version(BuildConfig.VERSION_NAME))
                put("osVersion", version(Build.VERSION.RELEASE))
                put("webviewVersion", version(webview))
                put("metrics", metrics)
            })
        }
    }

    override fun handleOnResume() {
        foreground = true
        super.handleOnResume()
    }

    override fun handleOnPause() {
        foreground = false
        super.handleOnPause()
    }

    override fun handleOnDestroy() {
        destroyed = true
        foreground = null
        super.handleOnDestroy()
    }
}

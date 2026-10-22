package play.ott.foss

import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.PixelCopy
import android.view.View
import android.view.Window
import android.view.WindowManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** Own-window capture for compatible Capacitor shells, never a display recording. */
@CapacitorPlugin(name = "RemoteScreenshot")
class RemoteScreenshotPlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())
    private val encoder = Executors.newSingleThreadExecutor()
    private var destroyed = false
    private var paused = false
    private var pending: Request? = null

    private class Request(var call: PluginCall?, val window: Window) {
        var deadline: Runnable? = null
    }

    private fun onMain(action: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) action() else main.post(action)
    }

    @PluginMethod
    fun capabilities(call: PluginCall) = onMain {
        val supported = !destroyed && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        call.resolve(JSObject().apply {
            put("supported", supported)
            put("source", if (supported) "player-window" else org.json.JSONObject.NULL)
        })
    }

    @PluginMethod
    fun capture(call: PluginCall) = onMain {
        if (destroyed || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.reject("Own-window screenshots require Android 8 or newer", "unavailable")
            return@onMain
        }
        if (pending != null) {
            call.reject("A screenshot is already in progress", "busy")
            return@onMain
        }
        val window = activity?.window
        if (window == null || !isVisible(window)) {
            call.reject("Player window is unavailable or protected", "unavailable")
            return@onMain
        }
        val decor = window.decorView
        val scale = min(1.0, min(1280.0 / decor.width, 720.0 / decor.height))
        val bitmap = try {
            Bitmap.createBitmap(max(1, floor(decor.width * scale).toInt()),
                max(1, floor(decor.height * scale).toInt()), Bitmap.Config.ARGB_8888)
        } catch (_: OutOfMemoryError) {
            call.reject("Insufficient memory for screenshot", "capture-failed")
            return@onMain
        }
        val request = Request(call, window)
        pending = request
        val deadline = Runnable { reject(request, "Screenshot timed out", "timeout") }
        request.deadline = deadline
        main.postDelayed(deadline, 10_000)
        // Animation callbacks precede drawing. The second frame crosses a full
        // traversal so recent UI changes are not copied from the old
        // window buffer. Recheck the owner before starting native PixelCopy.
        val copyAfterPaint = Runnable {
            if (!isCurrent(request)) {
                bitmap.recycle()
                finish(request, "Player window changed before screenshot", "unavailable")
                return@Runnable
            }
            try {
                // No View.draw fallback: it would bypass the platform's protection
                // checks and omit hardware surfaces while appearing successful.
                PixelCopy.request(window, bitmap, { result ->
                    if (result != PixelCopy.SUCCESS || !isCurrent(request)) {
                        bitmap.recycle()
                        finish(request, "Player window could not be captured", "capture-failed")
                    } else {
                        try {
                            encoder.execute {
                                val encoded = try { encode(bitmap) }
                                    catch (_: Exception) { null }
                                    catch (_: OutOfMemoryError) { null }
                                main.post {
                                    if (!isCurrent(request)) {
                                        finish(request, "Player window changed during screenshot", "unavailable")
                                    } else if (encoded == null) {
                                        finish(request, "Screenshot could not fit the image limit", "capture-failed")
                                    } else {
                                        request.deadline?.let { main.removeCallbacks(it) }
                                        request.deadline = null
                                        val activeCall = request.call
                                        request.call = null
                                        pending = null
                                        activeCall?.resolve(JSObject().apply {
                                            put("image", encoded.image)
                                            put("width", encoded.width)
                                            put("height", encoded.height)
                                            put("source", "player-window")
                                            // SurfaceView/protected video may be absent. Never
                                            // represent this as a verified complete video frame.
                                            put("video", "unknown")
                                        })
                                    }
                                }
                            }
                        } catch (_: RejectedExecutionException) {
                            bitmap.recycle()
                            finish(request, "Screenshot owner was destroyed", "unavailable")
                        }
                    }
                }, main)
            } catch (_: Exception) {
                bitmap.recycle()
                finish(request, "Player window could not be captured", "capture-failed")
            }
        }
        decor.postOnAnimation { decor.postOnAnimation(copyAfterPaint) }
    }

    private fun isVisible(window: Window): Boolean {
        val owner = activity ?: return false
        val decor = window.decorView
        return !destroyed && !paused && !owner.isFinishing && !owner.isDestroyed &&
            owner.window === window && owner.hasWindowFocus() &&
            window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE == 0 &&
            decor.isAttachedToWindow && decor.isShown && decor.windowVisibility == View.VISIBLE &&
            decor.width > 0 && decor.height > 0
    }

    private fun isCurrent(request: Request): Boolean =
        pending === request && request.call != null && isVisible(request.window)

    private fun reject(request: Request, message: String, code: String) {
        request.deadline?.let { main.removeCallbacks(it) }
        request.deadline = null
        request.call?.reject(message, code)
        request.call = null
        // PixelCopy has no cancellation API. Preserve the occupied slot until
        // its callback drains, so repeated timeouts cannot retain more bitmaps.
    }

    private fun finish(request: Request, message: String, code: String) {
        reject(request, message, code)
        if (pending === request) pending = null
    }

    override fun shouldOverrideLoad(url: Uri): Boolean? {
        onMain { pending?.let { reject(it, "Player navigation interrupted screenshot", "unavailable") } }
        return null
    }

    override fun handleOnPause() {
        onMain {
            paused = true
            pending?.let { reject(it, "Player is not in the foreground", "unavailable") }
        }
        super.handleOnPause()
    }

    override fun handleOnResume() {
        onMain { paused = false }
        super.handleOnResume()
    }

    override fun handleOnDestroy() {
        onMain {
            destroyed = true
            pending?.let { reject(it, "Screenshot owner was destroyed", "unavailable") }
            encoder.shutdown()
        }
        super.handleOnDestroy()
    }

    private data class Encoded(val image: String, val width: Int, val height: Int)

    private fun encode(original: Bitmap): Encoded? {
        var bitmap = original
        try {
            while (true) {
                val bytes = ByteArrayOutputStream().use { output ->
                    if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) return null
                    output.toByteArray()
                }
                if (bytes.size <= 1024 * 1024) {
                    return Encoded(Base64.encodeToString(bytes, Base64.NO_WRAP), bitmap.width, bitmap.height)
                }
                if (bitmap.width <= 1 && bitmap.height <= 1) return null
                val smaller = Bitmap.createScaledBitmap(bitmap, max(1, bitmap.width / 2), max(1, bitmap.height / 2), true)
                bitmap.recycle()
                bitmap = smaller
            }
        } finally {
            bitmap.recycle()
        }
    }
}

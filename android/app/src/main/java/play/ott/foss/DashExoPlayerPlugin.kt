package play.ott.foss

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.graphics.Color
import android.os.Build
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.app.NotificationCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Capacitor plugin wrapping Media3/ExoPlayer for native DASH (and HLS) playback.
 * Renders into a PlayerView overlay on the Cap Activity so video is visible.
 * DRM/Widevine is out of scope.
 */
@CapacitorPlugin(name = "DashExoPlayer")
class DashExoPlayerPlugin : Plugin() {

    companion object {
        private const val TAG = "DashExoPlayer"
        private const val CHANNEL_ID = "dash_player"
        private const val NOTIFICATION_ID = 4406
    }

    private var stopSubscription: (() -> Unit)? = null
    override fun load() {
        stopSubscription = NativeWork.onStandbyAsync { done ->
            val act = activity
            if (act == null) done()
            else act.runOnUiThread { try { tearDown() } finally { done() } }
        }
    }
    private var player: ExoPlayer? = null
    private var playerView: PlayerView? = null
    private var overlay: FrameLayout? = null

    @PluginMethod
    fun isDashSupported(call: PluginCall) {
        call.resolve(
            JSObject().apply {
                put("ok", true)
                put("unsupported", false)
            }
        )
    }

    @PluginMethod
    fun playDash(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) {
            call.resolve(
                JSObject().apply {
                    put("ok", false)
                    put("error", "missing url")
                }
            )
            return
        }
        // JS passes seconds (stbPlay position); ExoPlayer seeks in ms.
        val positionMs = ((call.getDouble("position") ?: 0.0) * 1000.0).toLong()
        val act = activity
        if (act == null) {
            call.resolve(
                JSObject().apply {
                    put("ok", false)
                    put("error", "no activity")
                }
            )
            return
        }
        act.runOnUiThread {
            if (NativeWork.isStandby) { call.reject("Player is in standby", "standby"); return@runOnUiThread }
            try {
                ensureOverlay(act)
                releasePlayerKeepOverlay()
                val p = ExoPlayer.Builder(act).build()
                player = p
                playerView?.player = p
                val mime = mimeForUrl(url)
                val itemBuilder = MediaItem.Builder().setUri(url)
                if (mime != null) {
                    itemBuilder.setMimeType(mime)
                }
                p.setMediaItem(itemBuilder.build())
                p.addListener(
                    object : Player.Listener {
                        override fun onPlayerError(error: PlaybackException) {
                            Log.e(TAG, "ExoPlayer error", error)
                        }
                    }
                )
                p.prepare()
                if (positionMs > 0) {
                    p.seekTo(positionMs)
                }
                p.playWhenReady = true
                showOverlay()
                notifyPlaying(true)
                call.resolve(JSObject().apply { put("ok", true) })
            } catch (e: Exception) {
                Log.e(TAG, "playDash failed", e)
                call.resolve(
                    JSObject().apply {
                        put("ok", false)
                        put("error", e.message ?: "playDash failed")
                    }
                )
            }
        }
    }

    @PluginMethod
    fun pauseDash(call: PluginCall) {
        val act = activity
        if (act == null) {
            call.resolve(
                JSObject().apply {
                    put("ok", false)
                    put("error", "no activity")
                }
            )
            return
        }
        act.runOnUiThread {
            val p = player
            if (p == null) {
                call.resolve(
                    JSObject().apply {
                        put("ok", false)
                        put("error", "no active player")
                    }
                )
                return@runOnUiThread
            }
            p.playWhenReady = false
            notifyPlaying(false)
            call.resolve(JSObject().apply { put("ok", true) })
        }
    }

    @PluginMethod
    fun resumeDash(call: PluginCall) {
        val act = activity
        if (act == null) {
            call.resolve(
                JSObject().apply {
                    put("ok", false)
                    put("error", "no activity")
                }
            )
            return
        }
        act.runOnUiThread {
            if (NativeWork.isStandby) { call.reject("Player is in standby", "standby"); return@runOnUiThread }
            val p = player
            if (p == null) {
                call.resolve(
                    JSObject().apply {
                        put("ok", false)
                        put("error", "no active player")
                    }
                )
                return@runOnUiThread
            }
            p.playWhenReady = true
            showOverlay()
            notifyPlaying(true)
            call.resolve(JSObject().apply { put("ok", true) })
        }
    }

    @PluginMethod
    fun getPlaybackState(call: PluginCall) {
        val act = activity
        if (act == null) {
            call.resolve(JSObject().apply {
                put("ok", false)
                put("position", 0.0)
                put("duration", 0.0)
                put("playing", false)
                put("ended", false)
                put("error", "no activity")
            })
            return
        }
        act.runOnUiThread {
            val p = player
            call.resolve(JSObject().apply {
                put("ok", p != null)
                put("position", (p?.currentPosition ?: 0L).coerceAtLeast(0L) / 1000.0)
                // ExoPlayer uses a negative sentinel for unknown/live duration.
                put("duration", (p?.duration ?: 0L).coerceAtLeast(0L) / 1000.0)
                put("playing", p?.isPlaying ?: false)
                put("ended", p?.playbackState == Player.STATE_ENDED)
            })
        }
    }

    @PluginMethod
    fun seekDash(call: PluginCall) {
        val position = call.getDouble("position")
        if (position == null || !position.isFinite()) {
            call.resolve(JSObject().apply {
                put("ok", false)
                put("error", "invalid position")
            })
            return
        }
        val act = activity
        if (act == null) {
            call.resolve(JSObject().apply {
                put("ok", false)
                put("error", "no activity")
            })
            return
        }
        act.runOnUiThread {
            val p = player
            if (p == null) {
                call.resolve(JSObject().apply {
                    put("ok", false)
                    put("error", "no active player")
                })
                return@runOnUiThread
            }
            var millis = (position.coerceAtLeast(0.0) * 1000.0).toLong()
            if (p.duration > 0) millis = millis.coerceAtMost(p.duration)
            p.seekTo(millis)
            call.resolve(JSObject().apply { put("ok", true) })
        }
    }

    @PluginMethod
    fun stopDash(call: PluginCall) {
        val act = activity
        if (act == null) {
            call.resolve(
                JSObject().apply {
                    put("ok", false)
                    put("error", "no activity")
                }
            )
            return
        }
        act.runOnUiThread {
            tearDown()
            call.resolve(JSObject().apply { put("ok", true) })
        }
    }

    override fun handleOnDestroy() {
        stopSubscription?.invoke(); stopSubscription = null
        tearDown()
        super.handleOnDestroy()
    }

    private fun mimeForUrl(url: String): String? {
        val path = url.lowercase().substringBefore('?')
        return when {
            path.endsWith(".mpd") -> MimeTypes.APPLICATION_MPD
            path.endsWith(".m3u8") -> MimeTypes.APPLICATION_M3U8
            else -> null
        }
    }

    private fun ensureOverlay(act: android.app.Activity) {
        if (overlay != null && playerView != null) return
        val root = act.findViewById<ViewGroup>(android.R.id.content)
        val wrap = FrameLayout(act).apply {
            layoutParams =
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
            isClickable = true
            elevation = 100f
        }
        val pv =
            PlayerView(act).apply {
                layoutParams =
                    FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        Gravity.CENTER
                    )
                useController = true
                setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
            }
        wrap.addView(pv)
        root.addView(wrap)
        overlay = wrap
        playerView = pv
    }

    private fun showOverlay() {
        overlay?.visibility = View.VISIBLE
    }

    private fun hideOverlay() {
        overlay?.visibility = View.GONE
    }

    private fun releasePlayerKeepOverlay() {
        playerView?.player = null
        player?.release()
        player = null
    }

    private fun tearDown() {
        releasePlayerKeepOverlay()
        hideOverlay()
        val ov = overlay
        if (ov != null) {
            (ov.parent as? ViewGroup)?.removeView(ov)
        }
        overlay = null
        playerView = null
        cancelNotification()
    }

    private fun notifyPlaying(playing: Boolean) {
        val ctx = context ?: return
        ensureChannel()
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        val contentPi =
            PendingIntent.getActivity(
                ctx,
                0,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        val notification: Notification =
            NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setContentTitle("OTT-play FOSS")
                .setContentText(if (playing) "Native DASH/HLS playback" else "Paused")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(contentPi)
                .setOngoing(playing)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .build()
        val nm = (ctx.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as? NotificationManager) ?: return
        nm.notify(NOTIFICATION_ID, notification)
    }

    private fun cancelNotification() {
        val ctx = context ?: return
        val nm = (ctx.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as? NotificationManager) ?: return
        nm.cancel(NOTIFICATION_ID)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val ctx = context ?: return
        val nm = (ctx.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as? NotificationManager) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Native DASH/HLS playback",
                NotificationManager.IMPORTANCE_LOW
            ).apply { setShowBadge(false) }
        )
    }
}

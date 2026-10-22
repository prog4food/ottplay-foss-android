package play.ott.foss

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "NativeBackground")
class NativeBackgroundPlugin : Plugin() {
    private fun snapshot() = JSObject().apply {
        val state = NativeWork.snapshot()
        put("standby", state.standby)
        put("pending", state.pending)
        put("quiescent", state.quiescent)
    }
    @PluginMethod fun setStandby(call: PluginCall) {
        val value = call.getBoolean("standby")
        if (value == null) { call.reject("standby must be a boolean"); return }
        context.getSharedPreferences("ott-background", 0).edit().putBoolean("standby", value).apply()
        NativeWork.setStandby(value)
        if (value) {
            MediaPlaybackService.retirePlayback()
            context.stopService(android.content.Intent(context, MediaPlaybackService::class.java))
        }
        call.resolve(snapshot())
    }
    @PluginMethod fun status(call: PluginCall) { call.resolve(snapshot()) }
}

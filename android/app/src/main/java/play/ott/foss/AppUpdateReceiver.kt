package play.ott.foss

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller

class AppUpdateReceiver : BroadcastReceiver() {
    @Suppress("DEPRECATION")
    override fun onReceive(context: Context, intent: Intent) {
        // Storage/launcher failures must not crash the newly installed player.
        runCatching { receive(context, intent) }
    }

    private fun receive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            val state = AppUpdates.status(context)
            if (state.optString("phase") == "installed") {
                context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
                    context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            }
        } else if (intent.action == context.packageName + ".APP_UPDATE") {
            AppUpdates.installationResult(context,
                intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1),
                intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE),
                intent.getParcelableExtra(Intent.EXTRA_INTENT))
        }
    }
}

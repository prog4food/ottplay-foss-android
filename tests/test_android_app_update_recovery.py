#!/usr/bin/env python3
"""Execute the production OTA retry guard; compile its bridge against Android SDK.

No device, network, APK installation or test-only production switch is used.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "android/app/src/main/java/play/ott/foss"
SDK = Path(os.environ.get("ANDROID_SDK_ROOT", os.environ.get("ANDROID_HOME", "/opt/homebrew/share/android-commandlinetools")))
ANDROID_JAR = SDK / "platforms/android-36/android.jar"
KOTLINC = shutil.which("kotlinc")
assert KOTLINC, "kotlinc is required"
assert ANDROID_JAR.is_file(), ANDROID_JAR

CASES = r'''
package play.ott.foss

fun main() {
    val own = "play.ott.foss"
    var tests = 0
    fun run(session: AppUpdateRecovery.Session?, id: Int = 19,
            verification: String? = null, cleanupFails: Boolean = false, invalidateFails: Boolean = false): List<String> {
        val events = mutableListOf<String>()
        try {
            AppUpdateRecovery.retry(id, own,
                { events.add("verify"); if (verification != null) error(verification) },
                { check(it == id); events.add("lookup"); session },
                { events.add("invalidate"); if (invalidateFails) error("persistence") },
                { check(it == id); events.add("abandon"); if (cleanupFails) error("cleanup") })
            events.add("returned")
        } catch (_: Exception) { events.add("rejected") }
        return events
    }
    fun expect(actual: List<String>, vararg expected: String) {
        check(actual == expected.toList()) { "$actual != ${expected.toList()}" }; tests++
    }
    val matching = AppUpdateRecovery.Session(own, own)
    expect(run(matching), "verify", "lookup", "invalidate", "abandon", "returned")
    // Android removed a stale session: verify the package, then create afresh.
    expect(run(null), "verify", "lookup", "invalidate", "returned")
    for (failure in listOf("hash", "signer", "installed-or-older", "missing-file")) {
        expect(run(matching, verification = failure), "verify", "rejected")
        expect(run(null, verification = failure), "verify", "rejected")
    }
    for (untrusted in listOf(
        AppUpdateRecovery.Session("other.installer", own),
        AppUpdateRecovery.Session(own, "other.target"),
        AppUpdateRecovery.Session(null, own),
        AppUpdateRecovery.Session(own, null),
        AppUpdateRecovery.Session(null, null)
    )) expect(run(untrusted), "verify", "lookup", "rejected")
    expect(run(matching, id = -1), "rejected")
    expect(run(matching, cleanupFails = true), "verify", "lookup", "invalidate", "abandon", "rejected")
    expect(run(matching, invalidateFails = true), "verify", "lookup", "invalidate", "rejected")
    // Model even a synchronous abandonment callback: old identity is already
    // retired, so it cannot replace the new installer state with failure.
    var recorded = 19
    var phase = "awaiting_confirmation"
    AppUpdateRecovery.retry(recorded, own, {}, { matching }, { recorded = -1 }, {
        if (recorded == it) phase = "failed"
    })
    check(phase == "awaiting_confirmation")
    recorded = 20
    phase = "installing"
    if (recorded == 19) phase = "failed"
    check(phase == "installing")
    tests++
    println("Android OTA recovery: $tests production guard cases passed")
}
'''

# Compile the actual bridge, not a transcription, to catch API22-compatible
# PackageInstaller calls and callback signatures. Platform code is not executed.
CAPACITOR = r'''
package com.getcapacitor
import android.content.Context
open class Plugin { lateinit var context: Context }
class JSObject {
    fun put(key: String, value: Any?): JSObject = this
    fun optString(key: String): String = ""
}
class PluginCall {
    fun getString(key: String): String? = null
    fun resolve(value: JSObject) {}
    fun reject(message: String) {}
}
annotation class PluginMethod
'''
SUPPORT = r'''
package play.ott.foss
object R { object raw { const val isrg_root_x1 = 1 } }
object LegacyUpdateTls {
    fun create(input: java.io.InputStream): javax.net.ssl.SSLSocketFactory =
        javax.net.ssl.SSLSocketFactory.getDefault() as javax.net.ssl.SSLSocketFactory
}
'''

with tempfile.TemporaryDirectory(prefix="ott-update-recovery-") as directory:
    tmp = Path(directory)
    (tmp / "Cases.kt").write_text(CASES)
    subprocess.run([KOTLINC, str(SOURCES / "AppUpdateRecovery.kt"), str(tmp / "Cases.kt"),
                    "-include-runtime", "-d", str(tmp / "cases.jar")], check=True)
    subprocess.run(["java", "-jar", str(tmp / "cases.jar")], check=True)
    (tmp / "Capacitor.kt").write_text(CAPACITOR)
    (tmp / "Support.kt").write_text(SUPPORT)
    (tmp / "Annotation.kt").write_text("package com.getcapacitor.annotation\nannotation class CapacitorPlugin(val name: String)\n")
    subprocess.run([KOTLINC, "-nowarn", "-classpath", str(ANDROID_JAR),
                    *map(str, [SOURCES / "AppUpdateRecovery.kt", SOURCES / "AppUpdatePlugin.kt",
                               SOURCES / "AppUpdateReceiver.kt", SOURCES / "NativeWork.kt",
                               tmp / "Capacitor.kt", tmp / "Support.kt", tmp / "Annotation.kt"]),
                    "-d", str(tmp / "bridge.jar")], check=True)
    print("Actual AppUpdate bridge and receiver compile against Android SDK")

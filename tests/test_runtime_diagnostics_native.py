#!/usr/bin/env python3
"""Compile shipped native producers against real SDKs and exercise their boundaries.

No device, networking, Gradle sync or app installation. Android needs kotlinc,
Java and SDK 36; iOS needs macOS/Xcode. All generated fixtures live in a temp dir.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ANDROID_SOURCE = ROOT / "android/app/src/main/java/play/ott/foss/RuntimeDiagnosticsPlugin.kt"
IOS_SOURCE = ROOT / "ios/App/App/Plugins/RuntimeDiagnostics.swift"

CAP_KOTLIN = r'''
package com.getcapacitor
open class Plugin {
    lateinit var context: android.content.Context
    open fun handleOnPause() {}
    open fun handleOnResume() {}
    open fun handleOnDestroy() {}
}
class JSObject {
    val values = LinkedHashMap<String, Any?>()
    fun put(key: String, value: Any?): JSObject { values[key] = value; return this }
}
class PluginCall {
    var result: JSObject? = null
    var code: String? = null
    var completions = 0
    fun resolve(value: JSObject) { result = value; completions++ }
    fun reject(message: String, code: String) { check(message.isNotBlank()); this.code = code; completions++ }
}
annotation class PluginMethod
'''

ANDROID_FIXTURES = {
    "OS.kt": r'''
package android.os
object Build { object VERSION { var SDK_INT = 36; var RELEASE = "16" } }
object SystemClock { var now = 100000L; fun elapsedRealtime() = now }
class Looper { companion object { fun getMainLooper() = Looper() } }
class Handler(val looper: Looper) {
    fun post(action: Runnable): Boolean { pending.add(action); return true }
    companion object {
        private val pending = java.util.ArrayDeque<Runnable>()
        fun drain() { while (pending.isNotEmpty()) pending.remove().run() }
    }
}
object Debug {
    var fail = false
    var pss = 42
    class MemoryInfo { var totalPss = 0 }
    fun getMemoryInfo(info: MemoryInfo) {
        if (fail) throw IllegalStateException("unavailable")
        info.totalPss = pss
    }
}
class PowerManager {
    var isPowerSaveMode = true
    val currentThermalStatus: Int get() {
        check(Build.VERSION.SDK_INT >= 29) { "unguarded thermal API" }
        return 3
    }
}
''',
    "Context.kt": r'''
package android.content
class Context {
    val services = mutableMapOf<String, Any>()
    fun getSystemService(name: String) = services[name]
    companion object { const val ACTIVITY_SERVICE = "activity"; const val POWER_SERVICE = "power" }
}
''',
    "Activity.kt": r'''
package android.app
class ActivityManager {
    var fail = false
    class MemoryInfo { var availMem = 0L; var totalMem = 0L; var lowMemory = false }
    fun getMemoryInfo(info: MemoryInfo) {
        if (fail) throw IllegalStateException("unavailable")
        info.availMem = 1024; info.totalMem = 4096; info.lowMemory = true
    }
}
''',
    "WebView.kt": r'''
package android.webkit
class PackageInfo(val versionName: String)
object WebView {
    var version = "130.0.1"
    fun getCurrentWebViewPackage(): PackageInfo? {
        check(android.os.Build.VERSION.SDK_INT >= 26) { "unguarded WebView API" }
        return PackageInfo(version)
    }
}
''',
    "JSON.kt": "package org.json\nclass JSONObject { companion object { val NULL = Any() } }\n",
}

ANDROID_MAIN = r'''
package play.ott.foss
import android.app.ActivityManager
import android.content.Context
import android.os.*
import android.webkit.WebView
import com.getcapacitor.*
import org.json.JSONObject

fun read(plugin: RuntimeDiagnosticsPlugin): JSObject {
    val call = PluginCall(); plugin.snapshot(call); Handler.drain()
    check(call.completions == 1 && call.code == null)
    return call.result!!
}
fun main() {
    val context = Context()
    context.services[Context.ACTIVITY_SERVICE] = ActivityManager()
    context.services[Context.POWER_SERVICE] = PowerManager()
    val plugin = RuntimeDiagnosticsPlugin().also { it.context = context }
    SystemClock.now += 234
    val first = read(plugin)
    check(first.values.keys == setOf("version", "platform", "appVersion", "osVersion", "webviewVersion", "metrics"))
    check(first.values["version"] == 1 && first.values["platform"] == "android")
    check(first.values["appVersion"] == "1.2.3+test")
    check(first.values["webviewVersion"] == "130.0.1")
    val metrics = (first.values["metrics"] as JSObject).values
    check(metrics["uptimeMs"] == 234L && metrics["systemUptimeMs"] == 100234L)
    check(metrics["pssBytes"] == 42L * 1024 && !metrics.containsKey("residentBytes"))
    check(metrics["systemAvailableBytes"] == 1024L && metrics["systemTotalBytes"] == 4096L)
    check(metrics["lowMemory"] == true && metrics["lowPower"] == true && metrics["thermalState"] == 3L)
    check(!metrics.containsKey("foreground"))
    plugin.handleOnResume()
    check(((read(plugin).values["metrics"] as JSObject).values)["foreground"] == true)
    plugin.handleOnPause()
    check(((read(plugin).values["metrics"] as JSObject).values)["foreground"] == false)

    // Both optional APIs throw if invoked below their introduction level.
    Build.VERSION.SDK_INT = 22
    val old = read(plugin)
    check(old.values["webviewVersion"] === JSONObject.NULL)
    check(!(old.values["metrics"] as JSObject).values.containsKey("thermalState"))
    Debug.fail = true; context.services.clear()
    val unavailable = (read(plugin).values["metrics"] as JSObject).values
    check(!unavailable.containsKey("pssBytes") && !unavailable.containsKey("lowMemory"))
    check(!unavailable.containsKey("systemAvailableBytes") && !unavailable.containsKey("lowPower"))

    for (value in listOf("", "v 1", "https://private/secret", "v1\n", "x".repeat(65)))
        check(RuntimeDiagnosticsPlugin.version(value) === JSONObject.NULL)
    check(RuntimeDiagnosticsPlugin.version("1.2_a-b+c") == "1.2_a-b+c")
    BuildConfig.VERSION_NAME = "secret value"; Build.VERSION.RELEASE = "vendor build"
    check(read(plugin).values["appVersion"] === JSONObject.NULL)
    check(read(plugin).values["osVersion"] === JSONObject.NULL)
    val numeric = JSObject()
    RuntimeDiagnosticsPlugin.number(numeric, "negative", -1)
    RuntimeDiagnosticsPlugin.number(numeric, "overflow", 9007199254740992L)
    RuntimeDiagnosticsPlugin.number(numeric, "maximum", 9007199254740991L)
    check(numeric.values.keys == setOf("maximum"))
    Debug.fail = false; Debug.pss = -1
    check(!(read(plugin).values["metrics"] as JSObject).values.containsKey("pssBytes"))

    val pending = PluginCall(); plugin.snapshot(pending); plugin.handleOnDestroy(); Handler.drain()
    check(pending.code == "unavailable" && pending.completions == 1 && pending.result == null)
    println("PASS Android producer: exact schema, units, API22 guards, omission, lifetime, lifecycle and retired requests")
}
'''

CAP_SWIFT = r'''
import Foundation
import UIKit
open class CAPPlugin: NSObject { public var bridge: Bridge? = Bridge() }
public class Bridge { public var viewController: UIViewController? = UIViewController() }
public protocol CAPBridgedPlugin {}
public let CAPPluginReturnPromise = "promise"
public struct CAPPluginMethod { public init(name: String, returnType: String) {} }
public class CAPPluginCall: NSObject {
    public var result: [String: Any]?
    public var code: String?
    public var completions = 0
    public func resolve(_ data: [String: Any]) { result = data; completions += 1 }
    public func reject(_ message: String, _ code: String) { self.code = code; completions += 1 }
}
'''

UIKIT_SWIFT = r'''
import Foundation
public class UIScene: NSObject {
    public enum ActivationState { case foregroundActive, foregroundInactive, background }
    public var activationState = ActivationState.foregroundActive
}
public class UIWindow: NSObject { public var windowScene: UIScene? = UIScene() }
public class UIView: NSObject { public var window: UIWindow? = UIWindow() }
public class UIViewController: NSObject { public var viewIfLoaded: UIView? = UIView() }
'''

SWIFT_MAIN = r'''
import Foundation
import Capacitor
func wait(_ call: CAPPluginCall) {
    let deadline = Date().addingTimeInterval(3)
    while call.completions == 0 && Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.001))
    }
    precondition(call.completions == 1)
}
func read(_ plugin: RuntimeDiagnostics) -> [String: Any] {
    let call = CAPPluginCall(); plugin.snapshot(call); wait(call)
    precondition(call.code == nil)
    return call.result!
}
let plugin = RuntimeDiagnostics()
let first = read(plugin)
precondition(Set(first.keys) == Set(["version", "platform", "appVersion", "osVersion", "webviewVersion", "metrics"]))
precondition(first["platform"] as? String == "ios" && first["version"] as? Int == 1)
precondition(first["webviewVersion"] is NSNull)
let metrics = first["metrics"] as! [String: Any]
precondition(metrics["foreground"] as? Bool == true)
precondition((metrics["residentBytes"] as? Double ?? 0) > 0)
precondition((metrics["footprintBytes"] as? Double ?? 0) > 0)
precondition(metrics["systemUptimeMs"] == nil && metrics["pssBytes"] == nil)
precondition(metrics["heapUsedBytes"] == nil && metrics["systemAvailableBytes"] == nil)
precondition((metrics["uptimeMs"] as? Double ?? -1) >= 0)
precondition((metrics["uptimeMs"] as? Double ?? 99999) < 3000)
precondition(JSONSerialization.isValidJSONObject(first))
plugin.bridge?.viewController?.viewIfLoaded?.window?.windowScene?.activationState = .background
precondition((read(plugin)["metrics"] as! [String: Any])["foreground"] as? Bool == false)
plugin.bridge = nil
precondition((read(plugin)["metrics"] as! [String: Any])["foreground"] == nil)
for value in ["", "v 1", "https://private/secret", "v1\n", String(repeating: "x", count: 65)] {
    precondition(RuntimeDiagnostics.version(value) is NSNull)
}
precondition(RuntimeDiagnostics.version("1.2_a-b+c") as? String == "1.2_a-b+c")
var bounds: [String: Any] = [:]
for (name, value) in [("negative", -1.0), ("nan", Double.nan), ("infinite", Double.infinity), ("overflow", 9007199254740992.0)] {
    RuntimeDiagnostics.number(&bounds, name, value)
}
RuntimeDiagnostics.number(&bounds, "maximum", 9007199254740991)
precondition(Set(bounds.keys) == ["maximum"])
let call = CAPPluginCall()
var retired: RuntimeDiagnostics? = RuntimeDiagnostics()
retired!.snapshot(call); retired = nil; wait(call)
precondition(call.code == "unavailable" && call.result == nil)
print("PASS iOS producer: real Mach memory, exact schema, bounded values, lifetime, scene ownership and retired requests")
'''


def run(*args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def android(work):
    sdk = Path(os.environ.get("ANDROID_SDK_ROOT", os.environ.get("ANDROID_HOME", "/opt/homebrew/share/android-commandlinetools")))
    jar = sdk / "platforms/android-36/android.jar"
    assert jar.is_file(), jar
    compiler = shutil.which("kotlinc")
    assert compiler, "kotlinc is required"
    (work / "Capacitor.kt").write_text(CAP_KOTLIN)
    (work / "Annotation.kt").write_text("package com.getcapacitor.annotation\nannotation class CapacitorPlugin(val name: String)\n")
    (work / "BuildConfig.kt").write_text('package play.ott.foss\nobject BuildConfig { var VERSION_NAME = "1.2.3+test" }\n')
    common = [ANDROID_SOURCE, work / "Capacitor.kt", work / "Annotation.kt", work / "BuildConfig.kt"]
    classes = work / "classes"
    run(compiler, *common, "-Werror", "-classpath", jar, "-d", classes)
    spec = importlib.util.spec_from_file_location("api_check", ROOT / "scripts/verify-android-plugin-apis.py")
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    checker.verify(classes, 22, sdk)
    for name, content in ANDROID_FIXTURES.items():
        (work / name).write_text(content)
    (work / "Main.kt").write_text(ANDROID_MAIN)
    run(compiler, *common, *[work / name for name in ANDROID_FIXTURES], work / "Main.kt", "-Werror",
        "-include-runtime", "-d", work / "test.jar")
    run("java", "-jar", work / "test.jar", timeout=30)
    assert "registerPlugin(RuntimeDiagnosticsPlugin.class)" in (ANDROID_SOURCE.parent / "MainActivity.java").read_text()


def ios(work):
    (work / "Capacitor.swift").write_text(CAP_SWIFT)
    ios_sdk = subprocess.check_output(["xcrun", "--sdk", "iphoneos", "--show-sdk-path"], text=True).strip()
    target = ["-sdk", ios_sdk, "-target", "arm64-apple-ios15.0", "-swift-version", "5"]
    run("swiftc", *target, "-emit-module", "-module-name", "Capacitor", work / "Capacitor.swift",
        "-emit-module-path", work / "Capacitor.swiftmodule")
    run("swiftc", *target, "-warnings-as-errors", "-I", work, "-typecheck", IOS_SOURCE)
    print("PASS complete Swift plugin typechecks against iOS SDK (deployment target 15)", flush=True)
    (work / "UIKit.swift").write_text(UIKIT_SWIFT)
    run("swiftc", "-swift-version", "5", "-emit-library", "-emit-module", "-module-name", "UIKit",
        work / "UIKit.swift", "-o", work / "libUIKit.dylib", cwd=work)
    run("swiftc", "-swift-version", "5", "-I", work, "-L", work, "-lUIKit", "-emit-library", "-emit-module", "-module-name", "Capacitor",
        work / "Capacitor.swift", "-o", work / "libCapacitor.dylib", cwd=work)
    (work / "main.swift").write_text(SWIFT_MAIN)
    run("swiftc", "-swift-version", "5", "-warnings-as-errors", "-I", work, "-L", work,
        "-lCapacitor", "-lUIKit", "-Xlinker", "-rpath", "-Xlinker", work,
        IOS_SOURCE, work / "main.swift", "-o", work / "test")
    run(work / "test", timeout=30)
    manifest = plistlib.loads((ROOT / "ios/App/App/PrivacyInfo.xcprivacy").read_bytes())
    assert {"NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategorySystemBootTime",
            "NSPrivacyAccessedAPITypeReasons": ["35F9.1"]} in manifest["NSPrivacyAccessedAPITypes"]
    project = (ROOT / "ios/App/App.xcodeproj/project.pbxproj").read_text()
    assert "RuntimeDiagnostics.swift in Sources" in project and "PrivacyInfo.xcprivacy in Resources" in project
    assert "registerPluginInstance(RuntimeDiagnostics())" in (ROOT / "ios/App/App/MainViewController.swift").read_text()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", choices=["android", "ios", "all"], default="all")
    options = parser.parse_args()
    for name, exercise in [("android", android), ("ios", ios)]:
        if options.platform in (name, "all"):
            with tempfile.TemporaryDirectory(prefix="ott-runtime-" + name + "-") as directory:
                exercise(Path(directory))

#!/usr/bin/env python3
"""Exercise the actual Kotlin XMLTV entry points with both Android flavor flags.

Network and Capacitor are doubles; source selection, caching, response contracts,
and all getEpg/getChannels/prefetch control flow come from the shipped plugin.
Requires kotlinc and Java on PATH; no Android build, device or network is used.
"""

import pathlib
import os
import shutil
import tempfile

from test_native_epg_cache import (
    GZIP,
    KOTLIN_CAPACITOR,
    KOTLIN_HTTP,
    ROOT,
    check_shipping_sources,
    run,
)


KOTLIN_TESTS = r'''
    fun runEditionTests() {
        val DEFAULT_URL = "https://cdn.epg.one/epg2.xml.gz"
        val dir = java.nio.file.Files.createTempDirectory("epg-edition-test").toFile()
        context = com.getcapacitor.Context(dir, dir)
        val data = java.util.Base64.getDecoder().decode("GZIP_FIXTURE")
        var scenarios = 0
        fun invoke(action: String, call: PluginCall) {
            when (action) {
                "getChannels" -> getChannels(call)
                "getEpg" -> getEpg(call)
                "prefetch" -> prefetch(call)
            }
        }
        fun fresh() {
            parsedCache.clear()
            cacheFile.delete()
            metaFile.delete()
            okhttp3.Fixture.requests = 0
            okhttp3.Fixture.requestUrls.clear()
            okhttp3.Fixture.sources.clear()
            okhttp3.Fixture.data = data
        }
        try {
            for (action in listOf("getChannels", "getEpg", "prefetch")) {
                for (shape in listOf("omitted", "empty-array", "blank-array", "blank-single")) {
                    fresh()
                    val call = PluginCall(if (shape == "blank-single") " \t " else "")
                    if (shape.endsWith("array")) call.values["xmltv_urls"] = JSArray().apply {
                        if (shape == "blank-array") put(" \t ")
                    }
                    invoke(action, call)
                    check(call.resolved && !call.rejected) { "$action/$shape must resolve honestly" }
                    val expected = if (BuildConfig.BUNDLED_EPG_DEFAULTS) 1 else 0
                    check(okhttp3.Fixture.requests == expected) { "$action/$shape default network policy" }
                    if (expected == 1) check(okhttp3.Fixture.requestUrls.single() == DEFAULT_URL)
                    if (action == "getChannels") {
                        val rows = call.result.values["channels"] as JSArray
                        check(rows.length() == expected) { "Play returns an empty channel/logo index" }
                    }
                    if (action == "getEpg") check((call.result.values["epg_data"] as JSArray).length() == 0)
                    scenarios++
                }
                for (array in listOf(false, true)) {
                    fresh()
                    val source = "https://user.example.invalid/my-feed.xml"
                    val call = PluginCall(if (array) "" else " $source ")
                    if (array) call.values["xmltv_urls"] = JSArray().apply { put(" $source "); put(source) }
                    invoke(action, call)
                    check(call.resolved && !call.rejected)
                    check(okhttp3.Fixture.requests == 1 && okhttp3.Fixture.requestUrls.single() == source)
                    if (action == "getChannels") check((call.result.values["channels"] as JSArray).length() == 1)
                    scenarios++
                }
            }
            if (!BuildConfig.BUNDLED_EPG_DEFAULTS) {
                // An explicit feed can populate both disk and memory. Removing
                // the user's source must not make that old cache a Play default.
                fresh()
                val explicit = PluginCall(DEFAULT_URL)
                getChannels(explicit)
                check(explicit.resolved && (explicit.result.values["channels"] as JSArray).length() == 1)
                val before = okhttp3.Fixture.requests
                val omitted = PluginCall("")
                getChannels(omitted)
                check(omitted.resolved && (omitted.result.values["channels"] as JSArray).length() == 0)
                check(okhttp3.Fixture.requests == before)
                scenarios++
            }
            println("PASS Kotlin XMLTV edition defaults=${BuildConfig.BUNDLED_EPG_DEFAULTS}: $scenarios source/cache/API scenarios")
        } finally { dir.deleteRecursively() }
    }
'''


def main():
    check_shipping_sources()
    for compiler in ("kotlinc", "java"):
        if not shutil.which(compiler):
            raise SystemExit(f"Required native test tool is missing: {compiler}")
    source = (ROOT / "mobile-xmltv-epg/src/android/play/ott/foss/plugin/MobileXmltvEpgPlugin.kt").read_text()
    source = source.replace(
        "    // MARK: - Cache",
        KOTLIN_TESTS.replace("GZIP_FIXTURE", GZIP) + "\n    // MARK: - Cache",
    )
    source += "\nfun main() { MobileXmltvEpgPlugin().runEditionTests() }\n"
    with tempfile.TemporaryDirectory(prefix="android-epg-editions-") as directory:
        tmp = pathlib.Path(directory)
        (tmp / "EditionTest.kt").write_text(source)
        (tmp / "Capacitor.kt").write_text(KOTLIN_CAPACITOR)
        (tmp / "Http.kt").write_text(KOTLIN_HTTP)
        (tmp / "Annotation.kt").write_text("package com.getcapacitor.annotation\nannotation class CapacitorPlugin(val name: String)\n")
        for enabled in (False, True):
            (tmp / "BuildConfig.kt").write_text(
                "package play.ott.foss\nobject BuildConfig { const val BUNDLED_EPG_DEFAULTS = "
                + str(enabled).lower() + " }\n"
            )
            run("kotlinc", "EditionTest.kt", "Capacitor.kt", "Http.kt", "Annotation.kt", "BuildConfig.kt",
                str(ROOT / "android/app/src/main/java/play/ott/foss/NativeWork.kt"),
                "-nowarn", "-classpath", str(ROOT / "vendor/ottplay-core.jar"), "-jvm-target", "17", "-include-runtime", "-d", "edition-test.jar", cwd=tmp)
            run("java", "-cp", "edition-test.jar" + os.pathsep + str(ROOT / "vendor/ottplay-core.jar"), "play.ott.foss.plugin.EditionTestKt", cwd=tmp)


if __name__ == "__main__":
    main()

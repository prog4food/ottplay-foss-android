#!/usr/bin/env python3
"""Verify shipping native parseXmltv results against pre-migration captures.

Requires Swift/macOS for --platform ios or kotlinc/java for --platform android.
Only temporary platform stubs are generated; parser and reducer code are real.
This runner cannot replace expected results or their provenance.
"""
import argparse
import base64
import concurrent.futures
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests/fixtures/guide"
SWIFT_PATH = 'mobile-xmltv-epg/src/ios/MobileXmltvEpg.swift'
KOTLIN_PATH = 'mobile-xmltv-epg/src/android/play/ott/foss/plugin/MobileXmltvEpgPlugin.kt'
SWIFT_METHOD = r'''
    func captureRecord(_ label: String, _ xml: String) {
        var output: [String: Any]
        do {
            // These captures exercise parsing, including invalid XML that never
            // passed the loader's plain-XML sniff. Adapt only the input medium.
            let document = try XmltvDocument(parent: xmlTemporaryDirectory)
            try Data(xml.utf8).write(to: document.url)
            let parsed = try parseXmltv(document)
            var programmes: [String: [[String: Any]]] = [:]
            for (id, entries) in parsed.programs {
                programmes[id] = entries.map { ["start": $0.start, "stop": $0.stop, "title": $0.title, "desc": $0.desc] }
            }
            output = ["name": label, "result": ["channels": parsed.channels, "names": parsed.names, "icons": parsed.icons, "programmes": programmes]]
        } catch {
            let value = error as NSError
            output = ["name": label, "error": ["type": value.domain, "code": value.code, "message": value.localizedDescription]]
        }
        let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
        print("RECORD:" + String(data: data, encoding: .utf8)!)
    }
'''
KOTLIN_METHOD = r'''
    fun captureRecord(label: String, xml: String) {
        val output: Map<String, Any> = try {
            val parsed = parseXmltv(xml.byteInputStream(Charsets.UTF_8))
            mapOf("name" to label, "result" to mapOf("channels" to parsed.channels, "names" to parsed.names,
                "icons" to parsed.icons, "programmes" to parsed.programs.mapValues { (_, entries) ->
                    entries.map { mapOf("start" to it.start, "stop" to it.stop, "title" to it.title, "desc" to it.desc) }
                }))
        } catch (error: Throwable) {
            mapOf("name" to label, "error" to mapOf("type" to error.javaClass.name, "message" to (error.message ?: "")))
        }
        println("RECORD:" + captureJson(output))
    }
'''
KOTLIN_JSON = r'''
fun captureJson(value: Any?): String = when (value) {
    null -> "null"
    is String -> buildString {
        append('"')
        for (character in value) when (character) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000c' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (character.code < 32) append("\\u" + character.code.toString(16).padStart(4, '0')) else append(character)
        }
        append('"')
    }
    is Number, is Boolean -> value.toString()
    is Map<*, *> -> value.entries.joinToString(",", "{", "}") { captureJson(it.key.toString()) + ":" + captureJson(it.value) }
    is Iterable<*> -> value.joinToString(",", "[", "]") { captureJson(it) }
    else -> error("unsupported capture value")
}
'''

def run(cmd, cwd):
    proc = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, timeout=240)
    if proc.returncode:
        raise RuntimeError(f'{cmd[0]} exited {proc.returncode}\n{proc.stdout}\n{proc.stderr}')
    return proc.stdout

def capture(repo, rows, harness, platform):
    with tempfile.TemporaryDirectory(prefix='native-records-' + platform + '-') as name:
        tmp = pathlib.Path(name)
        if platform == 'swift':
            source = (repo / SWIFT_PATH).read_text()
            source = source.replace('import Capacitor', harness.SWIFT_STUBS).replace('@objc(MobileXmltvEpg)', '').replace('@objc ', '')
            for resource, file in [('ottplay-core', 'ottplay-core.js'), ('ottplay-core.manifest', 'ottplay-core.manifest.json')]:
                extension = 'json' if resource.endswith('manifest') else 'js'
                source = source.replace(f'Bundle.main.url(forResource: "{resource}", withExtension: "{extension}")', f'Optional(URL(fileURLWithPath: {json.dumps(str(repo / "vendor" / file))}))')
            source = source.replace('    // MARK: - Cache', SWIFT_METHOD + '\n    // MARK: - Cache')
            source += '\nlet records = MobileXmltvEpg()\n'
            for row in rows:
                label = base64.b64encode(row['name'].encode()).decode()
                xml = base64.b64encode(row['xml'].encode()).decode()
                source += f'records.captureRecord(String(data: Data(base64Encoded: "{label}")!, encoding: .utf8)!, String(data: Data(base64Encoded: "{xml}")!, encoding: .utf8)!)\n'
            (tmp / 'Records.swift').write_text(source)
            stdout = run(['swift', '-module-cache-path', str(tmp / 'module-cache'), 'Records.swift'], tmp)
        else:
            source = (repo / KOTLIN_PATH).read_text().replace('    // MARK: - Cache', KOTLIN_METHOD + '\n    // MARK: - Cache')
            source += '\n' + KOTLIN_JSON + '\nfun main() { val records = MobileXmltvEpgPlugin()\n'
            for row in rows:
                label = base64.b64encode(row['name'].encode()).decode()
                encoded = base64.b64encode(row['xml'].encode()).decode()
                chunks = ','.join(json.dumps(encoded[i:i + 32000]) for i in range(0, len(encoded), 32000))
                xml = 'listOf(' + chunks + ').joinToString("")'
                source += f'records.captureRecord(String(java.util.Base64.getDecoder().decode("{label}"), Charsets.UTF_8), String(java.util.Base64.getDecoder().decode({xml}), Charsets.UTF_8))\n'
            source += '}\n'
            (tmp / 'Records.kt').write_text(source)
            (tmp / 'Capacitor.kt').write_text(harness.KOTLIN_CAPACITOR)
            (tmp / 'Http.kt').write_text(harness.KOTLIN_HTTP)
            (tmp / 'BuildConfig.kt').write_text('package play.ott.foss\nobject BuildConfig { const val BUNDLED_EPG_DEFAULTS = true }\n')
            (tmp / 'Annotation.kt').write_text('package com.getcapacitor.annotation\nannotation class CapacitorPlugin(val name: String)\n')
            jar = str(repo / 'vendor/ottplay-core.jar')
            run(['kotlinc', 'Records.kt', 'Capacitor.kt', 'Http.kt', 'BuildConfig.kt', 'Annotation.kt', str(harness.ROOT / 'android/app/src/main/java/play/ott/foss/NativeWork.kt'), '-nowarn', '-classpath', jar, '-jvm-target', '17', '-include-runtime', '-d', 'records.jar'], tmp)
            stdout = run(['java', '-cp', 'records.jar' + os.pathsep + jar, 'play.ott.foss.plugin.RecordsKt'], tmp)
        results = [json.loads(line[7:]) for line in stdout.split('\n') if line.startswith('RECORD:')]
        assert [r['name'] for r in results] == [r['name'] for r in rows], stdout
        return results

def boundary_cases():
    # The compact expected digests were captured from the old adapters, including
    # all string payloads. Inputs deliberately cross both Swift batch thresholds.
    channels = ''.join(f'<channel id="c{i}"><display-name>Name {i}</display-name><icon src="icon-{i}"/></channel>' for i in range(90))
    long_title = 'x' * (64 * 1024 + 1) + 'é😀end'
    programme = '<programme channel="c0" start="20260914110000 +0000" stop="20260914120000 +0000"><title>' + long_title + '</title><desc>Completed</desc></programme>'
    return [
        {'name': 'channel ownership and aliases cross 256 tokens', 'xml': '<tv>' + channels + '<channel id="c0"><display-name>Later alias</display-name><icon src="replacement"/></channel></tv>'},
        {'name': 'programme text crosses 64 KiB and retains Unicode tail', 'xml': '<tv><channel id="c0"/>' + programme + '</tv>'},
        {'name': 'malformed tail preserves completed metadata across batches', 'xml': '<tv>' + channels + programme + '<channel'},
    ]


def result_digest(result):
    canonical = json.dumps(result, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(canonical.encode()).hexdigest()


def verify_platform(repo, rows, boundaries, expected_boundaries, harness, platform):
    results = capture(repo, rows + boundaries, harness, platform)
    for row, actual in zip(rows, results):
        expected = row['expected'][platform]
        actual = {key: value for key, value in actual.items() if key != 'name'}
        assert actual == expected, f"{platform}: {row['name']} differs from captured output\nExpected: {expected}\nActual: {actual}"
    for row, actual, saved in zip(boundaries, results[len(rows):], expected_boundaries):
        assert row['name'] == saved['name'], 'Boundary fixture name changed'
        assert hashlib.sha256(row['xml'].encode()).hexdigest() == saved['xmlSha256'], 'Boundary fixture input changed'
        actual = {key: value for key, value in actual.items() if key != 'name'}
        digest = result_digest(actual)
        assert digest == saved['expectedSha256'][platform], f"{platform}: {row['name']} differs from captured output: {digest}"
    print(f'PASS {platform}: {len(rows)} captured XMLTV records and {len(boundaries)} captured batch boundaries', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=['ios', 'android', 'all'], default='all')
    args = parser.parse_args()
    repo = ROOT
    sys.path.insert(0, str(repo / 'tests'))
    spec = importlib.util.spec_from_file_location('native_capture_harness', repo / 'tests/test_native_epg_cache.py')
    harness = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(harness)
    harness.check_shipping_sources()
    rows = json.loads((FIXTURES / 'native-records-before-core.json').read_text())['cases']
    expected_boundaries = json.loads((FIXTURES / 'native-record-boundaries-before-core.json').read_text())['cases']
    boundaries = boundary_cases()
    assert len(boundaries) == len(expected_boundaries), 'Boundary fixture count changed'
    platforms = ['swift', 'android'] if args.platform == 'all' else ['swift' if args.platform == 'ios' else 'android']
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(platforms)) as pool:
        jobs = [pool.submit(verify_platform, repo, rows, boundaries, expected_boundaries, harness, platform) for platform in platforms]
        for job in jobs:
            job.result()


if __name__ == '__main__':
    main()

"""Behavioral checks for the shipped native ownership gate (no platform UI mocks)."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
KOTLIN_SOURCE = ROOT / "android/app/src/main/java/play/ott/foss/NativeWork.kt"


def swift_work_source():
    return (ROOT / "ios/App/App/Plugins/NativeBackground.swift").read_text().split("@objc(NativeBackground)", 1)[0].replace("import Capacitor\n", "")


KOTLIN = r'''
import play.ott.foss.NativeWork
fun main() {
    NativeWork.setStandby(false)
    var stopped = 0
    val unsubscribe = NativeWork.onStandby { stopped++ }
    val a = NativeWork.begin()!!
    val b = NativeWork.begin()!!
    var cancelled = 0
    a.cancelWith { cancelled++ }
    a.commit { check(NativeWork.pendingCount == 2) }
    NativeWork.setStandby(true)
    check(cancelled == 1 && stopped == 1 && NativeWork.pendingCount == 2)
    check(NativeWork.begin() == null)
    NativeWork.setStandby(true)
    check(cancelled == 1 && stopped == 1)
    b.cancelWith { cancelled++ }
    check(cancelled == 2)
    NativeWork.setStandby(false)
    check(runCatching { a.check() }.isFailure)
    var published = false
    check(runCatching { b.commit { published = true } }.isFailure && !published)
    val fresh = NativeWork.begin()!!
    fresh.check()
    a.finish(); b.finish(); b.finish()
    check(NativeWork.pendingCount == 1)
    fresh.finish()
    check(NativeWork.pendingCount == 0)
    unsubscribe()
    NativeWork.setStandby(true)
    check(stopped == 1 && NativeWork.pendingCount == 0)
    NativeWork.setStandby(false)
    println("PASS native Android standby: admission, idempotence, late cancel, drain, stale publication after wake")
}
'''
SWIFT = r'''
NativeWork.shared.setStandby(false)
let owner = NativeWork.shared
var stopped = 0
let unsubscribe = owner.onStandby { stopped += 1 }
let a = owner.begin()!, b = owner.begin()!
var cancelled = 0
a.cancelWith { cancelled += 1 }
try a.commit { assert(true) }
owner.setStandby(true)
assert(cancelled == 1 && stopped == 1 && owner.snapshot["pending"] as! Int == 2)
assert(owner.begin() == nil && owner.snapshot["quiescent"] as! Bool == false)
owner.setStandby(true)
assert(cancelled == 1 && stopped == 1)
b.cancelWith { cancelled += 1 }
assert(cancelled == 2)
owner.setStandby(false)
do { try a.check(); fatalError("stale work revived") } catch {}
var published = false
do { try b.commit { published = true }; fatalError("stale publication") } catch {}
assert(!published)
let fresh = owner.begin()!
try fresh.check()
a.finish(); b.finish(); b.finish()
assert(owner.snapshot["pending"] as! Int == 1)
fresh.finish()
assert(owner.snapshot["pending"] as! Int == 0)
unsubscribe()
owner.setStandby(true)
assert(stopped == 1 && owner.snapshot["quiescent"] as! Bool)
owner.setStandby(false)
print("PASS native iOS standby: admission, idempotence, late cancel, drain, stale publication after wake")
'''


def run_native_work(platform, temp, java="java"):
    if platform == "android":
        source = temp / "Work.kt"
        source.write_text(KOTLIN)
        binary = temp / "work.jar"
        subprocess.run(["kotlinc", str(KOTLIN_SOURCE), str(source), "-include-runtime", "-d", str(binary)], check=True)
        subprocess.run([java, "-jar", str(binary)], check=True)
    else:
        source = temp / "work.swift"
        source.write_text(swift_work_source() + SWIFT)
        binary = temp / "work"
        subprocess.run(["swiftc", "-swift-version", "5", str(source), "-o", str(binary)], check=True)
        subprocess.run([str(binary)], check=True)

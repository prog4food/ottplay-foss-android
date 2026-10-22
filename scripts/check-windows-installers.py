#!/usr/bin/env python3
"""Exercise locally built installers only on a disposable GitHub-hosted Windows VM.

Use the normal NSIS and MSI silent interfaces, not extracted payloads. No signing
secret, publication, registry deletion, or application launch is involved.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


SUPPORTED_CLI = "2.12.3"
BUNDLE_MARKER = b"__TAURI_BUNDLE_TYPE_VAR_UNK"
BUNDLE_MARKERS = {"nsis": b"__TAURI_BUNDLE_TYPE_VAR_NSS",
                  "msi": b"__TAURI_BUNDLE_TYPE_VAR_MSI"}
BUNDLER_SOURCE = ("https://github.com/tauri-apps/tauri/blob/"
                  "59b63ab500da9859f12d8888c3298bc29bba0b92/"
                  "crates/tauri-bundler/src/bundle.rs")


def payload_references(raw, cli_version):
    """Derive exact unsigned package bytes using the reviewed bundler transform.

    CLI 2.12.3 patches the unique marker for each format, then restores the raw
    executable. Never normalize or mutate installed bytes for comparison.
    """
    require(cli_version == SUPPORTED_CLI, "Review bundle transformation for this CLI version")
    require(raw.startswith(b"MZ"), "Expected the raw Windows executable")
    require(raw.count(BUNDLE_MARKER) == 1, "Missing or ambiguous raw bundle marker")
    # tauri-utils also embeds NSS/MSI literals in its runtime match table.
    # Only the unique UNK value is patched; comparison constants stay intact.
    offset = raw.index(BUNDLE_MARKER)
    references = {}
    for kind, marker in BUNDLE_MARKERS.items():
        require(len(marker) == len(BUNDLE_MARKER), "Bundle marker length changed")
        expected = raw[:offset] + marker + raw[offset + len(BUNDLE_MARKER):]
        references[kind] = {"sha256": hashlib.sha256(expected).hexdigest(),
                            "marker": marker.decode("ascii")}
    return {"cli_version": cli_version, "source": BUNDLER_SOURCE,
            "raw_sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw),
            "marker_offset": offset, "formats": references}


def retain_payload_references(output, raw, cli, locked_cli, report):
    """Preserve the actual build and diagnostics even if derivation rejects it."""
    (output / "raw-build.exe").write_bytes(raw)
    report["raw_build"] = {"sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw),
                           "marker_counts": {name: raw.count(marker) for name, marker in
                                             {"unknown": BUNDLE_MARKER, **BUNDLE_MARKERS}.items()}}
    try:
        require(cli == locked_cli, "Installed CLI differs from the lockfile")
        return payload_references(raw, cli)
    except Exception as error:
        report["error"] = str(error)
        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        raise


def nsis_command(executable, directory=None):
    # NSIS requires /D last and unquoted, even for a path containing spaces.
    # This is a CreateProcess command line, never a shell command.
    command = subprocess.list2cmdline([str(executable), "/S"])
    if directory is not None:
        directory = str(directory)
        require(not any(c in directory for c in ('"', '\r', '\n', '\0')),
                "Invalid NSIS directory")
        command += " /D=" + directory
    return command


def msi_command(installer, log, directory=None):
    # msiexec has its own parser: quote the property VALUE, not the assignment.
    # See Microsoft's "Setting Public Property Values on the Command Line".
    def quoted(path):
        value = str(path)
        require(value and not any(c in value for c in ('"', '\r', '\n', '\0')),
                "Invalid MSI path")
        return '"' + value + '"'

    command = 'msiexec.exe ' + ('/i ' if directory is not None else '/x ')
    command += quoted(installer) + ' /qn /norestart REBOOT=ReallySuppress'
    if directory is not None:
        command += ' INSTALLDIR=' + quoted(directory)
    return command + ' /L*V ' + quoted(log)


def run_msi(installer, log, report, label, directory=None):
    run(msi_command(installer, log, directory), report, label)
    require(log.is_file() and log.stat().st_size > 0, "MSI verbose log missing or empty")
    report["commands"][-1]["log"] = {"file": log.name, "size": log.stat().st_size,
                                    "sha256": digest(log)}


def run(command, report, label, timeout=180):
    row = {"operation": label, "command": command}
    report["commands"].append(row)
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, errors="replace", shell=False)
    row["pid"] = process.pid
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # Only this still-owned process tree, never an image-name/global kill.
        row["timeout"] = True
        try:
            subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                           check=False, capture_output=True, timeout=30)
        except (OSError, subprocess.SubprocessError) as error:
            row["tree_cleanup_error"] = str(error)
        finally:
            if process.poll() is None:
                process.kill()
        output, _ = process.communicate(timeout=30)
        row["output"] = output[-20000:]
        raise RuntimeError(label + " timed out")
    row.update(exit_code=process.returncode, output=output[-20000:])
    require(process.returncode == 0, label + " failed: " + str(process.returncode))


def registrations(product):
    import winreg
    result = []
    base = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
    for hive_name, hive in (("HKCU", winreg.HKEY_CURRENT_USER), ("HKLM", winreg.HKEY_LOCAL_MACHINE)):
        for view in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
            try:
                parent = winreg.OpenKey(hive, base, 0, winreg.KEY_READ | view)
            except FileNotFoundError:
                continue
            with parent:
                for index in range(winreg.QueryInfoKey(parent)[0]):
                    name = winreg.EnumKey(parent, index)
                    with winreg.OpenKey(parent, name) as key:
                        def value(field):
                            try:
                                return winreg.QueryValueEx(key, field)[0]
                            except FileNotFoundError:
                                return None
                        if value("DisplayName") == product:
                            result.append({"hive": hive_name, "view": view, "key": name,
                                           "version": value("DisplayVersion"),
                                           "location": value("InstallLocation")})
    # HKCU's shared 32/64 view can expose the same entry twice.
    return list({(r["hive"], r["key"], r["version"], r["location"]): r
                 for r in result}.values())


def wait_removed(directory, product, timeout=60):
    deadline = time.monotonic() + timeout
    while directory.exists() or registrations(product):
        require(time.monotonic() < deadline, "Uninstaller left files or product registration")
        time.sleep(0.5)


def installed_identity(directory, entries, version, expected_hash, observed=None):
    files = {str(p.relative_to(directory)): digest(p) for p in directory.rglob("*.exe")}
    if observed is not None:
        observed.update(files)
    require(len(entries) == 1, "Expected exactly one installed product registration")
    entry = entries[0]
    require(entry["version"] == version, "Installed version differs from source")
    require(isinstance(entry["location"], str)
            and Path(entry["location"].strip('"')).resolve() == directory.resolve(),
            "Installer ignored the owned temporary install directory")
    matches = [directory / name for name, sha in files.items() if sha == expected_hash]
    require(len(matches) == 1, "Installed executable differs from locally built application")
    return {"registration": entry, "executable": str(matches[0]), "sha256": expected_hash}


def exercise(kind, installer, directory, product, version, expected_hash, report, output):
    row = {"format": kind, "installer": str(installer), "sha256": digest(installer),
           "status": "failed", "commands": [], "expected_sha256": expected_hash,
           "observed_executables": {}, "install_directory": str(directory)}
    report["installers"].append(row)
    require(not directory.exists() and not registrations(product), "Pre-existing installation")
    started = False

    def uninstall(label):
        if kind == "nsis":
            executable = directory / "uninstall.exe"
            require(executable.is_file(), "NSIS uninstaller missing")
            run(nsis_command(executable), row, label)
        else:
            run_msi(installer, output / (label + ".log"), row, label)
        # NSIS normally forks a temporary uninstaller. Process exit alone is not proof.
        wait_removed(directory, product)

    try:
        started = True
        if kind == "nsis":
            run(nsis_command(installer, directory), row, "nsis-install")
        else:
            run_msi(installer, output / "msi-install.log", row, "msi-install", directory)
        row["observed_registrations"] = registrations(product)
        row["installed"] = installed_identity(directory, row["observed_registrations"], version, expected_hash,
                                              row["observed_executables"])
        retained = output / ("installed-" + kind + ".exe")
        shutil.copy2(row["installed"]["executable"], retained)
        require(digest(retained) == expected_hash, "Retained installed executable differs")
        row["installed"]["retained_file"] = retained.name
        uninstall(kind + "-uninstall")
        row.update(status="passed", install_directory_removed=True, registration_removed=True)
    finally:
        # Attempt the normal uninstaller even after an install/assertion failure.
        # Never turn a failed qualification into a pass by manually deleting files.
        if started and (directory.exists() or registrations(product)):
            try:
                uninstall(kind + "-cleanup")
            except Exception as error:
                row["cleanup_error"] = str(error)
                row["status"] = "failed"
    require(row["status"] == "passed", "Installer cleanup failed after qualification")


def exercise_installers(installers, temporary, product, version, references, report, output):
    # NSIS deliberately remembers its install path after normal uninstall;
    # MSI's AppSearch consumes that preference. Use the same owned path while
    # still requiring files and product registration to be absent before each.
    directory = temporary / "native install with spaces"
    report["install_directory"] = str(directory)
    for kind in ("nsis", "msi"):
        exercise(kind, installers[kind][0], directory, product, version,
                 references["formats"][kind]["sha256"], report, output)


def main():
    require(sys.platform == "win32" and os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted",
            "Installer execution is restricted to disposable GitHub-hosted Windows runners")
    root = Path(__file__).resolve().parents[1]
    require(root == Path(os.environ["GITHUB_WORKSPACE"]).resolve(), "Wrong checkout")
    output = root / "build/windows-installer-report"
    output.mkdir(parents=True, exist_ok=False)
    config = json.loads((root / "src-tauri/tauri.conf.json").read_text())
    product, version = config["productName"], config["version"]
    require(not registrations(product), "Refusing to modify a pre-existing product")
    bundle = root / "target/release/bundle"
    installers = {kind: list((bundle / kind).glob(pattern))
                  for kind, pattern in (("nsis", "*-setup.exe"), ("msi", "*.msi"))}
    require(all(len(paths) == 1 for paths in installers.values()), "Expected one NSIS and one MSI")
    binary = root / "target/release/ottplay-tauri.exe"
    require(binary.is_file(), "Locally built application missing")
    cli = json.loads((root / "node_modules/@tauri-apps/cli/package.json").read_text())["version"]
    locked_cli = json.loads((root / "package-lock.json").read_text())["packages"]["node_modules/@tauri-apps/cli"]["version"]
    raw = binary.read_bytes()
    report = {"schema": 1, "source_sha": os.environ["GITHUB_SHA"], "version": version,
              "product": product, "status": "failed", "installers": []}
    references = retain_payload_references(output, raw, cli, locked_cli, report)
    report["payload_references"] = references
    temp_base = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    temporary = Path(tempfile.mkdtemp(prefix="ottplay-installers-", dir=temp_base)).resolve()
    require(temporary.parent == temp_base, "Temporary directory escaped runner temp")
    try:
        exercise_installers(installers, temporary, product, version, references, report, output)
        report["status"] = "passed"
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        # The unique harness directory is the only manually removed path.
        # Any unsuccessful uninstaller remains a failed result in the receipt.
        try:
            shutil.rmtree(temporary)
            report["temporary_directory_removed"] = True
        except OSError as error:
            report["temporary_cleanup_error"] = str(error)
            report["status"] = "failed"
        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    require(report["status"] == "passed", "Installer cleanup failed")
    print("PASS: native NSIS and MSI installation, binary identity and uninstallation")


if __name__ == "__main__":
    main()

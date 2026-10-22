#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Public, release-candidate-only fuzzing policy and bounded runner.

The manifest is reviewed source, not an untrusted command interface. Commands
are argument arrays, never shell fragments. Campaigns run without networking;
only dependency installation/build steps may use the network.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
# Reviewed build and fuzz commands use argv arrays, never shell interpolation.
import subprocess  # nosec B404
import time

MANIFEST = ".github/fuzz.json"
JOB = "fuzz / RC fuzzing"
REPORT = "fuzz-report.json"
RUN_LOG = "run.log"
SHA_PATTERN = r"[a-f0-9]{40}"
SHA = re.compile(SHA_PATTERN)
CORPUS_FILES = 10000
CORPUS_BYTES = 64 * 1024 * 1024


def configuration(policy: dict) -> dict | None:
    """Opt-in requires a public, versioned release and immutable toolkit code."""
    value = policy.get("fuzzing")
    if value is None:
        return None
    if (
        not isinstance(value, dict)
        or set(value) != {"toolkit_ref"}
        or not isinstance(value["toolkit_ref"], str)
        or not SHA.fullmatch(value["toolkit_ref"])
        or policy.get("visibility", "public") != "public"
        or policy.get("mode") != "release"
        or policy.get("ci_execution", "github") != "github"
        or not isinstance(policy.get("versioning"), dict)
    ):
        raise ValueError("Fuzzing requires public versioned hosted releases and a pinned toolkit_ref")
    return value


def relative(value: object) -> str:
    """Restrict manifest paths to literal paths within the source tree."""
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_./-]+", value):
        raise ValueError("Fuzz paths must be literal relative paths")
    if value != "." and (value.startswith("/") or any(p in {"", ".", ".."} for p in value.split("/"))):
        raise ValueError("Fuzz path escapes the source tree")
    return value


def argv(value: object) -> list[str]:
    """Reject missing commands, control characters and unbounded argument lists."""
    if (
        not isinstance(value, list) or not 1 <= len(value) <= 64
        or any(not isinstance(v, str) or not v or len(v) > 2048 or any(ord(c) < 32 for c in v) for v in value)
    ):
        raise ValueError("Fuzz commands must be nonempty bounded argument arrays")
    return value


def validate_manifest_shape(data: object) -> None:
    if (
        not isinstance(data, dict)
        or set(data) - {"schema", "language", "setup", "targets", "go-version-file", "preflight", "preflight-paths"}
        or type(data.get("schema")) is not int or data["schema"] != 1
        or data.get("language") not in {"go", "rust", "python", "javascript", "c", "jvm"}
        or not isinstance(data.get("setup"), list) or len(data["setup"]) > 16
        or not isinstance(data.get("targets"), list) or not 1 <= len(data["targets"]) <= 12
    ):
        raise ValueError("Invalid fuzz manifest")


def validate_target(root: Path, target: object, names: set[str]) -> None:
    if (
        not isinstance(target, dict)
        or set(target) - {"name", "engine", "command", "seconds", "cwd", "corpus", "instrumentation"}
        or not isinstance(target.get("name"), str)
        or not re.fullmatch(r"[a-z][a-z0-9-]{0,49}", target["name"])
        or target["name"] in names
        or target.get("engine") not in {"go", "libfuzzer", "atheris"}
        or type(target.get("seconds")) is not int or not 1 <= target["seconds"] <= 120
    ):
        raise ValueError("Invalid, duplicated or unbounded fuzz target")
    names.add(target["name"])
    argv(target.get("command"))
    confined(root, relative(target.get("cwd", ".")))
    if "corpus" in target:
        confined(root, relative(target["corpus"]))
    if "instrumentation" in target:
        declarations = target["instrumentation"]
        if target["engine"] != "atheris" or not isinstance(declarations, list) or not 1 <= len(declarations) <= 32:
            raise ValueError("Instrumentation declarations require bounded Atheris functions")
        for declaration in declarations:
            if (not isinstance(declaration, dict) or set(declaration) != {"module", "functions"}
                    or not isinstance(declaration["module"], str)
                    or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", declaration["module"])
                    or not isinstance(declaration["functions"], list) or not 1 <= len(declaration["functions"]) <= 32
                    or any(not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", name)
                           for name in declaration["functions"])):
                raise ValueError("Invalid production instrumentation declaration")
    # The runner owns the time/resource limits and crash destination.
    reserved = ("-fuzztime", "-fuzzminimizetime", "-parallel", "-timeout", "-max_total_time", "-rss_limit_mb", "-artifact_prefix", "-runs", "-jobs", "-workers")
    if any(arg.split("=", 1)[0] in reserved for arg in target["command"]):
        raise ValueError("Fuzz target cannot override runner limits")


def manifest(root: Path) -> dict:
    raw = (root / MANIFEST).read_bytes()
    if len(raw) > 65536:
        raise ValueError("Fuzz manifest is too large")
    data = json.loads(raw)
    validate_manifest_shape(data)
    for command in data["setup"]:
        argv(command)
    if not isinstance(data.get("preflight", []), list) or len(data.get("preflight", [])) > 16:
        raise ValueError("Preflight commands must be a bounded list")
    for command in data.get("preflight", []):
        argv(command)
    if not isinstance(data.get("preflight-paths", []), list) or len(data.get("preflight-paths", [])) > 128:
        raise ValueError("Preflight paths must be a bounded list")
    for path in data.get("preflight-paths", []):
        confined(root, relative(path))
    if "go-version-file" in data:
        if data["language"] != "go":
            raise ValueError("go-version-file is only valid for Go")
        go_module_directory(root, data["go-version-file"])
    names = set()
    for target in data["targets"]:
        validate_target(root, target, names)
    if sum(t["seconds"] for t in data["targets"]) > 600:
        raise ValueError("Fuzz campaign budget exceeds ten minutes")
    return data


def confined(root: Path, value: str) -> Path:
    path = root / value
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Fuzz path resolves outside source")
    return path


def go_module_directory(root: Path, value: str) -> Path:
    version_file = confined(root, relative(value))
    if not version_file.is_file() or version_file.is_symlink():
        raise ValueError("go-version-file must be an existing regular file without symlinks")
    return version_file.parent


def event_contract(event: dict, event_name: str, ref: str, repository: str, sha: str) -> None:
    """Fail closed even if someone calls the reusable workflow directly."""
    repo = event.get("repository", {})
    if (
        event_name != "workflow_dispatch"
        or event.get("inputs", {}).get("channel") != "rc"
        or repo.get("private") is not False
        or repo.get("full_name") != repository
        or ref != "refs/heads/" + str(repo.get("default_branch"))
        or not SHA.fullmatch(sha)
    ):
        raise ValueError("Fuzz campaigns require a public default-branch RC dispatch")


def check_run_jobs(jobs: list[dict], channel: str, sha: str) -> None:
    matches = [j for j in jobs if j.get("name") == JOB]
    if channel == "rc":
        if len(matches) != 1 or any(matches[0].get(k) != v for k, v in {
            "head_sha": sha, "status": "completed", "conclusion": "success"
        }.items()):
            raise ValueError("RC requires one successful fuzz job at the exact source SHA")
    elif any(j.get("conclusion") != "skipped" for j in matches):
        raise ValueError("Fuzzing must not run outside RC")


def profile(policy: dict, channel: str) -> dict | None:
    config = configuration(policy)
    if config is None or channel != "rc":
        return None
    return {"schema": 1, "channel": "rc", "manifest": MANIFEST, **config}


def verify_report(directory: Path, root: Path, repository: str, sha: str, run: int, attempt: int) -> None:
    data = json.loads((directory / REPORT).read_bytes())
    config = manifest(root)
    expected = {
        "repository": repository, "source_sha": sha,
        "run_id": run, "run_attempt": attempt, "channel": "rc", "private": False,
        "manifest_sha256": hashlib.sha256((root / MANIFEST).read_bytes()).hexdigest(),
        "status": "passed", "network": "isolated",
    }
    if type(data.get("schema")) is not int or data["schema"] not in {1, 2} or any(type(data.get(k)) is not type(v) or data.get(k) != v for k, v in expected.items()):
        raise ValueError("Fuzz report identity or outcome mismatch")
    verify_target_inventory(data.get("targets", []), config["targets"])
    verify_preflight_evidence(data, config)


def verify_target_inventory(targets: object, configured: list) -> None:
    if not isinstance(targets, list) or any(
        not isinstance(t, dict) or type(t.get("seconds")) is not int or type(t.get("exit_code")) is not int
        for t in targets
    ) or [(t.get("name"), t.get("seconds"), t.get("exit_code")) for t in targets] != [
        (t["name"], t["seconds"], 0) for t in configured
    ]:
        raise ValueError("Fuzz report target inventory mismatch")


def verify_python_proof(proof: object, target: dict) -> None:
    expected = [(item["module"], function) for item in target.get("instrumentation", [])
                for function in item["functions"]]
    if not isinstance(proof, dict) or proof.get("target") != target["name"] or not expected:
        raise ValueError("Python instrumentation evidence differs from declared functions")
    if proof.get("engine") != "atheris" or type(proof.get("executions")) is not int or proof["executions"] <= 0:
        raise ValueError("Python preflight evidence requires positive engine execution metrics")
    actual = proof.get("instrumentation")
    if not isinstance(actual, list) or any(not isinstance(item, dict) for item in actual):
        raise ValueError("Malformed Python instrumentation evidence")
    if [(item.get("module"), item.get("function")) for item in actual] != expected:
        raise ValueError("Python instrumentation evidence differs from declared functions")


def verify_preflight_evidence(data: dict, config: dict) -> None:
    if data["schema"] == 1:
        if config.get("preflight") or any(target.get("instrumentation") for target in config["targets"]):
            raise ValueError("Declared preflight evidence requires a schema-2 fuzz report")
        return
    evidence = data.get("preflight")
    if not isinstance(evidence, dict) or evidence.get("commands") != len(config.get("preflight", [])):
        raise ValueError("Fuzz report preflight command inventory mismatch")
    if any(
        target.get("engine") != declared["engine"] or type(target.get("executions")) is not int or target["executions"] <= 0
        for target, declared in zip(data["targets"], config["targets"])
    ):
        raise ValueError("Fuzz report requires positive engine execution metrics")
    if config["language"] != "python":
        return
    proofs = evidence.get("python_targets")
    if not isinstance(proofs, list) or len(proofs) != len(config["targets"]):
        raise ValueError("Fuzz report requires Python instrumentation evidence")
    for proof, target in zip(proofs, config["targets"]):
        verify_python_proof(proof, target)


def exercised(engine: str, log: str) -> bool:
    """A successful command that discovers no fuzz target must not qualify an RC."""
    pattern = r"fuzz:.*?execs:\s*((?a:\d+))" if engine == "go" else r"Done ((?a:\d+)) runs in"
    return any(int(value) > 0 for value in re.findall(pattern, log))


def engine_metrics(engine: str, log: str) -> dict:
    """Retain actual engine work in the durable report, not only expiring logs."""
    pattern = r"fuzz:.*?execs:\s*((?a:\d+))" if engine == "go" else r"Done ((?a:\d+)) runs in"
    metrics = {"engine": engine, "executions": max((int(value) for value in re.findall(pattern, log)), default=0)}
    if engine == "go":
        discoveries = re.findall(r"new interesting:\s*((?a:\d+))", log)
        if discoveries:
            metrics["new_interesting"] = int(discoveries[-1])
    else:
        coverage = re.findall(r"\bcov:\s*((?a:\d+))\s+ft:\s*((?a:\d+))", log)
        if coverage:
            metrics.update(coverage_edges=int(coverage[-1][0]), coverage_features=int(coverage[-1][1]))
    return metrics


def corpus_walk_error(error: OSError) -> None:
    raise error


def corpus_files(source: Path, *, required: bool = False):
    """Walk regular inputs without silently dropping unreadable directories."""
    for current, directories, files in os.walk(source, followlinks=False, onerror=corpus_walk_error):
        if required and any((Path(current) / name).is_symlink() for name in [*directories, *files]):
            raise ValueError("Declared preflight corpus must not contain symlinks")
        directories[:] = sorted(name for name in directories if not (Path(current) / name).is_symlink())
        for name in sorted(files):
            path = Path(current) / name
            if stat.S_ISREG(path.lstat().st_mode):
                yield path


def retain_corpus(source: Path, destination: Path, *, required: bool = False) -> dict:
    """Copy only bounded regular corpus inputs, never symlinks or a build cache."""
    result = {"files": 0, "bytes": 0, "truncated": False}
    destination.mkdir(parents=True, exist_ok=True)
    if required and (not source.is_dir() or source.is_symlink()):
        raise ValueError("Declared preflight corpus must be an existing directory without symlinks")
    if not source.is_dir() or source.is_symlink():
        return result
    for path in corpus_files(source, required=required):
        size = path.stat().st_size
        if result["files"] >= CORPUS_FILES or result["bytes"] + size > CORPUS_BYTES:
            result["truncated"] = True
            return result
        target = destination / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        result["files"] += 1
        result["bytes"] += size
    if required and not result["files"]:
        raise ValueError("Declared preflight corpus must contain at least one regular seed file")
    return result


def split_receipts(receipts: list[dict]) -> tuple[list[dict], list[dict]]:
    """Fuzz validation evidence is not a toolchain input of final package builds."""
    validation = [r for r in receipts if r["name"] == "release-inputs-fuzz.json"]
    if len(validation) != 1 or [a.get("name") for a in validation[0]["inputs"].get("artifacts", [])] != [REPORT]:
        raise ValueError("Fuzz validation receipt must cover exactly the RC report")
    return [r for r in receipts if r not in validation], validation


def execute(command: list[str], cwd: Path, output: Path, timeout: int, isolated: bool) -> tuple[int, float]:
    # Build commands are reviewed source; do not interpolate them into a shell.
    if isolated:
        # Preserve the venv entry point: resolving its symlink selects the base
        # interpreter and silently discards pyvenv.cfg and installed packages.
        executable = os.path.abspath(cwd / command[0]) if "/" in command[0] else shutil.which(command[0])
        if executable is None:
            raise ValueError(f"Fuzz executable is unavailable: {command[0]}")
        environment = [f"{key}={os.environ[key]}" for key in (
            "PATH", "HOME", "GOROOT", "GOPATH", "GOCACHE", "GOMODCACHE", "GOTOOLCHAIN",
            "RUSTUP_HOME", "CARGO_HOME", "LD_LIBRARY_PATH", "PYTHONPATH", "JAVA_HOME",
        ) if key in os.environ]
        command = ["sudo", "-n", "unshare", "--net", f"--setgid={os.getgid()}",
                   f"--setuid={os.getuid()}", "--", "/usr/bin/env", "-i", *environment,
                   "GOMEMLIMIT=1536MiB", executable, *command[1:]]
    start = time.monotonic()
    with output.open("wb") as log:
        # The default-branch manifest supplies reviewed argv; campaigns add network isolation.
        process = subprocess.Popen(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)  # nosec B603
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            code = 124
    return code, round(time.monotonic() - start, 3)


def retain_go_diagnostics(root: Path, cwd: Path, target_dir: Path, go_version_file: str | None) -> dict:
    """Save native Go failures and bounded coverage discoveries separately."""
    for index, path in enumerate(cwd.rglob("testdata/fuzz")):
        if path.is_dir():
            shutil.copytree(path, target_dir / f"go-regressions-{index}")
    # Native Go keeps coverage discoveries outside testdata/fuzz. Resolve the
    # selected toolchain's cache; do not include compiled objects or modules.
    # A target may invoke Go through a Python/build adapter. Query the Go
    # selected on PATH in the declared module, never the adapter executable.
    go_cwd = go_module_directory(root, go_version_file) if go_version_file else cwd
    cache = subprocess.check_output(["go", "env", "GOCACHE"], cwd=go_cwd, text=True, timeout=30).strip()  # nosec B603, B607
    return retain_corpus(Path(cache) / "fuzz", target_dir / "go-generated-corpus")


def run_target(root: Path, output: Path, target: dict, *, go_version_file: str | None = None) -> dict:
    name, seconds = target["name"], target["seconds"]
    target_dir = output / name
    target_dir.mkdir()
    corpus = target_dir / "corpus"
    if "corpus" in target:
        retained = retain_corpus(confined(root, target["corpus"]), corpus, required=True)
        if retained["truncated"]:
            raise ValueError("Committed fuzz corpus exceeds the bounded input budget")
    else:
        corpus.mkdir()
    command = list(target["command"])
    if target["engine"] == "go":
        command += [f"-fuzztime={seconds}s", "-fuzzminimizetime=10s", "-parallel=2", f"-timeout={seconds + 60}s"]
    else:
        command += [f"-max_total_time={seconds}", "-timeout=10", "-rss_limit_mb=2048",
                    f"-artifact_prefix={target_dir}/", str(corpus)]
    cwd = confined(root, target.get("cwd", "."))
    code, elapsed = execute(command, cwd, target_dir / RUN_LOG, seconds + 300, True)
    metrics = engine_metrics(target["engine"], (target_dir / RUN_LOG).read_text(errors="replace"))
    if code == 0 and not metrics["executions"]:
        code = 125
    if target["engine"] == "go":
        metrics["generated_corpus"] = retain_go_diagnostics(root, cwd, target_dir, go_version_file)
    return {"name": name, "seconds": seconds, "exit_code": code, "elapsed_seconds": elapsed, **metrics}


def preflight_changed_paths(root: Path, event_name: str, event: dict) -> list[str]:
    import change_scope

    base, head, separator = change_scope.event_revisions(event_name, event)
    if not isinstance(base, str) or not isinstance(head, str):
        raise ValueError("Git revisions must be full object IDs")
    if not re.fullmatch(SHA_PATTERN, base) or not re.fullmatch(SHA_PATTERN, head) or separator not in {"..", "..."}:
        raise ValueError("Git revisions must be full object IDs with a fixed range separator")
    # Fixed Git query; the range contains only validated hex object IDs.
    raw = subprocess.check_output(  # nosec B603, B607
        ["git", "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", base + separator + head, "--"],
        cwd=root, timeout=30)
    return [path.decode("utf-8") for path in raw.split(b"\0") if path]


def preflight_needed(root: Path, data: dict) -> bool:
    """Skip unrelated ordinary-CI changes; missing Git evidence runs the check."""
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    repository = event.get("repository", {})
    if repository.get("private") is not False or repository.get("full_name") != os.environ.get("GITHUB_REPOSITORY"):
        raise ValueError("Hosted fuzz preflight requires a public repository")
    event_name = os.environ.get("GITHUB_EVENT_NAME")
    if event_name not in {"pull_request", "merge_group", "push"}:
        return False
    required = data.get("preflight-paths", [])
    if not required or "." in required:
        return True
    required = [*required, ".github/fuzz.json", ".github/requirements-fuzz.txt", ".release-policy.json", "scripts/change_scope.py",
                "scripts/release_fuzz.py", "scripts/fuzz_python_preflight.py", ".github/workflows"]
    try:
        changed = preflight_changed_paths(root, event_name, event)
    except (ValueError, KeyError, OSError, subprocess.SubprocessError):
        return True
    return any(path == wanted or path.startswith(wanted + "/") for path in changed for wanted in required)


def bounded_preflight(command, cwd, log, maximum, isolated, deadline):
    remaining = int(deadline - time.monotonic())
    if remaining <= 0:
        raise ValueError("Deterministic preflight exceeded its four-minute budget")
    return execute(command, cwd, log, min(maximum, remaining), isolated)


def replay_python_target(root: Path, output: Path, target: dict, deadline: float) -> dict:
    target_dir = output / target["name"]
    target_dir.mkdir()
    corpus = target_dir / "corpus"
    if "corpus" in target:
        retained = retain_corpus(confined(root, target["corpus"]), corpus, required=True)
        if retained["truncated"]:
            raise ValueError("Committed preflight corpus exceeds the bounded input budget")
    else:
        corpus.mkdir()
    report_path = target_dir / "instrumentation.json"
    command = [target["command"][0], str(Path(__file__).with_name("fuzz_python_preflight.py").resolve()),
               "--root", str(root), "--target", target["name"], "--output", str(report_path),
               "--", *target["command"][1:], "-runs=0", "-timeout=10", "-rss_limit_mb=2048",
               f"-artifact_prefix={target_dir}/", str(corpus)]
    code, _ = bounded_preflight(command, confined(root, target.get("cwd", ".")),
                               target_dir / RUN_LOG, 90, True, deadline)
    if code or not report_path.is_file():
        raise ValueError(f"Deterministic Python preflight failed: {target['name']}")
    metrics = engine_metrics("atheris", (target_dir / RUN_LOG).read_text(errors="replace"))
    if not metrics["executions"]:
        raise ValueError(f"Python preflight requires positive engine execution metrics: {target['name']}")
    proof = {**json.loads(report_path.read_text()), **metrics}
    report_path.write_text(json.dumps(proof, indent=2) + "\n")
    return proof


def preflight_python(root: Path, output: Path, data: dict, deadline: float) -> list:
    interpreters = set()
    proofs = []
    for target in data["targets"]:
        if target["engine"] != "atheris" or len(target["command"]) < 2:
            raise ValueError("Python preflight requires Atheris script targets")
        cwd = confined(root, target.get("cwd", "."))
        interpreter = target["command"][0]
        key = (str(cwd), interpreter)
        if key not in interpreters:
            code, _ = bounded_preflight([interpreter, "-m", "pip", "check"], cwd,
                                        output / f"pip-check-{len(interpreters)}.log", 60, True, deadline)
            if code:
                raise ValueError("Fuzz dependency environment failed pip check")
            interpreters.add(key)
        proofs.append(replay_python_target(root, output, target, deadline))
    return proofs


def validate_python_preflight(data: dict) -> None:
    if data["language"] == "python" and any(
        target["engine"] != "atheris" or len(target["command"]) < 2 or not target.get("instrumentation")
        for target in data["targets"]
    ):
        raise ValueError("Python preflight requires Atheris scripts with production instrumentation declarations")


def run_preflight(root: Path, output: Path, data: dict, *, setup: bool) -> dict:
    """Replay fixed seeds only; native campaigns are never built by default."""
    validate_python_preflight(data)
    output.mkdir(parents=True, exist_ok=False)
    deadline = time.monotonic() + 240
    if setup and data["language"] == "python":
        for index, command in enumerate(data["setup"]):
            code, _ = bounded_preflight(command, root, output / f"setup-{index}.log", 180, False, deadline)
            if code:
                raise ValueError(f"Preflight dependency setup {index} failed with {code}")
    evidence = {"python_targets": [], "commands": len(data.get("preflight", []))}
    if data["language"] == "python":
        evidence["python_targets"] = preflight_python(root, output, data, deadline)
    for index, command in enumerate(data.get("preflight", [])):
        code, _ = bounded_preflight(command, root, output / f"command-{index}.log", 90, True, deadline)
        if code:
            raise ValueError(f"Deterministic preflight command {index} failed with {code}")
    (output / "preflight-report.json").write_text(json.dumps(evidence, indent=2) + "\n")
    return evidence


def campaign(root: Path, output: Path) -> None:
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    event_contract(event, os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_REF"],
                   os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_SHA"])
    data = manifest(root)
    validate_python_preflight(data)
    # Fixed read-only Git query using the runner's selected toolchain.
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()  # nosec B603, B607
    if actual != os.environ["GITHUB_SHA"]:
        raise ValueError("Fuzz checkout differs from RC source")
    output.mkdir(parents=True, exist_ok=False)
    report = {
        "schema": 2, "repository": os.environ["GITHUB_REPOSITORY"], "source_sha": actual,
        "run_id": int(os.environ["GITHUB_RUN_ID"]), "run_attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
        "channel": "rc", "private": False, "network": "isolated", "status": "failed",
        "manifest_sha256": hashlib.sha256((root / MANIFEST).read_bytes()).hexdigest(),
        "targets": [],
    }
    try:
        for index, command in enumerate(data["setup"]):
            code, _ = execute(command, root, output / f"setup-{index}.log", 600, False)
            if code:
                raise ValueError(f"Fuzz build/setup {index} failed with {code}")
        report["preflight"] = run_preflight(root, output / "preflight", data, setup=False)
        for target in data["targets"]:
            report["targets"].append(run_target(root, output, target, go_version_file=data.get("go-version-file")))
        if any(t["exit_code"] for t in report["targets"]):
            raise ValueError("One or more fuzz targets failed; inspect diagnostics")
        report["status"] = "passed"
    finally:
        (output / REPORT).write_text(json.dumps(report, indent=2) + "\n")
    print(f"RC fuzzing passed: {len(report['targets'])} targets")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("inspect", "run", "preflight"))
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path)
    parser.add_argument("--if-changed", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    if args.action == "inspect":
        data = manifest(root)
        event_contract(json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()),
                       os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_REF"],
                       os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_SHA"])
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
            output.write(f"language={data['language']}\ngo_version_file={data.get('go-version-file', '')}\n")
    elif args.action == "preflight":
        if args.output is None:
            parser.error("preflight requires --output")
        data = manifest(root)
        if args.if_changed and not preflight_needed(root, data):
            print("Fuzz preflight skipped: no relevant ordinary-CI changes")
            return
        run_preflight(root, args.output.resolve(), data, setup=True)
        print("Deterministic fuzz preflight passed; no mutation campaign was run")
    else:
        if args.output is None:
            parser.error("run requires --output")
        campaign(root, args.output.resolve())


if __name__ == "__main__":
    main()

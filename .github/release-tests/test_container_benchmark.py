"""Offline safety, cache-evidence and runtime contracts for native benchmarks."""

import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("container_benchmark", ROOT / "scripts/benchmark-container-build.py")
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)
SHA = "a" * 40
CONFIG = "sha256:" + "b" * 64
RUST_NAME = "[rust-build 6/6] RUN cargo build --locked --release --bin ottplay-server"


def result(stdout="", code=0, stderr=""):
    return subprocess.CompletedProcess([], code, stdout, stderr)


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def rust_vertex(cached=False):
    return {
        "id": "sha256:rust",
        "name": RUST_NAME,
        "cached": cached,
        "started": "2026-09-19T01:00:00Z",
        "completed": "2026-09-19T01:00:02Z",
    }


class TemporaryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ottplay-benchmark-test-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()


class ProgressTests(TemporaryTest):
    def test_flat_and_batched_rawjson_merge_without_losing_cache_proof(self):
        progress = self.directory / "progress.jsonl"
        events = [
            {"id": "sha256:rust", "name": RUST_NAME, "started": "2026-09-19T01:00:00Z"},
            {"vertexes": [{"digest": "sha256:rust", "cached": True, "completed": "2026-09-19T01:00:02Z"}]},
            {"id": "sha256:rust", "stream": 1, "data": "unrelated log"},
        ]
        progress.write_text("diagnostic\n" + "\n".join(json.dumps(event) for event in events))
        vertices = benchmark.vertices_from_progress(progress)
        found = benchmark.require_rust_cache(vertices, True)
        self.assertEqual(found["seconds"], 2)
        self.assertEqual(len(vertices), 1)

    def test_cache_proof_rejects_missing_duplicate_failed_incomplete_and_miss(self):
        cases = [
            [],
            [rust_vertex(True), rust_vertex(True)],
            [{**rust_vertex(True), "error": "failure"}],
            [{**rust_vertex(True), "completed": None}],
            [rust_vertex(False)],
            [{**rust_vertex(), "cached": "true"}],
            [{**rust_vertex(True), "name": "[build] RUN npm run build:server"}],
        ]
        for vertices in cases:
            with self.subTest(vertices=vertices), self.assertRaises(benchmark.BenchmarkError):
                benchmark.require_rust_cache(vertices, True)
        with self.assertRaises(benchmark.BenchmarkError):
            benchmark.require_rust_cache([rust_vertex(True)], False)
        self.assertEqual(benchmark.require_rust_cache([rust_vertex()], False)["name"], RUST_NAME)

    def test_native_architecture_is_required_not_emulated(self):
        with patch.object(benchmark, "command", return_value=result('"aarch64"')):
            benchmark.require_native("linux/arm64")
            with self.assertRaisesRegex(benchmark.BenchmarkError, "native architecture"):
                benchmark.require_native("linux/amd64")


class SourceTests(TemporaryTest):
    def fixture(self):
        root = self.directory / "source"
        root.mkdir()
        subprocess.run(["git", "init", "--quiet", str(root)], check=True)
        policy = {
            "repository": "example/player",
            "mode": "release",
            "version_file": "package.json",
            "versioning": {
                "schema": 1,
                "promotion": "promote-bytes",
                "build_number_floor": 20,
                "files": [{"path": "package.json", "format": "json", "field": "version", "value": "package"}],
            },
        }
        for path, value in {
            "Dockerfile": "FROM fixture\n",
            ".release-policy.json": json.dumps(policy),
            "index.html": "<html>player</html>",
            "package.json": '{"version":"1.2.3"}',
            "scripts/prepare-container-workspace.py": "# fixture\n",
        }.items():
            write(root / path, value)
        subprocess.run(["git", "-C", str(root), "add", "."], check=True)
        return root

    def test_git_context_has_current_tracked_and_staged_bytes_not_private_files(self):
        root = self.fixture()
        write(root / "index.html", "updated tracked bytes")
        write(root / "staged.sh", "#!/bin/sh\n")
        (root / "staged.sh").chmod(0o755)
        subprocess.run(["git", "-C", str(root), "add", "staged.sh"], check=True)
        write(root / "private.json", "private untracked config")
        write(root / ".local-artifacts/private.json", "private evidence")
        destination = self.directory / "copy"
        inventory = benchmark.copy_workspace(root, destination)
        self.assertEqual((destination / "index.html").read_text(), "updated tracked bytes")
        self.assertTrue(inventory["staged.sh"]["executable"])
        self.assertNotIn("private.json", inventory)
        self.assertFalse((destination / ".local-artifacts").exists())
        (root / "staged.sh").unlink()
        deleted = benchmark.copy_workspace(root, self.directory / "deleted")
        self.assertNotIn("staged.sh", deleted)

    def test_indexed_links_and_missing_required_new_helper_fail_closed(self):
        root = self.fixture()
        (root / "escape").symlink_to(self.directory)
        subprocess.run(["git", "-C", str(root), "add", "escape"], check=True)
        with self.assertRaisesRegex(benchmark.BenchmarkError, "Symlinks"):
            benchmark.copy_workspace(root, self.directory / "copy")
        subprocess.run(["git", "-C", str(root), "rm", "--cached", "escape"], check=True, capture_output=True)
        subprocess.run(
            ["git", "-C", str(root), "rm", "--cached", "scripts/prepare-container-workspace.py"],
            check=True,
            capture_output=True,
        )
        with self.assertRaisesRegex(benchmark.BenchmarkError, "not Git-managed"):
            benchmark.copy_workspace(root, self.directory / "copy2")

    def test_three_cases_use_real_frozen_overlays_without_changing_source(self):
        root = self.fixture()
        output = self.directory / "output"
        original = {
            str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob("*")
            if path.is_file() and ".git" not in path.parts
        }
        calls = []
        real_command = benchmark.command

        def fake_command(args, **kwargs):
            if args[:3] == ["git", "rev-parse", "HEAD"]:
                return result(SHA)
            if args[:3] == ["docker", "buildx", "version"]:
                return result("fixture buildx")
            return real_command(args, **kwargs)

        def fake_build(context, directory, name, platform, plan, cache, warm, archive):
            benchmark.version_plan.validate_plan(plan, json.loads((context / ".release-policy.json").read_text()), SHA)
            self.assertEqual(json.loads((context / "package.json").read_text())["version"], plan["version"])
            calls.append((name, warm, plan["version"], (context / "index.html").read_text()))
            archive.write_bytes(b"fixture OCI")
            return {"case": name, "rustCached": warm}

        with (
            patch.object(benchmark.shutil, "which", return_value="tool"),
            patch.object(benchmark, "require_native"),
            patch.object(benchmark, "command", side_effect=fake_command),
            patch.object(benchmark, "build_case", side_effect=fake_build),
            patch.object(benchmark, "inspect_archive", return_value={"config_digest": CONFIG}),
            patch.object(benchmark, "smoke_archive", return_value={"healthStatus": 200}),
        ):
            report = benchmark.benchmark(root, "linux/arm64", output)
        self.assertTrue(report["passed"])
        self.assertFalse(report["registryWrites"])
        self.assertEqual(
            [call[:3] for call in calls],
            [
                ("cold-beta1", False, "1.2.3-beta.1"),
                ("warm-same-beta1", True, "1.2.3-beta.1"),
                ("warm-next-beta2-frontend", True, "1.2.3-beta.2"),
            ],
        )
        self.assertEqual(calls[0][3], calls[1][3])
        self.assertEqual(calls[2][3], calls[0][3] + benchmark.FRONTEND_MARKER)
        self.assertTrue((output / "native.oci.tar").is_file())
        self.assertTrue(json.loads((output / "report.json").read_text())["passed"])
        for path, raw in original.items():
            self.assertEqual((root / path).read_bytes(), raw)

    def test_existing_output_is_rejected_before_any_tool(self):
        with patch.object(benchmark, "command") as command:
            with self.assertRaisesRegex(benchmark.BenchmarkError, "new directory"):
                benchmark.benchmark(self.directory, "linux/arm64", self.directory)
            command.assert_not_called()

    def test_inspection_failure_preserves_completed_timings_phase_and_safe_reason(self):
        root = self.fixture()
        output = self.directory / "output"
        real_command = benchmark.command

        def fake_command(args, **kwargs):
            if args[:3] == ["git", "rev-parse", "HEAD"]:
                return result(SHA)
            if args[:3] == ["docker", "buildx", "version"]:
                return result("fixture")
            return real_command(args, **kwargs)

        def fake_build(context, directory, name, platform, plan, cache, warm, archive):
            archive.write_bytes(b"retained failed-inspection archive")
            return {"case": name, "rustCached": warm}

        with (
            patch.object(benchmark.shutil, "which", return_value="tool"),
            patch.object(benchmark, "require_native"),
            patch.object(benchmark, "command", side_effect=fake_command),
            patch.object(benchmark, "build_case", side_effect=fake_build),
            patch.object(
                benchmark,
                "inspect_archive",
                side_effect=ValueError(
                    "Attestation statement has a different subject https://signed.invalid/?token=private-value"
                ),
            ),
            patch.object(benchmark, "smoke_archive") as smoke,
            self.assertRaisesRegex(ValueError, "different subject"),
        ):
            benchmark.benchmark(root, "linux/arm64", output)
        smoke.assert_not_called()
        report = json.loads((output / "report.json").read_text())
        self.assertFalse(report["passed"])
        self.assertEqual(report["phase"], "inspect-oci")
        self.assertEqual(report["error"]["type"], "ValueError")
        self.assertEqual(len(report["cases"]), 3)
        self.assertTrue((output / "native.oci.tar").exists())
        self.assertIn("different subject", (output / "failure.log").read_text())
        self.assertNotIn("private-value", (output / "failure.log").read_text())


class BuildTests(TemporaryTest):
    def test_each_build_has_own_builder_with_explicit_export_or_import_and_no_publish(self):
        calls, builds = [], []
        cache = self.directory / "cache"

        def fake_command(args, **kwargs):
            calls.append(args)
            return result()

        def fake_build(args, **kwargs):
            builds.append(args)
            warm = "--cache-from" in args
            kwargs["stderr"].write(json.dumps(rust_vertex(warm)) + "\n")
            write(cache / "index.json", "{}")
            return result()

        with (
            patch.object(benchmark, "command", side_effect=fake_command),
            patch.object(benchmark.subprocess, "run", side_effect=fake_build),
        ):
            for name, warm in [("cold", False), ("warm", True)]:
                receipt = benchmark.build_case(
                    self.directory,
                    self.directory,
                    name,
                    "linux/arm64",
                    {"version": "1.2.3-beta.1", "source_sha": SHA},
                    cache,
                    warm,
                    self.directory / (name + ".tar"),
                )
                self.assertEqual(receipt["rustCached"], warm)
        created = [args[4] for args in calls if args[:3] == ["docker", "buildx", "create"]]
        removed = [args[-1] for args in calls if args[:3] == ["docker", "buildx", "rm"]]
        self.assertEqual(len(set(created)), 2)
        self.assertEqual(created, removed)
        self.assertIn("mode=max", builds[0][builds[0].index("--cache-to") + 1])
        self.assertNotIn("--cache-from", builds[0])
        self.assertNotIn("--cache-to", builds[1])
        self.assertIn(str(cache), builds[1][builds[1].index("--cache-from") + 1])
        for args in builds:
            self.assertNotIn("--push", args)
            self.assertNotIn("--load", args)
            self.assertEqual(args[args.index("--tag") + 1], "ottplay-container-benchmark:1.2.3-beta.1")
            self.assertIn("--sbom=true", args)
            self.assertIn("--provenance=mode=max", args)
            self.assertIn("oci-mediatypes=true,compression=gzip", args[args.index("--output") + 1])
        self.assertFalse(any("--use" in args for args in calls))

    def test_builder_is_removed_on_build_failure_and_progress_survives(self):
        calls = []
        with (
            patch.object(benchmark, "command", side_effect=lambda args, **kwargs: calls.append(args) or result()),
            patch.object(benchmark.subprocess, "run", return_value=result(code=1)),
            self.assertRaisesRegex(benchmark.BenchmarkError, "Docker build failed"),
        ):
            benchmark.build_case(
                self.directory,
                self.directory,
                "failed",
                "linux/arm64",
                {"version": "1.2.3-beta.1", "source_sha": SHA},
                self.directory / "cache",
                False,
                self.directory / "image.tar",
            )
        self.assertEqual(calls[-1][:3], ["docker", "buildx", "rm"])
        self.assertTrue((self.directory / "failed.jsonl").exists())


class Response(io.BytesIO):
    status = 200


class SmokeTests(TemporaryTest):
    def test_skopeo_endpoint_matches_docker_cli_environment_and_context(self):
        with (
            patch.dict(benchmark.os.environ, {"DOCKER_HOST": "unix:///override.sock", "DOCKER_CONTEXT": ""}),
            patch.object(benchmark, "command") as command,
        ):
            self.assertEqual(benchmark.docker_daemon_host(), "unix:///override.sock")
            command.assert_not_called()
        with (
            patch.dict(benchmark.os.environ, {"DOCKER_HOST": "unix:///ignored.sock", "DOCKER_CONTEXT": "colima"}),
            patch.object(benchmark, "command", return_value=result("unix:///colima.sock\n")),
        ):
            self.assertEqual(benchmark.docker_daemon_host(), "unix:///colima.sock")
        with (
            patch.dict(benchmark.os.environ, {"DOCKER_HOST": "tcp://remote:2375", "DOCKER_CONTEXT": ""}),
            self.assertRaisesRegex(benchmark.BenchmarkError, "local Unix"),
        ):
            benchmark.docker_daemon_host()

    def smoke(self, *, wrong_bytes=False, wrong_config=False):
        calls, requests = [], []
        web = {"index.html": b"<html>player</html>", "dist/player.js": b"var player = true;"}
        inspected = {
            "config_digest": CONFIG,
            "critical_web_files": {name: hashlib.sha256(raw).hexdigest() for name, raw in web.items()},
        }

        def fake_command(args, **kwargs):
            calls.append(args)
            if args[:3] == ["docker", "image", "inspect"]:
                return result("different" if wrong_config else CONFIG)
            if args[:2] == ["docker", "inspect"]:
                return result(json.dumps({"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "49152"}]}))
            if args[:2] == ["docker", "exec"]:
                return result("65532")
            return result()

        def response(url, timeout):
            requests.append(url)
            path = url.split("49152/", 1)[1]
            return Response(b"ok" if path == "health" else b"wrong" if wrong_bytes else web[path])

        with (
            patch.object(benchmark, "command", side_effect=fake_command),
            patch.object(benchmark, "docker_daemon_host", return_value="unix:///selected-context.sock"),
            patch.object(benchmark, "build_opener") as opener,
            patch.object(benchmark, "epg_image_check", return_value={"passed": True}) as epg,
        ):
            opener.return_value.open.side_effect = response
            if wrong_config or wrong_bytes:
                with self.assertRaisesRegex(benchmark.BenchmarkError, "differs"):
                    benchmark.smoke_archive(self.directory / "native.oci.tar", "linux/arm64", inspected)
            else:
                receipt = benchmark.smoke_archive(self.directory / "native.oci.tar", "linux/arm64", inspected)
                self.assertEqual(receipt["servedSha256"], inspected["critical_web_files"])
                self.assertEqual(receipt["epgPerformance"], {"passed": True})
                epg.assert_called_once()
        self.assertEqual(calls[-2][:3], ["docker", "rm", "--force"])
        self.assertEqual(calls[-1][:3], ["docker", "image", "rm"])
        self.assertEqual(calls[0][-1].split(":")[0], "docker-daemon")
        self.assertEqual(calls[0][calls[0].index("--dest-daemon-host") + 1], "unix:///selected-context.sock")
        if wrong_config:
            self.assertFalse(any(args[:2] == ["docker", "run"] for args in calls))
        else:
            run = next(args for args in calls if args[:2] == ["docker", "run"])
            self.assertEqual(run[run.index("--publish") + 1], "127.0.0.1::8080")
            self.assertIn("EPG_URLS=http://127.0.0.1:9/unused", run)
        return requests

    def test_exact_image_nonroot_loopback_health_and_frontend_bytes(self):
        requests = self.smoke()
        self.assertEqual(len(requests), 3)

    def test_wrong_loaded_config_never_runs_and_is_cleaned_up(self):
        self.smoke(wrong_config=True)

    def test_wrong_frontend_bytes_fail_and_clean_up(self):
        self.smoke(wrong_bytes=True)

    def test_skopeo_failure_retains_bounded_sanitized_diagnostics(self):
        log = self.directory / "smoke-import.log"
        with (
            patch.object(
                benchmark.subprocess,
                "run",
                return_value=result(
                    code=1, stderr="connection refused https://signed.example/path?secret=value token=private-value\n"
                ),
            ),
            self.assertRaisesRegex(benchmark.BenchmarkError, "smoke-import.log"),
        ):
            benchmark.command(["skopeo", "copy", "local"], diagnostic_path=log)
        self.assertIn("connection refused", log.read_text())
        self.assertNotIn("signed.example", log.read_text())
        self.assertNotIn("private-value", log.read_text())
        self.assertLessEqual(len(log.read_text()), 4096)


if __name__ == "__main__":
    unittest.main()

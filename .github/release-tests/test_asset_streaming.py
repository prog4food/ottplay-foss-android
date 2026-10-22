# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Exercise bounded release payload I/O and fail-closed staging offline."""

import io
# Imported only for subprocess result/exception fixtures; commands are mocked.
import subprocess  # nosec B404
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from test_release_control import FakeGitHub, REPO, SHA, rc


class BoundedReader(io.BytesIO):
    """Reject unbounded reads even when a fixture fits in memory."""

    def read(self, size=-1):
        if not 0 < size <= rc.ASSET_CHUNK_SIZE:
            raise AssertionError(f"Unbounded payload read: {size}")
        return super().read(size)


class AssetStreamingTests(unittest.TestCase):
    """Preserve byte identity and publication boundaries with streamed assets."""

    def test_copy_and_hash_bounded_chunks_including_empty_and_partial_chunk(self):
        """All byte counts and hashes match the original payload exactly."""
        for payload in (b"", b"x", b"abc" * rc.ASSET_CHUNK_SIZE):
            with self.subTest(size=len(payload)):
                output = io.BytesIO()
                identity = rc.stream_identity(BoundedReader(payload), output)
                self.assertEqual(output.getvalue(), payload)
                self.assertEqual(
                    identity, {"size": len(payload), "sha256": rc.digest(payload)}
                )

    def test_transport_streams_to_output_with_media_type_and_timeout(self):
        """Large responses bypass subprocess PIPE capture while retaining guards."""
        with tempfile.TemporaryFile() as output:
            with patch.object(
                rc.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0, stderr=b""),
            ) as run:
                rc.GitHub(REPO).download_asset("releases/assets/21", output)
            command = run.call_args.args[0]
            self.assertIn("Accept: application/octet-stream", command)
            self.assertEqual(command[-2:], ["--", f"repos/{REPO}/releases/assets/21"])
            self.assertIs(run.call_args.kwargs["stdout"], output)
            self.assertNotIn("capture_output", run.call_args.kwargs)
            self.assertEqual(run.call_args.kwargs["timeout"], 900)

    def test_transport_rejects_non_asset_endpoints_before_launching_gh(self):
        """Streaming does not widen the repository API allowlist."""
        for path in (
            "actions/artifacts/40/zip",
            "releases/assets/0",
            "../secrets",
            "releases/assets/21?x=1",
        ):
            with self.subTest(path=path), patch.object(rc.subprocess, "run") as run:
                gh = rc.GitHub(REPO)
                output = io.BytesIO()
                with self.assertRaisesRegex(rc.ReleaseError, "Unsupported binary"):
                    gh.download_asset(path, output)
                run.assert_not_called()

    def test_transport_timeout_uses_the_release_error_contract(self):
        """CLI entry points report bounded download failures without a traceback."""
        gh = rc.GitHub(REPO)
        output = io.BytesIO()
        with (
            patch.object(
                rc.subprocess, "run", side_effect=subprocess.TimeoutExpired("gh", 900)
            ),
            self.assertRaisesRegex(rc.GitHubError, "exceeded 900 seconds"),
        ):
            gh.download_asset("releases/assets/21", output)

    def test_successful_download_returns_identity_of_the_actual_staged_bytes(self):
        """Callers validate disk bytes, independently of GitHub metadata digests."""
        gh = FakeGitHub()
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / "app.zip"
            result = rc.download_asset(gh, 21, destination)
            self.assertEqual(destination.read_bytes(), gh.files[21])
            self.assertEqual(
                result, {"size": len(gh.files[21]), "sha256": rc.digest(gh.files[21])}
            )

    def test_partial_download_is_removed_on_transport_error_timeout_or_interrupt(self):
        """No failed payload remains eligible for a subsequent upload."""
        errors = (
            rc.GitHubError("HTTP 500"),
            subprocess.TimeoutExpired("gh", 900),
            KeyboardInterrupt(),
        )
        for error in errors:
            with (
                self.subTest(error=type(error).__name__),
                tempfile.TemporaryDirectory() as temp,
            ):
                destination = Path(temp) / "app.zip"

                def fail(_path, output, download_error=error):
                    output.write(b"partial payload")
                    raise download_error

                gh = Mock(download_asset=Mock(side_effect=fail))
                with self.assertRaises(type(error)):
                    rc.download_asset(gh, 21, destination)
                self.assertFalse(destination.exists())

    def test_existing_file_and_symlink_are_never_overwritten_or_removed(self):
        """Exclusive creation preserves foreign files even when download fails."""
        with tempfile.TemporaryDirectory() as temp:
            existing = Path(temp) / "existing.zip"
            existing.write_bytes(b"keep")
            link = Path(temp) / "link.zip"
            link.symlink_to(existing)
            gh = Mock()
            for destination in (existing, link):
                with self.subTest(path=destination), self.assertRaises(FileExistsError):
                    rc.download_asset(gh, 21, destination)
                self.assertEqual(existing.read_bytes(), b"keep")
                self.assertTrue(link.is_symlink())
            gh.download_asset.assert_not_called()

    def test_truncated_uploaded_bytes_leave_draft_unpublished(self):
        """A successful HTTP response still needs the complete expected payload."""
        gh = FakeGitHub()
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp)
            (stage / "app.zip").write_bytes(b"verified payload")

            def truncate(path, output):
                output.write(gh.binary(path)[:-1])

            with patch.object(gh, "download_asset", side_effect=truncate):
                with self.assertRaisesRegex(rc.ReleaseError, "Uploaded bytes differ"):
                    rc.publish(gh, "v9.9.9", SHA, stage, False, "")
        self.assertFalse(any(write[1] == "PATCH" for write in gh.writes))
        release = next(
            item for item in gh.releases.values() if item["tag_name"] == "v9.9.9"
        )
        self.assertTrue(release["draft"])


if __name__ == "__main__":
    unittest.main()

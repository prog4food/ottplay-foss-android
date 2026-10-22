#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Publish candidates and promote checked RCs inside the guarded Actions workflow."""

# Keep the audited engine self-contained when vendored into application repos.
# Lazy versioning imports call back into this engine only after it is initialized.
# pylint: disable=too-many-lines,cyclic-import

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import random
import re
import stat

# Subprocess calls below use argument vectors with shell=False.
import subprocess  # nosec B404
import sys
import tempfile
import time
import zipfile
from collections.abc import Iterable, Iterator, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, TypedDict, cast
from urllib.parse import quote, unquote

WORKFLOW = ".github/workflows/release-pipeline.yml"
GITHUB_HOSTNAME = "github.com"
MANIFEST = "release-manifest.json"
POLICY = ".release-policy.json"
EVIDENCE = Path(".release-evidence") / MANIFEST


class AssetRestriction(TypedDict):
    suffixes: Sequence[str]
    reason: str


class AssetIdentity(TypedDict):
    size: int
    sha256: str


JSONObject = dict[str, object]
ReleaseSnapshot = tuple[JSONObject, JSONObject, list[JSONObject]]
ASSET_RESTRICTIONS: tuple[AssetRestriction, ...]
ASSET_RESTRICTIONS = ({'suffixes': ['.aab'], 'reason': 'Play Store AAB publication belongs to open-ott-play/ottplay-android'},)
RELEASE_SIGNATURES_REQUIRED = False


def verify_required_signatures(directory: Path, repo: str, sha: str) -> None:
    """Fail closed before publication when this reviewed consumer requires signing."""
    if not RELEASE_SIGNATURES_REQUIRED:
        return
    # Only signed consumers vendor this optional verifier, from the same checkout.
    if __package__:
        from .release_signing import read_json, verify  # pylint: disable=import-outside-toplevel
    else:
        from release_signing import read_json, verify  # pylint: disable=import-outside-toplevel

    policy = read_json(Path(POLICY))
    if policy.get("repository") != repo or policy.get("sign_releases") is not True:
        raise ReleaseError("Trusted release-signing policy does not match this repository")
    verify(directory, policy, sha)
VERSION_PATTERN = r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
VERSION_RE = re.compile(VERSION_PATTERN, re.ASCII)
TAG_RE = re.compile(
    "v"
    + VERSION_PATTERN
    + r"(?:-(?:beta|rc)\.[1-9]\d*|-nightly\.\d{14}\.[1-9]\d*\.[1-9]\d*)?",
    re.ASCII,
)
API_PATHS = {
    "GET": (
        r"(?:|tags|releases|environments/release)",
        r"releases/(?:[1-9]\d*(?:/assets)?|assets/[1-9]\d*)",
        "releases/tags/" + TAG_RE.pattern,
        "git/ref/tags/" + TAG_RE.pattern,
        r"actions/runs/[1-9]\d*(?:/artifacts|/attempts/[1-9]\d*/jobs)?",
        r"actions/artifacts/[1-9]\d*/zip",
        r"contents/\.release-policy\.json\?ref=[0-9a-f]{40}",
        r"contents/CHANGELOG\.md\?ref=[0-9a-f]{40}",
        r"contents/\.github\?ref=[0-9a-f]{40}",
        r"contents/release-version-state\.json\?ref=release-version-state",
        r"git/ref/heads/release-version-state",
        r"git/ref/heads/(?:[A-Za-z0-9_.~-]|%[0-9A-F]{2})+",
        r"actions/workflows/release-pipeline\.yml/runs\?branch=(?:[A-Za-z0-9_.~-]|%[0-9A-F]{2})+&event=push&head_sha=[0-9a-f]{40}&per_page=100",
        r"compare/[0-9a-f]{40}\.\.\.(?:[A-Za-z0-9_.~-]|%[0-9A-F]{2})+",
    ),
    "POST": (r"(?:git/refs|releases)",),
    "PATCH": (r"releases/[1-9]\d*",),
    "PUT": (r"contents/release-version-state\.json",),
}
SHA256_PATTERN = r"[0-9a-f]{64}"
SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,199}\Z")
REPO_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*\Z")
ASSET_CHUNK_SIZE = 1024 * 1024
ASSET_DOWNLOAD_TIMEOUT = 900
API_READ_TIMEOUT = 30
API_READ_ATTEMPTS = 3


class ReleaseError(RuntimeError):
    """A release precondition failed. No retry should overwrite existing data."""


class GitHubError(ReleaseError):
    """Report a GitHub failure while distinguishing a genuine missing resource."""

    def __init__(self, message: str, not_found: bool = False):
        super().__init__(message)
        self.not_found = not_found


def require(condition: object, message: str) -> None:
    """Abort before the next operation when a release precondition fails."""
    if not condition:
        raise ReleaseError(message)


def version(value: str) -> str:
    """Validate and return a canonical numeric X.Y.Z base version."""
    require(
        bool(VERSION_RE.fullmatch(value)),
        "Version must be strict X.Y.Z without leading zeros",
    )
    return value


def positive(value: object, name: str) -> int:
    """Parse a positive integer identifier without accepting booleans."""
    require(
        isinstance(value, (str, int)) and not isinstance(value, bool), f"Invalid {name}"
    )
    require(bool(re.fullmatch(r"[1-9]\d*", str(value), re.ASCII)), f"Invalid {name}")
    return int(cast(str | int, value))


def digest(data: bytes) -> str:
    """Return the SHA-256 hex digest of the exact supplied bytes."""
    return hashlib.sha256(data).hexdigest()


def atomic_write_bytes(destination: Path, data: bytes) -> None:
    """Replace a plain output file without writing through existing hard links."""
    destination = Path(destination)

    def plain_mode() -> int | None:
        try:
            mode = destination.lstat().st_mode
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(mode):
            raise ValueError(f"Output must be a plain file: {destination}")
        return stat.S_IMODE(mode)

    mode = plain_mode()
    fd, name = tempfile.mkstemp(prefix=".release-output-", dir=destination.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(temporary, mode)
        plain_mode()
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def stream_identity(
    source: BinaryIO, destination: BinaryIO | None = None
) -> AssetIdentity:
    """Hash exact bytes in bounded chunks, optionally copying to private staging."""
    checksum = hashlib.sha256()
    size = 0
    while chunk := source.read(ASSET_CHUNK_SIZE):
        if destination is not None:
            destination.write(chunk)
        size += len(chunk)
        checksum.update(chunk)
    return {"size": size, "sha256": checksum.hexdigest()}


def download_asset(gh: GitHub, asset_id: object, destination: Path) -> AssetIdentity:
    """Stage one asset exclusively and discard incomplete or failed downloads."""
    path = f"releases/assets/{positive(asset_id, 'asset ID')}"
    output = destination.open("xb+")
    try:
        with output:
            gh.download_asset(path, output)
            output.seek(0)
            return stream_identity(output)
    except BaseException:
        destination.unlink()
        raise


def json_bytes(value: object) -> bytes:
    """Encode deterministic UTF-8 JSON for manifests and request bodies."""
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def parse_json(data: bytes, label: str) -> object:
    """Decode JSON while rejecting duplicate fields and invalid encoding."""

    def no_duplicates(pairs: list[tuple[str, object]]) -> JSONObject:
        result: JSONObject = {}
        for key, value in pairs:
            require(key not in result, f"Duplicate JSON field in {label}: {key}")
            result[key] = value
        return result

    try:
        return json.loads(data, object_pairs_hook=no_duplicates)
    except ValueError as exc:
        raise ReleaseError(f"Invalid JSON in {label}") from exc


def github_http_response(stdout: bytes, paginated: bool = False) -> tuple[int, bytes]:
    """Decode protocol headers emitted by gh --include, never its error prose.

    Paginated API metadata uses --jq tojson to frame each successful JSON page.
    gh normalizes those server-generated objects (including duplicate keys);
    nonpaginated bodies retain their exact bytes and strict JSON validation.
    """
    def read_head(data: bytes) -> tuple[int, bytes]:
        separator = re.search(rb"\r?\n\r?\n", data)
        if separator is None:
            raise GitHubError("GitHub response headers are missing or truncated")
        lines = data[:separator.start()].splitlines()
        status = re.fullmatch(
            rb"HTTP/(?:1\.[01]|2(?:\.0)?) ([1-5]\d{2})(?: [^\r\n]*)?", lines[0]
        ) if lines else None
        if status is None or any(
            not re.fullmatch(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+:[^\r\n]*", line)
            for line in lines[1:]
        ):
            raise GitHubError("GitHub response headers are invalid")
        return int(status.group(1)), data[separator.end():]

    status, body = read_head(stdout)
    if not paginated:
        return status, body
    pages: list[object] = []
    # Decode once: page boundaries are character offsets, including non-ASCII
    # JSON. Surrogate escapes preserve a later arbitrary error body unchanged.
    text = body.decode("utf-8", errors="surrogateescape")
    position = 0
    decoder = json.JSONDecoder()
    while 200 <= status < 300:
        while position < len(text) and text[position] in " \t\r\n":
            position += 1
        try:
            _, end = decoder.raw_decode(text, position)
            page_bytes = text[position:end].encode("utf-8", errors="surrogateescape")
            pages.append(parse_json(page_bytes, "GitHub response page"))
        except (ValueError, ReleaseError) as error:
            raise GitHubError("GitHub response page is invalid or truncated") from error
        position = end
        while position < len(text) and text[position] in " \t\r\n":
            position += 1
        if position == len(text):
            return status, json_bytes(pages)
        separator = re.compile(r"\r?\n\r?\n").search(text, position)
        if separator is None:
            raise GitHubError("GitHub response headers are missing or truncated")
        header = text[position:separator.end()].encode("utf-8", errors="surrogateescape")
        status, _ = read_head(header)
        position = separator.end()
    # A failed page invalidates every preceding page from the same attempt.
    return status, b""


class GitHub:
    """Access one repository through argument-safe gh subprocess calls."""

    def __init__(self, repository: str):
        require(bool(REPO_RE.fullmatch(repository)), "Repository must be OWNER/REPO")
        self.repo = repository
        self.base = f"repos/{repository}"
        self.workflow_scope_verified = False
        if os.environ.get("RELEASE_REQUIRE_WORKFLOW_SCOPE"):
            self.verify_publication_permissions()

    def verify_publication_permissions(self) -> None:
        """Fail before writes unless a classic token can publish historical workflows.

        Only permission headers and repository access are inspected. Never print
        the token, response body or authentication diagnostics from this probe.
        Fine-grained tokens do not expose verifiable OAuth scopes and fail closed.
        """
        self.workflow_scope_verified = False
        require(
            os.environ.get("RELEASE_REQUIRE_WORKFLOW_SCOPE") == "true"
            and bool(os.environ.get("GH_TOKEN")),
            "Publication token is missing or its permission probe is not enabled",
        )
        # Developer/CI toolchain selected by the invoking operator via PATH.
        result = subprocess.run(  # nosec B603, B607
            [
                "gh",
                "api",
                "--hostname",
                GITHUB_HOSTNAME,
                "--method",
                "GET",
                "--include",
                "--",
                self.base,
            ],
            capture_output=True,
            check=False,
        )
        require(result.returncode == 0, "Publication token permission probe failed")
        headers, separator, body = result.stdout.replace(b"\r\n", b"\n").partition(
            b"\n\n"
        )
        require(bool(separator), "Publication token permission headers are missing")
        scopes: set[str] = set()
        for line in headers.decode("utf-8", errors="replace").splitlines():
            key, colon, value = line.partition(":")
            if colon and key.lower() == "x-oauth-scopes":
                scopes.update(item.strip() for item in value.split(","))
        repository = parse_json(body, "publication repository permission probe")
        require(
            isinstance(repository, dict)
            and isinstance(repository.get("full_name"), str)
            and repository["full_name"].lower() == self.repo.lower()
            and isinstance(repository.get("private"), bool)
            and isinstance(repository.get("permissions"), dict)
            and repository["permissions"].get("push") is True,
            "Publication token cannot write the expected repository",
        )
        repository = cast(JSONObject, repository)
        require(
            "workflow" in scopes
            and (
                "repo" in scopes
                or (repository["private"] is False and "public_repo" in scopes)
            ),
            "Publication token requires verified workflow and repo/public_repo OAuth scopes",
        )
        self.workflow_scope_verified = True

    @staticmethod
    def response(
        result: subprocess.CompletedProcess[bytes], operation: str = "",
        http: tuple[int, bytes] | None = None,
    ) -> bytes:
        """Translate a completed fixed-form command without retrying failed writes."""
        status, body = http if http is not None else (None, result.stdout or b"")
        context = f"{operation}: " if operation else ""
        if status is not None and (result.returncode == 0) != (200 <= status < 300):
            raise GitHubError(context + "GitHub HTTP status and CLI result disagree")
        if result.returncode:
            stderr = result.stderr or b""
            message = stderr.decode(errors="replace").strip()
            raise GitHubError(context + message, status == 404)
        return body

    def request(
        self,
        path: str,
        method: str = "GET",
        body: JSONObject | None = None,
        mode: str = "json",
    ) -> bytes:
        """Call only allowed REST routes with fixed flags and one positional endpoint."""
        require(method in API_PATHS, "Unsupported API method")
        require(
            any(re.fullmatch(pattern, path, re.ASCII) for pattern in API_PATHS[method]),
            "Unsupported API endpoint",
        )
        require(
            all(part not in {".", ".."} for part in unquote(path).split("/")),
            "API endpoint cannot traverse repository paths",
        )
        require(
            (method == "GET" and body is None)
            or (method in {"POST", "PATCH", "PUT"} and isinstance(body, dict)),
            "API body does not match its method",
        )
        if method == "PUT":
            body = cast(JSONObject, body)
            require(
                body.get("branch") == "release-version-state"
                and set(body) <= {"branch", "content", "message", "sha"},
                "Ledger writes must target the dedicated state branch",
            )
        modes = {
            "json": [],
            # Canonical JSON framing prevents a malformed page body from spoofing
            # the next --include HTTP header when a later request fails.
            "pages": ["--paginate", "--jq", "tojson"],
            "asset": ["-H", "Accept: application/octet-stream"],
        }
        require(
            mode in modes and (mode == "json" or method == "GET"), "Invalid API mode"
        )
        endpoint = f"{self.base}/{path}".rstrip("/")
        if mode == "pages":
            endpoint += ("&" if "?" in endpoint else "?") + "per_page=100"
        method_args = {
            "GET": ["--method", "GET"],
            "POST": ["--method", "POST"],
            "PATCH": ["--method", "PATCH"],
            "PUT": ["--method", "PUT"],
        }[method]
        command = [
            "gh", "api", "--hostname", GITHUB_HOSTNAME, "--include",
            *method_args, *modes[mode],
            *(["--input", "-"] if body is not None else []),
            "--", endpoint,
        ]
        # Metadata is small and replayable. Binary transfers retain their own
        # timeout/cleanup policy; publication writes must never be replayed.
        if method == "GET" and mode != "asset" and not path.endswith("/zip"):
            return self._metadata_read(command, endpoint, mode == "pages")
        # Developer/CI toolchain selected by the invoking operator via PATH.
        result = subprocess.run(  # nosec B603
            command,
            input=json_bytes(body) if body is not None else None,
            capture_output=True,
            check=False,
        )
        return self.response(result, f"{method} {endpoint}", github_http_response(result.stdout))

    def _metadata_read(self, command: list[str], endpoint: str, paginated: bool = False) -> bytes:
        """Retry transient GET failures for at most three 30-second attempts.

        Jitter adds at most six seconds total. Authentication, authorization,
        rate limits and missing resources keep their original fail-closed result.
        A failed paginated response is discarded before replaying the whole read.
        """
        for attempt in range(API_READ_ATTEMPTS):
            try:
                result = subprocess.run(  # nosec B603
                    command, input=None, capture_output=True, check=False,
                    timeout=API_READ_TIMEOUT,
                )
            except subprocess.TimeoutExpired as error:
                if attempt == API_READ_ATTEMPTS - 1:
                    raise GitHubError(
                        f"GET {endpoint}: metadata read timed out after "
                        f"{API_READ_ATTEMPTS} attempts"
                    ) from error
            else:
                http = github_http_response(result.stdout, paginated)
                transient = (
                    result.returncode and http[0] in {500, 502, 503, 504}
                )
                if not result.returncode or not transient or attempt == API_READ_ATTEMPTS - 1:
                    return self.response(result, f"GET {endpoint}", http)
            # Scheduling jitter is not used for security decisions.
            time.sleep(random.uniform(1, 2 ** (attempt + 1)))  # nosec B311
        raise AssertionError("Metadata retry loop must return or raise")

    def api(
        self, path: str, method: str = "GET", body: JSONObject | None = None
    ) -> object:
        """Read or mutate a permitted repository endpoint with optional JSON input."""
        raw = self.request(path, method, body)
        return parse_json(raw, path) if raw.strip() else None

    def optional(self, path: str) -> object:
        """Return None only when GitHub explicitly reports a missing resource."""
        try:
            return self.api(path)
        except GitHubError as exc:
            if exc.not_found:
                return None
            raise

    def pages(self, path: str, field: str | None = None) -> list[JSONObject]:
        """Fetch and flatten every page so later jobs or artifacts are not skipped."""
        raw = self.request(path, mode="pages")
        pages = parse_json(raw, path)
        require(isinstance(pages, list), f"Invalid pagination response: {path}")
        records: list[JSONObject] = []
        for page in cast(list[object], pages):
            values = page.get(field) if field and isinstance(page, dict) else page
            require(isinstance(values, list), f"Invalid paginated records: {path}")
            records.extend(cast(list[JSONObject], values))
        return records

    def binary(self, path: str) -> bytes:
        """Download release bytes or an Actions ZIP using its required media type."""
        # The Actions redirect rejects octet-stream with HTTP 415; gh follows it.
        if re.fullmatch(r"actions/artifacts/[1-9]\d*/zip", path, re.ASCII):
            return self.request(path)
        require(
            re.fullmatch(r"releases/assets/[1-9]\d*", path, re.ASCII),
            "Unsupported binary download endpoint",
        )
        return self.request(path, mode="asset")

    def download_asset(self, path: str, output: BinaryIO) -> None:
        """Stream an allowlisted asset to disk without capturing installer bytes."""
        require(
            re.fullmatch(r"releases/assets/[1-9]\d*", path, re.ASCII),
            "Unsupported binary download endpoint",
        )
        endpoint = f"{self.base}/{path}"
        try:
            # Developer/CI toolchain selected by the invoking operator via PATH.
            result = subprocess.run(  # nosec B603, B607
                [
                    "gh",
                    "api",
                    "--hostname",
                    GITHUB_HOSTNAME,
                    "--method",
                    "GET",
                    "-H",
                    "Accept: application/octet-stream",
                    "--",
                    endpoint,
                ],
                stdout=output,
                stderr=subprocess.PIPE,
                check=False,
                timeout=ASSET_DOWNLOAD_TIMEOUT,
            )
        except subprocess.TimeoutExpired as error:
            raise GitHubError(
                f"GET {endpoint}: asset download exceeded {ASSET_DOWNLOAD_TIMEOUT} seconds"
            ) from error
        self.response(result, f"GET {endpoint}")

    def upload(self, tag: str, path: Path) -> None:
        """Upload a canonical tag's staged regular file, with no overwrite option."""
        require(TAG_RE.fullmatch(tag), "Unsupported release upload tag")
        require(
            path.is_absolute() and NAME_RE.fullmatch(path.name), "Unsafe upload path"
        )
        require(
            path.is_file() and not path.is_symlink(), "Upload must be a regular file"
        )
        parent = path.parent.resolve(strict=True)
        require(
            parent.parent == Path(tempfile.gettempdir()).resolve()
            and parent.name.startswith(
                ("release-candidate-", "release-promote-", "release-versioned-")
            )
            and "#" not in str(path),
            "Upload must come from the private release staging directory",
        )
        self.response(
            # Developer/CI toolchain selected by the invoking operator via PATH.
            subprocess.run(  # nosec B603, B607
                [
                    "gh",
                    "release",
                    "upload",
                    "--repo",
                    f"github.com/{self.repo}",
                    "--",
                    tag,
                    str(parent / path.name),
                ],
                capture_output=True,
                check=False,
            ),
            f"upload {tag} {path.name}",
        )


def repository_info(gh: GitHub) -> JSONObject:
    """Read the repository identity and authoritative default branch."""
    info = cast(JSONObject, gh.api(""))
    require(isinstance(info, dict), "Invalid repository response")
    require(
        cast(str, info.get("full_name", "")).lower() == gh.repo.lower(),
        "Repository identity mismatch",
    )
    require(bool(info.get("default_branch")), "Repository has no default branch")
    return info


def require_fuzzing_policy(policy: JSONObject) -> None:
    """Validate an adopted fuzz policy without importing it for legacy policies."""
    if "fuzzing" not in policy:
        return
    if __package__:
        from .release_fuzz import configuration
    else:
        from release_fuzz import configuration

    try:
        configuration(policy)
    except ValueError as error:
        raise ReleaseError(str(error)) from error


def require_release_policy(policy: object, repo: str, qualified: bool) -> None:
    """Check policy identity, release mode, and required eligibility blockers."""
    require(isinstance(policy, dict), "Source release policy must be an object")
    policy = cast(JSONObject, policy)
    require(
        isinstance(policy.get("repository"), str)
        and cast(str, policy["repository"]).lower() == repo.lower(),
        "Source policy repository mismatch",
    )
    require(policy.get("mode") == "release", "Source policy mode must be release")
    require_fuzzing_policy(policy)
    if "channel_validation_workflows" in policy:
        if __package__:
            from .release_validation import channel_workflows
        else:
            from release_validation import channel_workflows

        try:
            channel_workflows(policy)
        except ValueError as error:
            raise ReleaseError(str(error)) from error
    for field in ("release_blockers", "stable_blockers"):
        blockers = policy.get(field, [])
        require(
            isinstance(blockers, list)
            and all(isinstance(item, str) and item.strip() for item in blockers),
            f"Source policy {field} must be a list of nonempty strings",
        )
        if qualified:
            require(
                not blockers,
                f"Source policy has unresolved {field}; create a new RC after resolving them",
            )


def validation_profile(policy: JSONObject, channel: str) -> JSONObject | None:
    """Keep legacy policies self-contained and require explicit new profiles."""
    if "channel_validation_workflows" not in policy:
        return None
    if __package__:
        from .release_validation import profile
    else:
        from release_validation import profile

    try:
        return profile(policy, channel)
    except ValueError as error:
        raise ReleaseError(str(error)) from error


def validate_fuzz_manifest(manifest: JSONObject, policy: JSONObject) -> None:
    """Bind the optional fuzz profile and RC receipt to the immutable inventory."""
    if "fuzzing" not in policy:
        return
    if __package__:
        from .release_fuzz import profile
    else:
        from release_fuzz import profile

    require(
        json_bytes(manifest.get("fuzzing_profile")) == json_bytes(profile(policy, cast(str, manifest["channel"]))),
        "Manifest fuzzing profile differs from its source policy/channel",
    )
    if manifest["channel"] == "rc":
        assets = {item["name"]: item for item in cast(list[JSONObject], manifest["assets"])}
        receipt = assets.get("release-inputs-fuzz.json", {})
        require(
            "fuzz-report.json" in assets and bool(receipt)
            and manifest.get("validation_receipts") == [{"name": "release-inputs-fuzz.json", "sha256": receipt.get("sha256")}],
            "RC fuzz validation evidence is absent from the immutable asset inventory",
        )


def validate_validation_manifest(manifest: JSONObject) -> None:
    """A candidate's profile must match the policy frozen at its source SHA."""
    policy = cast(JSONObject, cast(JSONObject, manifest["source_policy"])["data"])
    expected = validation_profile(policy, cast(str, manifest["channel"]))
    require(
        json_bytes(manifest.get("validation_profile")) == json_bytes(expected),
        "Manifest validation profile differs from its source policy/channel",
    )
    validate_fuzz_manifest(manifest, policy)


def require_current_fuzzing(gh: GitHub, candidate_policy: JSONObject, current_sha: str) -> None:
    """An adopted project cannot qualify an older RC that predates fuzzing."""
    current = cast(JSONObject, source_policy_snapshot(gh, current_sha)["data"])
    if "fuzzing" in current:
        if __package__:
            from .release_fuzz import configuration
        else:
            from release_fuzz import configuration

        require(configuration(candidate_policy) is not None,
                "Current release policy requires fuzzing; create a new RC after adoption")


def validate_validation_run(
    gh: GitHub, run: JSONObject, policy: JSONObject, channel: str
) -> None:
    """Require the selected profile and CI gate in the exact run attempt."""
    has_profile = validation_profile(policy, channel) is not None
    if not has_profile and "fuzzing" not in policy:
        return
    if __package__:
        from .release_validation import check_run_jobs
    else:
        from release_validation import check_run_jobs

    jobs = gh.pages(
        f"actions/runs/{positive(run.get('id'), 'run ID')}/attempts/{positive(run.get('run_attempt'), 'run attempt')}/jobs",
        "jobs",
    )
    try:
        if has_profile:
            check_run_jobs(jobs, channel, cast(str, run["head_sha"]))
        if "fuzzing" in policy:
            if __package__:
                from .release_fuzz import check_run_jobs as check_fuzz_jobs
            else:
                from release_fuzz import check_run_jobs as check_fuzz_jobs

            check_fuzz_jobs(jobs, channel, cast(str, run["head_sha"]))
    except ValueError as error:
        raise ReleaseError(str(error)) from error


def source_policy_snapshot(gh: GitHub, sha: str) -> JSONObject:
    """Bind eligibility to the policy at the exact candidate source commit."""
    require(SHA_RE.fullmatch(sha), "Invalid source policy commit SHA")
    response = cast(JSONObject, gh.api(f"contents/{POLICY}?ref={sha}"))
    require(
        isinstance(response, dict)
        and response.get("type") == "file"
        and response.get("path") == POLICY
        and response.get("encoding") == "base64",
        "Source commit must contain a regular release policy file",
    )
    encoded = response.get("content")
    require(
        isinstance(encoded, str) and len(encoded) <= 400_000,
        "Invalid or oversized source policy content",
    )
    try:
        raw = base64.b64decode("".join(cast(str, encoded).split()), validate=True)
    except ValueError as exc:
        raise ReleaseError("Invalid source policy base64 content") from exc
    require(
        len(raw) <= 250_000 and response.get("size") == len(raw),
        "Source policy size mismatch",
    )
    # Git's object identifier is SHA-1; payload security uses SHA-256 separately.
    blob_sha = hashlib.sha1(
        b"blob " + str(len(raw)).encode() + b"\0" + raw, usedforsecurity=False
    ).hexdigest()
    require(response.get("sha") == blob_sha, "Source policy Git blob identity mismatch")
    data = parse_json(raw, "source release policy")
    require_release_policy(data, gh.repo, qualified=False)
    return {
        "schema": 1,
        "path": POLICY,
        "git_blob_sha": blob_sha,
        "sha256": digest(raw),
        "data": data,
    }


def validate_policy_snapshot(snapshot: object, repo: str) -> None:
    """Check the recorded policy schema, hashes, and stable eligibility."""
    require(
        isinstance(snapshot, dict)
        # JSON booleans must not qualify as integer schema versions.
        and type(snapshot.get("schema")) is int  # pylint: disable=unidiomatic-typecheck
        and snapshot["schema"] == 1
        and snapshot.get("path") == POLICY,
        "Manifest requires a versioned source policy snapshot",
    )
    snapshot = cast(JSONObject, snapshot)
    require(
        isinstance(snapshot.get("git_blob_sha"), str)
        and SHA_RE.fullmatch(cast(str, snapshot["git_blob_sha"]))
        and isinstance(snapshot.get("sha256"), str)
        and re.fullmatch(SHA256_PATTERN, cast(str, snapshot["sha256"])),
        "Invalid source policy snapshot hashes",
    )
    require_release_policy(snapshot.get("data"), repo, qualified=True)


def check_ancestry(gh: GitHub, sha: str, default_branch: str) -> None:
    """Require the source commit to remain on the current default branch."""
    comparison = cast(
        JSONObject, gh.api(f"compare/{sha}...{quote(default_branch, safe='')}")
    )
    require(
        comparison.get("status") in ("ahead", "identical"),
        "Source commit is not an ancestor of the current default branch",
    )
    require(
        cast(JSONObject, comparison.get("merge_base_commit", {})).get("sha") == sha,
        "Source/default branch ancestry could not be verified",
    )


def checked_out_sha() -> str:
    """Return the exact local commit used by the publication process."""
    # Developer/CI toolchain selected by the invoking operator via PATH.
    result = subprocess.run(  # nosec B603, B607
        ["git", "rev-parse", "HEAD"], text=True, capture_output=True, check=False
    )
    require(result.returncode == 0, "Must run from the checked-out release repository")
    return result.stdout.strip()


def workflow_tree(gh: GitHub, sha: str) -> str:
    """Read the immutable workflow tree without a truncated recursive Git diff."""
    entries = cast(list[JSONObject], gh.api(f"contents/.github?ref={sha}"))
    require(
        isinstance(entries, list)
        and len(entries) < 1000
        and all(isinstance(entry, dict) for entry in entries),
        "Cannot verify the complete source .github directory",
    )
    matches = [
        entry
        for entry in entries
        if entry.get("name") == "workflows" or entry.get("path") == ".github/workflows"
    ]
    require(
        len(matches) == 1
        and matches[0].get("name") == "workflows"
        and matches[0].get("path") == ".github/workflows"
        and matches[0].get("type") == "dir"
        and isinstance(matches[0].get("sha"), str)
        and SHA_RE.fullmatch(cast(str, matches[0]["sha"])),
        "Cannot verify a regular source .github/workflows directory",
    )
    return cast(str, matches[0]["sha"])


def check_workflow_publication(gh: GitHub, sha: str) -> None:
    """Reject known workflow-token failures before consuming a version or tag.

    GitHub cannot atomically bind this read-only preflight to release creation.
    A later default-branch change can still fail closed after partial writes.
    """
    require(
        isinstance(sha, str) and SHA_RE.fullmatch(sha), "Invalid release source SHA"
    )
    if getattr(gh, "workflow_scope_verified", False) is True:
        return
    info = repository_info(gh)
    branch = cast(str, info["default_branch"])
    path = f"git/ref/heads/{quote(branch, safe='')}"
    ref = cast(JSONObject, gh.api(path))
    require(
        isinstance(ref, dict)
        and ref.get("ref") == f"refs/heads/{branch}"
        and isinstance(ref.get("object"), dict)
        and cast(JSONObject, ref["object"]).get("type") == "commit"
        and isinstance(cast(JSONObject, ref["object"]).get("sha"), str)
        and SHA_RE.fullmatch(cast(str, cast(JSONObject, ref["object"])["sha"])),
        "Cannot verify default HEAD before release publication",
    )
    head = cast(str, cast(JSONObject, ref["object"])["sha"])
    if sha == head:
        return
    require(
        workflow_tree(gh, sha) == workflow_tree(gh, head),
        "Release source workflows differ from current default HEAD; "
        "create and accept a new candidate before publication",
    )
    require(
        repository_info(gh)["default_branch"] == branch
        and cast(JSONObject, gh.api(path)) == ref,
        "Default branch changed during publication preflight; retry at current HEAD",
    )


# Verify each independently supplied identity before recording supersession.
# pylint: disable-next=too-many-locals
def superseded_candidate(
    gh: GitHub, info: JSONObject, run: JSONObject, channel: str
) -> JSONObject | None:
    """Skip only automatic candidates with a proven newer default-branch run.

    This is not a publication claim about the successor: its checks may still
    fail. API errors and an unproven replacement remain failures. Call again
    immediately before publication writes; GitHub provides no atomic head/tag CAS.
    """
    if (run["event"], channel) not in {("push", "beta"), ("schedule", "nightly")}:
        return None
    branch = cast(str, info["default_branch"])
    require(
        repository_info(gh)["default_branch"] == branch,
        "Default branch changed during this run; dispatch a fresh release",
    )
    path = f"git/ref/heads/{quote(branch, safe='')}"
    ref = cast(JSONObject, gh.api(path))
    require(
        isinstance(ref, dict)
        and ref.get("ref") == f"refs/heads/{branch}"
        and isinstance(ref.get("object"), dict)
        and cast(JSONObject, ref["object"]).get("type") == "commit"
        and isinstance(cast(JSONObject, ref["object"]).get("sha"), str)
        and SHA_RE.fullmatch(cast(str, cast(JSONObject, ref["object"])["sha"])),
        "Cannot verify current default branch for automatic publication",
    )
    head = cast(str, cast(JSONObject, ref["object"])["sha"])
    if head == run["head_sha"]:
        return None
    comparison = cast(JSONObject, gh.api(f"compare/{run['head_sha']}...{head}"))
    require(
        isinstance(comparison, dict)
        and comparison.get("status") == "ahead"
        and cast(JSONObject, comparison.get("merge_base_commit", {})).get("sha")
        == run["head_sha"],
        "Automatic release source is not a verified ancestor of current default HEAD",
    )
    replacement = cast(
        JSONObject,
        gh.api(
            "actions/workflows/release-pipeline.yml/runs"
            f"?branch={quote(branch, safe='')}&event=push&head_sha={head}&per_page=100"
        ),
    )
    # A boolean is not an authoritative API count.
    # pylint: disable-next=unidiomatic-typecheck
    require(
        isinstance(replacement, dict)
        and type(replacement.get("total_count")) is int
        and replacement["total_count"] == 1
        and isinstance(replacement.get("workflow_runs"), list)
        and len(cast(list[object], replacement["workflow_runs"])) == 1,
        "Default branch advanced without one proven replacement release run; "
        "inspect its release workflow and dispatch a fresh run at current HEAD",
    )
    successor = cast(list[JSONObject], replacement["workflow_runs"])[0]
    require(isinstance(successor, dict), "Invalid replacement release run")
    validate_run_provenance(
        gh, successor, info, head, positive(successor.get("run_attempt"), "run attempt")
    )
    require(
        successor.get("event") == "push"
        and positive(successor.get("id"), "successor run ID")
        > positive(run.get("id"), "source run ID")
        and positive(successor.get("run_number"), "successor run number")
        > positive(run.get("run_number"), "source run number")
        and successor.get("status")
        in {"queued", "requested", "pending", "waiting", "in_progress", "completed"},
        "Replacement must be a newer automatic run of the default-branch release workflow",
    )
    require(
        cast(JSONObject, gh.api(path)) == ref,
        "Default branch changed while verifying replacement; retry at current HEAD",
    )
    return {
        "status": "superseded",
        "source_sha": run["head_sha"],
        "superseded_by": head,
        "successor_run_id": str(successor["id"]),
        "successor_run_url": f"https://github.com/{gh.repo}/actions/runs/{successor['id']}",
    }


def check_execution(
    gh: GitHub, run_id: int, channel: str, info: JSONObject, run: JSONObject
) -> None:
    """Bind publication to the expected Actions repository, ref, run and event."""
    require(
        os.environ.get("GITHUB_ACTIONS") == "true",
        "Publication must run inside GitHub Actions; dispatch the release workflow locally",
    )
    require(
        os.environ.get("GITHUB_REPOSITORY", "").lower() == gh.repo.lower(),
        "Execution repository mismatch",
    )
    require(os.environ.get("GITHUB_RUN_ID") == str(run_id), "Execution run ID mismatch")
    require(
        os.environ.get("GITHUB_RUN_ATTEMPT") == str(run.get("run_attempt")),
        "Execution run attempt mismatch",
    )
    require(
        os.environ.get("GITHUB_REF") == f"refs/heads/{info['default_branch']}",
        "Dispatch must target the default branch",
    )
    require(
        os.environ.get("GITHUB_WORKFLOW_REF")
        == f"{info['full_name']}/{WORKFLOW}@refs/heads/{info['default_branch']}",
        "Execution workflow mismatch",
    )
    require(
        checked_out_sha() == run.get("head_sha"),
        "Checkout does not match the source run SHA",
    )
    event = os.environ.get("GITHUB_EVENT_NAME")
    require(event == run.get("event"), "Execution event mismatch")
    allowed = {
        "nightly": {"schedule", "workflow_dispatch"},
        "beta": {"push", "workflow_dispatch"},
        "rc": {"workflow_dispatch"},
        "stable": {"workflow_dispatch"},
    }
    require(event in allowed[channel], f"Event cannot publish channel {channel}")
    if event == "workflow_dispatch":
        event_file = os.environ.get("GITHUB_EVENT_PATH")
        require(bool(event_file), "Missing workflow dispatch event")
        payload = parse_json(
            Path(cast(str, event_file)).read_bytes(), "workflow dispatch event"
        )
        require(
            isinstance(payload, dict)
            and payload.get("inputs", {}).get("channel") == channel,
            f"Workflow dispatch input channel must be {channel}",
        )


def validate_run_provenance(
    gh: GitHub, run: JSONObject, info: JSONObject, sha: str, attempt: int
) -> None:
    """Check immutable run identity before considering its changing status."""
    require(
        cast(
            str, cast(JSONObject, run.get("repository", {})).get("full_name", "")
        ).lower()
        == gh.repo.lower(),
        "Source run belongs to another repository",
    )
    require(
        cast(
            str, cast(JSONObject, run.get("head_repository", {})).get("full_name", "")
        ).lower()
        == gh.repo.lower(),
        "Source run comes from another repository",
    )
    require(
        run.get("head_sha") == sha and SHA_RE.fullmatch(sha), "Source run SHA mismatch"
    )
    require(run.get("path") == WORKFLOW, "Source run uses an unexpected workflow path")
    require(
        run.get("head_branch") == cast(str, info["default_branch"]),
        "Source run does not target the default branch",
    )
    require(
        run.get("event") in ("push", "schedule", "workflow_dispatch"),
        "Untrusted source run event",
    )
    require(
        run.get("run_attempt") == attempt,
        "Source run was rerun; evidence is not from its latest attempt",
    )


# Keep the independently verified provenance fields explicit at each call site.
# pylint: disable-next=too-many-arguments
def validate_run(
    gh: GitHub,
    run: JSONObject,
    info: JSONObject,
    sha: str,
    attempt: int,
    completed: bool,
    gate: bool = True,
) -> None:
    """Verify run provenance and require one explicitly successful Release gate."""
    validate_run_provenance(gh, run, info, sha, attempt)
    if completed:
        require(
            run.get("status") == "completed" and run.get("conclusion") == "success",
            "Source run has not completed successfully",
        )
    else:
        require(
            run.get("status") == "in_progress", "Publication run is not in progress"
        )
    if gate:
        jobs = gh.pages(
            f"actions/runs/{positive(run.get('id'), 'run ID')}/attempts/{attempt}/jobs",
            "jobs",
        )
        gates = [job for job in jobs if job.get("name") == "Release gate"]
        require(
            len(gates) == 1
            and gates[0].get("status") == "completed"
            and gates[0].get("conclusion") == "success",
            "Exactly one successful, completed Release gate is required; skipped is not a pass",
        )
        require(gates[0].get("head_sha") == sha, "Release gate SHA mismatch")


# Execution identity is deliberately checked again on every fresh response.
# pylint: disable-next=too-many-arguments
def wait_for_executing_run(
    gh: GitHub,
    run_id: int,
    channel: str,
    info: JSONObject,
    sha: str,
    attempt: int,
    gate: bool = True,
) -> JSONObject:
    """Wait at most 60 seconds for Actions' aggregate status to catch up.

    A running job may still be reported as queued or waiting after environment
    approval. Those states never authorize publication: only a fresh, fully
    bound in_progress run can pass. Completed RC validation does not wait.
    """
    deadline = time.monotonic() + 60
    while True:
        run = cast(JSONObject, gh.api(f"actions/runs/{run_id}"))
        require(run.get("id") == run_id, "Execution run identity mismatch")
        check_execution(gh, run_id, channel, info, run)
        validate_run_provenance(gh, run, info, sha, attempt)
        status = run.get("status")
        require(
            run.get("conclusion") is None, "Publication run already has a conclusion"
        )
        if status == "in_progress":
            validate_run(gh, run, info, sha, attempt, completed=False, gate=gate)
            return run
        require(
            status in {"queued", "requested", "pending", "waiting"},
            f"Publication run is not active: {status!r}",
        )
        remaining = deadline - time.monotonic()
        require(
            remaining > 0,
            f"Publication run did not become in_progress within 60 seconds; "
            f"last status: {status!r}, run: {run_id}, attempt: {attempt}",
        )
        time.sleep(min(2, remaining))


def closed_push_cycle(gh: GitHub, base: str, kind: str) -> JSONObject | None:
    """Stop automatic betas for an occupied stable version before any build."""
    if kind != "push":
        return None
    tag = f"v{version(base)}"
    try:
        ref = cast(JSONObject, gh.api(f"git/ref/tags/{quote(tag, safe='')}"))
    except GitHubError as error:
        if error.not_found:
            return None
        raise
    require(
        isinstance(ref, dict)
        and ref.get("ref") == f"refs/tags/{tag}"
        and isinstance(ref.get("object"), dict)
        and cast(JSONObject, ref["object"]).get("type") in {"commit", "tag"}
        and isinstance(cast(JSONObject, ref["object"]).get("sha"), str)
        and re.fullmatch(
            r"[0-9a-f]{40}", cast(str, cast(JSONObject, ref["object"])["sha"])
        ),
        "Invalid stable tag response during automatic beta preparation",
    )
    return {
        "status": "version-required",
        "channel": "beta",
        "version": base,
        "build": "false",
        "plan_artifact": "",
        "reason": (
            f"Stable tag {tag} already exists; prepare and merge the next "
            "committed base version before creating another beta."
        ),
    }


def ensure_absent(gh: GitHub, tag: str) -> None:
    """Refuse existing tags, published releases and hidden release drafts."""
    require(
        gh.optional(f"git/ref/tags/{quote(tag, safe='')}") is None,
        f"Tag already exists: {tag}",
    )
    require(
        gh.optional(f"releases/tags/{quote(tag, safe='')}") is None,
        f"Release already exists: {tag}",
    )
    # GitHub's releases-by-tag endpoint can hide drafts. Explicitly check them.
    require(
        not any(release.get("tag_name") == tag for release in gh.pages("releases")),
        f"Draft release already exists: {tag}",
    )


def next_sequence(gh: GitHub, base_version: str, channel: str) -> int:
    """Find an unused beta or RC sequence across all tags and releases."""
    require(channel in ("beta", "rc"), "Sequence only applies to beta and rc")
    prefix = f"v{version(base_version)}-{channel}."
    numbers = []
    tags = [cast(str, item.get("name", "")) for item in gh.pages("tags")]
    tags += [cast(str, item.get("tag_name", "")) for item in gh.pages("releases")]
    for tag in tags:
        if tag.startswith(prefix) and re.fullmatch(
            r"[1-9]\d*", tag[len(prefix) :], re.ASCII
        ):
            numbers.append(int(tag[len(prefix) :]))
    return max(numbers, default=0) + 1


# pylint: disable-next=too-many-arguments
def candidate_tag(
    gh: GitHub,
    channel: str,
    base_version: str,
    run_id: int,
    attempt: int,
    sequence: int | None,
    now: datetime,
) -> str:
    """Keep each validated channel, sequence and run identity component explicit."""
    prefix = f"v{version(base_version)}-{channel}."
    if channel == "nightly":
        require(sequence is None, "Nightly tags do not accept a sequence")
        return prefix + now.strftime("%Y%m%d%H%M%S") + f".{run_id}.{attempt}"
    require(channel in ("beta", "rc"), "Invalid candidate channel")
    return prefix + str(
        positive(sequence, "sequence")
        if sequence is not None
        else next_sequence(gh, base_version, channel)
    )


def reject_restricted_assets(names: Iterable[str]) -> None:
    """Reject retired package types using the current repository's static policy."""
    for name in names:
        for restriction in ASSET_RESTRICTIONS:
            if name.casefold().endswith(tuple(restriction["suffixes"])):
                raise ReleaseError(f"{restriction['reason']}: {name}")


def stage_assets(source: Path, destination: Path) -> list[JSONObject]:
    """Snapshot flat regular payload files and hash the private staged bytes."""
    require(
        source.is_dir() and not source.is_symlink(),
        "Assets must be a regular directory",
    )
    entries = sorted(source.iterdir())
    reject_restricted_assets(entry.name for entry in entries)
    assets = []
    folded_names = set()
    for entry in entries:
        require(
            not entry.is_symlink() and entry.is_file(),
            f"Assets must be flat regular files: {entry.name}",
        )
        require(
            NAME_RE.fullmatch(entry.name)
            and entry.name.casefold() != MANIFEST.casefold(),
            f"Unsafe or reserved asset name: {entry.name}",
        )
        require(
            entry.name.casefold() not in folded_names,
            f"Asset name collision: {entry.name}",
        )
        folded_names.add(entry.name.casefold())
        descriptor = os.open(entry, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as stream:
            require(
                stat.S_ISREG(os.fstat(stream.fileno()).st_mode),
                f"Asset is not a regular file: {entry.name}",
            )
            with (destination / entry.name).open("xb") as output:
                identity = stream_identity(stream, output)
        assets.append({"name": entry.name, **identity})
    require(assets, "Cannot publish an empty assets directory")
    return assets


def verify_uploaded_asset(gh: GitHub, item: JSONObject, path: Path) -> None:
    """Re-download every uploaded byte before making the draft public."""
    with path.open("rb") as source:
        local = stream_identity(source)
    require(
        item.get("state") == "uploaded" and item.get("size") == local["size"],
        "Incomplete asset upload; draft left unpublished",
    )
    with tempfile.TemporaryFile() as downloaded:
        gh.download_asset(
            f"releases/assets/{positive(item.get('id'), 'asset ID')}", downloaded
        )
        downloaded.seek(0)
        remote = stream_identity(downloaded)
    require(remote == local, "Uploaded bytes differ; draft left unpublished")


def _release_fence(line: str) -> tuple[str, int, str] | None:
    """Recognize a Markdown fence with at most three leading spaces."""
    content = line.lstrip(" ")
    if len(line) - len(content) > 3 or not content or content[0] not in "`~":
        return None
    marker = content[0]
    length = len(content) - len(content.lstrip(marker))
    if length < 3:
        return None
    return marker, length, content[length:]


def _release_code_span_ends(line: str) -> dict[int, int]:
    """Find equal-length inline backtick pairs in one linear scan and reverse pass."""
    runs = [(match.start(), match.end()) for match in re.finditer(r"`+", line)]
    following: dict[int, int] = {}
    ends: dict[int, int] = {}
    for start, end in reversed(runs):
        length = end - start
        if length in following:
            ends[start] = following[length]
        following[length] = end
    return ends


def _release_comment_line(line: str, comment: bool) -> tuple[str, bool]:
    """Mask comments without shifting offsets or interpreting literal inline code."""
    visible = list(line)
    code_ends = _release_code_span_ends(line)
    position = 0
    while position < len(line):
        if comment:
            end = line.find("-->", position)
            stop = len(line) if end < 0 else end + 3
            visible[position:stop] = [
                char if char in "\r\n" else " " for char in line[position:stop]
            ]
            position = stop
            comment = end < 0
        elif line[position] == "\\":
            position += 2
        elif position in code_ends:
            position = code_ends[position]
        elif line.startswith("<!--", position):
            comment = True
        else:
            position += 1
    return "".join(visible), comment


def _release_fence_closes(
    candidate: tuple[str, int, str] | None, fence: tuple[str, int]
) -> bool:
    return (
        candidate is not None
        and candidate[0] == fence[0]
        and candidate[1] >= fence[1]
        and not candidate[2].strip(" \t\r\n")
    )


def _release_lines(text: str) -> Iterator[tuple[str, bool, bool]]:
    """Yield offset-preserving text, heading eligibility and visible guidance."""
    fence = None
    comment = False
    for line in io.StringIO(text):
        candidate = _release_fence(line)
        if fence is not None:
            closes = _release_fence_closes(candidate, fence)
            yield line, False, not closes
            if closes:
                fence = None
        elif (
            not comment
            and candidate is not None
            and (candidate[0] == "~" or "`" not in candidate[2])
        ):
            fence = candidate[:2]
            yield line, False, False
        elif not comment and line.startswith(("    ", "\t")):
            yield line, False, True
        else:
            visible, comment = _release_comment_line(line, comment)
            yield visible, True, True


def _release_heading_title(content: str) -> str:
    """Remove an optional whitespace-separated ATX closing hash sequence."""
    title = content.strip(" \t\r\n")
    before_hashes = title.rstrip("#")
    if not before_hashes or before_hashes.endswith((" ", "\t")):
        return before_hashes.rstrip(" \t")
    return title


def _release_headings(text: str) -> list[tuple[int, str, int, int]]:
    """Locate release headings outside comments and fenced code examples."""
    headings = []
    offset = 0
    for line, heading_allowed, _ in _release_lines(text):
        indentation = len(line) - len(line.lstrip(" "))
        heading = line[indentation:] if indentation <= 3 else line
        level = len(heading) - len(heading.lstrip("#"))
        if (
            heading_allowed
            and 1 <= level <= 6
            and heading[level : level + 1] in ("", " ", "\t", "\r", "\n")
        ):
            headings.append(
                (level, _release_heading_title(heading[level:]), offset, offset + len(line))
            )
        offset += len(line)
    return headings


def _release_sections(text: str, level: int) -> Iterator[tuple[str, str, str]]:
    """Keep original bodies plus comment-masked bodies for validation."""
    visible = "".join(line for line, _, _ in _release_lines(text))
    headings = [heading for heading in _release_headings(text) if heading[0] <= level]
    for index, (heading_level, title, _, start) in enumerate(headings):
        if heading_level != level:
            continue
        end = headings[index + 1][2] if index + 1 < len(headings) else len(text)
        yield title, text[start:end].strip(), visible[start:end]


def _release_container_content(line: str) -> str:
    """Ignore empty Markdown containers without discarding literal code content."""
    line = line.expandtabs(4).strip()
    marker = re.compile(r">|(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)", re.ASCII)
    position = 0
    list_item = False
    while match := marker.match(line, position):
        list_item = match.group() != ">"
        position = match.end()
        whitespace = position
        while position < len(line) and line[position] in " \t":
            position += 1
        if position - whitespace >= 5:
            # After the container separator, four spaces introduce literal code.
            return line[whitespace:]
    content = line[position:]
    if list_item and content in ("[ ]", "[x]", "[X]"):
        return ""
    return content


def _release_has_guidance(text: str) -> bool:
    """Require visible content beyond comments, headings and separator markers."""
    for line, heading_allowed, guidance in _release_lines(text):
        if not guidance or not line.strip():
            continue
        if not heading_allowed:
            return True
        line = _release_container_content(line)
        if line.startswith(("    ", "\t")):
            return True
        if not line or re.match(r" {0,3}#{1,6}(?:[ \t\r\n]|$)", line):
            continue
        markers = line.strip().replace(" ", "").replace("\t", "")
        if len(markers) >= 3 and markers[0] in "-*_" and not markers.strip(markers[0]):
            continue
        return True
    return False


def _release_has_setext_heading(text: str) -> bool:
    """Reject unsupported underlined headings within the selected ATX section."""
    paragraph = False
    for raw, (line, heading_allowed, _) in zip(io.StringIO(text), _release_lines(text)):
        if not heading_allowed:
            paragraph = False
            continue
        if not line.strip() and raw.strip():
            # Hidden comment lines cannot make an ambiguous underline harmless.
            continue
        if re.fullmatch(r" {0,3}(?:=+|-+)[ \t]*(?:\r?\n)?", line):
            if paragraph:
                return True
            paragraph = False
        else:
            paragraph = bool(line.strip()) and not re.match(
                r" {0,3}#{1,6}(?:[ \t\r\n]|$)", line
            )
    return False


# pylint: disable-next=too-many-arguments
def release_notes(gh: GitHub, tag: str, sha: str, provenance: str) -> str:
    """Use reviewed notes at the package source commit, retaining build evidence."""
    policy = cast(JSONObject, source_policy_snapshot(gh, sha)["data"])
    source = policy.get("release_notes")
    if source is None:
        return provenance
    require(source == "CHANGELOG.md", "Unsupported release notes source")
    require(TAG_RE.fullmatch(tag), "Invalid release notes tag")
    base_version = cast(re.Match[str], VERSION_RE.match(tag[1:])).group(0)
    response = cast(JSONObject, gh.api(f"contents/CHANGELOG.md?ref={sha}"))
    require(
        isinstance(response, dict)
        and response.get("type") == "file"
        and response.get("path") == source
        and response.get("encoding") == "base64",
        "Release notes must be a regular CHANGELOG.md at the source commit",
    )
    encoded = response.get("content")
    require(
        isinstance(encoded, str) and len(encoded) <= 400_000,
        "Invalid or oversized release notes content",
    )
    try:
        raw = base64.b64decode("".join(cast(str, encoded).split()), validate=True)
        changelog = raw.decode("utf-8").replace("\r\n", "\n")
    except ValueError as exc:
        raise ReleaseError("Invalid release notes encoding") from exc
    require(
        len(raw) <= 250_000 and response.get("size") == len(raw),
        "Release notes size mismatch",
    )
    blob_sha = hashlib.sha1(
        b"blob " + str(len(raw)).encode() + b"\0" + raw, usedforsecurity=False
    ).hexdigest()
    require(response.get("sha") == blob_sha, "Release notes Git blob identity mismatch")
    matches = [
        (section, visible)
        for title, section, visible in _release_sections(changelog, 2)
        if re.fullmatch(
            rf"\[{re.escape(base_version)}\](?:[ \t]+-[ \t]+[^\n]+)?[ \t]*",
            title,
        )
    ]
    require(
        len(matches) == 1 and matches[0][0],
        "Release needs one nonempty changelog section",
    )
    notes, visible_notes = matches[0]
    require(
        not _release_has_setext_heading(notes),
        "Release note sections must use ATX headings, not Setext underlines",
    )
    sections = list(_release_sections(visible_notes, 3))
    for heading in ("Upgrade", "Security"):
        section = next((body for title, _, body in sections if title == heading), None)
        require(
            section and _release_has_guidance(section),
            f"Release notes need {heading} guidance",
        )
    body = f"## Changes in {base_version}\n\n{notes}\n\n## Build provenance\n\n{provenance}"
    require(len(body.encode("utf-8")) <= 125_000, "Release notes are too large")
    return body


def publish(
    gh: GitHub, tag: str, sha: str, directory: Path, prerelease: bool, body: str
) -> JSONObject:
    """Keep draft creation, exact-byte upload checks and publication in one transaction."""
    reject_restricted_assets(path.name for path in directory.iterdir())
    body = release_notes(gh, tag, sha, body)
    return _publish_prepared(gh, tag, sha, directory, prerelease, body)


def _publish_prepared(
    gh: GitHub, tag: str, sha: str, directory: Path, prerelease: bool, body: str
) -> JSONObject:
    """Internal transaction after callers validate immutable source-bound notes.

    Callers that maintain publication state prepare notes before their first
    persistent write. Keep mutable tag/workflow authorization checks here too.
    """
    verify_required_signatures(directory, gh.repo, sha)
    reject_restricted_assets(path.name for path in directory.iterdir())
    ensure_absent(gh, tag)
    check_workflow_publication(gh, sha)
    cast(
        JSONObject, gh.api("git/refs", "POST", {"ref": f"refs/tags/{tag}", "sha": sha})
    )
    release = cast(
        JSONObject,
        gh.api(
            "releases",
            "POST",
            {
                "tag_name": tag,
                "target_commitish": sha,
                "name": tag,
                "body": body,
                "draft": True,
                "prerelease": prerelease,
                "make_latest": "false",
            },
        ),
    )
    require(
        release.get("draft") is True and release.get("tag_name") == tag,
        "Unexpected draft release response",
    )
    release_id = positive(release.get("id"), "release ID")
    for path in sorted(directory.iterdir()):
        gh.upload(tag, path)
    uploaded = gh.pages(f"releases/{release_id}/assets")
    expected = {path.name: path for path in directory.iterdir()}
    require(
        len(uploaded) == len(expected)
        and {item.get("name") for item in uploaded} == set(expected),
        "Uploaded asset inventory mismatch; draft left unpublished",
    )
    for item in uploaded:
        verify_uploaded_asset(gh, item, expected[cast(str, item["name"])])
    result = cast(
        JSONObject,
        gh.api(
            f"releases/{release_id}",
            "PATCH",
            {
                "draft": False,
                "prerelease": prerelease,
                "make_latest": "false" if prerelease else "true",
            },
        ),
    )
    require(
        result.get("draft") is False
        and result.get("tag_name") == tag
        and result.get("prerelease") is prerelease,
        "Publication response did not confirm the requested state",
    )
    return result


def emit_result(result: JSONObject) -> None:
    """Print the result and write validated single-line Actions outputs."""
    print(json.dumps(result, sort_keys=True))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary and result.get("status") == "version-required":
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(
                "### Next release version required\n\n"
                f"{result['reason']} No candidate was built or published. "
                "Prepare the next base in a reviewed version PR; versioned consumers "
                "can use `python3 scripts/release.py prepare-version --pr`. "
                "Explicit beta/RC requests retain their strict version checks.\n"
            )
    if summary and result.get("status") == "superseded":
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(
                "### Automatic release superseded\n\n"
                f"Source `{result['source_sha']}` was replaced by default HEAD "
                f"`{result['superseded_by']}`. "
                f"[Replacement run]({result['successor_run_url']}) must pass its own checks; "
                "this does not confirm publication. No tag, release or promotion evidence "
                "was created, and the publication floor was not advanced.\n"
            )
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            for key, value in result.items():
                require(
                    "\n" not in str(value) and "\r" not in str(value),
                    "Unsafe workflow output",
                )
                handle.write(f"{key}={value}\n")


# Keep validation, immutable staging and publication in one auditable sequence.
# pylint: disable-next=too-many-locals
def candidate(args: argparse.Namespace) -> JSONObject:
    """Validate the active run and source policy before publishing a prerelease."""
    gh = GitHub(args.repo)
    base_version = version(args.version)
    require(
        SHA_RE.fullmatch(args.sha),
        "Source SHA must be a full lowercase 40-character commit SHA",
    )
    run_id, attempt = (
        positive(args.run_id, "run ID"),
        positive(args.run_attempt, "run attempt"),
    )
    info = repository_info(gh)
    run = wait_for_executing_run(gh, run_id, args.channel, info, args.sha, attempt)
    policy_snapshot = source_policy_snapshot(gh, args.sha)
    require_release_policy(
        cast(JSONObject, policy_snapshot["data"]),
        gh.repo,
        qualified=args.channel == "rc",
    )
    require(
        not cast(JSONObject, policy_snapshot["data"]).get("versioning"),
        "Versioned policies require the frozen-plan publisher, not post-build allocation",
    )
    check_ancestry(gh, args.sha, cast(str, info["default_branch"]))
    superseded = superseded_candidate(gh, info, run, args.channel)
    if superseded:
        return superseded
    if args.channel in ("beta", "rc"):
        # Once a base version is final, further candidates would mislabel new
        # code as an already released version. Nightlies retain run identities.
        ensure_absent(gh, f"v{base_version}")
    now = datetime.now(timezone.utc)
    tag = candidate_tag(
        gh, args.channel, base_version, run_id, attempt, args.sequence, now
    )
    with tempfile.TemporaryDirectory(prefix="release-candidate-") as temp:
        stage = Path(temp)
        assets = stage_assets(Path(args.assets), stage)
        manifest = {
            "schema": 1,
            "repository": info["full_name"],
            "version": base_version,
            "channel": args.channel,
            "tag": tag,
            "source_sha": args.sha,
            "source_policy": policy_snapshot,
            "workflow_path": WORKFLOW,
            "run_id": run_id,
            "run_attempt": attempt,
            "created_at": now.isoformat(),
            "assets": assets,
        }
        content = json_bytes(manifest)
        (stage / MANIFEST).write_bytes(content)
        superseded = superseded_candidate(gh, info, run, args.channel)
        if superseded:
            return superseded
        body = release_notes(
            gh,
            tag,
            args.sha,
            f"{args.channel} candidate from `{args.sha}`.\n\n"
            f"Validation: https://github.com/{gh.repo}/actions/runs/{run_id}\n\n"
            f"See `{MANIFEST}` for checksums and immutable Actions evidence provenance.",
        )
        EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
        EVIDENCE.write_bytes(content)
        release = _publish_prepared(
            gh,
            tag,
            args.sha,
            stage,
            True,
            body,
        )
    return {
        "status": "published",
        "tag": tag,
        "release_url": release["html_url"],
        "manifest_path": str(EVIDENCE),
    }


def _validate_manifest_assets(manifest: JSONObject) -> None:
    assets = manifest.get("assets")
    require(isinstance(assets, list) and assets, "Manifest contains no assets")
    names = set()
    for item in cast(list[JSONObject], assets):
        require(isinstance(item, dict), "Invalid manifest asset")
        name = item.get("name")
        require(
            isinstance(name, str)
            and NAME_RE.fullmatch(name)
            and name.casefold() != MANIFEST.casefold(),
            "Unsafe manifest asset name",
        )
        name = cast(str, name)
        require(name.casefold() not in names, "Duplicate manifest asset name")
        names.add(name.casefold())
        require(
            # Reject JSON booleans, which isinstance(value, int) would accept.
            type(item.get("size")) is int  # pylint: disable=unidiomatic-typecheck
            and cast(int, item["size"]) >= 0,
            "Invalid manifest asset size",
        )
        require(
            isinstance(item.get("sha256"), str)
            and re.fullmatch(SHA256_PATTERN, cast(str, item["sha256"])),
            "Invalid asset checksum",
        )


def _validate_manifest_plan(manifest: JSONObject, base_version: str) -> None:
    # Optional imports preserve the standalone legacy engine contract.
    # pylint: disable-next=import-outside-toplevel
    if __package__:
        from .version_plan import plan_digest, validate_plan
    else:
        from version_plan import plan_digest, validate_plan

    plan = validate_plan(
        manifest.get("version_plan"),
        cast(JSONObject, cast(JSONObject, manifest["source_policy"])["data"]),
        cast(str, manifest["source_sha"]),
    )
    require(
        plan["tag"] == manifest["tag"]
        and plan["channel"] == manifest["channel"]
        and plan["base_version"] == base_version
        and manifest.get("plan_sha256") == plan_digest(plan),
        "Manifest differs from the frozen version plan",
    )


# pylint: disable-next=too-many-locals
def validate_manifest(
    raw: bytes, repo: str, rc_tag: str, allow_final: bool = False
) -> JSONObject:
    """Reject malformed or ineligible RC manifests before trusting their assets."""
    require(len(raw) <= 2_000_000, "Manifest is unreasonably large")
    manifest = parse_json(raw, MANIFEST)
    require(
        isinstance(manifest, dict)
        # JSON booleans must not qualify as integer schema versions.
        and type(manifest.get("schema")) is int  # pylint: disable=unidiomatic-typecheck
        and manifest["schema"] == 1,
        "Unsupported manifest schema",
    )
    manifest = cast(JSONObject, manifest)
    require(
        isinstance(manifest.get("repository"), str)
        and cast(str, manifest["repository"]).lower() == repo.lower(),
        "Manifest repository mismatch",
    )
    base_version = manifest.get("version")
    require(isinstance(base_version, str), "Missing manifest version")
    base_version = cast(str, base_version)
    version(base_version)
    final = allow_final and manifest.get("channel") == "stable"
    if final:
        require(
            manifest.get("tag") == rc_tag == f"v{base_version}",
            "Final tag/version mismatch",
        )
    else:
        require(
            manifest.get("channel") == "rc", "Only release candidates can be promoted"
        )
        require(
            manifest.get("tag") == rc_tag
            and re.fullmatch(
                rf"v{re.escape(base_version)}-rc\.[1-9]\d*", rc_tag, re.ASCII
            ),
            "Manifest RC tag/version mismatch",
        )
    require(
        isinstance(manifest.get("source_sha"), str)
        and SHA_RE.fullmatch(cast(str, manifest["source_sha"])),
        "Invalid manifest source SHA",
    )
    require(
        manifest.get("workflow_path") == WORKFLOW, "Manifest workflow path mismatch"
    )
    positive(manifest.get("run_id"), "manifest run ID")
    positive(manifest.get("run_attempt"), "manifest run attempt")
    validate_policy_snapshot(manifest.get("source_policy"), repo)
    validate_validation_manifest(manifest)
    versioning = cast(
        JSONObject, cast(JSONObject, manifest["source_policy"])["data"]
    ).get("versioning")
    if versioning:
        _validate_manifest_plan(manifest, base_version)
    if final:
        versioning = cast(JSONObject, versioning)
        require(
            versioning and versioning.get("promotion") == "final-build",
            "Final package policy is missing",
        )
        parent = manifest.get("derived_from_rc")
        require(
            isinstance(parent, dict)
            and set(parent) == {"tag", "manifest_sha256", "source_sha", "run_id"},
            "Final manifest needs accepted RC provenance",
        )
        parent = cast(JSONObject, parent)
        require(
            isinstance(parent["tag"], str)
            and re.fullmatch(rf"v{re.escape(base_version)}-rc\.[1-9]\d*", parent["tag"])
            and parent["source_sha"] == cast(str, manifest["source_sha"])
            and isinstance(parent["manifest_sha256"], str)
            and re.fullmatch(SHA256_PATTERN, parent["manifest_sha256"]),
            "Invalid final RC provenance",
        )
        require(
            positive(parent["run_id"], "parent RC run ID") != manifest["run_id"],
            "Final build must use a new run",
        )
    _validate_manifest_assets(manifest)
    return manifest


def release_snapshot(gh: GitHub, tag: str) -> ReleaseSnapshot:
    """Read a candidate tag, release metadata and its complete asset inventory."""
    ref = cast(JSONObject, gh.api(f"git/ref/tags/{quote(tag, safe='')}"))
    require(
        ref.get("ref") == f"refs/tags/{tag}"
        and cast(JSONObject, ref.get("object", {})).get("type") == "commit",
        "Candidate must have a lightweight commit tag",
    )
    release = cast(JSONObject, gh.api(f"releases/tags/{quote(tag, safe='')}"))
    require(
        release.get("tag_name") == tag
        and release.get("draft") is False
        and release.get("prerelease") is True,
        "Candidate is not a published prerelease",
    )
    assets = gh.pages(f"releases/{positive(release.get('id'), 'release ID')}/assets")
    require(
        all(asset.get("state") == "uploaded" for asset in assets),
        "Candidate has incomplete uploads",
    )
    names = [asset.get("name") for asset in assets]
    require(
        all(isinstance(name, str) and NAME_RE.fullmatch(name) for name in names),
        "Unsafe release asset name",
    )
    require(
        len(names) == len({name.casefold() for name in cast(list[str], names)}),
        "Duplicate release assets",
    )
    return ref, release, assets


def snapshot_identity(snapshot: ReleaseSnapshot) -> bytes:
    """Encode the immutable identity fields used to detect candidate changes."""
    ref, release, assets = snapshot
    return json_bytes(
        {
            "ref": ref,
            "release": {
                key: release.get(key)
                for key in (
                    "id",
                    "tag_name",
                    "target_commitish",
                    "draft",
                    "prerelease",
                    "updated_at",
                )
            },
            # A verifier's own GETs increment this counter. Preserve every other
            # field, including unknown metadata, when checking for replacement.
            "assets": sorted(
                (
                    {
                        key: value
                        for key, value in asset.items()
                        if key != "download_count"
                    }
                    for asset in assets
                ),
                key=lambda asset: cast(int, cast(JSONObject, asset)["id"]),
            ),
        }
    )


def verify_evidence(gh: GitHub, manifest: JSONObject, raw: bytes) -> None:
    """Match the manifest to the digest-verified immutable Actions evidence ZIP."""
    artifacts = gh.pages(f"actions/runs/{manifest['run_id']}/artifacts", "artifacts")
    matching = [
        item
        for item in artifacts
        if item.get("name") == "release-evidence" and not item.get("expired")
    ]
    require(
        len(matching) == 1,
        "Exactly one unexpired immutable release-evidence artifact is required",
    )
    artifact = matching[0]
    require(
        cast(JSONObject, artifact.get("workflow_run", {})).get("id")
        == manifest["run_id"]
        and cast(JSONObject, artifact.get("workflow_run", {})).get("head_sha")
        == cast(str, manifest["source_sha"]),
        "Evidence artifact provenance mismatch",
    )
    archive = gh.binary(
        f"actions/artifacts/{positive(artifact.get('id'), 'artifact ID')}/zip"
    )
    require(
        artifact.get("digest") == f"sha256:{digest(archive)}",
        "Evidence must have a matching immutable v4 artifact digest",
    )
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            entries = [entry for entry in zipped.infolist() if not entry.is_dir()]
            require(
                len(entries) == 1 and entries[0].filename in (MANIFEST, str(EVIDENCE)),
                "Evidence artifact has unexpected contents",
            )
            require(
                entries[0].file_size <= 2_000_000,
                "Evidence artifact manifest is too large",
            )
            require(
                zipped.read(entries[0]) == raw,
                "Release manifest differs from immutable Actions evidence",
            )
    except zipfile.BadZipFile as exc:
        raise ReleaseError("Cannot read release evidence archive") from exc


def require_reviewers(gh: GitHub) -> None:
    """Require the release environment to configure at least one reviewer."""
    environment = cast(JSONObject, gh.api("environments/release"))
    require(
        environment.get("name") == "release", "Protected release environment is missing"
    )
    rules = environment.get("protection_rules", [])
    require(
        any(
            rule.get("type") == "required_reviewers" and rule.get("reviewers")
            for rule in cast(list[JSONObject], rules)
        ),
        "The release environment must have required reviewers configured",
    )


# Preserve the ordered security checks and staged bytes within one transaction.
# pylint: disable-next=too-many-locals,too-many-statements
def promote(args: argparse.Namespace) -> JSONObject:
    """Verify an approved RC and publish the same bytes under a new stable tag."""
    gh = GitHub(args.repo)
    require(
        re.fullmatch(
            "v" + VERSION_PATTERN + r"-rc\.[1-9]\d*",
            args.rc,
            re.ASCII,
        ),
        "Promotion requires a strict vX.Y.Z-rc.N tag",
    )
    current_id = positive(args.run_id, "run ID")
    info = repository_info(gh)
    wait_for_executing_run(
        gh,
        current_id,
        "stable",
        info,
        checked_out_sha(),
        positive(os.environ.get("GITHUB_RUN_ATTEMPT"), "current run attempt"),
        gate=False,
    )
    require_reviewers(gh)
    initial = release_snapshot(gh, args.rc)
    ref, candidate_release, release_assets = initial
    manifest_assets = [
        asset for asset in release_assets if asset.get("name") == MANIFEST
    ]
    require(len(manifest_assets) == 1, "Candidate manifest is missing")
    raw = gh.binary(
        f"releases/assets/{positive(manifest_assets[0].get('id'), 'manifest asset ID')}"
    )
    manifest = validate_manifest(raw, gh.repo, args.rc)
    policy_snapshot = source_policy_snapshot(gh, cast(str, manifest["source_sha"]))
    require_release_policy(
        cast(JSONObject, policy_snapshot["data"]), gh.repo, qualified=True
    )
    require_current_fuzzing(gh, cast(JSONObject, policy_snapshot["data"]), checked_out_sha())
    require(
        cast(
            JSONObject, cast(JSONObject, policy_snapshot["data"]).get("versioning", {})
        ).get("promotion")
        != "final-build",
        "This RC requires a separately validated final build; byte promotion is disabled",
    )
    if manifest.get("version_plan"):
        # pylint: disable-next=import-outside-toplevel
        if __package__:
            from .release_state import verify_promotion_order
        else:
            from release_state import verify_promotion_order

        verify_promotion_order(gh, cast(JSONObject, manifest["version_plan"]))
    require(
        policy_snapshot == manifest["source_policy"],
        "Manifest policy snapshot differs from the policy at the candidate source commit",
    )
    require(
        cast(JSONObject, ref["object"]).get("sha") == cast(str, manifest["source_sha"]),
        "Candidate tag SHA differs from manifest",
    )
    require(
        manifest["run_id"] != current_id,
        "Candidate and promotion must use separate runs",
    )
    source_run = cast(JSONObject, gh.api(f"actions/runs/{manifest['run_id']}"))
    validate_validation_run(gh, source_run, cast(JSONObject, policy_snapshot["data"]), "rc")
    require(source_run.get("id") == manifest["run_id"], "Source run identity mismatch")
    validate_run(
        gh,
        source_run,
        info,
        cast(str, manifest["source_sha"]),
        cast(int, manifest["run_attempt"]),
        completed=True,
    )
    require(
        source_run.get("event") == "workflow_dispatch",
        "RC must originate from a manual workflow dispatch",
    )
    check_ancestry(
        gh, cast(str, manifest["source_sha"]), cast(str, info["default_branch"])
    )
    verify_evidence(gh, manifest, raw)
    tag = f"v{manifest['version']}"
    ensure_absent(gh, tag)
    expected = {
        item["name"]: item for item in cast(list[JSONObject], manifest["assets"])
    }
    require(
        {item["name"] for item in release_assets} == set(expected) | {MANIFEST},
        "Candidate assets differ from manifest inventory",
    )
    check_workflow_publication(gh, cast(str, manifest["source_sha"]))
    with tempfile.TemporaryDirectory(prefix="release-promote-") as temp:
        stage = Path(temp)
        for asset in release_assets:
            name = cast(str, asset["name"])
            if name == MANIFEST:
                (stage / name).write_bytes(raw)
                identity: AssetIdentity = {"size": len(raw), "sha256": digest(raw)}
            else:
                identity = download_asset(gh, asset.get("id"), stage / name)
            require(
                asset.get("size") == identity["size"],
                f"Release asset size mismatch: {name}",
            )
            if name != MANIFEST:
                require(
                    identity["size"] == expected[name]["size"]
                    and identity["sha256"] == expected[name]["sha256"],
                    f"Candidate checksum mismatch: {name}",
                )
        require(
            snapshot_identity(release_snapshot(gh, args.rc))
            == snapshot_identity(initial),
            "Candidate changed during verification",
        )
        verify_required_signatures(stage, gh.repo, cast(str, manifest["source_sha"]))
        # Recheck mutable authorization/provenance just before the first write.
        latest_run = cast(JSONObject, gh.api(f"actions/runs/{manifest['run_id']}"))
        validate_validation_run(gh, latest_run, cast(JSONObject, policy_snapshot["data"]), "rc")
        validate_run(
            gh,
            latest_run,
            info,
            cast(str, manifest["source_sha"]),
            cast(int, manifest["run_attempt"]),
            completed=True,
        )
        require_reviewers(gh)
        check_workflow_publication(gh, cast(str, manifest["source_sha"]))
        body = release_notes(
            gh,
            tag,
            cast(str, manifest["source_sha"]),
            f"Promoted unchanged from [{args.rc}]({candidate_release['html_url']}).\n\n"
            f"Source: `{manifest['source_sha']}`\n\n"
            f"Validation: https://github.com/{gh.repo}/actions/runs/{manifest['run_id']}\n\n"
            f"Promotion: https://github.com/{gh.repo}/actions/runs/{current_id}\n\n"
            f"Assets and `{MANIFEST}` are byte-for-byte copies of the verified release candidate.",
        )
        if manifest.get("version_plan"):
            verify_promotion_order(gh, cast(JSONObject, manifest["version_plan"]))
            # pylint: disable-next=import-outside-toplevel
            if __package__:
                from .release_state import begin_publication
            else:
                from release_state import begin_publication

            begin_publication(
                gh,
                cast(JSONObject, manifest["version_plan"]),
                current_id,
                promotion=True,
            )
        release = _publish_prepared(
            gh,
            tag,
            cast(str, manifest["source_sha"]),
            stage,
            False,
            body,
        )
    return {"tag": tag, "release_url": release["html_url"]}


def parser() -> argparse.ArgumentParser:
    """Build the CLI for guarded publication and read-only release helpers."""
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    new = commands.add_parser(
        "candidate", help="Publish a checked prerelease from the current Actions run"
    )
    new.add_argument("--repo", required=True)
    new.add_argument("--channel", choices=("nightly", "beta", "rc"), required=True)
    new.add_argument("--version", required=True)
    new.add_argument("--sha", required=True)
    new.add_argument("--run-id", required=True)
    new.add_argument("--run-attempt", required=True)
    new.add_argument("--assets", required=True)
    new.add_argument("--sequence", type=int)
    stable = commands.add_parser(
        "promote", help="Promote an existing verified RC without rebuilding"
    )
    stable.add_argument("--repo", required=True)
    stable.add_argument("--rc", required=True)
    stable.add_argument("--run-id", required=True)
    sequence = commands.add_parser(
        "next", help="Read-only next beta/RC sequence; publication still detects races"
    )
    sequence.add_argument("--repo", required=True)
    sequence.add_argument("--channel", choices=("beta", "rc"), required=True)
    sequence.add_argument("--version", required=True)
    verify = commands.add_parser(
        "verify-manifest", help="Validate a local RC manifest's structure"
    )
    verify.add_argument("--repo", required=True)
    verify.add_argument("--rc", required=True)
    verify.add_argument("--manifest", type=Path, required=True)
    return result


def main(argv: list[str] | None = None) -> int:
    """Execute one release command and report failures without retrying writes."""
    args = parser().parse_args(argv)
    try:
        if args.command == "candidate":
            result = candidate(args)
        elif args.command == "promote":
            result = promote(args)
        elif args.command == "next":
            result = {
                "sequence": next_sequence(GitHub(args.repo), args.version, args.channel)
            }
        else:
            result = validate_manifest(args.manifest.read_bytes(), args.repo, args.rc)
        emit_result(result)
        return 0
    except (ReleaseError, OSError, KeyError, TypeError) as exc:
        print(f"release-control: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

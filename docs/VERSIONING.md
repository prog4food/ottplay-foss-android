# Version plans and manifest synchronization

Repositories opt in through `versioning` in `.release-policy.json`. The toolkit
still supports legacy policies without this key. Never select a new promotion
mode implicitly when updating a consumer.

## Preparing the source version

From a clean checkout at the current default-branch HEAD:

```bash
python3 scripts/release.py prepare-version --dry-run
python3 scripts/release.py prepare-version --pr
python3 scripts/release.py prepare-version --bump minor --pr
python3 scripts/release.py prepare-version --version 2.0.0 --pr
```

The default refreshes tags, considers only stable tags merged into the current
line, and chooses the next patch after the latest stable. An already prepared,
unreleased source base is retained. Minor and major changes require explicit
intent. `--pr` creates a dedicated branch and reuses an existing open preparation
PR for that version. Without `--pr`, the declared source files are edited locally.
No command commits unrelated files, pushes the default branch, or creates a
public release. Normal project checks still apply to the preparation PR.

After the stable tag for a committed base exists, automatic push betas report
`version-required` before allocating a plan or building packages. The full quality
and security checks still run, and their failures still fail the release gate.
No candidate is published. Prepare and merge the next base version to resume beta
publication. Explicit beta/RC requests still reject an occupied stable base;
scheduled nightlies keep their existing behavior.

Only owned fields change: JSON/TOML fields, the named package's lock entries,
text versions, declared Python constants, and native configuration fields.
Unrelated dependencies and independently versioned components are preserved.
Build-counter fields are excluded from a source-base PR.

## Before compilation

The release workflow freezes `.release-plan.json` before checks/builds. It contains
the exact base/full version, tag/channel/sequence, source SHA, policy digest,
promotion profile, and allocated native build number. Every platform downloads
the same immutable Actions plan artifact and runs:

```bash
python3 scripts/version_plan.py sync --plan .release-plan.json
```

The synchronizer checks checkout identity and owned source fields, changes only
declared version inputs, and writes `.release-inputs.json`. Its file hashes and
effective-input digest distinguish committed source from the build overlay.
`main` and the source tag retain the base version: reproducing a candidate also
requires its saved plan. Automatic per-candidate version commits are not enabled
by this implementation.

SemVer prereleases map to Python PEP 440 where declared. Apple marketing versions
remain numeric; the product UI can independently use the full embedded identity.
Python nightlies use `X.Y.Z.dev<run_id * 1000000 + attempt>`: attempts must be
below one million and the numeric component must fit `uv`'s unsigned 64-bit
limit (at most `2**64 - 2`). This preserves run/attempt ordering and uniqueness
without a local suffix. The full tag and frozen plan retain the UTC timestamp.
The former concatenated timestamp/run/attempt projection exceeded that limit;
do not reuse previously produced package receipts after changing the recipe.
Native counters must be seeded above existing compatible published values.
The Apple build projection uses bounded numeric components; changing an older,
incompatible build-number format needs a reviewed platform migration.

Tauri applications that build Windows MSI packages must project the numeric
`base` version into `tauri.conf.json`. Keep the `full` candidate in owned package
manifests and expose the frozen plan identity to the UI/runtime, so beta and RC
labels remain visible without putting an unsupported prerelease string in MSI
metadata. Tauri can serialize Cargo manifests with LF while preparing a build;
because receipts intentionally compare exact input bytes after packaging, keep
those checkout bytes stable on Windows:

```gitattributes
src-tauri/Cargo.toml text eol=lf
src-tauri/Cargo.lock text eol=lf
```

## Durable allocation and retries

The repository's dedicated `release-version-state` branch contains only the
allocator's logical state file, `release-version-state.json` (the branch starts
at the first source commit). GitHub's Contents API blob-SHA compare-and-swap
serializes allocations. Conflicts fail; they never silently rename a compiled
candidate. This metadata branch is not a release/deployment trigger.

A reservation is keyed by Actions run ID and bound to the source, policy, channel,
base, and accepted RC when applicable. Rerunning that run reuses the plan; a new
run consumes a new number. Failed runs may leave gaps. Preserve the state branch
and issued numbers during rollback. The ordinary release workflow remains
serialized through publication. Publication also rejects delayed builds when a
newer reserved build has already been published. Existing public tags/assets are
never overwritten.

Immediately before publication, a compare-and-swap permanently advances the
publication floor. Deleting GitHub release metadata cannot make an older build
publishable again. A failed publication consumes the number and needs a new run;
if it already created the stable tag, that immutable tag also prevents a same-base
retry. Investigate the partial publication before preparing a new base. Removing
the ledger file from an existing state branch fails closed.

## Automatic nightly publication reuse

Versioned repositories still allocate a fresh plan and run all required checks,
current security scans and the complete nightly build matrix. This preserves
coverage of mutable base images, downloaded packages and hosted toolchains even
when the source commit is unchanged. After the Release gate and new build receipts
pass, a scheduled nightly can report `reused` instead of publishing duplicate
GitHub release assets. It requires a published beta, RC or stable with the exact
same source, policy and base version, successful originating CI/Release gates,
retained immutable Actions evidence, and matching asset sizes and digests.

Only publication is skipped: the new build artifacts remain in Actions under
normal adapter retention. No new release/tag or promotion evidence is created,
and the publication floor stays unchanged so this nightly does not invalidate the
accepted RC. The allocated build number remains reserved; gaps are intentional.
Manual nightly requests, new sources, and missing, expired or unverifiable prior
evidence follow normal publication. Failed current checks/builds still fail the
run. This does not reset an existing floor or restore an already obsolete RC;
those still require a new RC. Legacy repositories retain their existing behavior.

## Checking the packages

Each platform performs its package-specific metadata checks, then stages its
final payloads into a flat directory and creates a uniquely named receipt:

```bash
python3 scripts/version_receipt.py create \
  --plan .release-plan.json --inputs .release-inputs.json \
  --assets release-assets/linux \
  --output release-assets/linux/release-inputs-linux.json
```

The receipt binds the effective version inputs to every payload's exact size and
SHA-256. The publisher rejects missing, duplicate, mismatched, or uncovered files.
CLI receipt and binary-metadata paths must stay inside the checkout containing
the installed scripts; Git metadata, symlink escapes and existing output files
are rejected. The receipt also rechecks declared source-file hashes after packaging.
It records installed compiler/runtime versions and GitHub runner image identifiers
per platform; final-build compares
these with the accepted RC and rejects toolchain drift. Failure diagnostics cover
all platform receipts in deterministic order, with field paths, missing fields
and changed types; receipt values are withheld. Diagnostics show at most 100 field
differences, count any omitted differences, and redact unsafe or oversized labels.
Receipt inventory, byte integrity and JSON failures still stop verification.
Floating runner image rollouts can give successive jobs different `ImageVersion`
values, so a new RC alone does not guarantee matching final-build inputs. Inspect
the verified RC and final receipts and runner/toolchain availability before
starting another RC/final cycle. Exact equality remains required for publication;
the diagnostic does not permit dropping fields or overriding the receipt.
It additionally reads all metadata targets declared in `versioning.artifacts`;
each declared pattern must match a real package in the complete matrix.

The release manifest keeps the existing schema-1 base fields for readers and adds
`version_plan`, `plan_sha256`, `build_receipts`, and inspected `package_versions`.
The immutable Actions evidence still records the exact manifest bytes.

## Explicit stable profiles

`promote-bytes` retains verified RC payloads without rebuilding. Package versions
already contain the final base for RC. The embedded RC origin cannot change
offline; external stable assignment and build origin are distinct. Full beta
versions may be embedded because beta is not directly promoted.

`final-build` builds final-version packages from the accepted RC's exact source
commit, including the dependency locks and recipe. The RC must match the current
default-branch HEAD; create a new RC after code, policy or workflow changes.
The complete checks and matrix run again. The protected release approval applies
to the new final artifacts, whose manifest records `derived_from_rc` and new
hashes. This is not a claim of byte-for-byte RC promotion. Old RCs that predate the
versioned policy cannot qualify for final-build.

Stable remains an explicit dispatch with an exact RC tag. Hardware/device
acceptance, app-store admission, registry import and production deployment remain
separate checks. Version stamping alone does not implement npm/crates publication
or enable Python prerelease publication.

## Policy example

```json
{
  "versioning": {
    "schema": 1,
    "promotion": "final-build",
    "build_number_floor": 2005042,
    "files": [
      {"path": "package.json", "format": "json", "field": "version", "value": "full"},
      {"path": "src-tauri/Cargo.toml", "format": "toml", "field": "package.version", "value": "full"},
      {"path": "src-tauri/Cargo.lock", "format": "cargo-lock", "package": "owned-app", "value": "full"},
      {"path": "src-tauri/tauri.conf.json", "format": "json", "field": "version", "value": "base"}
    ]
  }
}
```

Use the real package name and fields for each consumer. A policy owns exactly the
listed fields; unsupported formats and ambiguous selectors fail closed. Render
the shared scripts/workflows with `install_release.py`, pin the toolkit revision
in the consumer policy, and run the generated contract tests plus project checks.

Retired package families can be preserved with a top-level `asset_restrictions`
list, for example `{"suffixes": [".apk", ".aab"], "reason": "Android publication moved"}`.
The renderer embeds these reviewed restrictions in the release engine. It rejects
matching suffixes case-insensitively before staging any bytes and before any
publication API call, including promotion of an older RC.

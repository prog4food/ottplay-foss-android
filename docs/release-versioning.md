# Release version inputs

The `versioning` section of `.release-policy.json` owns the exact fields that identify
this application. Committed sources contain a numeric base version. The release
workflow freezes one `.release-plan.json` before any platform build and applies its
version overlay before dependency installation or compilation.

Beta and nightly packages include their candidate identity. Python package fields
use PEP 440 (`X.Y.ZbN` or `.dev...`); SemVer fields use the corresponding hyphenated
suffix. With the `promote-bytes` profile, RC packages contain the final numeric base
version so stable promotion can reuse the exact verified RC bytes. The plan and
release manifest retain the full RC identity.

Local base checks do not allocate versions or create publishable candidates:

```bash
python3 scripts/version_plan.py check-base --root .
```

For a clean checkout at the frozen source commit, apply a plan from the release
workflow before running the existing package command:

```bash
python3 scripts/version_plan.py sync --root . --plan .release-plan.json
```

`RELEASE_VERSION_PLAN` can select a plan path for the local version validator. The
positional package arguments remain the numeric base and channel. A mismatched
source commit, policy, channel, base, or version field fails validation. Independent
dependency versions are never changed by a broad search-and-replace.

Every platform stages only its original declared upload files in a fresh flat
`release-assets/<target>/` directory. Before upload, the staging helper checks the
version inputs again, reads declared package metadata, and produces a receipt with
payload sizes and SHA-256 hashes bound to the plan. Native/source archives include
the frozen plan and input evidence where their packaging format permits it.

The receipt proves which source inputs and bytes were packaged; device, installer,
store, service, and production deployment acceptance remain separate checks.

## Owned files

- `Cargo.lock`
- `ios/App/App.xcodeproj/project.pbxproj`
- `package-lock.json`
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

## iOS build numbering migration

The published `v1.1.42-beta.5` unsigned IPA contains marketing version `1.1.42` and
build `10142` (SHA-256 `d9c2bf05cac9cbd8ac85e306c79c71dc4e338bdc73b4f99481105d255d7c40e9`).
This migration starts the new `1.1.43` marketing version with a valid committed iOS
build `1.0.0`; candidate builds use the separately allocated bounded Apple build
projection. The allocation floor is `10142`. The old arithmetic mobile-version
script now requires a frozen plan and cannot silently reuse a build number.

Apple permits iOS builds to use a lower build number for a new marketing version,
while macOS build numbers must increase across versions; see
[Apple's build number requirements](https://developer.apple.com/documentation/xcode/setting-the-next-build-number-for-xcode-cloud-builds).
This establishes the intended version scheme, not App Store acceptance or a tested
device upgrade. These iOS packages remain unsigned and require operator signing.
The separate `ottplay-core` and `ottplay-server` crate versions remain `0.1.0`.

OCI builds set `org.opencontainers.image.version` from the checked package projection
and `org.opencontainers.image.revision` from the source commit. Publication verifies
the version label on every runnable platform image, following the bounded OCI
index, manifest and config digest chain. Local container builds require an available
Docker daemon; registry publication and live deployment are separate actions.

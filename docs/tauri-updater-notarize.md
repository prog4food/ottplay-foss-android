# Tauri updater and macOS signing (Mode B)

Configuration for desktop auto-updates and macOS release signing. **No secrets
are committed.** Without Apple credentials, the release workflow signs the Mac
app bundle ad hoc before packaging it. That signature seals bundle contents;
Developer ID and notarization require separate Apple credentials. This describes
the current workflow; previously published artifacts retain their original signing
state.

## What each signature establishes

- **Ad-hoc code signing** seals the app's executable and bundle resources without
  an Apple-authenticated identity. It requires no certificate or account and does
  not make the app trusted by Gatekeeper. See [Tauri's ad-hoc signing documentation](https://v2.tauri.app/distribute/sign/macos/#ad-hoc-signing).
- **Developer ID code signing** identifies the developer through an Apple-issued
  certificate. **Notarization** is a separate Apple service; a valid code signature
  alone does not prove it succeeded. See [Apple's signing and notarization overview](https://support.apple.com/en-us/102445).
- **Tauri updater signatures** authenticate update payloads to the public key
  configured in the app. They neither sign the macOS app bundle for Gatekeeper
  nor notarize it. They use different keys from Apple code signing.

The current implementation is in [the release build workflow](../.github/workflows/release-build.yml)
and [the artifact collector](../scripts/ci-tauri-collect-artifacts.sh).

## Updater (GitHub Releases)

Config lives in `src-tauri/tauri.conf.json` under `plugins.updater`:

- **Endpoint:** `https://github.com/open-ott-play/ottplay-foss/releases/latest/download/latest.json`
- **Pubkey:** placeholder pubkey in `tauri.conf.json` (base64 stub — **not** production) until you generate a real keypair
- **`createUpdaterArtifacts`:** not enabled in the committed config. Release CI passes `--config '{"bundle":{"createUpdaterArtifacts":true}}'` only when `TAURI_SIGNING_PRIVATE_KEY` is set.

### Generate signing keys (human, once)

```bash
cd src-tauri
npx tauri signer generate -w ~/.tauri/ottplay-foss.key
```

1. Copy the **public** key into `plugins.updater.pubkey` in `tauri.conf.json` (commit that change).
2. Store the **private** key contents as GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`.
3. If you set a password on the key, also set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Never commit the private key, `.key` files, or dotenv copies of them.

### Release candidates and updater readiness

Use [the release workflow](release-workflow.md), not direct tag pushes:

```bash
python3 scripts/release.py check
python3 scripts/release.py rc --version 1.2.3
python3 scripts/release.py stable --rc v1.2.3-rc.1
```

Replace the example versions with the committed base version and the actual checked
RC tag. A base version already published as stable cannot receive new beta/RC
releases; bump all committed native version files through a PR first. Stable requires the protected `release` environment approval and copies the
RC bytes without rebuilding. The mandatory desktop/mobile build matrix produces
installers; the complete native matrix must still pass on hosted runners and be
smoke-tested on the intended devices.

Automatic updates are **not configured for production**. The committed updater
public key is a placeholder, and the release adapter does not generate `latest.json`.
Setting a signing secret produces signed updater payloads; it does not by itself
make the configured update endpoint usable. Manual installer downloads remain the
supported delivery path until a reviewed updater integration is implemented.

A future updater integration must commit the real public key and generate and
validate `latest.json` as part of the candidate artifact set, with URLs targeting
the eventual stable version. The manifest and signature files must be checked
before the candidate is published and copied unchanged during promotion. Never
attach, replace or edit assets on a checked RC or stable release: that changes the
inventory covered by its immutable evidence. Create a corrected candidate instead.

The collector creates `.app.zip` and copies Tauri's `.dmg` separately for
`aarch64-apple-darwin` and `x86_64-apple-darwin`. It fails if either required
package type is absent. When updater artifacts are enabled, it also copies
`.app.tar.gz` and `.app.tar.gz.sig`, preserving their paired names. A `.app.zip`
is a manual-install archive, not the updater payload.

Mode B JS checks for updates only when `window.__TAURI__` is defined (Mode A / browser companion unchanged).

### Permissions

`src-tauri/capabilities/default.json` includes `updater:default` (`check` / `download` / `install`).

## macOS release signing paths

The workflow selects one of these paths during **Build desktop package**:

1. With `APPLE_CERTIFICATE`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
   `APPLE_TEAM_ID` present on the Mac runner, it imports the certificate into a
   temporary keychain and passes the Apple credentials to Tauri. This retains
   the configured Developer ID signing/notarization path. An import, signing or
   notarization failure fails the build; it does not retry with ad-hoc signing.
2. Otherwise, it sets `CSC_IDENTITY_AUTO_DISCOVERY=false`. On macOS, if neither
   `APPLE_SIGNING_IDENTITY` nor `APPLE_CERTIFICATE` is already set in the build
   environment, it passes:

   ```json
   {"bundle":{"macOS":{"signingIdentity":"-"}}}
   ```

   Tauri signs the complete app ad hoc before producing its distribution
   artifacts. An explicit identity or certificate in the build environment is
   preserved; the fallback does not override it. The macOS override is not
   applied to Windows or Linux.

After Tauri finishes, the collector runs
`codesign --verify --deep --strict --verbose=2` on each source `.app`. It then
creates the manual-install ZIP with `ditto --sequesterRsrc --keepParent`, extracts
it into a temporary directory and runs the same verification on the extracted
app. Failure at either check stops collection. This catches incomplete bundle
signatures and resource damage during ZIP packaging; an executable's linker
signature alone is insufficient.

The collector copies the DMG and optional updater tarball without mounting or
extracting them. Its ZIP check is not a DMG/updater round-trip test or a Gatekeeper
assessment. Test the exact distribution format during candidate acceptance;
[the commands below](#verify-a-downloaded-macos-artifact) cover manual inspection.

### Developer ID and notarization secrets

Tauri reads these env vars during `tauri build` on macOS (see [macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)):

| Secret | Purpose |
|--------|---------|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` Developer ID Application cert |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: …` (optional if cert import is enough) |
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password (CI maps this to `APPLE_PASSWORD`) |
| `APPLE_TEAM_ID` | 10-character Team ID |
| `KEYCHAIN_PASSWORD` | Optional; CI generates a random unlock password if unset |

The certificate password must match the exported certificate. Secret presence
selects the path; it does not prove the credentials are valid or notarization
succeeded. Do not bake certificates into the repository or workflow files.

Alternative to Apple ID + app password: App Store Connect API key via `APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_PATH` (see Tauri docs). Prefer documenting one path; this repo’s CI hooks the Apple ID path.

## Windows / Linux signing

- **Updater signatures** use the Tauri minisign keypair above (all desktop OSes).
- **Windows Authenticode / Linux package signing** are not configured; unsigned MSI/NSIS/AppImage/deb attach to the release.

## Verify a downloaded macOS artifact

Download from the intended release tag and retain its asset name and SHA-256
alongside your results. The examples extract into new temporary directories and
do not launch, install or modify the app. Use the archive from the tag you are
accepting; the ZIP filename itself does not contain a version. Run the blocks
in Bash (`bash`) on macOS.

### Manual-install ZIP

For Apple Silicon (replace `aarch64-apple-darwin` with `x86_64-apple-darwin` for
Intel):

```bash
(
  set -e
  macos_archive="$HOME/Downloads/OttPlay.FOSS_aarch64-apple-darwin.app.zip"
  macos_verify_dir="$(mktemp -d "${TMPDIR:-/tmp}/ottplay-verify.XXXXXX")"
  shasum -a 256 "$macos_archive"
  ditto -x -k "$macos_archive" "$macos_verify_dir"
  codesign --verify --deep --strict --verbose=2 "$macos_verify_dir/OttPlay FOSS.app"
  codesign --display --verbose=4 "$macos_verify_dir/OttPlay FOSS.app"
  printf 'Extracted app retained at: %s\n' "$macos_verify_dir/OttPlay FOSS.app"
)
```

### DMG

Place only the selected tag's DMG in the directory below. The collector preserves
Tauri's version/architecture stem and appends the target triple, so select the
actual filename instead of constructing one from a tag. This example refuses
ambiguous matches:

```bash
(
  set -e
  macos_release_dir="$HOME/Downloads/ottplay-release"
  macos_dmgs=("$macos_release_dir"/OttPlay.FOSS_*_aarch64-apple-darwin.dmg)
  if [ "${#macos_dmgs[@]}" -ne 1 ] || [ ! -f "${macos_dmgs[0]}" ]; then
    printf 'Expected exactly one Apple Silicon DMG in %s\n' "$macos_release_dir" >&2
    exit 1
  fi
  macos_mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/ottplay-dmg.XXXXXX")"
  shasum -a 256 "${macos_dmgs[0]}"
  hdiutil verify "${macos_dmgs[0]}"
  hdiutil attach -readonly -nobrowse -mountpoint "$macos_mount_dir" "${macos_dmgs[0]}"
  trap 'hdiutil detach "$macos_mount_dir"' EXIT
  codesign --verify --deep --strict --verbose=2 "$macos_mount_dir/OttPlay FOSS.app"
  codesign --display --verbose=4 "$macos_mount_dir/OttPlay FOSS.app"
)
```

Use the `x86_64-apple-darwin.dmg` suffix for Intel. `hdiutil verify` checks the disk
image; the separate `codesign` invocation checks the app inside it.

### Optional updater tarball

When the selected release includes an updater payload, inspect the app extracted
from that payload separately. Use the actual `.app.tar.gz` asset name shown on
the release; the usual Apple Silicon name is below:

```bash
(
  set -e
  macos_archive="$HOME/Downloads/OttPlay.FOSS_aarch64-apple-darwin.app.tar.gz"
  macos_verify_dir="$(mktemp -d "${TMPDIR:-/tmp}/ottplay-updater.XXXXXX")"
  shasum -a 256 "$macos_archive"
  tar -xzf "$macos_archive" -C "$macos_verify_dir"
  codesign --verify --deep --strict --verbose=2 "$macos_verify_dir/OttPlay FOSS.app"
  codesign --display --verbose=4 "$macos_verify_dir/OttPlay FOSS.app"
  printf 'Extracted app retained at: %s\n' "$macos_verify_dir/OttPlay FOSS.app"
)
```

This checks the inner app's code signature, not the tarball's updater `.sig`.
A digest you calculate locally identifies your download but is not independently
trusted evidence; compare it with the selected candidate's recorded inventory.

### Interpret the results

A passing `codesign --verify` establishes the bundle's signature integrity.
`codesign --display` describes it: the fallback reports `Signature=adhoc`, while
a Developer ID signature includes its `Authority` chain and `TeamIdentifier`.
Displaying these fields does not itself verify the signature.

To assess an extracted app with this Mac's Gatekeeper policy, substitute its
reported path:

```bash
spctl --assess --type execute --verbose=4 "/path/to/OttPlay FOSS.app"
```

An ad-hoc app can pass `codesign` and be rejected by `spctl`. For a build expected
to be notarized, also check its stapled ticket with Xcode command-line tools:

```bash
xcrun stapler validate "/path/to/OttPlay FOSS.app"
```

Record these results separately; neither the workflow's credential detection nor
the ZIP signature check establishes Gatekeeper acceptance. If a trusted,
integrity-verified ad-hoc app needs first-launch approval, follow
[Apple's Open Anyway instructions](https://support.apple.com/en-us/102445).
A damaged-bundle error requires diagnosis, not a blanket quarantine reset.
Never re-sign a downloaded release to hide a failed integrity check. Preserve
the original bytes and error, and build a corrected candidate instead.

## Local smoke without Apple credentials

The release workflow supplies the fallback; a direct local CLI invocation must
request it explicitly. From the repository root, on macOS with no Apple signing
credentials configured:

```bash
npm ci
npx tauri build --ci --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}'
```

This signs the local bundle ad hoc. It does not create updater signatures unless
you also enable updater artifacts and provide the separate Tauri key. For that
local test, keep the private key outside the repository:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/ottplay-foss.key)"
# Export TAURI_SIGNING_PRIVATE_KEY_PASSWORD separately if the key is encrypted.
npx tauri build --ci --config '{"bundle":{"macOS":{"signingIdentity":"-"},"createUpdaterArtifacts":true}}'
```

These are build examples, not a release publication command. See [local macOS
delivery](macos-local-delivery.md) for installation and runtime checks. Follow
the [release workflow](release-workflow.md) to produce an official candidate.

## Related

- Release workflows: `.github/workflows/release-build.yml` (native builds) and `.github/workflows/release-pipeline.yml` (validation and promotion)
- Artifact collect: `scripts/ci-tauri-collect-artifacts.sh`
- Signing/packaging regression coverage: `.github/release-tests/test_macos_release_signing.py`
- Local delivery: [macOS build and installation](macos-local-delivery.md)
- Remote diagnostics: [remote workbench](remote-workbench.md)

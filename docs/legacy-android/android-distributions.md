> **Archived Capacitor Android reference.** This document describes the retired wrapper before extraction. Its Android build/signing commands no longer run in this repository. Native Android development is in [ottplay-android](https://github.com/open-ott-play/ottplay-android), currently a private preview requiring repository access. These notes do not describe that application.

# Android Full and Play distributions

The two Android products use the same player and native plugins. Their provider
catalogs, application identities and packaged frontend assets are selected at build
time. There is no hidden switch that restores the Full catalog in Play.

**Full** is the sideload product: application ID `play.ott.foss`, launcher name
`OTT-play FOSS Full`, and the existing provider catalog. The ID preserves the
installed application's upgrade path when the update has the same signing
certificate. Keeping the ID alone cannot migrate between unrelated signing keys.

**Play** is the store submission product: application ID `play.ott.foss.play`,
launcher name `OTT-play FOSS`. It contains Demo and user-configured M3U, Xtream and
Stalker entries. Branded provider implementations, logos and provider pages from
Full are excluded from the package. Play has separate Android application storage
and can be installed beside Full. Its native XMLTV implementation does not select
Full's built-in EPG services when the user supplies no EPG source.

Play's About screen displays local diagnostics without contacting a public-IP
lookup service. The legacy request and its result row are removed at build time;
the package audit rejects any remaining `ipify.org` reference in executable
frontend assets.

Both Android flavors use system fonts. Native Tauri and Capacitor builds exclude
all custom text fonts and every Fontello format (`ttf`, `eot`, `woff`, `woff2`,
`svg`). Font-face rules, font selectors and private-use glyph references are
replaced by system `sans-serif` text and Unicode symbols such as `▸`, `■`, `‖`,
`«`, `»`, `□` and `✓`. Android's system symbol fallback supplies missing characters;
their appearance can vary across devices. The web/legacy distribution retains
its existing font files.

Native builds use npm-locked jQuery 4.0.0, hls.js 1.7.3 and Shaka Player 5.2.10.
Their license files and a generated version/hash manifest accompany the native
assets. The older vendor JavaScript files remain for the web/legacy profile.

The demo is an original synthetic test pattern streamed over HTTPS; it requires a
network connection. User-configured services require the user's own authorized
URLs and credentials. A source's presence in Full does not grant distribution or
viewing rights. The Play flavor is a reviewable submission artifact, not a claim
that Google has approved the application or any content source.

Before public distribution, resolve the outstanding inherited-core permission
question in the [inherited component notices](../legacy-provenance.md). The root MIT statement
does not establish the original authors' grant for imported code. Missing
local evidence alone does not establish infringement or justify rewriting the
entire player. Native builds no longer carry the historical text/icon fonts;
those font questions apply only to artifacts that retain them.

The required native license notices include Capacitor App's separate MIT
attribution and Cordova's original NOTICE, in addition to the runtime package
licenses. See [Third-party notices](../../THIRD-PARTY-NOTICES.md). A passing artifact
audit is not a copyright clearance or store approval.

[Play submission materials](play-submission.md) contain English reviewer steps,
listing copy, a Data safety worksheet, a media-playback foreground-service draft
and the remaining publisher/device checks. They are preparation materials;
Console declarations and public policy publication are separate actions.

## Build commands

Install the locked Node dependencies with `npm ci`, use Node 22 and JDK 21, and
install the Android SDK declared by `android/variables.gradle`.

```bash
# Full debug APK for local sideload
npm run android:full

# Full release APK, signed only when the release keystore is configured
npm run android:full:release

# Play release AAB
npm run android:play

# Play debug APK for device testing
npm run android:play:debug

# All four artifacts
npm run android:all
```

These commands synchronize native plugin projects, run the explicit Gradle
variants and audit the resulting APK/AAB. They do not copy `dist/` into a shared
Android app assets directory. To update native projects without building:

```bash
node scripts/build-android.cjs sync
```

AAB verification uses official bundletool 1.18.3. The wrapper downloads it into
ignored `android/build/tools/` and checks the pinned SHA256 from its GitHub release.
For offline verification, set `BUNDLETOOL_JAR` to the same official jar. Python 3,
Java and curl are required. The gate reads compiled manifests, rejects a Full
package presented as Play, and checks versionCode, release debugging and permissions
before signing. The signed output is checked again before becoming a CI artifact.

After that synchronization, Gradle or Android Studio can build variants directly:

```bash
cd android
./gradlew :app:assembleFullDebug :app:bundlePlayRelease
```

Output paths under `android/app/build/outputs/` are:

- Full debug: `apk/full/debug/app-full-debug.apk`.
- Full release without a keystore:
  `apk/full/release/app-full-release-unsigned.apk`.
- Full release with a keystore: `apk/full/release/app-full-release.apk`.
- Play debug: `apk/play/debug/app-play-debug.apk`.
- Play release: `bundle/playRelease/app-play-release.aab`; this filename alone
  does not tell whether the bundle is signed.

## Asset isolation and verification

Gradle registers `prepareFullOttplayAssets` and `preparePlayOttplayAssets` as
generated asset sources. Every build runs the preparer before the corresponding
asset merge. Each uses an isolated frontend compilation directory and writes a
complete `android/app/build/generated/ottplay/{full,play}/assets` root, including
`public`, `capacitor.config.json` and `capacitor.plugins.json`.

All app source-set asset directories are excluded, including the old
`android/app/src/main/assets/public`. A previous Full build therefore cannot be
overlaid into Play. Missing frontend files, an incorrect application ID, invalid
plugin metadata or a failed generator stop packaging. The preparer also verifies
the exact Play provider inventory, frontend identity and ES5 scripts.

Shared player assets use an explicit list: `styles/player.css`, language packs (`locales/*.js`)
and, in Full only, the startup `images/player-logo.png`. Play excludes the startup image and
its matching `favicon.ico`, removes their rendering/request code, and does not
replace them with another logo. Adding an image to `images/` does not
automatically include it in a package. Staging removes old output first; the
package audit rejects additional player images and a Play build containing either
legacy logo file or references to it. Full retains its dynamically loaded provider
logos; Play does not bundle or request those logos.

Verify an already-built package independently:

```bash
node scripts/verify-android-distribution.cjs android/app/build/outputs/apk/full/debug/app-full-debug.apk full
node scripts/verify-android-distribution.cjs android/app/build/outputs/bundle/playRelease/app-play-release.aab play
python3 tests/test_android_flavor_assets.py
```

The regression test runs the actual Gradle task with incomplete, foreign and stale
fake outputs, then checks the actual Android source sets and task dependencies.
It uses the installed Gradle/Android dependencies in offline mode and does not
compile an APK or rebuild the frontend. Device playback, permissions, background
audio and UI behavior still require device validation for each product.

## Signing and releases

Debug APKs use the local Android debug certificate and are suitable for local
testing. Debug certificates from different machines may differ; they are not a
stable production upgrade identity.

For production Full sideloads, keep a stable Full release keystore. Set
`KEYSTORE_FILE`, `KEYSTORE_PASSWORD`, `KEY_ALIAS` and `KEY_PASSWORD` in the build
environment. Store key material outside the repository and preserve a secure
backup. A new signing key cannot silently replace an installed release signed by
a different key.

Gradle's `KEYSTORE_*`/`KEY_*` release signing settings apply only to Full. Play
release AABs always leave Gradle unsigned, even when the Full key is configured.
Both debug variants retain their normal Android debug signing configuration.

The dedicated Play signer uses the upload key provisioned in the repository's CI
secrets. That configuration does not register the key with Google Play. Play
Console registration and App Signing enrollment have not been independently
verified here. Before the first submission, confirm the app record, complete
enrollment and register the intended upload certificate. Once enrolled,
Google Play App Signing manages the certificate used for installed Play applications. The
Full release certificate and Play upload key serve separate products and should
not be interchanged. Do not substitute a debug certificate for either release
path. Store enrollment, listing details, privacy declarations, content rights and
review remain separate from a successful build.

The general release workflow publishes two required unsigned Android artifacts:

- `ottplay-foss-android-unsigned.apk` is Full; the established filename is retained
  for download compatibility.
- `ottplay-foss-android-play-unsigned.aab` is Play.

Both packages must exist and pass the distribution audit before release upload.
The release stays a draft if either build fails. These unsigned outputs cannot be
installed or submitted to Play as-is; use the appropriate signing process. The
dedicated Play bundle workflow handles the separate signed Play build.

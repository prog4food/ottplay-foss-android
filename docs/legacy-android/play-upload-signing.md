> **Archived Capacitor Android reference.** This document describes the retired wrapper before extraction. Its Android build/signing commands no longer run in this repository. Native Android development is in [ottplay-android](https://github.com/open-ott-play/ottplay-android), currently a private preview requiring repository access. These notes do not describe that application.

# Build a Google Play upload bundle

The **Android Play upload bundle** workflow builds an AAB from the selected `main` commit, signs it with the project's Play upload key, and saves it as a GitHub Actions artifact. It does not register an app, contact Play Console, publish a release, or install anything. Run it manually after the signing secrets have been configured.

The Play application identity is `play.ott.foss.play`; the separate Full sideload product keeps `play.ott.foss`. Check `android/app/build.gradle` for the version name and version code before each upload; Play requires a version code that has not already been used for that app. The current target SDK is defined in `android/variables.gradle`.

## Upload key and app signing key

With [Play App Signing](https://developer.android.com/studio/publish/app-signing), the upload key authenticates the AAB submitted to Google. Google signs delivered APKs with the app signing key. These can be different keys. An upload-signed AAB is not a directly installable APK and does not establish that the app is registered or approved by Play.

Keep the upload key stable and backed up outside CI. Do not generate a replacement for an existing registered key without following Play's upload-key reset process. This workflow neither generates nor rotates production keys. The ephemeral keys used by its tests are disposable fixtures and must never be used for distribution.

Direct APK distribution has a separate signing/upgrade contract. The general release pipeline produces unsigned Full APK and Play AAB artifacts. Gradle `KEYSTORE_*` settings apply only to Full; Play release bundles remain unsigned until this dedicated upload signer processes them. Full and Play have separate package identities and signing contracts. An APK signed with the upload key may not update a Play-installed copy signed with a different app signing key.

## Required GitHub Actions secrets

Configure these four repository secrets only after the intended key is chosen:

- `PLAY_UPLOAD_KEYSTORE_BASE64`: the complete keystore encoded as a single base64 value.
- `PLAY_UPLOAD_STORE_PASSWORD`: the keystore password.
- `PLAY_UPLOAD_KEY_ALIAS`: the intended private-key entry alias.
- `PLAY_UPLOAD_KEY_PASSWORD`: that entry's password.

No Play service-account credentials are needed because upload remains manual. Never commit a keystore, passwords, or encoded secret values. Do not paste them into workflow inputs or logs.

In Actions, select **Android Play upload bundle**, choose `main`, and run the workflow. The signed AAB is in `ottplay-play-upload-<commit SHA>` for seven days, named `ottplay-foss-android-play-upload.aab`. Download the artifact and submit its AAB through the intended Play Console testing/release track. The signature certificate SHA-256 is printed after successful verification so it can be compared with the registered upload certificate.

The signer accepts only `.aab` paths inside the current workspace (including resolved symlink targets). Upload aliases must start with a letter or digit and contain only letters, digits, dots, underscores, or hyphens.

Missing or invalid secrets, an unavailable alias, or a signature failure stop the signing step; no unsigned fallback is uploaded. The decoded key exists only in a private temporary directory during signing and is removed on success or failure. Passwords reach JDK tools through environment references rather than command-line values.

## Verification

Signing uses the JDK's [jarsigner](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jarsigner.html). A separate JDK verifier reads every payload entry, verifies its signature, and compares its signer with the certificate exported from the intended keystore alias. This rejects unsigned bundles, unsigned additions, changed payloads, and a different signer; a successful `jarsigner` exit alone is insufficient.

Run the real cryptographic contract tests with Java 17 or newer and Python 3:

```sh
python3 -m unittest discover -s tests -p test_play_upload_signing.py -v
```

These tests sign minimal ZIP fixtures with disposable keys. They verify the signing contract, not Android compilation, Play policy compliance, device installation, or store acceptance. The manually dispatched workflow builds `:app:bundlePlayRelease`, audits the actual Play package identity, provider inventory, resources and manifest before signing, then repeats the artifact audit after signing. These gates do not establish content rights or store approval. See [Android distribution details](android-distributions.md) and [remaining submission steps](play-submission.md).

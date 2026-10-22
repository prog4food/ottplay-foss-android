# Capacitor Android

This project packages the current shared TypeScript player as a **Full Capacitor
APK**, with application ID `play.ott.foss`, for Android 7 (API 24) and later.
It is separate from the Kotlin/Compose application in
[ottplay-android](https://github.com/open-ott-play/ottplay-android).

Use Node 22, Java 21, Android SDK 36 and Build Tools 36.0.0:

```sh
npm ci
npm run android:full          # debug APK
npm run android:full:release  # unsigned release APK, unless KEYSTORE_FILE is set
npm run cap:android          # Android Studio
```

The build synchronizes native plugins, generates isolated assets from the current
frontend, then audits the final APK. Do not use `cap copy android` or copy an old
`dist-mobile` tree into the application. `android/version.json` is the input for
native version metadata; release CI projects the frozen version plan into it.

Beta and RC builds publish `ottplay-foss-android-full.apk`, signed with the existing
Full certificate. Stable promotes the verified RC bytes. iOS remains part of the
same release pipeline. Play Store AAB publication belongs to the native repository.

The maintained XMLTV plugin lives in
`mobile-xmltv-epg/src/android/play/ott/foss/plugin/MobileXmltvEpgPlugin.kt` and is
included directly in the Gradle source set. Do not add another copy.

See [Android distributions and remote updates](../docs/android-distributions.md).

## Optional Home startup

`play.ott.foss/.HomeActivity` is an alias of `MainActivity`, disabled by default.
It allows an operator to select OTTPlay as the Android Home app on a dedicated
player. This makes the physical Home button return to OTTPlay as well as allowing
Android to open it at startup. It adds no boot receiver or background service.
Installing an APK does not enable or select this mode automatically.
The explicit native `play.ott.foss/.HomeSetupActivity` screen enables the alias
after confirmation and opens Android's Home selector. This works without asking
the ADB shell to change another application's component state.

Follow the [setup, rollback and hardware verification procedure](../docs/android-distributions.md#optional-startup-as-the-android-home-app)
or the [Russian instructions](../docs/android-autostart-RU.md). Keep the existing
launcher installed, record its exact component and use the normal signed update
path to preserve player data. Source/build checks alone do not verify startup on
vendor firmware; record reboot and cold-start results separately from manual
launch tests.

## Android 5.1 compatibility APK

`npm run android:api22:release` builds the same Full interface and native plugins
using the isolated, lockfile-pinned Capacitor 6 runtime. It writes
`app/build-api22/outputs/apk/full/release/app-full-release-unsigned.apk`.
The modern `android:full:release` output remains in `app/build/`.
`npm run android:api22` builds a debuggable device-test package.
Both targets use the same Java 21 / SDK 36 build tools. API 22 uses compatible
AndroidX, Media3 and OkHttp versions plus core library desugaring. Keep the two
build roots separate and test changes on a real API 22 device.

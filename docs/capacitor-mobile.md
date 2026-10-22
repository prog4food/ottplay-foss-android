# Capacitor mobile

The shared player is packaged for iOS and Android in this repository. See
[Android distributions](android-distributions.md) for APK builds and OTT updates.
The Kotlin/Compose Android application remains a separate project.

## Build and open

Install the Node version used by CI, npm dependencies and Xcode. Then run:

```bash
npm ci
npm run build:ios
npm run cap:ios
```

`build:ios` builds and audits `dist-mobile`, syncs only iOS, then audits the copied
runtime. `build:mobile` is a compatibility alias for `build:ios`; `cap:copy` and
`cap:sync` also target iOS explicitly. Android uses the separate `android:full` and `android:full:release` commands. `build-ios-local.sh` and `build-ios-sim-local.sh` remain available;
see [local build scripts](local-build-scripts.md).

## Configuration and native behavior

`capacitor.config.ts` defines both containers. The app uses the same provider,
settings, channel-list and playback logic as the shared player. Native Swift plugins
supply command-queue HTTP control, authenticated stream proxying, XMLTV cache and
native media/PiP integration. HTTP remote control remains off until explicit opt-in.

The iOS target requests landscape orientation and background audio. Tablet windowing
may override orientation. Device signing, background playback, real streams and
physical-device PiP require device validation; unsigned CI compilation alone does
not establish those behaviors.

Use [the device checklist](mode-b-device-smoke.md) and
`./scripts/smoke-capacitor-device.sh --check-native --check-ios-tools` for setup.
`--build-sync` builds iOS; `--open-ios` opens Xcode. Queue probing remains available
for existing legacy installations. `--open-android` opens the Capacitor Android project in Android Studio.

## Native bridge tests

The [Android project](../android/README.md) is compiled and its APK is audited in
native CI. JVM regression tests additionally exercise bridge behavior without a
device. Physical playback, system dialogs and Fire OS behavior need device tests.

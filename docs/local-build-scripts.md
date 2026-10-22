# Local build scripts (Mac)

These scripts build and install OttPlay FOSS locally on macOS: **Tauri** for
desktop and **Capacitor** for iOS.

| Script | What it does |
| --- | --- |
| `./build-local.sh` | `npm ci` → Tauri release build → quit app → clear Tauri/WebKit caches → install `/Applications/OttPlay FOSS.app` → `open` |
| `./run-tauri-local.sh` | Alias for `build-local.sh` |
| `./build-ios-local.sh` | Capacitor unsigned device IPA → `dist/ios/` (sideload; no paid Apple Developer needed) |
| `./build-ios-sim-local.sh` | Capacitor build for Simulator → boot → install → launch |

Common flags: `--clean`, `--update-deps`. iOS also supports `--dev`. iOS sim: `--device 'iPhone 16'` or `IOS_SIM_DEVICE=…`.

Tauri: `./build-local.sh --no-open` to skip launch.

After the build, `build-local.sh` / `run-tauri-local.sh` quit running `ottplay-tauri` and delete `~/Library/Caches/com.ottplay.foss`, `~/Library/WebKit/com.ottplay.foss`, plus `ottplay-tauri` and instance variants (`com.ottplay.foss.2`, …). Application Support (`~/Library/Application Support/com.ottplay.foss`, feedback.log, window-state) is left alone.

**Note:** Player settings/providers live in **WebKit localStorage** under `~/Library/WebKit/com.ottplay.foss`, not Application Support. Wiping that WebKit tree (as these scripts do, or manually) resets M3U URLs and other in-player settings. Prefer quitting the app and clearing only `WebsiteData/NetworkCache` under that tree if you need a cache bust without losing settings.

`build-local.sh` / `run-tauri-local.sh` pass `--bundles app` so Tauri skips DMG packaging (unreliable in some CI/agent environments). The `.app` under `target/release/bundle/macos/` is what gets copied to `/Applications`.

Build the Full Capacitor APK with `npm run android:full:release` using Java 21 and Android SDK 36. See [Android build instructions](../android/README.md). Play Store AABs and the independent Kotlin app remain in [ottplay-android](https://github.com/open-ott-play/ottplay-android).

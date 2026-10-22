> **Scope after Android extraction:** build/sync/open checks here target iOS. Android sections are historical runtime checks for already installed Capacitor builds; the standalone [native Android app](https://github.com/open-ott-play/ottplay-android) has its own checks and currently requires private-repository access.

# Capacitor device smoke (Mode B)

Repeatable **iOS Simulator / Android emulator** (and optional real-device) smoke for Mode B Capacitor.
FOSS closes what can be automated without a specific physical device in CI: build/sync/open helpers,
native project presence checks, and optional authenticated command-queue checks for an explicitly enabled loopback listener.
**A human still marks the UI checklist** on a simulator, emulator, or sideloaded device.

This is **Mode B** (Capacitor / Tauri loopback). Do **not** confuse with Mode A companion smokes
(`./scripts/smoke-modea-companion.sh`, `./scripts/smoke-modea-e2e-play.sh`, etc.) — those need
`ottplay-server` / `local_proxy.py` and are HTTP-only against the companion, not Cap UI.

Related:

- Build / store prep: [`docs/capacitor-mobile.md`](capacitor-mobile.md)
- Command-queue curl: `./scripts/smoke-command-queue.sh`
- Browser baseline: a local or self-hosted web player built from the same revision.
- Thin helper: `./scripts/smoke-capacitor-device.sh`

## What is automated vs human

| Step | Automated? | Notes |
| --- | --- | --- |
| Tools present (`node` / `npm`; optional `xcrun` / `adb`) | Yes (helper) | Soft unless `--require-*` |
| `ios/` directory after sync | Yes (helper) | Project presence only |
| `npm run build:mobile` / `npm run cap:sync` | Optional (helper flags) | Local; flaky in headless CI if Xcode/SDK missing |
| Open Xcode | Optional (`--open-ios`) | Human continues in IDE |
| Optional command-queue HTTP POST/GET | Only after explicit opt-in | HTTP is off by default; separate token-authenticated check, never required for normal playback |
| UI: queue drain / EPG / M3U play / Stalker / swop | **Human** | Simulator, emulator, or real device |
| Paid TestFlight / Play upload | **Out of scope** | Unpaid: sim + sideload APK / free Apple ID only |

## Prerequisites (unpaid store)

Paid Apple Developer / Play Console accounts are **not** required for this smoke.

### iOS (Simulator or local device)

- macOS + Xcode 15+ (Simulator)
- Node.js >= 18, CocoaPods
- Free Apple ID is enough for Simulator and limited personal-team device runs
- **No** TestFlight / App Store Connect upload required here (see store readiness in `capacitor-mobile.md`)

### Android (emulator or sideload)

- Android Studio (or SDK + emulator) **or** a physical device with USB debugging
- Node.js >= 18, `$ANDROID_HOME` when using SDK CLI
- Install **unsigned / debug APK** via Android Studio Run or `adb install` — **no** Play Console

### Optional real device

- Same UI checklist as simulator/emulator
- Optional authenticated HTTP test only: forward the explicitly enabled listener’s selected port on Android USB
- iOS Simulator shares Mac localhost — no forward needed
- Physical iOS device: internal queue checks use the native bridge. Do not expose its optional loopback listener to other hosts

## Build + sync + open

```bash
npm install
npm run build:mobile          # build, audit and sync iOS
npm run cap:ios               # open Xcode (macOS)
# Android builds now live in open-ott-play/ottplay-android (private preview).
```

Or via helper (best-effort; does not boot simulators by itself):

```bash
./scripts/smoke-capacitor-device.sh --help
./scripts/smoke-capacitor-device.sh --check-native
./scripts/smoke-capacitor-device.sh --build-sync
./scripts/smoke-capacitor-device.sh --open-ios      # or --open-android
```

In Xcode: pick an iPhone Simulator → Run.
In Android Studio: pick an AVD (or USB device) → Run.
Wait until the player UI loads. `MobileCommandQueue.start()` starts the internal queue without a listening socket.

## Optional authenticated command-queue check

HTTP control is disabled by default. A normal launch and smoke run must work with no listener, no token, and no port forwarding. Native `post({data,deviceId})` / `get({deviceId})` calls exercise the internal queue.

After enabling **Settings → Remote control → Local HTTP remote control**, supply the displayed device code through `QUEUE_HTTP_TOKEN` and the selected loopback `BASE_URL`. Never commit or print the token. The script does not enable the listener.

```bash
# No HTTP requirement: normal project smoke.
./scripts/smoke-capacitor-device.sh
# Optional check: QUEUE_HTTP_TOKEN and BASE_URL are already set securely.
./scripts/smoke-capacitor-device.sh --queue --require-queue
```

The optional contract test enqueues and drains commands, so use a dedicated `DEVICE_ID`; the player polls the broadcast queue and its own UUID queue. Without a token, `--queue` soft-skips and `--require-queue` reports missing opt-in configuration. See [the native queue contract](../mobile-command-queue/README.md).

## Manual UI checklist (human marks)

Run on **iOS Simulator and/or Android emulator** (optional: real device). Skip rows that need credentials you do not have; note the skip honestly.

### A. Launch + shell

- [ ] App launches without native crash; web UI paints
- [ ] Settings open (F2 / equivalent / on-screen)
- [ ] Device ID visible under Player / Remote settings (optional note)

### B. Internal command queue

- [ ] Normal launch works without an HTTP listener or token.
- [ ] Native bridge `post({data,deviceId})` / `get({deviceId})` enqueue and drain a dedicated test queue.
- [ ] If explicitly testing HTTP opt-in: every request requires Bearer authentication and the selected endpoint is loopback only; record this separate test.

### C. EPG / XMLTV (Cap `MobileXmltvEpg`)

- [ ] Configure a public or operator XMLTV/EPG source you are allowed to use (no secrets in repo)
- [ ] Channel guide / now-next populates for at least one channel
- [ ] Airplane mode or kill network briefly → stale cache still serves if previously warm (honest offline path)

### D. M3U / media play

- [ ] Add an M3U provider (playlist URL you control or a public test list)
- [ ] Channel list loads
- [ ] Start playback on one stream (HLS / progressive as available)
- [ ] Pause / resume; volume or wake-lock behavior sanity-check
- [ ] Android DASH: select Shaka on a device/stream that supports WebView DASH; verify the OTT pause/seek/mute controls and channel-list preview use the same player, with no ExoPlayer overlay. Unsupported codecs remain unsupported.
- [ ] Android second-channel PiP: open a different channel, verify its muted picture and configured corner/size, then close it while the main channel keeps playing. The Activity must stay in the foreground.
- [ ] Optional Android system PiP: explicitly invoke `MobileNativeMedia.enterSystemPip()` and restore using OS controls; this must not substitute for the second-channel action.

### E. Stalker portal (FOSS JSON-RPC)

- [ ] Configure portal URL + MAC for a portal that speaks FOSS `stalker_portal/api/` JSON-RPC
- [ ] Handshake + channel list without Mode A companion `:8443`
- [ ] Play one portal-built stream URL
- [ ] **Skip** if no portal URL — mark "skipped: no portal"

### F. `host_ott` / swop dealer-cloud

- [ ] With `host_ott` / `host_ott_proto` set, Enter Provider Code (remote) or cloud send/load reaches `swop/a.php` via native shim (no CORS failure)
- [ ] **Skip** if no `host_ott` — mark "skipped: no host_ott"
- [ ] Mag `load.php` classic handshake is **not** expected in FOSS (allowlist only) — do not fail Cap smoke for Mag JsHttpRequest gaps

### G. Optional Mode A companions (do not mix into Mode B pass/fail)

Only when you also run a Mode A companion for comparison:

```bash
# Separate stack — not Cap UI
./scripts/smoke-modea-companion.sh
./scripts/smoke-modea-e2e-play.sh
```

Record Mode A results separately. Cap device smoke **passes** without Mode A.

## Helper script exit codes

`./scripts/smoke-capacitor-device.sh`:

| Code | Meaning |
| --- | --- |
| `0` | Checks passed (queue soft-skip counts as pass unless `--require-queue`) |
| `1` | Hard failure (missing required tool/dir, build/sync failed, queue required but down) |
| `2` | Queue smoke ran but contract assertion failed |
| `3` | Usage / unknown flag / missing baseline deps (`node`/`npm`/`curl` when needed) |

## Honest remaining human work

- Marking the UI checklist above on sim/emulator/device
- Any portal / playlist / `host_ott` credentials (operator-owned; never commit)
- Paid TestFlight / Play Console upload (store readiness docs only)
- Host HTTP access to a physical iOS device’s optional loopback queue
- Headless CI that boots Xcode Simulator / Android emulator (intentionally not required here — flaky and account/SDK heavy)

When the human checklist is done for your targets, the Mode B **device smoke** gap is closed for FOSS; DRM and Mag JsHttpRequest remain separate Remaining items in `capacitor-mobile.md`.

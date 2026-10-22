# Tauri desktop smoke (Mode B)

> **Mode B desktop (Tauri).** Sibling of Cap device smoke (`docs/mode-b-device-smoke.md`).
> Debug webview often uses `OTTPLAY_WEB_URL=http://127.0.0.1:8443/`.
> Native PiP: always-on-top `play_pip` / `stop_pip` / `set_pip_bounds`. Unpaid/unsigned OK.
> Helper: `./scripts/smoke-tauri-desktop.sh` - does **not** assert headed play/PiP.

Repeatable **macOS / Windows / Linux** smoke for Mode B Tauri desktop.
FOSS closes what can be automated without a headed GUI in CI: toolchain checks,
`src-tauri/` presence, optional unsigned compile, optional companion curl on `:8443`,
and optional authenticated command-queue curl for an explicitly enabled loopback listener.
Normal playback uses internal IPC; HTTP control is off by default.
**A human still marks the UI checklist** on a desktop window (debug or built app).

This is **Mode B desktop** (Tauri). Do **not** confuse with Mode A companion smokes
(`./scripts/smoke-modea-companion.sh`, `./scripts/smoke-modea-e2e-play.sh`, etc.) — those need
`ottplay-server` / `local_proxy.py` and are HTTP-only against the companion, not Cap/Tauri UI.

Related:

- Updater / unsigned local build: [`docs/tauri-updater-notarize.md`](tauri-updater-notarize.md)
- Cap device sibling: [`docs/mode-b-device-smoke.md`](mode-b-device-smoke.md)
- Browser baseline: a local or self-hosted web player built from the same revision.
- Thin helper: `./scripts/smoke-tauri-desktop.sh`

## Auto playback in Tauri

The streaming player menu includes `auto` (value 3) in Tauri. Existing explicit
`html5`, `hls.js` and `shaka` preferences keep values 0, 1 and 2. Auto is the default
only for a Tauri provider without a saved player preference; existing HTML5 users
select Auto once and save. Server/browser and Capacitor defaults are unchanged.

Auto starts `.m3u8` URLs with native HLS where supported, using hls.js immediately
on platforms without native HLS. `.mpd` URLs use Shaka; progressive MP4 and other
URLs retain the native path. Query strings and fragments do not affect matching.
Working native video incurs no extra manifest/segment probe.

A native decode/unsupported-source error switches that playback to hls.js once.
WebKit can instead report successful audio-only playback for HEVC inside MPEG-TS,
even with nonzero video dimensions. Auto checks actual audio/video tracks rather
than treating those dimensions as evidence of video playback.
After that state persists for 1.5 seconds, Auto uses a detached hls.js instance to
inspect one fragment, with an 8-second deadline. It switches only when parsed
tracks prove video is present. Radio and inconclusive probes keep HTML5 and renew
the source once, because some proxies invalidate their previous session when a
second client reads the master playlist. A radio stream may briefly reconnect.
Archive/VOD position and the user's pause intent survive the handoff. Stop,
channel changes and a new mode invalidate pending decisions. The same watcher
is used by main playback and the dedicated PiP document.

Use `node tests/test_tauri_auto_playback.cjs` and
`node tests/test_tauri_pip_window.cjs` for deterministic lifecycle regressions.
Runtime acceptance should also exercise H.264/AAC native HLS, HEVC/AAC MPEG-TS,
audio-only HLS and progressive MP4 in the target WebView; unit tests do not prove
decoder support on another operating system.

The video footer measures HLS bitrate from bytes and media duration of the last
eight completed main-stream segments, including muxed audio and container
overhead. hls.js also measures LL-HLS parts. It does not display download bandwidth
or trust manifest BANDWIDTH. All footer refreshes use the same renderer.

WKWebView does not supply a usable decoded-byte counter for native HLS. For HTTP(S)
`.m3u8` playback (including portal URLs with `extension=m3u8`), the main Tauri
window therefore starts a temporary loopback relay. Query-selected HLS keeps its
signed upstream URL intact; the native decoder receives the loopback playlist
instead of making an HTTP request that macOS App Transport Security can block.
Only requests made by the player fetch upstream media; polling statistics uses
local IPC. Playlists retain their durations and media requests are streamed to the
native decoder. Only completed main segments enter the rolling measurement;
audio renditions, initialization data, retries and incomplete responses do not.
The Auto codec probe uses the same transport. Stop, channel changes, engine
fallback and main-page navigation dispose of the old session.

A transport initialization or playback error retries the original URL directly
once, preserving pause intent and archive position. Unsupported playlist extensions
and HTTP authentication challenges use that direct path. When no reliable media
sample or native byte counter is available (including native LL-HLS parts alone),
the footer shows resolution without Mbps. Run `node tests/test_stream_bitrate.cjs`
and `cargo test --locked -p ottplay-tauri native_hls` for measurement and lifecycle
regressions; verify native decoding and the visible footer in the target WebView.

## What is automated vs human

| Step | Automated? | Notes |
| --- | --- | --- |
| Tools present (`node` / `npm`; optional `cargo` / `rustc`) | Yes (helper) | Soft unless `--require-cargo` |
| `src-tauri/` present | Yes (helper) | Scaffold presence only |
| `npm run build` / `npx tauri build --ci` | Optional (`--build`) | Unsigned CI build inside `src-tauri/` |
| Companion curl on `:8443` | Optional (helper flags) | Soft-skip if not up unless `--require-companion` |
| Optional command-queue HTTP POST/GET | Only after explicit opt-in | Token required; never a normal playback prerequisite |
| UI: window launch / paint / play / PiP | **Human** | Debug or built desktop app |
| Paid notarize / code signing | **Out of scope** | Unpaid: unsigned / local debug OK |

## Prerequisites (unpaid signing OK)

Paid Apple Developer / notarization / Authenticode are **not** required for this smoke.

- **macOS**: Node.js >= 18; Rust toolchain (`cargo` / `rustc`) for build; Xcode Command Line Tools for Tauri system deps
- **Windows**: Node.js >= 18; Rust toolchain; Visual Studio Build Tools
- **Linux**: Node.js >= 18; Rust toolchain; system libs (`webkit2gtk`, `libssl`, etc. per Tauri docs)

No Xcode, Android Studio, CocoaPods, `adb`, or Cap/iOS/Android SDK required.

## Build / run

```bash
npm install
npm run build                  # vite production build
npm run tauri dev              # debug window
npm run tauri build            # unsigned release build
```

Or via helper:

```bash
./scripts/smoke-tauri-desktop.sh --help
./scripts/smoke-tauri-desktop.sh --check-src-tauri
./scripts/smoke-tauri-desktop.sh --build
./scripts/smoke-tauri-desktop.sh --check-companion
./scripts/smoke-tauri-desktop.sh --check-queue
```

Set `OTTPLAY_WEB_URL=http://127.0.0.1:8443` for debug webview pointing at a local Mode A companion.

## Channel list formatting under native CSP

The packaged Tauri page adds a nonce to its style policy. Dynamically inserted
HTML style attributes are therefore blocked, even when the same HTML renders
correctly on the HTTP companion. The shared channel renderer uses external CSS
classes and explicit DOM style properties for trusted layout and theme values.
Provider descriptions still pass through metadata sanitization; the Tauri CSP
and its script/style nonce handling remain enabled.

After building the emitted bundles, run the browser regression in both Chromium
and WebKit:

```bash
npx playwright install chromium webkit
npm run test:native:ui
```

Check programme accents, channel logos, archive markers, progress bars, selection,
and programme details with the same settings and EPG data in both targets.
The browser test enforces the packaged style policy; JSDOM renderer tests alone
do not enforce CSP. Also check the installed native app after replacement.

## Automated companion curl

When a Mode A companion is listening on `:8443`:

```bash
./scripts/smoke-tauri-desktop.sh --check-companion
./scripts/smoke-tauri-desktop.sh --check-companion --require-companion   # fail if down
```

Soft-skip is intentional when the companion is not running — CI without a local companion should not hard-fail.

## Optional authenticated command-queue check

Normal Tauri launch uses internal command IPC with no HTTP listener. Test that default first; do not enable HTTP simply to make a smoke pass.

Enable **Local HTTP remote** in player settings to generate a device code. Settings call `queue_http_configure` with `{enabled: true, token: deviceCode}`; startup environment variables cannot enable the listener. Use the device code as the Bearer token in your local proxy. Disabling the option closes the listener and its connections, clears pending commands, and revokes the active code. The listener binds loopback only, prefers port 18081, and falls back through 18090; `OTTPLAY_QUEUE_PORT` pins a port. `queue_port` reports the live `httpEnabled`, `running`, and `port` status.

```bash
# No token means an intentional soft-skip, without an HTTP request.
./scripts/smoke-tauri-desktop.sh --check-queue
# Only for a deliberately enabled listener, with QUEUE_HTTP_TOKEN already set securely:
./scripts/smoke-command-queue.sh --discover --backend tauri
./scripts/smoke-tauri-desktop.sh --check-queue --require-queue
```

The helper also accepts `OTTPLAY_QUEUE_HTTP_TOKEN`; `QUEUE_BASE_URL` chooses a specific loopback origin instead of discovery. It does not start the listener. The optional contract test enqueues and drains commands, so set a dedicated `DEVICE_ID` to avoid draining the player’s broadcast queue. Never commit or print the token.

## Manual UI checklist (human marks)

Run on **macOS / Windows / Linux** desktop window. Skip rows that need credentials you do not have; note the skip honestly.

### A. Launch + shell

- [ ] App launches without native crash; web UI paints
- [ ] Settings open (F2 / equivalent)
- [ ] Window title / size / position behave normally
- [ ] With menus closed, press `L` to enter fullscreen, then `L` again to restore the original window size without clicking or opening Menu
- [ ] Repeat `L` → `Escape` several times; Escape exits fullscreen without opening the app-exit dialog, and the next key still reaches the player
- [ ] Repeat after clicking the video and after opening/closing Menu; keyboard behavior must not depend on the overlay
- [ ] On macOS Tahoe, enter fullscreen with dark video or black letterboxing: all four outer screen edges must be free of a gray 1px window rim, including after switching focus away and back
- [ ] Exit fullscreen: the normal window shadow returns; repeat `L` → `L` and `L` → `Escape` without losing the original size or keyboard focus

On macOS, this checks native WebView focus as well as fullscreen geometry.
Tao changes the window style when entering/exiting simple fullscreen and can
make its container NSView the first responder. The fullscreen command must
restore focus to the WebView on the macOS main dispatch queue after the deferred
style update; otherwise exit can steal focus again. A DOM keyboard test or
focusing only the native window does not verify this behavior.

Simple fullscreen must also disable the native window shadow. macOS Tahoe
includes a gray edge in that shadow even when the window fills the screen;
changing CSS borders does not remove it. Restore the shadow after returning
to windowed mode. See [SDL's corresponding fix](https://github.com/libsdl-org/SDL/pull/15005).

### B. Playback

- [ ] Add an M3U provider (playlist URL you control or a public test list)
- [ ] HTTP localhost playlist (e.g. `http://127.0.0.1:8090`) loads channels in Tauri Mode B (shim → `proxy_fetch`; not empty 0/0/0)
- [ ] Channel list loads
- [ ] Start playback on one stream (HLS / progressive as available)
- [ ] Pause / resume; volume or wake-lock behavior sanity-check
- [ ] With a valid interface language already loaded, run two `ott PLAYER standby` → `ott PLAYER go` cycles in the same window without reload; repeat for manual and system language modes. Confirm standby drains to `suspended` with `pending: 0`, then the same provider/profile/item resumes with advancing playback; no language settings reopen, and each navigation key produces one action.

### C. PiP (native)

- [ ] Start playback, trigger native PiP (`play_pip`)
- [ ] Window becomes always-on-top compact player
- [ ] Stop PiP (`stop_pip`) returns to normal window
- [ ] Resize / move via `set_pip_bounds` if exercised

### D. EPG / XMLTV

- [ ] Configure a public or operator XMLTV/EPG source you are allowed to use (no secrets in repo)
- [ ] Channel guide / now-next populates for at least one channel
- [ ] Cold start: after playlist names appear, list rows / podval now-next / EPG menu fill once XMLTV warm finishes (startup preload + `epg-cache-ready`; not permanently empty)
- [ ] Airplane mode or kill network briefly → stale cache still serves if previously warm (honest offline path)

### E. Stalker portal (FOSS JSON-RPC)

- [ ] Configure portal URL + MAC for a portal that speaks FOSS `stalker_portal/api/` JSON-RPC
- [ ] Handshake + channel list without Mode A companion `:8443`
- [ ] Play one portal-built stream URL
- [ ] **Skip** if no portal URL — mark "skipped: no portal"

### F. `host_ott` / swop dealer-cloud

- [ ] With `host_ott` / `host_ott_proto` set, Enter Provider Code (remote) or cloud send/load reaches `swop/a.php` via native shim (no CORS failure)
- [ ] **Skip** if no `host_ott` — mark "skipped: no host_ott"
- [ ] Mag `load.php` classic handshake is **not** expected in FOSS (allowlist only) — do not fail smoke for Mag JsHttpRequest gaps

### G. Optional Mode A companions (do not mix into Mode B pass/fail)

Only when you also run a Mode A companion for comparison:

```bash
# Separate stack — not Tauri UI
./scripts/smoke-modea-companion.sh
./scripts/smoke-modea-e2e-play.sh
```

Record Mode A results separately. Tauri desktop smoke **passes** without Mode A.

## Helper script exit codes

`./scripts/smoke-tauri-desktop.sh`:

| Code | Meaning |
| --- | --- |
| `0` | Checks passed (queue/companion soft-skip counts as pass unless `--require-*`) |
| `1` | Hard failure (missing required tool/dir, build failed, queue/companion required but down) |
| `2` | Queue/companion smoke ran but contract assertion failed |
| `3` | Usage / unknown flag / missing baseline deps (`node`/`npm`/`curl` when needed) |

## Honest remaining human work

- Marking the UI checklist above on desktop window
- Any portal / playlist / `host_ott` credentials (operator-owned; never commit)
- Paid notarize / code signing (store readiness docs only)
- Headless CI that runs a headed Tauri window (intentionally not required here — flaky without xvfb/headless GL)

When the human checklist is done for your targets, the Mode B **desktop smoke** gap is closed for FOSS; DRM and Mag JsHttpRequest remain separate Remaining items in `tauri-updater-notarize.md`.

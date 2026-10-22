# Device detection and emulator testing

Device selection happens twice: in `index.html` before the bundle loads, then
in `src/app/device.ts` inside the classic bundle. Both must select the same
`devices/<device>/device.js`. An explicit `/f/<device>/` path takes precedence over
user-agent and native API signals, including nested `lg/*` and `samsung/*` paths.

## Automated checks

```sh
npm ci --ignore-scripts
npm run test:devices
npm run build
npm run check:bundle
npx playwright install chromium
npm run test:devices:browser
```

On a Linux host that lacks browser dependencies, use
`npx playwright install --with-deps chromium`. CI installs them in the Build job.
The normal `npm test` graph includes the source matrix; `check:bundle` also
executes the actual emitted ES5 detector. The CI inventory checks that both
variants and the browser spec remain reachable from executable workflow steps.

`tests/fixtures/device-detection.json` is shared by VM and browser tests. Each
fixture identifies its source or explicitly says it is synthetic. The NetCast
and webOS examples come from LG documentation; the MAG200 example comes from
the YASEM MAG250/AuraHD emulator profile, not a captured physical STB session.
Add an observed UA and its source here when supporting another device.

The VM checks execute the real boot scripts, detector and adapter, cover every
shipped adapter route, and exercise missing legacy APIs and throwing native
bridge access. Detection must inspect the MAG bridge without invoking it.

Playwright runs the production HTML, classic bundle and staged assets through
a loopback server with the Mode A URL layout. Each fresh browser context checks
the initial boot decision, final device, adapter request, remote codes and real
list navigation through Down, Back and Enter. User-Agent and optional `gSTB`
signals are emulated; HTTP requests outside the test origin and WebSockets are
blocked. No live provider or operator settings are required.

The report is `build/device-browser-report/index.html`. Failed runs retain
screenshots and traces under `build/device-browser-results/`; CI uploads both
directories as `device-browser-failures-<commit>`. For a focused local run:

```sh
npm run test:devices:browser -- --grep 'NetCast|MAG'
npx playwright show-report build/device-browser-report
```

These checks validate detection, loading and the existing adapter key contracts.
Chromium UA emulation does not reproduce a TV's engine version, firmware,
native services, decoder or DRM implementation. ES5 parsing separately protects
the syntax requirements of older engines.

## Magic Remote on a physical LG

The browser tests cover hover, wheel, click and directional-key transitions.
They cannot prove that LG firmware makes its native pointer visible. The player
does not force that pointer on or off. LG switches to directional mode when an
arrow is pressed; shaking the remote switches back to pointer mode.

If the pointer is missing, first compare the LG Home screen with the player and
record whether the player was opened by Media Station X or the TV browser.
Then open **Information → Debug HUD** in the player. This enables diagnostics
for the current page without restarting playback. The LG input line reports
cursor visibility, document focus and input-event counts. Move the remote and
click while watching the counts; `unknown` means no cursor-visibility event has
been received, not that the pointer is hidden. Input diagnostics do not capture
coordinates or typed text and never cancel events or change pointer mode.

See LG's [Magic Remote guide](https://webostv.developer.lge.com/develop/guides/magic-remote)
and [system UI visibility events](https://webostv.developer.lge.com/develop/guides/system-ui-visibility).

## Official LG webOS TV Simulator

The launcher installs the official [LG Simulator](https://webostv.developer.lge.com/develop/tools/simulator-installation)
if missing; it does not install or require the webOS CLI. Automatic simulator installation targets webOS TV 26
on Apple Silicon; other versions and hosts can use a separately installed SDK
via `--sdk`. SDK packages are downloaded from LG, never redistributed here.

Run the hosted app against the existing local stack:

```sh
./scripts/run-webos-simulator.sh
```

The defaults are webOS TV 26 and `http://127.0.0.1:8443/`. The launcher checks
`/health` and the player page, prepares `build/device-webos-simulator`, then
starts the newest compatible installed Simulator with the app directory. It does not start another server, deploy a build or
require local `dist/` files. The player uses the build already deployed to the
stack. Port 8090 belongs to the playlist proxy, not the player.

To install prerequisites without launching the player:

```sh
./scripts/setup-webos-simulator.sh
```

The bundled launcher uses only Node.js built-ins and passes arguments without a
shell. Existing simulator registrations and installations are reused when their
files still exist. A missing default SDK is restored automatically; temporary
download files are removed after setup. Setup checks the pinned archive size and
SHA-256 before extraction. `--no-install` disables automatic setup on launch;
setup's `--archive` option accepts an already downloaded official ZIP.

An explicit `--cli /path/to/ares-launch` or `WEBOS_CLI` selects an externally
managed CLI. It is never installed or selected from `PATH` automatically.
Read [CLI dependency security](webos-cli-security.md) before using this override.
The older setup `--cli-only` option is a compatibility no-op because the bundled
launcher needs no npm installation. To select another extracted
Simulator directory:

```sh
./scripts/run-webos-simulator.sh --sdk "$HOME/Applications/webOS_TV_26_Simulator_1.5.0"
```

Use `WEBOS_SDK_PATH` or repeat `--sdk` for subsequent launches from a custom
location. Existing CLI registrations remain readable and are not rewritten.
Keep the SDK in a persistent directory, not `/tmp`. The directory passed to `--sdk` contains the
Simulator `.app` on macOS, rather than being the `.app` itself. Review the vendor
license documents; any license dialogs remain interactive.

Other examples:

```sh
./scripts/run-webos-simulator.sh --version 25 --sdk /path/to/webOS_TV_25_Simulator_1.4.1
./scripts/run-webos-simulator.sh --url http://127.0.0.1:8443/
./scripts/run-webos-simulator.sh --dry-run
./scripts/run-webos-simulator.sh --help
```

`WEBOS_VERSION`, `WEBOS_SDK_PATH`, `WEBOS_CLI` and `OTTP_PLAYER_URL` provide the
same configuration through environment variables. `OTTP_DEVICE_TEST_PORT` is
retained as a loopback URL fallback when `OTTP_PLAYER_URL` is not set. Explicit
`--url` takes precedence. `--dry-run` prepares the app and prints the command
without network checks, downloads or SDK execution. Missing dependencies appear
in the printed setup plan.

The launcher follows LG's
[hosted web app](https://webostv.developer.lge.com/develop/getting-started/web-app-types)
model and redirects to the server root by default, preserving automatic device
detection. You can also select `build/device-webos-simulator` through Simulator's
**File > Launch App**. Use **File > Close App**, then launch again if an existing
app has not picked up a changed target. Storage is origin-specific, so switching
ports can require configuring the test playlist again.

For EPG, the existing companion needs current XMLTV data in its configured
`EPG_URLS` sources. A successful `/health` response does not establish EPG
readiness: check actual programme data and the full guide. Using the same
playlist URL in Chrome and Simulator does not guarantee the same EPG backend;
compare the player's origin and its EPG server setting. Deploy the desired
[Mode A package](mode-a-test-bundle.md) to the stack before checking PR changes.

The separate static server used by Chromium tests is only for detection and
button checks. To deliberately run this narrower manual test:

```sh
npm run build
OTTP_DEVICE_TEST_DIAGNOSTICS=1 node tests/helpers/device-browser-server.cjs
# In another terminal: prepare the SDK app, then launch it through File > Launch App.
OTTP_DEVICE_TEST_PORT=4179 node scripts/prepare-webos-simulator.cjs
```

That static server has no companion APIs: matching returns 405 and `/epg/*`
returns 404. The shell launcher's companion health check intentionally rejects
it. Its opt-in read-only badge shows the actual UA, adapter, remote key codes
and shortcut settings, and its diagnostic log includes EPG route classes and
HTTP status codes without playlist bodies, channel identifiers or query strings.
Diagnostics are disabled in the Chromium CI matrix.

In the [Simulator Inspector](https://webostv.developer.lge.com/develop/tools/simulator-dev-guide),
record `navigator.userAgent`, `ott_device`, `keys.RETURN`, console errors and the
loaded adapter request. Expect `lg/webos`, Back code 461 and
`/devices/lg/webos/device.js`. On a fresh profile, select a language and use the SDK's
RCU Down, Back and OK buttons to check the first-run screen and language chooser.
During playback, LG profiles default Left to action 1 (Menu) and Right to
action 4 (Info). Press Right once for the channel footer, then again for the
current programme details when EPG is available. A third press hides the
information. Without programme details, repeated Right keeps the footer on
its normal timeout instead of opening an empty panel. Check both animation
settings and a guide that arrives after playback starts. Media descriptions
containing only an image must still expand.
webOS defaults Back to action 1 (confirm exit); NetCast and other profiles
retain Back action 0. Other profiles retain Right action 13 (volume up).
On the first LG startup after the Right-key upgrade, a stored Right action 13
(volume up) is changed to action 4 (Info). Other assignments are preserved.
New explicit volume assignments use the signed integer `+13` in the same
`sARfun` key; existing integer readers still read action 13. This distinguishes
a new choice from the old default without a separately persisted marker.
Failed upgrade writes still use Info for that session and retry on the next
startup. Explicit assignments survive reload and settings transaction rollback.
Other profiles retain Left action 14 (volume down) and Right action 13.
Assignments can be changed in **Settings > Button settings**. The guide remains
available from Menu. Fullscreen Plex Left/Right retain ten-second seeking, and
visible menus retain their own arrow navigation.

Exercise both Back delivery paths: a numeric 461 key event and actual browser
history traversal. The adapter retains one same-page history entry, so Back
closes the player menu instead of navigating away. In unobstructed playback,
the default Back action asks for confirmation; an open playback infobar is
hidden first. Cancel must keep the player usable, and confirmation must exit
only once. LG documents this distinction in its
[Back button guide](https://webostv.developer.lge.com/develop/guides/back-button).

Channel switching accepts delivered codes 427/428, Page Up/Down codes 33/34,
and named ChannelUp/ChannelDown or PageUp/PageDown events. Test both directions
on the actual launch shell: LG's
[Magic Remote guide](https://webostv.developer.lge.com/develop/guides/magic-remote)
marks Channel Up/Down unavailable to web apps, so a browser-generated event
does not establish that a physical TV or host forwards those buttons.
On webOS, both **STB settings** and **Interface settings** hide the playback
engine selector. Playback chooses native HLS when supported, Shaka for DASH
manifests, and hls.js when native HLS is unavailable or fails the Auto probe.
Previously saved manual engine choices remain stored for use on other platforms,
but webOS runs Auto. NetCast and other platforms keep their existing choices.
This does not guarantee every codec or DRM scheme: see LG's
[streaming specification](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm)
and [MSE/Shaka playback sample](https://github.com/webOS-TV-app-samples/MediaPlayback).
The manual simulator has ordinary application networking; use a test profile
and explicit test streams when checking playback.

LG's [simulator limitations](https://webostv.developer.lge.com/develop/tools/simulator-introduction)
include different media capabilities and no DRM support. Retain physical TV/STB
acceptance for decoder behavior, stream compatibility, DRM and real remote
events. A successful simulator launch is separate from the automated Chromium
matrix and from physical-device acceptance.

## Android TV and Google TV

Install Java first. Setup and launch install missing [Android command-line tools](https://developer.android.com/tools),
emulator packages, the TV system image and an isolated AVD (virtual device).
The launcher reuses `ANDROID_HOME` / `ANDROID_SDK_ROOT`, or finds a standard
macOS/Linux SDK location, including the Homebrew SDK on Apple Silicon.
Command-line tools are downloaded from Google with pinned checksums on macOS
ARM64/Intel and Linux x86_64. The separate setup step is optional:

```sh
./scripts/setup-android-tv-emulator.sh
./scripts/run-android-tv-emulator.sh
./scripts/run-android-tv-emulator.sh --stop
```

The default is Android TV API 36, the `tv_1080p` hardware profile and the name
`OttplayAndroidTV`. The image uses ARM64 on Apple Silicon and x86_64 on Intel.
`--google-tv` selects the separate Google TV image and `OttplayGoogleTV` name;
use `./scripts/run-android-tv-emulator.sh --google-tv` to install and launch it.
If using the separate setup command, pass the flag there too. Each image needs
substantial disk space: the API 36 Android TV package alone extracts an 8 GB
system image, before writable AVD storage. Install only the variants you need.

Setup and launch leave SDK license prompts interactive. They never accept terms
for you and never overwrite an AVD. A matching existing AVD is retained; a
conflicting image requires a different `--avd` name. Existing SDK packages are reused.
Setup also installs Android platform 36 and build-tools 36.0.0 when missing; the
default launcher uses these with Java 17+ to build its small WebView test app.
An existing AVD keeps its selected image and API version on launch. Missing
packages are restored without replacing the device. `--no-install` disables
automatic installation on launch; `--stop` never installs anything. `--dry-run`
prints the setup/launch plan without downloading or creating a virtual device.
Use `--image`, `--device`, `--avd` and `--sdk` to select another TV configuration.
`--data-size 2048` is the default writable partition size in MB; it is applied
only when creating a new AVD and never resizes an existing profile.
For example, `--image 'system-images;android-35;android-tv;x86_64'` is an Intel
host example, not a way to virtualize x86 through Rosetta on Apple Silicon.

Run without arguments opens the existing hosted player at `http://127.0.0.1:8443/`.
It checks the companion and player page, builds a small test APK with the installed
SDK, boots or reuses the named TV AVD, installs the APK and opens the URL. A browser
is not required: the test app uses the system
[Android WebView](https://developer.android.com/develop/ui/views/layout/webapps/webview).
`--url` or `OTTP_PLAYER_URL` selects another companion URL. `--home` boots/connects
without launching an app. `--url`, `--home` and an explicit APK/activity are separate
launch modes. The script works from any working directory.

The test host sources live under `scripts/fixtures/android-tv-webview/`; its APK
and build cache stay under ignored `build/device-android-tv-player/`. Its anonymous
signing key is shared between checkouts, under `ottplay-simulator/debug.keystore`
in the Android user directory (`ANDROID_USER_HOME`, otherwise `~/.android`). The
builder preserves an existing key from the old build location when migrating it,
so clearing build outputs or switching checkouts does not change the app signature.
The run command builds offline and reuses the APK when sources and tools have not
changed. It does not download APKs or SDK packages.
The test app enables JavaScript and DOM storage, forwards TV navigation keys, and
does not expose a native JavaScript bridge or bypass TLS certificate errors.
Digits and arrows in focused text fields keep native WebView editing behavior;
Enter and Back retain the player's accept/cancel actions.

The APK appends `OttplayTestWebView/1.0` to the standard WebView user agent.
Only this marked Android host gets an `auto` engine setting by default: `.m3u8`
uses hls.js when MSE is supported, `.mpd` uses Shaka, and progressive video uses
HTML5. Existing explicit engine preferences remain selected; choose `auto` once
in settings to replace a saved manual choice. All hosts load the same bundled
hls.js 1.7.3 after the shared ES5 runtime; no CDN or device-specific version is selected. Native
Android bridges and unmarked Android hosts keep their existing engine policy.
The APK and the hosted frontend must both be updated for this behavior.
These engines still use the WebView's media decoder; changing the JavaScript
engine does not establish smooth playback or codec support in an emulator.

Parental PIN input resolves digits through the active device key map, including
screen-button clicks and remote Enter. Regression tests verify one digit per
press and submission after four presses across Android, LG, Samsung, PC, Dune
and MAG maps, in both source functions and the emitted classic bundle.

To test another APK, pass its explicit activity component:

```sh
./scripts/run-android-tv-emulator.sh \
  --apk /path/to/ottplay-native.apk \
  --component play.ott.foss.nativeapp/play.ott.nativeapp.MainActivity
```

The current native Android product is maintained in
[ottplay-android](https://github.com/open-ott-play/ottplay-android); installing
that APK tests its native player, not this repository's JavaScript player.
The default WebView test host exercises this repository's hosted JavaScript player;
it does not implement or validate the native product's media bridge or decoder.
The archived Android fixtures in this repository remain unchanged.

The launcher checks the exact AVD identity before installing an APK or changing
ports. It reuses an already running matching TV with working input settings,
leaves phone emulators alone,
and refuses to take an occupied console port. A new instance uses port 5570;
`--port 5572` can select another free even port. `--stop` only stops the named TV.
Use `--headless` for a windowless instance and `--timeout 300` for a slower boot.
Logs are under `build/emulator-logs/`.

New TV AVDs enable `hw.keyboard` and `hw.dPad`. Run also repairs these two settings
in an existing TV AVD, preserving its other settings and user data. If a running
instance needs this repair, the launcher restarts that exact AVD with a cold boot.
This matters even for the drawn D-pad: the emulator's
[Virtio input implementation](https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/android-qemu2-glue/main.cpp#827)
creates the guest keyboard only when `hw.keyboard` is enabled. A TV profile with
`hw.dPad=yes` and `hw.keyboard=no` can therefore show remote buttons that send no
key events into Android. Dry runs and `--stop` do not repair configuration.

After boot, ADB reverses ports 8443 and 8090 for this emulator only, so the same
`http://127.0.0.1:8443/` player and `http://127.0.0.1:8090/` playlist addresses
reach the host stack. A custom player URL using loopback also reverses its port.
The script does not start that stack. The normal Android
[host alias `10.0.2.2`](https://developer.android.com/studio/run/emulator-networking)
is also available when explicitly configuring guest URLs without ADB reverse.

Both scripts support `--dry-run` and `--help`. Integration tests use fake SDK
commands in temporary directories and cover installation failure, AVD reuse,
paths with spaces, occupied ports, boot timeouts and the exact target of APK,
port-forwarding and stop operations. Default-launch tests cover player preflight,
APK preparation, custom URLs, shell quoting and failure before SDK/app mutation.
The builder tests cover offline packaging, cache invalidation, key reuse across
checkouts and preservation of the previous APK/key after build failure.
A JVM test compiles the actual host and checks its URL, lifecycle, text editing
and key behavior against the real player handlers and key maps. It runs in the
existing Android CI job with Java installed; `npm test` keeps the launcher and
builder tests without requiring a JDK.
Locally, the default launcher was verified on Android TV API 36 ARM64: the hosted
player reached its first-run language screen. Enabling the missing virtual
keyboard restored both the drawn D-pad and host keyboard; native key logs and
selection changes were verified, and the user confirmed both input methods work.
Native-product playback and DRM were not tested. These tests do not boot an
Android OS in CI.

## Samsung TV Web Simulator on macOS

The standalone Samsung TV Web Simulator is an Intel NW.js application. It is
separate from the Tizen TV firmware emulator. The launcher installs the pinned
official package if missing; the separate setup step is optional:

```sh
./scripts/setup-tizen-simulator.sh
./scripts/run-tizen-simulator.sh
./scripts/run-tizen-simulator.sh --app /absolute/path/to/local/index.html
```

Setup downloads Samsung's macOS package 10.0.6, checks its pinned size and
SHA256, validates archive paths, and extracts to
`~/.local/share/ottplay/tizen-tv-simulator/10.0.6`. It neither runs a vendor
installer nor accepts license dialogs. Review the Samsung license documents
included with the package; any acceptance dialog remains a user action.
A working installation is reused. Other existing destinations are never
overwritten. `--destination` and `--cache` select other locations. A newly
downloaded archive is removed after successful extraction unless `--keep-archive`
is set; pre-existing cached archives are preserved. The vendor SDK and its
archive are not committed.

Run accepts `--sdk` or `TIZEN_SIMULATOR_SDK` for an existing Tizen Studio root,
`sec-tv-simulator` directory, or `nwjs.app`. An explicit SDK path must be valid;
automatic installation applies when no override is supplied and the standard
user-local package and `~/tizen-studio` have no simulator. Without arguments it
opens the local player; `--home` opens the simulator home screen. `--app` accepts a local Tizen
app HTML entry point with a valid `config.xml` manifest in the same directory,
using the same
`--file=file:///...` convention as
[Samsung's launcher](https://github.com/Samsung/webIDE-common-tizentv/blob/dev/lib/projectHelper.js).
The launcher rejects a missing manifest before starting the SDK, including with
`--dry-run`; the SDK validates its contents. Use a separate application directory:
the SDK copies the entire directory containing the HTML entry point. A hosted URL,
bare HTML file, or `.wgt` archive is not a local Tizen app entry point. Both scripts
support `--dry-run` and `--help`.

To receive supplemental remote keys, the containing Tizen application's manifest
must include `<tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"/>`.
The Tizen adapter registers these keys individually; an unsupported key does not
prevent startup or registration of the remaining keys. Arrows, Enter and Back do
not require registration. See [Samsung's remote control guide](https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html).

Samsung's [Simulator limitations](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-simulator.html)
exclude hosted applications, DRM and real HLS playback (HLS uses a dummy video).
Consequently this is useful for local UI/API checks; the webOS redirect launcher
on 8443 cannot be reused as a Samsung media compatibility test.

For an **experimental server UI check**, run the launcher without arguments. It
checks the existing companion and player page, generates a small local Tizen app
with the required manifest and redirect, and opens it in the simulator:

```sh
./scripts/run-tizen-simulator.sh
```

The default player URL is `http://127.0.0.1:8443/`; `--url` or `OTTP_PLAYER_URL`
overrides it. The launcher resolves its files relative to the script, so it also
works when invoked by an absolute path from another directory. `--dry-run` prepares
the app and prints the command without checking the server or opening the SDK.
Use `--home` for the simulator home, or `--app FILE` for another local app; these
options are mutually exclusive with `--url` and ignore `OTTP_PLAYER_URL`.
Use `http://127.0.0.1:8090/` as the playlist URL in the player. These commands do not
build, deploy or start a server. If an existing simulator instance does not open
the application, quit it normally and rerun the launch command. The SDK copies the
launcher directory; the launcher regenerates the redirect on each player launch.
For manual preparation only, use `node scripts/prepare-tizen-simulator.cjs`.

This redirect loaded the player, local M3U channels and programme listings in
Simulator 10.0.6 on macOS 26 through Rosetta. Hosted applications remain outside
Samsung's supported simulator scenarios: API injection timing and real TV media
decoding cannot be inferred from that UI result. The simulator's Tizen user agent
also does not identify its actual Chromium version.

Simulator 10.0.6 replaces the application iframe's `window.onkeydown` when focus
enters or leaves the iframe. The player uses an idempotent `addEventListener`
binding so clicking the drawn remote after interacting with the app does not
disable input. The source, static and emitted-bundle regression checks model
both SDK overwrites. The actual simulator also verified OK/Back, one-row Up/Down,
Left/Right page navigation and returning to the remote after a mouse click.

## Rosetta, firmware emulators and legacy devices

Rosetta remains available on macOS 26 and can run Intel macOS applications,
including a compatible Intel simulator application. It does not emulate Intel
VT-x or support Intel kernel extensions and applications that virtualize an
x86_64 platform: see [Apple's Rosetta documentation](https://developer.apple.com/documentation/apple-silicon/about-the-rosetta-translation-environment).
An installed Rosetta runtime alone does not establish that a particular old SDK
works on the current macOS version.

The full **Samsung Tizen TV Emulator** has
[Intel/VT-x and GPU requirements](https://developer.samsung.com/smarttv/develop/tools/prerequisites.html).
Samsung does not support running it inside VirtualBox, VMware or Parallels VMs.
The Web Simulator above is the local macOS option; it must not be reported as
booting Samsung firmware.

The archived **LG NetCast SDK 3.0.1** targets old Intel operating systems,
Java 6 and VirtualBox 4.1.18–4.2.18 according to its
[requirements](https://webostv.developer.lge.com/more/netcast/sdk-v301).
Rosetta cannot make those virtualization drivers compatible with Apple Silicon.
No working NetCast firmware launcher on this Mac is claimed or added.

[QEMU TCG](https://www.qemu.org/docs/master/about/emulation.html) can emulate an
x86 system in software. Preparing a legacy guest OS and adapting a vendor TV
image would be a separate experiment, with significant disk/performance costs;
it is not a verified substitute for either vendor's supported host.

For **MAG and other shipped adapters**, retain the Chromium detection/key
matrix and real-device checks. Those tests do not emulate firmware, native
services or hardware decoders.

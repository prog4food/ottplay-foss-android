# Native shell contracts

Tauri and Capacitor share the TypeScript player's click targets, provider
protocols, playback state and second-channel PiP semantics. An app compiling
successfully is not a device playback result.

## Input and OS controls

Capacitor single taps use the same target and coordinates as browser clicks.
In native lists, one stationary tap focuses and activates the touched row.
Native text inputs keep their trusted touch defaults so the WebView can focus
them and open its keyboard. The touchscreen lock and four-finger unlock still
take priority. Vertical swipes over native lists move through rows and pages.
Fast flicks coast with gradually decreasing speed, while slow drags retain row
precision. A new touch or key stops the coast, as do list replacement, overlays,
backgrounding and external selection changes. Other swipes retain remote-key
gestures. A moved gesture cannot activate its
initial target on release, even if it returns to its starting point.

An attached hardware keyboard uses the shared main-view seek shortcuts:
**Alt/Option + Left/Right**, **Ctrl + Left/Right**, or **Command + Left/Right** on macOS, moves the main
playback backward/forward by ten seconds. The same bindings work in fullscreen
and the normal player view for local video, VOD and supported archive playback.
Menus/editors keep their own input routing and kiosk locks remain authoritative.
See [playback keyboard shortcuts](browser-window-controls.md#playback-keyboard-shortcuts).

Native media Next/Previous resolve the active device keymap at event time.
Explicit Play/Pause/Stop go through the shared playback lifecycle. Explicit Play
checks the current state before calling the legacy toggle-style `stbContinue`,
so repeated OS Play commands do not pause the stream. Android plugin session
updates are marked session-only to avoid feeding Stop back into JavaScript.

Tauri's second-channel PiP starts muted, matching the browser video. Window drag
chrome and drag initiation are disabled during native fullscreen.

## Android plugin wiring

The Android app compiles its local Kotlin plugins and registers all six with the
Capacitor bridge before `super.onCreate`. Plugin registration is checked against
the actual annotated source files. Hardware media events use the same playback
lifecycle as OS media sessions; device-specific navigation and volume codes come
from the active keymap. The Java regression executes the real `MainActivity`.
The local command queue returns a JSON array and closes listening/client sockets
when its Activity is destroyed. Its JVM regression exercises real loopback HTTP,
queue draining, idle clients and startup/destroy races.

## Playback and PiP

Normal Capacitor playback stays in the shared HTML/HLS/Shaka backend. The
main and preview video elements opt into inline playback on iOS, keeping the
programme footer and menus accessible without stopping the stream. The
standalone Android ExoPlayer plugin is an explicit native API; it is not an
automatic codec fallback for the shared player.

Android second-channel PiP opens the requested URL in the shared muted
`videopip`. Activity PiP is a separate explicit `enterSystemPip` plugin operation,
which checks the platform result. iOS retains its URL-aware native PiP path.
Deferred background metadata updates are cancelled on stop, pause and replacement.

## Provider transport

Tauri and Capacitor remote HTTP use a jQuery transport so the bundled jQuery retains ownership
of serialization, JSON conversion, callbacks, HTTP failures, abort and timeout.
JSONP response envelopes are parsed without evaluating provider response code.
An unexpected JavaScript MIME type never turns a playlist/API reply into code.
Explicit remote matching services keep their URL and request body.

JavaScript abort suppresses late callbacks. The iOS HTTP bridge also cancels the
matching native request and its pending sign-in waiter. Other bridges without
request cancellation rely on the native timeout to bound already-dispatched work.
The native HTTP clients do not import the WebView's cookie store; providers
requiring ambient browser cookies need a separate transport contract.

## EPG and playlist metadata

Provider APIs keep ownership of EPG. Native XMLTV is selected only for M3U
channels using the built-in local companion. An explicitly configured external
EPG/matching backend keeps its original protocol and request body.

For an external companion, relative EPG source prefixes returned by matching
are resolved against that companion, not the player's origin. This includes
the Rust companion's `local~/` response. Absolute and protocol-relative source
prefixes retain their supplied origin. Use an absolute HTTP(S) URL for the
configured external companion; native application origins do not necessarily
have an HTTP(S) scheme to inherit.

Native M3U metadata retains raw `tvg-id`, `tvg-name`, display name and ordered
XMLTV URLs, including playlist source indexes and aliases. Matching checks exact
IDs and names before fuzzy names. The first source defining a channel owns that
channel and its programmes. Native parsing handles plain/gzip XML, aliases,
CDATA and chronological programme order. Corrupt disk entries are refetched;
incomplete native XMLTV documents cannot replace a healthy cached feed. Regional suffix shifts and explicit
`tvg-shift` are separate operations.

Capacitor channel matching and logo lookup translate the native channel index
back into the existing FOSS text protocol. Direct playlist logos remain intact.
Parsed source caches share concurrent work and keep source-specific offline
fallbacks. On mobile, the disk cache retains one source across process restarts;
multiple sources share memory during a running session.

## Regression checks and device acceptance

Run `npm test`, `npm run build`, and `npm run check:bundle` for the shared TS and
native adapter regressions. Tests execute actual application code, bundled
jQuery and provider fixtures; they do not replace real decoder and OS tests.

Run `node tests/test_android_activity.cjs` with JDK 21 for Android registration
and hardware media events. CI compiles the Android and iOS applications and
tests the compiled Tauri transport.

Run Rust tests and compile both Capacitor projects after changing native plugins.
The XMLTV plugin source copies must match the files actually shipped in the
Android and iOS projects.

On each target OS, use a known playlist and EPG fixture:

- Tap a non-selected channel, menu action and text input; check the actual target,
  keyboard focus and touchscreen lock.
- Load provider JSON/JSONP, M3U mapping/logos and regional EPG; verify now/next,
  archive start and custom source selection.
- Switch HLS/DASH/progressive streams; pause, seek, mute and change aspect/tracks.
  Check that only one primary player remains active and Stop stays stopped.
- Open list, EPG and preview over video; enter/exit fullscreen and rotate the
  device. Check layout geometry and hit testing.
- Exercise repeated OS Play, Pause, Stop, Next and Previous; test second-channel
  PiP separately from system Activity PiP.

Record the Git revision with test artifacts. Codec/DRM support, background
survival, safe area and layout remain target-device checks.

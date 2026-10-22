# PC2: Video.js and VHS

`/f/pc2` restores the historical alternate streaming implementation without
changing the player UI or loading another media library on `/f/pc`.

## Versions and packaging

The pinned versions are **Video.js 7.21.7** and **Video.js HTTP Streaming (VHS)
2.16.3**, the last published stable 7.x and 2.x versions verified against the npm
registry on 2026-09-26. Video.js 7.21.7 itself pins VHS 2.16.3. The official
`video.js/dist/video.min.js` UMD already includes that VHS, so the player loads
one unchanged upstream file, not two copies of VHS. Both packages are exact
runtime dependencies and retain their lockfile integrity values.

Video.js 8 and VHS 3 explicitly stopped targeting ES5; see the
[upstream release announcement](https://videojs.org/blog/videojs-8-and-vhs-3),
[Video.js release](https://github.com/videojs/video.js/releases/tag/v7.21.7) and
[VHS release](https://github.com/videojs/http-streaming/releases/tag/v2.16.3).
These historical branches are a deliberate compatibility constraint, not the
current modern-browser releases.

`npm run build:media` copies the upstream bytes and licenses and fingerprints
them in `js/media-runtime.json`. Build/cache audits compare those bytes to the
installed locked package, verify the bundled VHS dependency and parse the
runtime with Acorn's ES5 grammar. Web, Tauri and Capacitor stages retain the
optional asset. The HTML URL uses the shared runtime version for cache busting.
The ordinary PC page makes no request for this file or the small PC2 stylesheet.
There is no external CDN dependency. Network streams still require connectivity;
this does not add a service worker or offline caching for a web installation.

## Compatibility and polyfills

The existing blocking `js/runtime-polyfills.js` supplies core-js/stable and the
project's web shims before Video.js executes. A second Set/Promise polyfill is
unnecessary. Browser tests strip Promise, Map, Set, WeakMap, Symbol,
Object.assign, Array.from, Number.isFinite and String.startsWith before startup,
then run the actual library and play clear and AES-128 HLS fixtures. They also
remove `VTTCue`/`TextTrackCue` and render real WebVTT subtitles. Video.js bundles
its own cue/parser compatibility code. Keep its native text-track detection:
forcing native tracks on an engine without native `VTTCue` would pass shim cues
to the browser's incompatible `TextTrack.addCue`. core-js cannot fix that DOM
contract. The tests also capture errors handled by the application's onerror.

VHS 2 creates Blob workers for transmuxing and decryption. They are separate
JavaScript environments. Tests capture their actual generated sources, parse
them as ES5 and remove modern APIs inside each worker before that code runs.
Both fixture paths work without importing our page runtime into those workers;
do not add the full shared polyfill bundle to every VHS worker without evidence
that a required API is missing. This differs from the current HLS.js worker,
whose separate bootstrap remains unchanged.

Real media APIs and codecs remain required. Without Worker, the adapter disables
VHS source selection and leaves native HTML5 playback available. Upstream VHS
already checks MediaSource support and normally leaves Safari HLS native.
Neither ES5 nor core-js supplies MSE, DRM, hardware decoders or missing codecs.
Tests on Chromium with missing APIs are not validation on physical old TVs.

A deployment CSP must allow local scripts/styles, the actual stream endpoints,
media Blob URLs and `worker-src blob:` for VHS. The tested policy needs no
`unsafe-eval`. The adapter does not loosen server CSP. A restrictive policy that
forbids Blob workers cannot run VHS streaming; native playback depends on the
browser and source. Other routes keep their existing worker behavior.

## Engine ownership

The optional adapter registers an engine port through `__ottCoreTransport`.
`__ottMediaBackend` still owns main/PiP requests, cancellation, provider stream
resolution, observation and archive positions. UI controls continue to use that
backend. Video.js controls are disabled; the minimal stylesheet only supports
the media wrapper and captions. The common layout scales the wrapper, and the
original HTML video element remains the core's media reference.

Each lane retains one Video.js player. Each request receives its own listeners,
seek intent and lifetime guard. A replaced request cannot attach a source from a
late ready callback or restore tracks into the next request. Pausing before
ready suppresses autoplay, including a resume followed by pause before source
attachment. The adapter never calls `Player.play` before the source is attached,
so Video.js cannot queue an unowned play callback. Only a supplied positive start offset triggers an
initial seek, so live streams retain VHS's normal live-edge selection.
Resume and user seeks wait until the current source reaches `canplay`
(`HAVE_FUTURE_DATA`); metadata alone is too early for WebKit's initial MSE
buffer append. A newer seek replaces pending intent, and disposing a request
also disposes its readiness listeners.

The pinned adapter uses HTML5 Tech `setSource` synchronously, with Video.js's
source cache updated first. The generic `Player.src` middleware queue is not
used, since a deferred old source could attach after cancellation. Teardown
calls `disposeSourceHandler`, `clearTracks` and the Tech's `reset`; it must never
use `Player.reset`, which replaces the video element and invalidates core DOM
references. These version-specific integration points have regression tests.
Teardown aborts VHS requests, terminates its workers and removes request
listeners. The retained player wrappers are disposed on document unload.

Audio tracks and subtitle/caption tracks come from the Video.js lists. Metadata
tracks are excluded while original indexes remain stable for saved preferences.
Main and in-page PiP engines have independent lifetimes. Native shell PiP effects
retain their existing platform ownership.

## Validation

- `node tests/test_pc2_engine.cjs`: cancelled/delayed initialization, pause intent,
  seek, track selection/restoration, metadata filtering, source types and lanes.
- `npx playwright test tests/browser/pc2-playback.spec.cjs`: real clear/encrypted
  HLS, missing APIs in page and workers, pause/resume, seek, volume, channel
  replacement, layout, PiP, worker release, CSP, missing-vendor fallback and
  ordinary-PC request isolation. Playback uses local generated media fixtures.
- Device routing tests include PC2 and its optional-library request order.
- Build, ES5, media-manifest, native staging and existing playback tests remain
  mandatory. Test a real device's streams/codecs before claiming firmware support.

# External library upgrades with ES5 compatibility

The shared application remains a classic ES5 script. New dependencies must fit
that contract in every execution context that receives them. A desktop user
agent or development origin is not permission to download a different HLS
version at runtime.

## Current runtime and ownership

- Every profile uses the exact npm-locked hls.js **1.7.3** UMD distribution.
  `js/hls.min.js` is upstream's unchanged `dist/hls.min.js`. Its standalone
  worker is upstream's `dist/hls.worker.js` with a small ES5 loader prepended.
  The loader synchronously imports the sibling compatibility runtime and
  checks its version/readiness; it never relies on polyfills in `window`.
- `js/runtime-polyfills.js` is generated from exact core-js **3.50.0**
  `stable` modules and `src/polyfills/runtime.ts`. Core-js owns standard
  JavaScript compatibility, including Promise, collections, iterators,
  Symbol support, Array/Object/String/Number methods, typed-array methods,
  URL and URLSearchParams. Project code owns the small worker-safe web API
  additions, including UTF-8 TextEncoder and monotonic `performance.now`.
  Conforming native APIs are preserved. Proposals are not included merely
  because a new core-js release offers them.
- The legacy web profile retains jQuery **1.11.1** and Shaka Player **3.3.19**.
  Native shells use npm-locked jQuery **4.0.0** and Shaka Player **5.2.10**.
  These are explicit packaging profiles. Neither uses a user-agent-triggered
  CDN substitution. Updating HLS does not establish that the other libraries'
  current native versions can run on the old web profile.

Edit `src/polyfills/runtime.ts` or the locked dependencies, then regenerate the
assets. Do not hand-edit minified polyfills, HLS code, or worker internals.
`js/media-runtime.json` records dependency versions, npm integrity values,
builder/source hashes, and generated asset hashes. Native staging also writes
its own runtime manifest. The staged bytes and licenses must match the
corresponding checked-in inputs.

The generator fingerprints canonical lockfile inputs, installed build-tool
versions and runtime sources into a deterministic `runtimeVersion`. The lock
digest excludes only the values of the two root project-version fields, so a
release version overlay does not rebuild unchanged media assets. Dependency
versions, integrity values and other lockfile metadata remain part of the key.
Manifest schema 2 calls this digest `lockInputsSha256`; it is not a hash of the
raw lockfile bytes. The generator stamps the runtime version
into both source HTML bootstrap URLs; hls.js and Worker URLs use the same value
published by the bootstrap. Native staging preserves the version when rewriting
paths. Distinct versions use separate cache keys; the worker additionally rejects
an imported runtime that lacks its expected version or ready marker. Publish
the generated assets and matching HTML together, including when serving the
source tree. A versioned query does not make an old response immutable on a
server that always serves current bytes for that path.

## Load order and separate JavaScript environments

The bootstrap must complete `runtime-polyfills.js` before jQuery, hls.js,
Shaka, device/provider scripts, and `dist/player.js`. Code that runs before
the compatibility layer must use ES5 built-ins and guarded host APIs only.
Failure to load the layer must stop dependent initialization with a useful
boot error; proceeding with partially initialized libraries hides the cause.

HLS is configured with the packaged `js/hls.worker.js` path. Each worker calls
`importScripts("./runtime-polyfills.js?v=<literal-build-version>")` before the
unchanged upstream code. The synchronous classic-worker import resolves against
the worker's own URL, including on nested paths. It installs the full runtime
in that worker's realm; window built-ins and prototypes are not shared. A worker
must not require `window`, `document`, a CDN, or a provider endpoint to install
its polyfills. Worker creation failure must remain an observable upstream HLS
fallback to main-thread transmuxing, rather than changing library versions.

Keep both files in the same directory in web, native and PiP packages. Moving
only the worker into a Blob URL or a different directory breaks this sibling
contract. Do not construct the import with `new URL` before its polyfill runs.
The generated guard requires the ready marker to be exactly `true` and the
runtime version to match. Import, execution and guard errors propagate before
upstream registers its message listener.

Cache reuse can save a second transfer of the runtime, but does not remove its
execution or installed objects in the worker. On a cold worker-only load the
runtime needs another response; loading may be slower. Starting another HTTP
worker offline requires both exact versioned resources to be cached and reusable.
This does not establish persistent whole-application offline restart. Native
packages retain both files locally and do not need a provider or CDN request.
An uncached web origin has no new offline capability.

Page-to-worker cache reuse depends on the browser. Browser tests check request
counts separately for Chromium and WebKit; `no-store` responses are fetched
again for each fresh worker realm. Keep the complete runtime packaged alongside
the worker regardless of HTTP cache behavior.

Worker permissions alone do not authorize its imported script. When a worker
response carries CSP, its effective script policy must allow the same-origin
runtime import. Keep existing application restrictions; do not add broad
permissions to make a failing test pass. Missing/stale runtime, denied CSP and
wrong JavaScript MIME must fail visibly. Test actual worker `init` and
`transmuxComplete` messages: successful playback alone can conceal HLS's
main-thread recovery.

The core-js language layer and web shims must remain idempotent. Runtime shim
entry points in the application bundle may also be used by isolated tests or
embedders. Do not add a second independent implementation of the same standard
API to the application bundle.

## What JavaScript compatibility can and cannot provide

An Acorn parse with `ecmaVersion: 5` proves the emitted syntax is acceptable to
an ES5 parser. It does not execute code, provide missing browser APIs, validate
cross-origin permissions, or prove decoding. TypeScript's `target: "ES5"`
likewise does not install Promise, Map, or browser APIs. A UMD wrapper describes
how a library is loaded, not its syntax level or browser requirements.

The standard library layer restores JavaScript behavior where a polyfill is
possible. HLS also has internal fallbacks for selected optional browser APIs;
for example, an absent TextDecoder does not require a project decoder polyfill
when HLS uses its own UTF-8 decoding path. Add web API shims only for observed
required behavior, with semantic tests covering that behavior.

Successful hls.js playback still requires real MediaSource/SourceBuffer support
for its output, native typed-array and ArrayBuffer interoperability with those
APIs, an available decoder for the selected codecs, and a usable transport.
JavaScript cannot supply a missing firmware MSE implementation, hardware
decoder, DRM/EME system, trusted certificate store, or modern TLS support.
Polyfilled typed arrays alone do not establish native media interoperability.
Native HLS and platform playback adapters remain necessary on devices whose
browser cannot use MSE. `Hls.isSupported()` must remain false when the browser
lacks MSE; polyfills must not manufacture a positive capability result.

## Repeatable update workflow

1. Select an exact release after reading its upstream migration notes,
   supported-browser policy, output formats, worker packaging, and licenses.
   Inventory globals and methods used by both the main bundle and workers.
   Distinguish required APIs from guarded optional features. Record any changed
   HLS events, configuration values, retry behavior, and public integration APIs.
2. Update exact package versions and the lockfile together. Install dependencies
   with `npm ci`. Once the locked packages are available locally, the media
   asset generator and runtime checks perform no downloads. A fully offline
   fresh install additionally requires a populated npm cache or internal mirror;
   do not call an uncached install an offline build.
3. Run `npm run build:media`, then `npm run check:media`. Review changes to
   generated bytes, `js/media-runtime.json`, and `js/licenses/`. Keep upstream
   HLS UMD bytes unchanged and preserve the identified worker modification.
   Update this document and `THIRD-PARTY-NOTICES.md` when the recorded versions
   or license requirements change.
4. Run `npm run test:media` and `npm run typecheck`. The VM test executes actual
   shipped HLS and worker code with missing APIs, and includes a failing
   unpolyfilled control, asynchronous Promise behavior, collection semantics,
   native API preservation, URL/Unicode behavior, a no-MSE check, and actual
   TS-to-fMP4 audio/video transmuxing. The worker receives an independent
   environment rather than reusing patched window built-ins.
5. Run `npm run build`, `npm run check:es5`, `npm run check:bundle`, and
   `npm test`. Review all web/native staging audits. ES5 checking must cover
   bootstrap scripts, each shipped external script, the standalone worker,
   and the final classic application bundle. A syntax conversion that changes
   vendor semantics needs its own regression coverage.
6. Run `npm run test:media:browser` and `npm run test:devices:browser` with the
   installed Playwright Chromium runtime. The media test serves a checked-in
   synthetic H.264/AAC MPEG-TS fixture over loopback and verifies decoded
   640 x 360 video with advancing position, both with and without a worker.
   It also removes APIs inside a real worker before the shipped loader runs,
   checks nested sibling paths and worker-response CSP, and exercises missing,
   stale and wrong-MIME imports. Cache tests use real HTTP request counts without
   Playwright routing (which disables its browser HTTP cache), including a
   new worker in an existing offline browser context and uncached-resource
   failures. A deliberately missing worker runtime must also produce an
   observable nonfatal HLS error and successful main-thread playback; healthy
   worker cases still forbid this recovery. No live provider or public media
   endpoint is required.
7. Validate the release on representative physical devices before claiming
   those devices are supported. Record device model, firmware/browser version,
   selected playback adapter, MSE/codec support, worker behavior, and the media
   fixture used. Exercise live/VOD playback, seeking, discontinuities, audio
   selection, subtitles, errors/retries, and the platform's native fallback.
   Add encrypted-stream, DRM, or additional-codec checks only where the
   corresponding product support is claimed.

Keep the previous verified package and runtime manifest available for rollback.
Rollback changes the pinned inputs and regenerates/stages all dependent assets
together; runtime code must not silently switch to a historical HLS version.

## Next upgrade work for jQuery and Shaka

For jQuery, first inventory the application and provider/device adapters' actual
API use. Test DOM creation, event routing and remote keys, AJAX/XHR behavior,
Deferred ordering, and removed/deprecated APIs against the proposed release.
Evaluate the chosen release's own supported-browser policy. ES5 transpilation
cannot restore browser support that depends on unsupported DOM behavior.
Where an intermediate compatibility migration is necessary, complete and verify
it before replacing the shipped legacy release. Diagnostic migration helpers
must not become permanent unreviewed production dependencies.

For Shaka, inventory Player initialization, load/unload/destroy, DRM
configuration, error events, track selection, and networking filters. Check
upstream's compiler target and browser policy before selecting a new legacy
artifact. Keep Shaka's own media/DOM polyfill installation in its documented
position, after the shared standard-library layer and before Player use.
Remove historical syntax rewrites only after an equivalent generated artifact
passes Acorn and runtime regression tests. Test local clear DASH fixtures,
language/track changes, seek, stop/restart, failure recovery, and existing native
bridge boundaries before attempting provider-specific DRM validation.

A future shared-library upgrade should extend the manifest/staging audit to
include its exact package, transformed artifact if any, source/build hashes,
worker assets, licenses and notices. Do not broaden the HLS compatibility
bundle to include every possible web API spec in anticipation of that work.
Keep required shims bounded by observed dependency and application behavior.

## Redistribution and evidence

HLS and Shaka use Apache 2.0; core-js and jQuery use MIT. Retain complete license
texts, copyright notices, and applicable upstream third-party notices. Identify
modified distributions and preserve upstream NOTICE files when supplied.
The project's MIT license does not replace those obligations or grant rights
to third-party streams, codecs, DRM systems, fonts, or artwork. Consult the
checked-in notices and upstream release files for each actual distribution.

The tests establish syntax, isolated JavaScript behavior, real transmuxing and
playback in the tested browser. They do not certify every historical television
firmware or physical decoder. Record physical-device evidence separately from
the automated compatibility gates.

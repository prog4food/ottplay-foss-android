# Classic ES5 build pipeline

`npm run build` runs Vite, TypeScript compilation, the classic linker in
`scripts/classic-bundle.cjs`, and Terser. The result is `dist/player.js`.
Vite uses an empty build entry to avoid transforming an unused second module
graph, then stages the web roots and validates the actual shipped scripts as ES5.

`CLASSIC_MODULES` in `scripts/classic-bundle.cjs` is the ordered list of runtime
modules. Every emitted runtime import must resolve to a listed module or an
explicit checked ABI bridge. Missing dependencies fail the build. The linker
uses TypeScript syntax trees and bound symbols to remove module syntax; it
supports multiline named imports and resolves renamed imports without confusing
local variables or object property names.

Imported aliases use the original global binding when it cannot be captured by
a local declaration; otherwise small ES5 reader functions keep the value live.
An alias such as
`video as videoElement` continues to read the current `video` after initialization
or replacement. Default and namespace imports are rejected with a diagnostic;
use named imports for this classic output.

Classic adapter/provider modules share a global scope because separately loaded
scripts use bare public identifiers. `scripts/classic-optimizer.cjs` compresses local
implementation details while preserving every top-level binding, property name,
published or escaping function name, and function arity. Menu preferences persist
`callback.name`; these names must survive optimization. A local function used
only by direct calls may be renamed or inlined. Symbol analysis retains constructors,
callbacks, name collisions and functions used as values; known dynamic code or
caller reflection disables this relaxation. Private stack-frame names are not an API.
Top-level and property mangling, unsafe rewrites,
getter purity assumptions, and IE-incompatible `typeof` rewrites remain disabled.
The compressor uses three passes with declaration hoisting disabled.
Indexed-argument rewrites and Boolean-to-integer conversion are disabled because
they change omitted/mapped arguments and native bridge Boolean contracts.
The optimizer parses both input and output as ES5 and rejects missing globals.
Put leaf modules before consumers that use their values during initialization, and avoid
duplicate global declarations when extracting new modules.

`CLASSIC_PRIVATE_MODULES` declares audited implementation boundaries. The debug
controller publishes `window.__ottDebug`; its functions, queue and timer state
run in a private immediate scope at the original module position. The scope
retains the script's receiver and does not introduce strict mode or deferred
initialization. Compiler helpers inside private modules are not shared across
the boundary. Named imports/exports, bare private references and direct named
`window`/global-object property reads fail the build. Aliases, `this` receivers,
computed property names and external device/provider scripts still require a
reachability audit; the linker cannot prove their intent.

The HTML bootstrap owns startup: runtime support, media libraries, player bundle,
selected adapter, then `startPlayer()`. Device detection always returns a
nonempty route. There is no competing DOM-ready startup path.
The shared runtime installer is supplied once by `js/runtime-polyfills.js`.
The classic linker validates its explicit import bridge and the bundle checks
bootstrap readiness before use. The application timezone adapter remains in the
player bundle; standard web polyfills remain available to both page and HLS worker.

The provider registry remains in the entry bundle. Specialized implementations
are emitted once as `dist/provider-{catalog,edem,m3u,playlist,stalker}.js` and
loaded when that family is selected. Concurrent requests share a script load;
disposed provider sessions cannot mount a driver or publish a stale failure.
Successful loads are reused and failures can be retried. Shared catalog, XML,
transport and media services remain in the entry bundle. Native and Mode A
packages include every supported family; Play includes only M3U and Stalker.

`src/app/state.ts` remains an ESM-only state mirror. Its three provider popup
imports (`popupActions`, `popupArray`, `popupDetail`) explicitly resolve to the
classic arrays owned by `src/index.ts`. The linker checks those declarations and
rejects any additional implicit bridge. Listing the state mirror itself would
reinitialize the shared popup arrays and break provider mutations.

`npm run check:bundle` validates public identifiers and executes the emitted
bundle in legacy, modern and Capacitor profiles. `npm run check:es5` checks
JavaScript grammar and staged copies. `npm test` includes linker regressions for
live aliases, lexical shadowing, multiline imports, missing dependencies and the
explicit state bridge. See `docs/es5-compatibility.md` for runtime API constraints
and `docs/mode-a-test-bundle.md` for the standalone device package.

## Shared helpers and native fallbacks

The linker recognizes `__awaiter` and `__generator` against actual output from
its installed TypeScript compiler. It retains the first initialization at its
original position and removes only identical repeated helpers. Unknown helpers
are preserved; conflicting shared bindings fail the build. Dynamic evaluation
prevents this optimization. Independently emitted modules retain their own
helpers, so they remain usable by tests and other consumers.

Native web fallbacks use `nativeWebFallback` instead of `async` methods without
`await`. Its Promise executor runs immediately, converts throws into rejections
and adopts returned thenables. This avoids unnecessary ES5 generator machines
without delaying warnings or changing the native registration/proxy interfaces.

The HTTP player can execute inside Tauri or Capacitor, so native bridges remain
in the shared bundle. Splitting them requires an explicit capability bootstrap,
versioned chunk loading, offline packaging and cross-chunk ABI tests first.
Do not select code solely by URL or development computer identity.

Native adapters share Promise-to-jQuery settlement and playback metadata
collection. Platform wrappers retain their own request arguments, lifecycle,
timers and session ownership. The shared Deferred bridge subscribes directly to
the existing thenable and retains callback receivers, completion-before-settlement,
error conversion and return-object identity on legacy and current jQuery.

## Reachability and future module boundaries

Classify entry points before removing code: HTML startup, bare provider/device
globals, `window` publications, saved callback names, native/plugin APIs and
registered event callbacks are roots. A missing TypeScript import does not
establish dead code. All 24 device adapters remain reachable through explicit
`/f/<adapter>` routes; native bridges remain reachable from HTTP-hosted shells.

Preserve published globals such as `handleTouchEnd` and the documented
`DashExoPlayer` API even when current automatic playback does not call them.

For further extraction, define the public interface and immediate initialization
effects first, then isolate internal state and test through that interface.
Prefer shared operations behind capability-specific adapters over copied platform
implementations. Lazy loading needs versioned chunk paths, offline/native staging,
failure recovery and ordering tests before it can replace the current bootstrap.
An automatic tree-shaker over all legacy globals would discard supported hooks.

## Build validation and size budgets

Release source identity has a measured compression cost. On Node 22.23.3, 68
different 40-hex revision values add at most 40 gzip bytes to the same payload.
The native entry grows from 263,566 bytes with an empty revision to at most
263,606; its seven providers still contribute 43,074 bytes. The entry and total
gzip budgets each include a 64-byte allowance for the required metadata and
compression variation. This metadata allowance leaves raw limits and the
complete staged-asset inventory unchanged.

Normal builds audit the complete media runtime before reuse. The audit checks
input fingerprints, all asset hashes, licenses, bootstrap URLs, ES5 grammar and
the worker prelude. Missing or stale assets trigger regeneration and another
full audit. `npm run build:media` always rebuilds explicitly. No timestamp or
process-local cache can bypass validation.

The HLS worker contains a synchronous, versioned sibling-runtime import and an
exact readiness/version guard followed by unchanged upstream worker bytes.
The auditor reconstructs that complete sequence; changing an asset and its
manifest hash together cannot authorize another import or a removed guard.
The loader recipe lives in the already-fingerprinted builder. Both runtime and
worker remain staged together, with their licenses, in every web/native root.

Each final classic entry bundle is limited to 897,023 UTF-8 bytes and 278,582
bytes compressed with gzip level 9. The entry plus all eight provider families
must also fit within 1,017,923 bytes and 323,482 gzip bytes, summed per file.
Both limits apply independently to server, Tauri and Capacitor artifacts.
Native transformations are measured after staging.
`npm run check:size` reads the actual artifacts; it does not trust a prior report.
These budgets cover `player.js`, not external media libraries or the complete
application download. Raise a budget only with a reviewed feature/size tradeoff.
The authoritative limits and measurement history are in `scripts/classic-size.cjs`.

Debug-v3 attempt history adds 1,867 raw and 564 gzip bytes over `1e8973`,
measured with Node 22.23.3 / zlib 1.3.1-e00f703, the production compiler and
optimizer, the same 1.1.56 version and a nonempty 40-hex source identity.
The baseline is 894,773 / 277,766 raw/gzip bytes for web and
894,731 / 277,823 for native. The optimized implementation is
896,640 / 278,330 for web and 896,598 / 278,387 for native.
The entry and total budgets each add exactly that feature cost, retaining the
previous 383-byte raw and 195-byte worst-native gzip reserve. All eight provider
bundles remain unchanged. This preserves strict validation, bounded counters,
EOF retention, and the exact legacy debug-v1/v2 payloads.

Deduplicating counter snapshots and validation saves 397 raw bytes and 67 web /
71 native gzip bytes versus the initial diagnostic implementation. Brotli at
quality 11 is a separate observation: web grows by 43 bytes (225,242 to
225,285), while native shrinks by 151 (225,216 to 225,065). The baseline Brotli
sizes are 224,579 web and 224,606 native; there is no claim that every compressor
improves. Version projections using the same optimized source and full identity
measure 896,661 / 278,350 web and 896,619 / 278,405 native for `1.1.56-beta.1`;
`1.1.56-rc.1` measures 896,655 / 278,345 and 896,613 / 278,402 respectively.
The existing source-identity reserve remains in place; release builds still
measure the actual committed identity and all final staged outputs.

Attached-engine diagnostics add 868 raw bytes and at most 233 gzip bytes on
Node 22.23.3, comparing the same beta.10 and final-base versions before and after
the feature. All seven provider bundles remain byte-identical. A 900-byte raw
and 256-byte gzip allowance covers this feature once in the entry and complete
payload, preserving the existing reserve. The comparison uses the production
linker, optimizer and native icon transformation; complete frozen release builds
still enforce every final artifact limit.

Explicit debug-v2 negotiation preserves legacy version 1 payloads. On the same
Node 22.23.3 beta.10 and final-base inputs, it adds 235 raw bytes and at most
108 gzip bytes to each entry; all seven providers remain byte-identical. The
existing raw limits fit. An additional 128 gzip bytes in both the entry and
complete-payload limits covers this protocol cost and bounded version variation.

The cancellable Plex arrow wait, buffered HLS resume and bounded read retries add
1,282 raw / at most 366 gzip entry bytes and 1,670 raw / at most 488 gzip
complete-payload bytes over `fbc80031`. Both revisions were built at version
1.1.54 on Node 26.8.2,
including all seven providers and native staging. The allocation adds 1,300 / 400
entry bytes and 1,700 / 500 complete-payload bytes, preserving the prior reserve
for clean-source identity, native transforms and release suffixes.

Named Plex library selection adds 1,319 raw / at most 398 gzip entry bytes and
3,988 raw / at most 1,319 gzip complete-payload bytes after a 265-byte entry
reduction. Both revisions were freshly compiled with Node 22.23.3 and
zlib 1.3.1-e00f703 at the common version 1.1.54, including all seven providers.
The reviewed allocation adds 1,350 / 400 entry bytes and 4,000 / 1,350 total
bytes to the previous limits, preserving their reserve once. The 1.1.54-beta.1
candidate measures 831,270 / 258,821 entry and 946,528 / 301,518 total bytes
for web, or 831,228 / 258,889 entry and 946,486 / 301,586 total for both
native shells. Strict request validation, cancellation, pagination and all
entry/complete-payload checks remain enabled.

Folder shuffle, Repeat and exact Plex startup resume measure 640,894 raw /
194,762 gzip bytes for web and 640,852 / 194,822 for Tauri and Capacitor on
Node 26.8.2. Including all providers measures 733,963 / 229,802 for web and
733,921 / 229,862 for native.
The increase retains collection bounds, independent request cancellation, PIN
ownership and guarded natural completion; Plex pagination remains optional.
Budgets include release suffix and Node 22 compression variation.

The iOS protected-source integration retains its authentication and cancellation
checks after sharing native transport helpers. Its combined beta candidate on
Node 22.23.2 / zlib 1.3.1-e00f703 measures 183,516 gzip bytes after native staging,
16 bytes over the previous entry limit. The reviewed tradeoff adds 50 gzip bytes
to that limit; the raw and complete-payload limits remain unchanged. Validate
both base and candidate versions against every final artifact.

CSP-safe playback selection and confirmation controls share the color-picker
layout to recover raw bytes. Relative to that protected-source baseline, the
combined change removes 119 raw bytes and adds 209 gzip bytes for server output
and 210 gzip bytes for native output. On the same Node/zlib toolchain, version
1.1.51-beta.3 measures 605,567 raw / 183,673 gzip bytes for server and 605,525 raw /
183,726 gzip bytes for Tauri and Capacitor after staging. The reviewed entry gzip
limit increases from 183,550 to 184,000 bytes; raw and complete-payload limits stay
unchanged. The largest complete beta payload is 670,191 raw / 208,260 gzip bytes
(the raw maximum is server; the gzip maximum is native).

### Measuring delivery size

Use the same Node/zlib version, lockfile, optimizer settings and application
version for repeatable measurements. Record raw bytes and gzip level 9 for each
final server, Tauri and Capacitor bundle. Measure Play after its distribution
filter and native staging; a pre-staging result is not the shipped artifact.

Include separately loaded shared-core and vendor scripts when measuring the
complete delivery. Duplicate nested paths in a staging tree are packaging
contracts; they do not necessarily cause additional startup transfers.

`build/reports/classic-bundle.json` records module order, optimizer version/options,
public bindings, private-module interfaces, source/output hashes and final artifact sizes. CI publishes it
alongside the normal checks. It lives outside the served roots and is deterministic
for identical inputs and toolchain; it records Node/zlib versions and contains no
absolute machine paths, timestamps or performance claims.

Run `npm test`, `npm run check:bundle`, `npm run check:size`, `npm run check:es5`,
`npm run test:devices:browser` and `npm run test:native:ui` when changing this
pipeline. Differential optimizer tests cover late provider mutations, reentrant
callbacks, eval, function identity/arity, getters, side effects and sloppy-mode
behavior. Actual device codec/DRM acceptance remains a separate playback check.

## Measuring optimizer profiles

`npm run measure:classic` compiles fresh ES5 modules and measures bounded Terser
profiles, including a one-pass profile. It writes candidate scripts to
`build/experiments/classic-options` and measurements to
`build/reports/minify-options.json`, without changing shipped bundles. Use
`npm run measure:classic -- --rounds 2` to check reproducible output across two
runs. Timings are local samples, not stable build-speed measurements. Brotli
quality 11 measurements do not describe the native packager's compression profile.

Diagnostic profiles deliberately include options rejected by runtime contracts.
ES5 parsing and preserved global declarations alone do not make them safe. The
optimizer tests exercise the real HTTP remote bridge and reject changed getter,
argument and Boolean behavior. Keep these tests and the emitted-bundle/browser
checks passing before adopting a different profile.

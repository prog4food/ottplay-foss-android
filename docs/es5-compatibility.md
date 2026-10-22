# Legacy engine compatibility

The shared player is a classic ES5 script. Keep `tsconfig.json` target `ES5`,
Terser `ecma: 5` and preservation of top-level bindings, property names and
function names/arity: device adapters, providers and menu preferences use this
public contract. Local variable names may be shortened; see
[Classic build pipeline](build-pipeline.md) for the guarded optimizer.

Every Vite build (web, Capacitor and Tauri) parses the final bundle and shipped
JavaScript with Acorn's ES5 grammar. `npm run check:es5` repeats that check and
verifies that device, library and provider scripts are present and current in
both packaged web roots. A syntax failure or missing asset fails the build.
`npm run check:bundle` checks the required public identifiers and executes the
actual bundle in legacy, modern and Capacitor runtime profiles.

The compiler lowers syntax, not browser APIs. A blocking local
`js/runtime-polyfills.js` runs before third-party scripts, native environment
setup and the application. It combines pinned `core-js/stable` with worker-safe
web API shims. The application bundle retains its timezone customization.
The HLS worker synchronously imports the same sibling runtime file with its
literal build version, then checks readiness and that version before upstream
HLS starts. This removes the second bundled copy, not the worker's own runtime
initialization: page globals are never assumed to exist in a Worker. Keep
`hls.worker.js` and `runtime-polyfills.js` together; the loader uses ES5 syntax
and requires no URL constructor or Promise before compatibility is installed.
Native media calls and input events must support older implementations
where `video.play()` returns nothing and `event.key` / `new MouseEvent` are absent.

All profiles use the same local npm-locked hls.js UMD version. No CDN version is
selected by user agent, development host or device ID. `npm run build:media`
regenerates assets and license notices; `npm run check:media` checks input/output
hashes, ES5 syntax and the worker prelude. Normal builds fully audit and reuse unchanged assets; stale assets are
regenerated and audited again before staging. Staged copies are also validated. The development server uses the committed
assets. See [External library upgrades](external-library-upgrades.md).

Device IDs used by remote text input are generated with WebCrypto or `msCrypto`.
Engines without those APIs still boot the player and retain existing IDs. The
same-origin `/swop` installation relay obtains a securely generated client ID
from the Worker for such engines; the player saves it for later sessions.
Direct legacy Worker configurations still need a provisioned client ID in
`/local/swop.json`. Access credentials never use `Math.random`.

The vendored Shaka Player 3.3.19 retains its license and runtime polyfills. Its
six exponentiation expressions use `Math.pow` and its four object spreads use
its own polyfilled `Object.assign`, so the shared file parses as ES5. Replacing
vendor libraries must pass the same gate.

`npm test` includes port regression coverage for playback, VOD, EPG, native
bridges, polyfills and device initialization. Syntax checks and simulated old
APIs do not establish codec, DRM or native firmware support: those still require
playback on the corresponding physical devices.

PC2 additionally loads the locked Video.js 7.21.7 / VHS 2.16.3 distribution after
this same blocking polyfill runtime. Its generated Blob workers are independently
checked for ES5 and exercised with missing modern APIs, including AES decryption.
See [PC2 compatibility and lifecycle](pc2-videojs.md). Other profiles do not load
Video.js; no duplicate page polyfill or full polyfill copy in VHS workers is added.

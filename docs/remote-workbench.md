# Remote diagnostic workbench

The workbench extends an existing remote-control connection. It needs no second
permission switch or temporary screenshot grant. Local parental restrictions,
browser screen-selection requirements and platform capabilities still apply.

Install the CLI, controller and player separately. The controller's
[CLI installation guide](https://github.com/open-ott-play/ottplay-control-server/blob/main/docs/cli.md#installation-and-connection)
provides a pinned source installation. Keep the complete `cli/` directory from
one revision together, including the offline report verifier. Stable CLI v0.1.0
does not contain this workbench. Updating a launcher or running `restart` does not
install a new player.
For a local Mac installation, use the
[delivery and recovery runbook](macos-local-delivery.md); verify the loaded
runtime after the files have been replaced.

Use a controller and player that implement `inspect` v1, and replace `l`/`a1`
below with your registered aliases. Each report path must be a new directory
inside an existing parent:

```sh
ott l doctor
ott l debug --json
ott l inspect --view ui,media --json
ott a1 inspect --lane native --json
ott l bundle --out ./lg-case
ott l test run health --report ./lg-health
ott -t 45 l test run media-progress --duration 5 --report ./lg-progress
ott -t 45 a1 test run media-progress --lane native --duration 5 --report ./android-progress
ott report verify ./lg-progress --json
ott report verify ./android-progress --json
```

See the controller's [workbench reference](https://github.com/open-ott-play/ottplay-control-server/blob/main/docs/workbench.md)
for installation, native-agent binding, request receipts, exit codes and examples.
`health` tests collection and management availability. `media-progress` compares
two samples from the same runtime, media generation and decoder handle. Neither
test proves that pixels appeared on the physical TV, that sound was audible, or
that a specific requested movie played. User input between samples can affect
the observation; the runner does not acquire exclusive ownership.

The native lane in these examples requires a separately provisioned Android
maintenance agent. It is not a generic native inspector for Tauri, LG or iOS.
Without that binding, `not_bound` is expected. Offline verification needs no
controller or credentials: it validates the export and recomputes the verdict,
but does not authenticate the report's origin.

For an intentionally requested reload, retain its request ID and inspect the
receipt instead of repeating the effect:

```sh
ott --receipt l restart
# Replace the example ID with request_id from the JSON line on stderr.
ott l operation 0123456789abcdef0123456789abcdef --json
```

Web receipt history is lost on reload, so this lookup may return `unknown` even
when the reload succeeded. Check the new runtime with `doctor`; an
`accepted`/`handler_completed` receipt alone does not establish that playback
recovered. The Android agent's separate durable history is described in the
controller's workbench reference.

For cross-platform runtime/native snapshots, the bounded event history and server
counters, see [Runtime diagnostics](runtime-debug.md).

## What the player exposes

`collectRemoteDoctor` projects a bounded, synchronous snapshot: owned UI pane,
focus category, document and CSS visibility, pane/video rectangles, decoder
readiness, playback generation, lane handle and position. It never exports DOM
text, HTML, media URLs, titles, settings, credentials or arbitrary JavaScript.
It never creates a backend, samples a decoder, reconciles playback, captures a
screen or writes storage. The UI and playback revisions are checked around
collection so a changing observation is marked inconsistent.

Capability reasons use the control implementation's policy checks. A supported
restart is an eligible attempt; execution still rechecks ownership and policy.
Live-stream recovery remains eligible during loading/error. Screenshot inspection
uses a pure cached `peek` and does not start or stop screen sharing.

Build version, source revision and a content identifier are embedded in the
loaded bundle. Fetching a newer `build-info.json` cannot change this identity.
The `bundle-` identifier hashes the compiled input before identity insertion and
minification; it is not a hash of the downloadable asset. A clean Git checkout or
an exact frozen release version overlay retains its source revision. The overlay
must match the current commit, its committed policy and every declared version
input, with no staged or unrelated changes; a release receipt alone is not proof.
Builds with a frozen release plan or `RELEASE_CHANNEL` fail if that source identity
cannot be verified. CI checks the committed media runtime before building: after
updating dependencies, run `npm ci --ignore-scripts`, `npm run build:media` and
`npm run check:media`, then commit the generated assets and bootstrap references
alongside the lockfile. A release build must not silently rebuild stale tracked
assets and publish a partial identity.

Ordinary dirty development worktrees and source archives without Git metadata
report a partial source identity. The Docker frontend is built from a source
archive; its OCI revision labels and release receipts supply the separate source
binding. Compare downloadable bytes against the release manifest when checking
delivery.

## Transport and operation receipts

The optional `caps.inspect` extension advertises `doctor`, `snapshot`, and
`operation`. These read-only requests use protocol 1 with an explicit page runtime.
The controller binds successful, negative and replayed responses to the requested
runtime and section. Updated players leave another runtime's inspection queued.
This is response validation, not a new authentication mechanism or exclusive
routing for existing protocol-1 mutation commands.

The operation journal holds at most 128 request IDs. It stores action names and
receipt stages, never parameters or raw errors. `accepted` means an after-ACK
effect was queued; it does not establish that the effect is still pending. A
disconnect or ACK deadline can discard the effect without updating that
receipt. An HTTP 404 response to the result post also discards the pending effect
without updating that receipt. `invoked` means the handler ran; the handler can still
decline its effect if policy or ownership changed. The current journal does not
emit `observed`: a moving decoder could belong to a later command or a local
seek. A retained receipt reports `expired` after ten minutes. Eviction or reload
loses this in-memory history; `unknown` does not mean that an earlier command was
not executed. Never replay a mutation automatically after losing its response.

An older player without `caps.inspect` is reported as unsupported. An older
controller that rejects the new action is reported as `unsupported_controller`.
Web and separately provisioned native-agent observations remain separate lanes.

## Development checks

`npm run test:diagnostics` covers pure collection, bounds, receipt stages, expiry,
loaded build identity and the existing diagnostics implementation. The real
Chromium cases in `tests/browser/remote-doctor.spec.cjs` exercise CSS visibility,
owned panes and the production dispatcher after a server build.

For a cross-repository test, build the changed controller, then run from the
player repository:

```sh
OTT_CONTROL_BINARY=/absolute/path/to/ottplay-control-server \
OTT_CLI=/absolute/path/to/ottplay-control-server/cli/ott.py \
node scripts/smoke-workbench.cjs
```

This runs a real Go controller, compiled TypeScript handlers and the Python CLI
against a synthetic media host. It checks wrong-runtime rejection, unchanged
pending requests, CLI scenarios and private evidence bundles. It does not test
LG firmware, Android hardware or physical presentation.

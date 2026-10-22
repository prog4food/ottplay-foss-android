# Remote diagnostics

An enabled controller connection authorizes scoped operator access to structured playback,
network, input and EPG observations and two typed repair actions. Diagnostic protocol 2 uses the
existing outbound HTTPS connection to the command server; it opens no listener
on the player. Existing protocol 1 commands and repairs remain compatible.

## Connect and inspect

1. Configure the command server's diagnostic operator and enable diagnostics for
   the exact device. Operator scopes remain separate from the player's device
   access code and the legacy administrator credential.
2. In the player, connect through **Settings → Remote control** to the HTTPS
   command server. This connection authorizes diagnostics, supported repairs and
   screenshots. No separate temporary grant or trusted-support switch is needed.
   Existing enabled connections are authorized automatically on upgrade/restart.
3. Use `ott diagnostics --help` or `cli/diagnostics_mcp.py`. Discover the exact
   `runtime_id`, `consent.epoch` and `server_epoch`, then start a capture with an
   idempotency key. These epoch names remain wire-protocol concurrency fields;
   they do not represent a second user approval. A start receipt means queued;
   `active` confirms that the player applied it.
4. **Stop current capture**, the active capture indicator or the operator stop API
   stops that collection session while retaining the configured connection.
   **Disconnect** revokes the controller's access. A queued stop is distinguished
   from a confirmed device stop by `device_stop_confirmed`.

Each collection session retains its ten-minute resource limit, byte/event/rate
budgets and connectivity lease. The connection's authorization has no ten-minute
expiry. A later collection session needs a new operator request, not another
local approval. Kiosk STOP ends the current collection without unlocking kiosk
policy or revoking the connection.

Authorization follows the saved enabled controller address and device credential.
Changing or disabling them cancels the old runtime, pending requests and repairs.
A newly configured connection is authorized by that configuration. A page reload,
process restart or network recovery creates a fresh runtime and epoch; operators
must rediscover it. Runtime credentials, captures and repair commands are not
persisted. Old screenshot/diagnostic permission records no longer grant or revoke
access and are not needed for startup. An unavailable permission database cannot
block an otherwise valid controller connection.

Counters can be collected in a background page while its runtime is executing.
Offline state, page teardown or OS suspension can interrupt collection; recovery
registers automatically with bounded backoff. The local HUD still has independent
ownership. Ending a remote session does not disable a locally enabled HUD.
`window.__ottDebug.disable()` stops all logger consumers and instrumentation.

## What is observed

- Playback state and finite media counters: position, buffer ahead, dimensions,
  dropped frames, stalls, waiting, error/recovery counts and media error codes.
- Observed HLS fragment byte/latency counters and HTTP error status, with late
  attachment to an already-running HLS instance.
- LG input delivery counts and optional producer-owned EPG availability. These
  are advertised only when their snapshot adapter is available; a missing
  observation is not represented as a measured zero.

The remote event schema excludes URLs, provider/account configuration, headers,
credentials, key text, coordinates, raw console lines, stacks, DOM and images.
Remote screenshots use a separate protocol-1 command authorized by the same
controller connection; see [Remote screenshots](remote-command-server.md#remote-screenshots).
Images are not diagnostic events or attachments. Browser capture still requires
the browser's source picker.
Collection and server retention have independent byte/event/rate bounds, and
readers receive sequence gaps and drop counters. Diagnostic delivery uses a
separate control loop and upload lane, so a pending legacy command or upload
cannot block an ordinary remote stop. A ten-second connectivity lease stops
capture if successful control polls cease. A blocked JS event loop can delay
local timers; no browser-side agent can guarantee stop latency in that case.

Each registration receives its own server-issued credential kept in that
runtime's memory. Two tabs sharing the same configured device credential remain
separate diagnostic targets, even with identical metadata. Runtime IDs and
reported UUIDs are selectors, not authentication. Process restarts invalidate
old credentials and operator mutations require the discovered server epoch.

## Repair and platform coverage

Existing `ott PLAYER restart stream`, `ott PLAYER restart player`, profile and
playback commands remain the typed repair interface. They use the existing
protocol 1 device queue. Diagnostic runtime selection does not make that legacy
queue tab-specific: avoid sharing a command credential across independent
players when applying repairs. An unknown mutation result is not permission to
blindly repeat it.

For exact runtime targeting use `ott diagnostics repair` or the MCP tool
`diagnostics_repair`, with `restart_stream` or `reload_player`. The runtime must
advertise `repairs`; the operator needs `repairs.start` and `repairs.read` to inspect
the receipt with `diagnostics_repair_status`. Every request names its runtime,
consent epoch, server epoch, idempotency key and a deadline of at most 30 seconds.
The existing owned-backend and parental guards still apply. Stream restart
`applied` means the effect was invoked, not that playback recovered. Player reload
is dispatched only after its `accepted` result reaches the server and the exact
ACK reaches the still-authorized client. That receipt does not prove a completed
reload; rediscover the new runtime and inspect new observations. A newer repair
can supersede an older unacknowledged intent. Unknown outcomes must not be
blindly repeated, even after a receipt expires.

The MCP adapter exposes discovery, capture, status, events, stop, revocation
and these two repairs. It has no arbitrary JavaScript execution,
shell, native invocation, file access or general HTTP request tool.

Browser, LG webOS, Tauri and Capacitor use the same frontend diagnostic lifecycle.
Native platforms reuse their existing protected HTTP bridge. The separate [runtime diagnostics](runtime-debug.md) command adds native
app/process observations and server counters. Protocol-2 streaming events remain
frontend observations; arbitrary OS logs and complete native decoder internals
are not included. Older WebViews
without the required monotonic clock or secure transport report unavailable.
Local Chrome DevTools, webOS inspection and native debugging remain useful for
those deeper cases.

Runtime instance labels include a bounded platform/build prefix to distinguish
browser, webOS, Tauri and Capacitor instances without sending raw user agents,
device names or URLs. Labels are informational; server-issued runtime credentials
remain the authority.

## Verification and operation

`npm run test:diagnostics` exercises the real logger, LG input lifecycle, bounded
buffer, transport and connection authorization controller with deterministic clocks and
synthetic transports. Existing redaction, settings navigation, transport and
bundle tests remain enabled. All diagnostic code must also pass ES5 output,
localization, type, lint and measured bundle-size checks.

Cross-repository acceptance uses actual Go, HTTPS with a temporary trusted test
CA, the production TS secure transport, two runtimes, Python CLI and stdio MCP:

```sh
OTT_CONTROL_BINARY=/absolute/path/to/ottplay-control-server \
OTT_DIAGNOSTICS_CLI=/absolute/path/to/control/cli/diagnostics.py \
node scripts/smoke-diagnostics.cjs
```

This test has no real provider, installed player or persistent user credential.
It includes exact-runtime stream/reload repairs and lost result acknowledgements.
The required CI workflow runs both cross-repository smoke tests against a pinned
control-server commit. Chromium acceptance tests exercise the production bundle,
automatic connection authorization, settings navigation, reload and offline recovery.
Run the existing `scripts/smoke-remote-cli.cjs` separately to verify legacy repairs.
Deterministic tests and builds do not substitute for hardware-specific release
canaries. Record the exact app/server versions and platform for each such run.
Deploy server support before exposing the player feature; diagnostics defaults
to disabled. Disabling the per-device server setting and restarting the server
revokes runtime credentials. Older server builds leave protocol 1 operational,
while diagnostic registration backs off or reports that the controller needs an update.

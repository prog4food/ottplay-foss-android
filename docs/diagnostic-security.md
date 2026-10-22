# Playback diagnostics

The HUD and in-memory event ring can be enabled with the existing `?debug=1`
setting. Server persistence is a separate opt-in: set `OTTPLAY_DEBUG=1` before
starting `ottplay-server`, or create `debug.enabled` in its working directory.
Without that opt-in, ingest and diagnostic reads return 403 and create no files.

All diagnostic reads and writes require `Authorization: Bearer ...` matching
`OTTPLAY_DEBUG_TOKEN`, a random value of at least 32 printable ASCII characters
without spaces. This includes loopback connections: a reverse proxy can look
like a local client. Host, Origin and forwarded headers never establish trust.
`/debug/config` reports `enabled: false` to unauthorized clients.

The token is operator configuration: do not put it in URLs, repositories or
publicly served frontend assets. A reverse proxy must authenticate clients before
injecting this header. Setting a token does not itself enable server persistence.
Ordinary playback and the local HUD work without a token.

For browser diagnostics, set the same token in that tab's session storage using
the developer console, then reload:

```js
sessionStorage.setItem("ottplay_debug_token", "YOUR_RANDOM_SERVER_TOKEN");
```

The client reads the token only for the Authorization header, never adds it to
event payloads, and uses authenticated fetch or XHR for normal and unload sends.
Without a valid token, events remain available in the local ring but are not sent
to the server. Remove the session-storage entry when finished. Use HTTPS for
remote diagnostics.

Diagnostic URLs retain only the server origin. Paths, query strings, fragments,
userinfo, credential fields and authorization values are removed before writing.
The frontend also removes them before adding events to its ring, pending queue or
dump. Server-side filtering applies independently to incoming JSON and to reads of
pre-upgrade logs. This intentionally hides URL paths that may contain Xtream
usernames and passwords.

Limits:

- 256 KiB per HTTP ingest and per serialized batch; at most 500 events.
- The client sends batches of at most 500 events and 60 KiB, including UTF-8
  encoding. Network errors, HTTP 429 and 5xx are retried within the bounded
  800-event queue. An individual event larger than the send budget stays local.
- 20 MiB live log with one rotated backup.
- 100 MiB total diagnostic archive; files older than seven days are removed on
  the next write, then the oldest remaining files are removed as needed.
- Only `debug-playback-*.jsonl` and `debug-playback-*.log` regular files are pruned.
  Unrelated files and symlinks are not deleted. New logs use mode 0600 on Unix.

`OTTPLAY_DEBUG_ARCHIVE` retains its existing archive-directory override. The
archive no longer duplicates every rotated live log, because events are already
stored in its daily JSONL files.

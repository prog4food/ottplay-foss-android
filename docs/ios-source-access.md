# Protected media sources on iOS

The iOS app supports a source-specific Cloudflare Access sign-in through the
system browser (`ASWebAuthenticationSession`). It works with unsigned/AltServer
builds: no associated-domain entitlement, embedded client secret, or custom
passkey implementation is required. The identity provider owns passkey and
recovery verification.

When a playlist request receives an authentication failure, the app checks
`https://<source>/_ottplay/public/config`. Playback also performs discovery once
per HTTPS origin, including when the channel list was restored from a cache.
Sources without this endpoint keep their normal transport. Definitive absence
is cached for five minutes; transient network/server failures retry after ten
seconds. Concurrent discovery and sign-in requests share one operation. An
unknown media alias must present a contract matching one fetched directly from
its claimed source, so it cannot overwrite another source's trusted mapping.

After signing in, playback and native HTTP/EPG downloads share a native session.
Settings → Manage settings → **Source access** offers sign-in and local sign-out.
Local sign-out removes the app's credentials, cancels pending sign-in and stops
its media listener; delayed browser/network completions cannot restore it. It
does not log the user out of Safari or revoke the identity provider's session.

## Trusted networks

When discovery names a separate mobile origin, the app first requests the
original source without cookies, authorization headers or stored credentials.
This also applies when an Access session is already saved. The source server
decides whether the current public IPv4 or IPv6 address is allowed; the app does
not infer trust from a Wi-Fi name or from the public discovery endpoint.

An access denial or Cloudflare challenge switches that request to the mobile
origin and reuses or obtains the Access session. Ordinary missing content,
server errors and network failures do not open sign-in. Successful HTML replies
are rejected rather than forwarded as a playlist or video. Explicit **Source
access → Sign in** still opens the interactive login when requested.

Playback preparation checks the actual source GET response headers, cancelling
the body immediately, before starting a decoder that may have a short startup
timeout. Recent successful source downloads avoid this extra check for 20
seconds. A denied route is remembered for at most 30 seconds to avoid a rejected
request for every media segment. Network changes and foregrounding clear these
routing hints; an expired saved session also causes a fresh source attempt before
interactive renewal. Late responses from a previous network cannot change the
current routing preference.

Both routes retain the loopback listener, so later HLS playlists, segments and
keys can fall back after leaving a trusted network. Every source request is
still checked by the server. A switch requiring sign-in may interrupt playback
until the app is foregrounded and login completes. No Cloudflare Access Bypass
policy or change to the origin's JWT validation is required.

## Server contract, version 1

The public discovery JSON contains:

```json
{
  "version": 1,
  "source_origin": "https://media.example.com",
  "media_origin": "https://mobile-media.example.com",
  "authorize_path": "/_ottplay/authorize",
  "exchange_path": "/_ottplay/public/exchange",
  "callback": "ottplay-access://callback"
}
```

Discovery must come from the configured source's HTTPS origin. A separate
mobile origin lets existing TV clients retain their network-based access.
The mobile origin must protect all media paths with Access and validate its
application audience at the origin/Tunnel. Only `/_ottplay/public/*` is public;
it must be served by the auth broker, with a fail-closed origin fallback.

The app opens `authorize_path` with independent 256-bit `state` and PKCE S256
challenge values. The authenticated broker returns a random single-use code
to the **fixed** callback scheme, plus the original state. Codes expire after
90 seconds. The native client POSTs `{code, verifier}` as JSON to the exchange
endpoint. The broker atomically consumes the code only after verifying PKCE.

The JSON response is `{token, expires_at, media_origin}`, where `token` is an
Access application JWT for that exact media origin, `expires_at` is its Unix
expiry, and the session has at most 24 hours remaining. The broker must validate
the Access signature, issuer, audience, expiry and permitted identity before
issuing a code. A binding cookie is incompatible with this cookie transfer;
keep HttpOnly enabled and disable binding cookies for this dedicated app.

## Native boundary

Credentials are kept in device-only Keychain storage and are never returned
to JavaScript, exported settings or playlist URLs. Protected requests use an
ephemeral URLSession without ambient cookies or credential storage; redirects
may stay only within the same HTTPS origin. Concurrent requests share login,
and expiry/rejection permits one renewal attempt. Interactive renewal requires
the app to be foregrounded; after a background expiry, open the app and reload
the channel.

The HTML5/AVPlayer HLS loaders use a random-port listener bound only to
`127.0.0.1`. Every URL contains a fresh per-launch random capability. Host,
Origin, method, headers and source origin are checked; the listener forwards
only to discovered source/media origins. Manifests rewrite relative and
same-source absolute URIs, including variants, audio, subtitles, keys, init
maps, parts and preload hints. Other HTTPS origins retain their original URLs
and never receive an Access cookie. Network-path references (`//cdn/path`) are
resolved against the upstream manifest, preserving HTTPS and signed queries
when AVPlayer reads the rewritten manifest over local HTTP.
Binary media is streamed with backpressure;
HEAD, byte ranges and content ranges are preserved. A single isolated upstream
session reuses its connection pool, with credentials and redirect decisions
scoped to each task. Low-latency HLS reload directives reach upstream without
rewriting the original signed query. Upstream manifest buffering is bounded to
2 MiB, and rewritten output to 8 MiB. Rewriting stops at the output limit rather
than first allocating every expanded URL; long manifests within that separate
budget remain supported.
Loopback URLs are not saved as channel identities; reconnects prepare the
original source again.

Native PiP uses the same preparation outside its native command queue, so Stop
does not wait for an open sign-in prompt. Replacing a playing channel retires
its decoder even while the next channel waits for sign-in. Failed sign-in never
starts a CSS fallback; a native playback failure after successful preparation
passes the authenticated URL to that fallback. EPG uses an injected native transport
while retaining original source/cache keys. Direct AirPlay receivers cannot
consume the phone's loopback URL; remote receiver playback needs a separate
authenticated transport. Web/Android/TV/desktop builds do not acquire iOS
source sessions.

Stopping playback or replacing a channel cancels its pending native preparation.
Other consumers of the same sign-in continue; cancelling the last consumer
closes the browser and cancels the exchange. Late callbacks cannot save a token
or restart playback. Closing a proxy connection also cancels its pending
authorization. A clean TCP write-half-close remains supported, with the existing
request deadlines bounding connections whose peer cannot be distinguished from
a client waiting for its response.

Native HTTP retains each request's network timeout and allows up to five extra
minutes for discovery and interactive sign-in, with an overall deadline.
Aborting or timing out an iOS playlist/provider AJAX request cancels that
request's native work and login waiter, while other consumers continue.
Signing out cancels protected downloads already in progress. Manual sign-in
from **Source access** is independent of a download's deadline and remains
available when entering an email code needs longer than an AJAX caller allows.

Native text responses with invalid UTF-8 fail explicitly instead of becoming
empty successful responses. The M3U loader rejects empty bodies and obvious
HTML/JSON responses with a playlist-processing error; a valid empty M3U remains
an empty catalogue. Neither error includes the response body or source credentials.

## Verification

`python3 tests/test_ios_access_media.py` compiles the real Swift policy and
loopback transport and exercises PKCE/state validation, manifest/key/map
rewrites, chunk boundaries, binary streaming, Range, HEAD and unauthorized
loopback requests. Native parity CI runs it. Playback tests cover asynchronous
login completion after channel changes, stop and cancellation. Existing proxy,
EPG and native bridge suites still apply.
It also covers credential-free source playback, source-to-mobile fallback,
bounded renewal, signed queries and ranges across routes, rejected HTML, and
headers-only probes that cancel large or unfinished upstream responses.

After deployment, verify a real device over cellular: load a protected playlist,
complete passkey login, play/switch/seek channels, exercise native PiP, restart
the app, sign out, cancel a login, and test the configured recovery path. Unit
fixtures and an unsigned build do not establish successful biometric login
or provider playback on an iPhone.
Also verify a trusted network without a saved login, then switch between Wi-Fi
and cellular during playback. Include IPv6 in the server's trusted list when
that is the address family the phone actually uses.

`python3 tests/test_ios_access_auth.py` exercises the actual authentication code
with deterministic OS/network fixtures: concurrent discovery/login/renewal,
saved-session reuse, source/alias trust, failed browser start, cancellation
without an OS callback, and delayed callbacks/exchange after logout. This fixture
does not invoke the real system browser or Keychain.

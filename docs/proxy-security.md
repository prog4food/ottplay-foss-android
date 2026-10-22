# Playlist proxy security

The shared Rust `m3u::proxy_stream` (Mode A `/m3u/cp.php` and Tauri
`proxy_fetch`) and archived Python `/m3u/cp.php` accept HTTP and HTTPS
provider URLs. They reject local files and non-public destinations by default.
This policy does not change native `proxy_http`, user-configured XMLTV fetches,
or the application's direct media transport.

Before every connection, including every redirect, all DNS answers are checked.
A mixed public/private answer set fails closed. The transport connects to those
checked numeric addresses without a second DNS lookup. It preserves the original
Host header, TLS SNI and certificate validation. URL Basic credentials survive
relative and absolute redirects within the exact same origin; another host, port
or an HTTPS downgrade does not inherit them. Environment HTTP/SOCKS proxy
settings are ignored for this endpoint, because their DNS or routing could evade
the destination check.

Loopback, link-local, unspecified, multicast, documentation and other special-use
ranges are blocked. IPv4-mapped IPv6 addresses receive the corresponding IPv4
check; NAT64 and 6to4 forms do not bypass the private-address boundary. DNS names
that resolve to private addresses are blocked, even if another allowed LAN
origin points to that address.

## Explicit LAN providers

`OTTPLAY_PROXY_LAN_ORIGINS` defaults to empty. An operator may explicitly add
comma-separated exact origins with literal RFC1918 IPv4 or ULA IPv6 addresses:

```text
OTTPLAY_PROXY_LAN_ORIGINS=http://192.168.1.20:8080,https://[fd00::20]:8443
```

This is a configuration example; installation scripts do not enable it. Scheme,
address and effective port must match. An omitted port means HTTP 80 or HTTPS
443. DNS names, wildcards, CIDR ranges, URL credentials, query strings and path
prefixes are not accepted. Loopback and link-local addresses remain forbidden,
including when listed explicitly. Invalid configuration fails closed.

**A LAN opt-in trusts the users of this proxy endpoint.** If other clients can
reach the server, put the endpoint behind reverse-proxy authentication or a
network ACL before enabling a LAN origin. Every accessible path on the listed
origin becomes readable through the proxy. The list does not establish a new
per-user authorization boundary. Use a dedicated playlist service and its narrow
port rather than an administrative server. This is also relevant to redirects
from a public provider to an explicitly listed LAN origin.

Existing public HTTP(S) playlists and User-Agent presets keep working. LAN
playlists that previously relied on unrestricted proxy access need this explicit
configuration; a loopback companion should use a direct trusted application
transport instead. The old loopback-only header smoke cannot be used against the
hardened public proxy; use the isolated transport tests below, or an intentionally
configured dedicated LAN fixture. Do not add a loopback exemption for that smoke.

## Resource limits

Both implementations accept at most eight simultaneous proxy operations and
reject excess work immediately. Bodies are limited to 16 MiB, including chunked
responses without Content-Length, and redirects to five hops. The Python
endpoint additionally limits the incoming form to 64 KiB and rejects conflicting
or malformed framing.

Rust applies a 60-second total deadline to playlist fetches across DNS, redirects
and response reads. The browser retains a 5-second direct attempt before its
65-second proxy fallback, allowing the server to finish and report failures.
Stalker and VPortal API operations retain their separate 15-second deadline.
Separate DNS slots stay held until an underlying system lookup actually finishes,
even when its caller times out. Python retains its 15-second network budget and closes
an active socket when the deadline expires; its synchronous system DNS lookup
remains subject to the operating system's DNS timeout and keeps its concurrency
slot until it returns. Neither implementation logs complete proxy URLs or returns
URL-bearing transport errors.

Mode A buffers the bounded upstream body and lets its HTTP server generate new
response framing. It forwards only Content-Type and Content-Encoding from the
upstream response; compressed bytes remain unchanged so the browser can decode
them. Provider cookies and connection headers never become local-origin headers.
The response always supplies local `Content-Security-Policy: sandbox` and
`X-Content-Type-Options: nosniff` headers. A form POST that navigates to upstream
HTML cannot execute its scripts or access the player's origin in CSP-capable
browsers; XHR still receives the unchanged playlist text.

The Python fallback now requires `archive/proxy_security.py` alongside
`archive/server.py`. Run or distribute the two files together.

## Verification

```sh
cargo test -p ottplay-core proxy::tests
cargo test -p ottplay-server cp_proxy_tests
PYTHONDONTWRITEBYTECODE=1 python3 tests/test_proxy_security.py
```

The tests exercise private/mapped/numeric destinations, mixed DNS records, exact
LAN origins, address pinning with a nonresolving hostname, redirect checks,
Content-Length and chunked byte limits, concurrency-slot cleanup and the Python
handler's dummy `file://` regression. Network fixtures bind temporary loopback
ports and inject their addresses at the checked-transport boundary; the production
policy itself never enables loopback. They do not contact live providers or test
physical devices. The existing Mode A endpoint keeps its error status contract:
proxy-policy and upstream failures are HTTP 502 with no provider credentials.

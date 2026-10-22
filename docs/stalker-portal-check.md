# Checking a Stalker portal

`scripts/check-stalker-portal.cjs` checks one account supplied in a local JSON
file. It uses the same shared protocol core as the player and requires Node.js
22 or later. Run it from a repository checkout with its `vendor/` directory;
no npm packages, running player or OTT server are required.

Copy `scripts/stalker-portal.example.json` to a private file outside the checkout,
set its permissions to `600`, and fill in the URL and MAC for your own account:

```json
{
  "portal": "https://portal.example/c/",
  "mac": "02:00:00:00:00:01"
}
```

```sh
node scripts/check-stalker-portal.cjs --input /private/my-portal.json
```

The input also accepts `server` instead of `portal`, an OTT provider configuration
`{"provider":"stalker","settings":{"server":"…","mac":"…"}}`, or the saved
Stalker `{ "active": 0, "portals": [...] }` configuration. For saved profiles, the
active slot is checked by default; `--profile 3` selects profile 3. Only one slot
is checked per invocation. The input file is never modified.

## What the check establishes

- HTTP connectivity and a valid protocol response.
- Classic MAG handshake and profile acceptance, or the legacy JSON-RPC handshake.
- Successful catalog retrieval, including the player's bulk-to-page fallback.
- The number of live channels and groups. The synthetic VOD folder is excluded.

The default protocol is selected like the player: `/c/`, `/c/index.html`,
`/stalker_portal`, `load.php` and `portal.php` use classic MAG; other roots use
legacy JSON-RPC. Override with `--protocol classic` or `--protocol legacy` if
necessary. Classic requests use the player's default MAG250 profile.

The JSON report contains `ok`, `code`, `stage`, `protocol`, `reachable`,
`http_status`, `authentication`, `channels`, `groups`, `requests` and
`elapsed_ms`. It omits URLs, MACs, bearer tokens, response bodies and channel
names. `ok: true` requires a nonempty live catalog. A token alone is insufficient.
An empty handshake is retried once, as in the player.

`playback` is always `not_checked`: the script does not request temporary stream
links or play media. It connects directly from this machine; browser CORS,
OTT relay routing and connectivity from other devices require separate checks.
It does not install profiles, alter the private OTT preset store or contact
players.

## Limits and failures

Defaults: 15 seconds per HTTP request, a 60-second overall check budget,
32 requests and 8 MiB per response. Both supported protocols remain bounded.

```sh
node scripts/check-stalker-portal.cjs --input /private/my-portal.json \
  --timeout 15 --deadline 120 --max-requests 64
```

Maximum options are 60 seconds per request, 300 seconds overall and 200 requests.
Input must be a regular file and is limited to 256 KiB. Redirects are reported
without following them, so credentials cannot be forwarded to another destination.
HTTPS requests verify TLS certificates. HTTP URLs are also accepted: the account
MAC is sent in cleartext, as is the bearer token for classic requests. Use HTTPS
to protect these credentials. No session data is written to disk.

Common result codes:

- `catalog_ok`: account accepted and at least one live channel returned.
- `empty_catalog`: account accepted, but no live channels returned.
- `access_denied` / `authentication_rejected`: HTTP 401/403 or protocol rejection.
- `handshake_rejected`: no usable handshake; account acceptance is unverified.
- `invalid_json`: HTTP answered, but the body was not valid JSON.
- `redirect`: use the correct endpoint supplied by your provider.
- `http_error`, `dns_error`, `tls_error`, `connection_error`: transport failure.
- `timeout`, `deadline`, `request_limit`, `response_too_large`: the check exceeded
  a bound; this does not establish that the account is invalid.
- `response_interrupted`: the server closed the response before it finished.

Exit codes: `0` for a nonempty catalog, `1` for an unsuccessful check, and `2` for
CLI/file errors. Invalid account configuration is reported as a check failure.
Invalid command options are rejected before the input file is opened or any
request is sent.

Offline regression tests use only a loopback fixture server:

```sh
node --test tests/test_stalker_portal_check.cjs
```

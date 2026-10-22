# Hosted EPG service v1

`EPG_ONLY=true` runs the Rust server as a restricted public guide service. It
exposes only `/health`, `/epg/v1/health`, `/epg/v1/match`, `/epg/v1/current` and
`/epg/v1/programmes`. The ordinary server is unchanged when this variable is
absent or false. Bind/TLS flags retain their existing behavior.

The administrator-owned source is `epg-one`, fixed to
`https://cdn.epg.one/epg2.xml.gz`. If `EPG_URLS` is supplied in this mode it must
be exactly that URL. HTTP redirects are disabled. Clients cannot submit feed,
playlist, stream or proxy URLs. No playlist session or provider credentials are
stored. The intended public ingress forwards only the match, current and programmes
routes; keep the health routes internal. A same-origin here.now proxy avoids a
cross-origin dependency on LG. This API does not enable CORS itself.

## Matching

`POST /epg/v1/match` accepts JSON:

```json
{"version":1,"source":"epg-one","channels":[{"id":"0","tvgId":"hlsproxy-382","tvgName":"","name":"РЕН ТВ HD"}]}
```

All four channel fields are strings, with at most 512 UTF-16 code units each.
Local `id` must be nonempty and unique. A batch contains at most 2048 channels;
HTTP body limit is 512 KiB. Unknown fields and sources are rejected.

Matching has an eight-second server deadline after JSON validation, including
waiting for the shared matcher. At most two requests are admitted and only one
enters that matcher at a time; the other waits asynchronously. Expiry returns
504 `EPG_TIMEOUT`, never partial mappings or an empty success. Dropping the HTTP
request cancels its work. The web runtime checks cancellation and the deadline
inside JavaScript as well as between channels; its temporary budget is cleared
before another call can use the context. Admission remains held until running
work actually stops. This does not evict or change the accepted EPG snapshot.

```json
{"version":1,"source":"epg-one","generation":"opaque","fetchedAt":1790685238000,"refreshMs":7200000,"stale":false,"mappings":{"0":{"channelId":"18","shift":0,"logo":"https://cdn.epg.one/example.png"}}}
```

Unmatched entries are omitted. `channelId` is the canonical XMLTV ID, stable
across client sessions. The pinned shared core's **web** matcher resolves
`tvgId`, then `tvgName`, then `name`, retaining ordered display aliases and
exact-ID precedence. Duplicate display aliases retain the web profile's first
match; the native server's different alias policy is not substituted.
`shift` is inferred from `name` and is measured in **seconds**.

## Current programme search

`POST /epg/v1/current` matches a client channel catalog and searches its current
programme titles in one accepted snapshot:

```json
{"version":1,"source":"epg-one","channels":[{"id":"local-42","tvgId":"18","tvgName":"","name":"РЕН ТВ HD","shift":0}],"search":"передача"}
```

The channel metadata, unique local IDs, 2048-channel maximum and 512 KiB request
body limit are the same as matching. Every channel additionally requires
`shift`, an integer number of **seconds** in [-86400, 86400]. This is the
player's separate provider `row.ts` adjustment, added to the name-inferred
shift exactly once. `search` is a required string of at most 1024 UTF-8 bytes;
an empty string returns every nonempty current title. Unknown fields and
sources are rejected, including feed, playlist and stream URL fields.

```json
{"version":1,"source":"epg-one","generation":"opaque","fetchedAt":1790685238000,"refreshMs":7200000,"asOf":1790685238,"stale":false,"checked":1,"total":1,"programs":[{"id":"local-42","start":1790683200,"end":1790686800,"title":"Передача"}]}
```

`asOf`, `start` and `end` are Unix seconds; `fetchedAt` remains milliseconds.
All channels use that single `asOf` and snapshot `generation`, even if refresh
publishes a new snapshot during the request. `checked` and `total` both count
every submitted channel, including unmatched channels and those without EPG.
Results preserve input order and contain only local IDs, shifted intervals and
titles. Descriptions, logos, stream URLs and provider credentials are absent.

Current selection follows the shared guide: `start <= asOf < end`, preferring
the latest start and the first valid stored row when starts tie. Selection
uses the sorted schedule directly without cloning its full programme window.
An empty current title is omitted instead of falling back to an older show.
Search is a case-insensitive substring comparison using the player's caseless
key (lowercase then uppercase, preserving dotless `ı`). Tests pin all Unicode
17 default case-fold equivalences. No accent removal, `ё`/`е` substitution,
whitespace collapsing or Unicode normalization is applied.

Current search shares matching's two admission slots, single execution slot,
eight-second deadline and disconnect cancellation. It returns a complete result
or an error, never partial rows. The complete encoded JSON response is capped
at **2 MiB**, including escaped strings; exceeding it returns 422
`EPG_CHANNEL_LIMIT`. Narrow the search or channel selection before retrying.
`stale` is explicit, and clients should not automatically tune from stale
results. This fixed-source endpoint does not substitute for another provider's
private guide or a custom XMLTV feed.

## Programmes

`GET /epg/v1/programmes?channelId=18&shift=0&hours=168&generation=opaque`

All four parameters are required; extra parameters are rejected. `shift` is an
integer multiple of 3600 in [-86400, 86400]. `hours` is an integer in [0, 8784];
zero means 48 hours of history. The future window is always 48 hours.
`generation` must be copied from the match response.

```json
{"version":1,"source":"epg-one","generation":"opaque","fetchedAt":1790685238000,"refreshMs":7200000,"stale":false,"rows":[{"time":1790683200,"time_to":1790686800,"name":"Передача","descr":"Описание","icon":""}]}
```

`time` and `time_to` are Unix **seconds**. The response already includes the
inferred `shift`, exactly once. The player alone applies its separate provider
`row.ts` adjustment. `fetchedAt` is Unix **milliseconds**, recording completion
of the accepted download. Selection uses overlap with `[now-history, now+48h)`;
rows ending exactly at the lower boundary or starting at the upper boundary
are excluded. Rows sort stably by start, then stop, retaining duplicates and
full descriptions. A known channel with no matching programmes returns an
empty array. Per-channel limits are 20,000 rows and an 8 MiB decoded record
budget; exceeding them fails the request instead of returning partial history.
At most four programme requests are admitted. Disconnecting while work is still
queued returns its admission slot immediately, even if the blocking worker pool
is occupied. Once processing starts, the worker retains that slot until it
finishes. Programme requests do not inherit the match endpoint's deadline.

Browser XMLTV record behavior is preserved using native token parsing:
first metadata for a channel, all aliases in input order, first nonempty title
and description, explicit XMLTV timezones, 12/14-digit dates, and strict valid
intervals. Malformed dates and nonpositive intervals are discarded. No external
DTD or entity is resolved; only an inert XMLTV doctype is accepted. Truncated
XML, channels after programmes, excessive depth or record/field limits reject
the candidate snapshot. Existing legacy/native parser profiles are unchanged.

## Refresh and failures

The first download starts in the background. `/health` is liveness (200).
`/epg/v1/health` is readiness metadata, returning 503 until a nonempty complete
snapshot has been accepted. Successful refreshes run every two hours. Failed
refreshes retry with the existing shared exponential backoff (starting at
60 seconds), retaining the complete previous snapshot. `stale` becomes true
when its fetch age reaches two hours. Each accepted snapshot has a new opaque
`generation`; it is not a security token or a persistent identifier.

If refresh lands between matching and a programme query, the query returns
409. The client should rematch and retry once with the new generation, keeping
its last accepted guide on failure. Server mode must not trigger an automatic
large XMLTV download on the TV when the service is unavailable. Playlist
source overrides and explicit local mode are a separate client policy.

All responses, including failures, send `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`. Error bodies contain only
`{"version":1,"source":"epg-one","error":{"code":"..."}}`:

- 400 `EPG_REQUEST`: invalid schema, field or parameter.
- 413 `EPG_REQUEST_LIMIT`: HTTP request body too large.
- 503 `EPG_NOT_READY`: no accepted snapshot, `Retry-After: 5`.
- 429 `EPG_BUSY`: the relevant request pool is full, `Retry-After: 5`.
  Matching has two slots and programme reads have four independent slots, so
  a burst of new playlists cannot consume all guide-read capacity.
- 409 `EPG_GENERATION`: snapshot changed; rematch.
- 404 `EPG_CHANNEL`: unknown canonical channel or unavailable route.
- 422 `EPG_CHANNEL_LIMIT`: complete requested history or current result exceeds its budget.
- 500 `EPG_INTERNAL`: internal computation failed; no provider data is exposed.
- 504 `EPG_TIMEOUT`: matching exceeded its bounded processing/queue deadline.

Download limits are 96 MiB compressed and 512 MiB decoded, with 30-second
connect, 60-second read and 600-second total timeouts. Parsing, matching, query
assembly and disposal of replaced snapshots run off the async executor.
Upstream failures log a fixed message, never URLs or nested error text.
Ingress rate limits should additionally bound public requests per client IP.

## Verification

Run `cargo test --offline -p ottplay-core -p ottplay-server`. Tests cover the
pinned browser reducer, alias and timezone semantics, archive boundaries,
request/response limits, cold readiness, restricted route surface, generation
coherence and retaining an accepted snapshot after a bad replacement.

An ignored test supports reproducible offline qualification against a retained
public feed without network requests:

```sh
OTTPLAY_EPG_TEST_GZIP=/path/public.xml.gz \
OTTPLAY_EPG_TEST_OUTPUT=/path/existing-output-directory \
OTTPLAY_EPG_TEST_NOW=1790685238 \
cargo test -p ottplay-server hosted_retained_feed_qualification -- --ignored --nocapture
```

It writes `server-feed-qualification.json`, with parse timings, counts and
complete REN TV responses for archive and shifted-window comparison. Host
measurements do not establish physical LG performance.

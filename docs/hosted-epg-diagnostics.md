# EPG diagnostics on the hosted player

## Server-prepared public EPG

A publisher can explicitly select the versioned server transport for the fixed
public `epg-one` feed. The TV then downloads channel mappings and small JSON
programme windows on demand; the Rust service downloads and parses XMLTV.
See the [server API and deployment contract](hosted-epg-server.md).

Diagnostics identifies the transport. In server mode, initial readiness and
elapsed time describe channel matching, not the download of every programme or
the latency of the first visible guide. Measure first usable programme rows
separately when comparing desktop or physical-TV startup.

The server transport retains bounded last-good programme windows in IndexedDB
and preserves them through transient service failures. An HTTP 409 triggers one
rematch against the new generation; cold HTTP 503 and network failures are
reported with bounded retries. A service failure never implicitly starts a
full public XMLTV download on the TV. Explicit custom or mixed-source profiles
retain the XMLTV worker and its existing source precedence; their URLs are not
submitted to the public EPG service.

Channel matching uses sequential batches of at most 256 channels. If the service
returns HTTP 504, the client reduces the batch size and retries the remaining
channels, down to 32 channels per batch. It keeps the smaller size for later
refreshes in that player session. All batches must finish against one generation
before new mappings become visible; a terminal failure preserves the previous
accepted guide. Network failures and other HTTP errors use the normal retry
policy instead of splitting requests. The minimum batch size prevents repeated
timeouts from turning a large catalogue into thousands of individual requests.

## XMLTV processing on the device

The decompressed-input limit is 512 MiB of UTF-8 XML. Count bytes in the
incrementally decoded chunks, not `string.length * 2`: the latter incorrectly
rejected the 457,465,999-byte public feed on 2026-09-28 because its cumulative
UTF-16 representation was 647,854,032 bytes. The full XML is never retained;
separate chunk, channel and retained-cache limits still bound memory.

Downloads allow up to ten minutes in total, but fail after one minute without
receiving additional bytes. Only increasing byte progress extends the idle
deadline. This lets a large public feed finish over a slower connection while
still stopping stalled transfers. A production check on 2026-09-28 received
46,230,420 of 49,166,552 bytes before the former fixed three-minute timeout
aborted the transfer.

The retained programme budget is 192 MiB per cache generation, measured as
`80 + 2 * (title.length + description.length)` per programme. This is a
conservative payload estimate, not measured browser heap or exact disk usage.
A 1,565-channel playlist with up to six days of archive required 203,908 unique
programme records and 134,648,412 estimated bytes: 430,684 bytes above the former
128 MiB budget. The larger budget preserves descriptions and archive windows;
it does not silently discard channels or programmes. The 300,000-record limit,
8 MiB/20,000-record per-channel limits and 4 MiB pending-batch limit still apply.
Parsing and storage remain incremental. Refresh keeps the previous generation
until the replacement commits, so storage must temporarily accommodate both;
browser quota failures are still reported as storage errors.

Open **Information → EPG diagnostics** from the player menu (also available with
a TV remote). The screen stays available after startup and updates while XMLTV
downloads and parses. It shows the source host and index, byte progress, retained
programme count, matched channels, cache timestamp, elapsed time, and the failed
stage with an error code. Source credentials, paths and query parameters are not
displayed; diagnostics remain on the device and are not uploaded.

Elapsed time is the completed attempt's total, not a countdown: it stops when
the guide becomes ready or fails. The three times below it separate cache access
and waiting (including worker startup), downloading, and local processing and
storage. Processing includes gzip decompression, XML parsing and IndexedDB writes;
these operations are interleaved and are not reported as separate CPU timings.
Stage durations accumulate across all sources, update while running and freeze
on completion. Each retry or scheduled refresh starts fresh counters. A fresh
saved guide has zero download and processing time. These device-local wall times
make it possible to distinguish a slow transfer from slow TV processing without
assuming that a desktop benchmark describes the TV.

**OK / Retry EPG download** restarts the worker and requests a fresh guide even
when the saved cache is still fresh. The last accepted cache remains available
until a replacement commits. The old worker acknowledges closure after releasing
its cache lease; an unresponsive worker is terminated after one second. If it
cannot release the lease before termination, or the release transaction fails,
the replacement may still wait for the remaining lease lifetime (up to 30 seconds).
Repeated lease polling does not republish the same schedule generation, and elapsed time
restarts for each scheduled refresh rather than including the idle interval.
**Back** closes the screen; up/down scroll its details. A failure also displays a brief notice with
the menu location, rather than only appending to the hidden startup screen.

- `EPG_HTTP` includes the source HTTP status; `EPG_TIMEOUT` is the download timeout.
- `EPG_NETWORK` can mean network, TLS or CORS failure: browsers do not expose
  enough detail to distinguish these through XMLHttpRequest.
- `EPG_INSECURE_SOURCE` means an HTTPS player was given an HTTP-only source.
- `EPG_GZIP`, `EPG_XML*` and `EPG_UTF8` identify corrupt/unsupported input.
- `EPG_STORAGE*` identifies unavailable, blocked or failing IndexedDB storage.
- `EPG_*_LIMIT` identifies an explicit input/cache limit; data is never silently
  truncated to claim a successful guide.
- `EPG_EMPTY` means no usable programmes matched the playlist and time window.
- `EPG_WORKER` or `EPG_STALLED` identifies unavailable/crashed/unresponsive
  background processing. Retrying does not enable an infrastructure fallback.
  If the worker failed during startup, diagnostics offers **Restart player**
  and explains that playback will stop. An explicit button press or remote OK
  reloads the player files, which also recovers an old tab whose worker URL was
  removed by a deployment. Nothing restarts automatically; if the action changes
  since it was displayed, the first activation only updates its label.
- `EPG_STORAGE_CHANGED` stops the worker and releases its connection when
  another tab upgrades or removes the cache. It does not reload the player.

For a physical-TV report, record the code, stage, source host, progress and model
from this screen. A desktop browser test is not proof of physical webOS support.

Hosted source selection follows the browser's ordered source affinity: each
playlist channel tries its XMLTV URLs in order, resolving its ID and names
within each feed. A match in an earlier source keeps priority over a match in
a later source. This differs from native clients that merge feed metadata
before resolving channels globally. Declaring a matching channel establishes
its source priority even if the feed has no programmes or only programmes
outside the selected date window; those two cases must behave alike. If no
source supplies any usable programmes, the refresh still reports `EPG_EMPTY`
and preserves the last accepted cache.

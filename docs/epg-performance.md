# Server EPG performance and compatibility

The standalone Rust server parses XMLTV records directly with the existing
QuickXML tokenizer and `chrono` dependency. It no longer marshals every server
XML event and programme through Kotlin/JS running inside QuickJS. Parsing and
decompression remain on a blocking worker; request workers keep serving the
published immutable guide snapshot.

The startup placeholder creates its empty matching index only if an early request
needs it, on the existing blocking worker. Every fetched snapshot, including an
empty feed, still builds its complete index before publication and the `Loaded`
message. Each snapshot owns its index so in-flight readers retain their generation.

## Scope and ownership

`src-rs/core/src/xmltv/server_records.rs` is an explicit server-profile compatibility
implementation of the shared core's `rust` record profile. The common
`XmltvRecords` implementation remains the semantic reference. This exception
avoids a second XML tokenizer, an additional runtime and new dependencies; it
also creates a maintenance obligation to keep two record implementations equal.
The corresponding common-core unification guard and architecture documentation
name the exception rather than silently exempting an unchecked file.

The boundary is the record profile, not the executable: Tauri's default-feed
cache also calls the server profile and receives the same acceleration.
The native custom-feed profile (`parse_xmltv_native`) still uses `GuideRecords`
for fields, aliases and chronological ordering. Matching, source ownership,
refresh transitions, time shifts and programme slicing still use the common
core. The public shared timestamp API is unchanged. There is no feature flag
whose workspace unification can accidentally change a client's profile.

The server profile retains its legacy behavior: repeated channel IDs replace
metadata, the last display-name/title/description wins, programme input order is
preserved, and empty/invalid records and malformed XML retain their existing
admission/error behavior. The tokenizer handles text, CDATA, references and
attribute decoding identically for both implementations. Error precedence is
part of the differential contract, including ignored invalid entities outside
admitted text fields and failures before a malformed tail.

## Correctness checks

The default core test suite compares the server implementation with the actual
pinned QuickJS `rust` implementation through the same tokenizer. It covers
captured pre-migration records and batch boundaries, deterministic generated
records, Unicode whitespace, fragmented fields, repeated metadata, missing and
invalid attributes, calendar/timezone boundaries and malformed input. The
reference entry point exists only under `cfg(test)`; it is not a second shipping
server mode.

Run the normal tests:

```sh
cargo test --locked -p ottplay-core -p ottplay-server
```

Full real-feed checks compare every channel and programme field, including
programme order, against the same reference. Timing comparisons must keep the
input hash, node, resource limit and build profile fixed. Release images require
separate Linux qualification; a fast local parser microbenchmark is insufficient.

To separate parsing from construction of the persistent HTTP matching index:

```sh
cargo run --locked --release -p ottplay-core --example epg_bench -- feed.xml http-match
```

The `parse` phase ends before index construction. Add `parse` and `index` times
when comparing cold computation with a version that did not build a persistent
index before publishing its guide. The existing `match` mode builds the native
name index; `http-match` also includes the retained HTTP aliases. Both modes
measure three passes of up to 500 sorted channel names. The output fingerprint covers
every parsed field and programme order outside the timed regions; it does not
certify the selected channel IDs, which require the matching tests and HTTP
schedule comparisons.

These phase totals omit fetch ownership merging and server bootstrap. Use the
complete server readiness boundary for the final comparison; phase timings only
locate the remaining work.

Alternate old and candidate binaries on the same host with the same frozen feed.
Record complete readiness, process CPU, first and warm requests, and complete
ordered programme responses. Check the selected channel identity explicitly:
v1.1.43 can return a regional schedule for an unshifted name. A faster response
with the wrong schedule is not a valid correctness baseline.

## Why the change is necessary

The move to shared record rules in v1.1.44 improved rule ownership but introduced
per-event allocation, bridge conversion and interpreted record/calendar work.
Shared timestamp optimizations reduced the cost, and v1.1.47-beta.1's retained
matching index made warm requests fast. Neither removed the full-feed record
bridge.

A controlled comparison of the published Linux binaries on node `mp`, with a
local 354,823,568-byte XML file, 2 CPU / 2 GiB, and no network download measured
complete readiness at 10.278 seconds for v1.1.43 and 152.615 seconds for
v1.1.47-beta.1. Beta consumed 152.21 CPU seconds while the host was 87% idle.
This was CPU work in the parser, not insufficient CPU quota. Both parsed
3,247 unique channels and 565,973 admitted programmes. The frozen XML SHA-256 is
`8ee9536f39e2236fa5fb1d66ebcc5096a893539c3f3fc07bd6c9c17a1ad06b5e`.

## Continuous performance gate

```sh
cargo build --locked --release -p ottplay-server
python3 scripts/check-epg-performance.py --server target/release/ottplay-server
python3 scripts/check-epg-performance.py --image an-already-loaded-image
```

The offline fixture contains 3,247 channels and 600,000 programmes with diverse
dates, Cyrillic text, entities and CDATA. The gate requires all programmes to be
published within 30 seconds, then checks legacy channel/logo responses, nonempty
programme JSON by both registered hash and independent name lookup, and
concurrent readers within a 2-second request budget. The previous 100,000-record,
90-second budget was too permissive to catch the observed cold-load regression.

CI tests the release executable. Container validation and native release builds
also import and exercise the exact AMD64 and ARM64 OCI images before accepting
them as release inputs. Container checks use 2 CPU / 2 GiB, a read-only fixture,
an ephemeral loopback port and automatic cleanup. JSON evidence records the
input hash, result counts, budgets and timings, including failures. A successful
`/health` response alone is never programme readiness.

`--feed` accepts an already downloaded, decompressed XMLTV file. `--probe-name`
defaults to РЕН ТВ HD; use an unambiguous final display-name for real server feeds.
The server's historical names-only REN ambiguity between ID 18 and regional
variants is a separate pre-existing matching issue. Direct ID checks and complete
parser comparisons avoid mistaking a different match for a parser regression.

The hosted here.now worker and physical LG TV runtime use other execution paths.
These server measurements do not certify their performance or a production
deployment. They also do not include WAN download or gzip decompression time.

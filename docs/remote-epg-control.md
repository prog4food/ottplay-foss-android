# Server EPG queries from the control CLI

With a configured public EPG service, `ott PLAYER p` and `p --list TEXT` list
current programmes without loading every channel's schedule on the player.
`p TEXT` searches programmes and randomly selects one of the matches.
`ott PLAYER TEXT` searches channel names first, then current programmes, then
available archive programmes. `p --list TEXT` never starts playback.
VPortal library searches remain the separate `vp TEXT` command.

The CLI requests `epg_catalog` from the player. This synchronous metadata snapshot
contains an opaque `catalog` receipt and ordered channels with `id`, `number`,
`name`, `tvgId`, `tvgName`, `shift` in seconds and `archiveHours` (0–144).
An additive `archive: {version: 1, revision: "..."}` capability identifies a
catalogue revision independently of the short-lived receipt. It never calls the guide loader.
No playlist, stream URL, account credentials or private EPG URL is included. The
receipt's source fingerprint and catalogue signature stay inside the player.
Only M3U's explicit XMLTV identifiers are forwarded as `tvgId` and `tvgName`.
Other providers are matched by channel name because their internal EPG IDs can
collide with unrelated IDs in the public guide.

The CLI sends the metadata and title filter directly to the configured service's
`POST /epg/v1/current` endpoint without the command-server authorization token.
The service matches against its accepted public guide snapshot and returns only
current programme titles and intervals. There is no per-channel schedule transfer
or XMLTV parsing on the TV for this command. Inferred channel timezone and the
player's explicit EPG shift are applied separately, once each.

Playback uses `play_catalog` with the opaque receipt and selected local channel
ID. The player checks the source, channel reload generation, full ordered metadata
and receipt age before entering its ordinary channel playback path. Changed
provider, reordered channels, modified guide identity/shift or an expired receipt
reject the request instead of playing a different channel at the old number.
Unchanged snapshots share a receipt for up to two minutes; receipts do not survive
a player reload. Parental and category admission remain owned by ordinary playback.

When no current programme matches, the CLI retrieves `/match` and `/programmes`
from the same EPG service. Only channels with archive support are searched, within
their advertised retention and at most 144 hours. Adjacent matching programmes
form a chain; a different title, gap or overlap breaks it. The first programme
with a readable manifest and initial media fragment becomes the chain's result.
Multiple chains are listed separately, including chains on the same channel.

`resolve_archive` explicitly returns a provider-generated media URL to the
authenticated controller for a local availability check. It does not switch
channels or open a PIN prompt. The URL is never sent to the public EPG service,
printed by the CLI or saved in its caches. `play_archive_catalog` carries only
`catalog`, `id`, `start`, `end` and `title`; the player checks receipt, retention
and access again, then enters its existing archive controller. A successful
reply confirms dispatch, not decoded video on physical hardware.

The CLI caches mappings, schedules and archive search results for up to two
hours and successful media checks for seven days. Programme boundaries, guide
expiry and the moving retention window can shorten reuse. It checks current
EPG before archive fallback and renews the catalogue receipt before dispatch.
Both controller and player need the archive RPC extension. Shared FOSS code
covers browser, Tauri desktop, Capacitor/iOS and packaged TV installations;
installed applications still need their updated builds.

Snapshots are limited to 10,000 channels, 1,800,000 UTF-8 bytes of metadata and
512 UTF-16 code units per field. The CLI splits large catalogues into bounded
EPG requests and requires one guide generation across the complete result.
Explicit shifts must be integer seconds in -86,400..86,400. The CLI and
server also enforce request/response size limits. A configured server failure must
not silently fall back to the expensive player-wide EPG scan. Deploy the matching
controller, player and EPG API before enabling the CLI's server EPG configuration.

The public service supports the fixed `epg-one` source. Configuring that service
explicitly selects its programme data for remote queries; it does not upload or
replace custom/private guide sources configured on a player.

Source tests verify a 2,981-channel metadata snapshot makes zero guide requests,
preserves channel IDs/time shifts, and rejects stale playback receipts. This is a
deterministic work/transport contract, not a physical LG latency measurement.

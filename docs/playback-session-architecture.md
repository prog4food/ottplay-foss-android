# Playback sessions and provider lifetimes

The player now delegates playback history and seek decisions to the Kotlin
shared core. The classic view consumes those decisions through an explicit
compatibility adapter. Normal playback commands own a typed state store; a
versioned journal owns channel history and the resume target. All 48
shipped provider entrypoints use injected driver instances. The classic views
and external custom-script extension retain a compatibility boundary.

## Responsibilities

`PlaybackSession.kt` in `ottplay-core/shared-core` defines source/channel
identities, explicit live/archive/VOD modes, departure history, position effects
and seek plans. It does not read DOM elements, storage, device globals or timers.
Archive origins are epoch seconds; media positions are elapsed seconds. A
history kind filter is applied before truncation so VOD cannot consume a slot
in a channel-only journal.

`src/playback/session.ts` owns a state store (typed target, phase, position and
generation) and pending operations. Live/archive/VOD open, pause, resume, stop
and measured-position commands update the store; legacy mode fields are
projected at the host edge. Browser event handlers bind to both the media
request and state generation, and detach when replaced. A pending new source
cannot borrow the previous decoder's position. Native finite-channel discovery
reclassifies the same session without retiring its active event handlers.

The operation controller receives observation,
clock/timer and effect ports, and uses opaque core ownership tickets. A later
selection or stop invalidates earlier callbacks even if the selected ID is
reused. Offset seeks accumulate for 500 ms and are planned from the current
position when applied. Guards can start without a current channel, enabling
history restoration after a catalog removes the previous selection.

`src/playback/classic-adapter.ts` translates the classic host into that model.
This is the only new playback module that interprets numeric mode sentinels,
positional history records or storage keys. The host context check also binds
catalog/channel/list objects and storage accessors for transient UI operations:
replacing a source with the same identifiers must not revive old effects.
Decoder validity uses a separate source/target guard, so a group reorder does
not stop the playing channel; see [Media backend](media-backend.md).
Native finite channel media and
medHistory VOD are different legacy cases and retain their different histories.

`src/provider/runtime.ts` owns provider and catalog generations independently.
Replacing a generation retires it before cleanup, so synchronous abort callbacks
cannot write into the replacement. Resources are disposed in reverse order;
cleanup failures do not prevent other resources from being released. Reentrant
source selections retain the latest requested selection.

The Full distribution's external dealer-script adapter scopes AJAX callbacks,
jqXHR/deferred callbacks and function timers created while a provider call executes,
including nested asynchronous work. Catalog fetches have their own reload lifetime.
Subsequent guide, media and stream URL entrypoints retain the provider lifetime.
Play permits only its managed profiles and excludes that script adapter's loader
and interception code; its ordinary provider/catalog lifetime registry remains.

`src/playback/archive.ts` independently owns archive requests, schedule snapshots,
programme selection and the active media resource's bounds. Its ports receive
decoded source/channel context and implement guide requests, authorization,
URL resolution, device effects and rendering. The common core selects programmes
using half-open intervals and latest-start precedence for overlaps. A file is
reused only when its source, channel, programme identity and time bounds match;
changing a UI row index cannot reopen it or seek into a different resource.

`classic-archive.ts` is the compatibility edge. The renderer consumes a selected
programme and timeline model; it no longer chooses transport or starts guide
requests. Missing/last-programme refresh has its own request lifetime and retry
interval, independent of whether the visible row changed. Source replacement,
Stop and a newer intent retire pending guide and URL callbacks. Authorization
and archive retention are checked again before delayed playback effects.

EPG selection also binds the exact chosen row, destination and playback context
before requesting a PIN. Manual seek dialogs bind their callback, accumulated
delta and timer revision to the session that opened them. A queued old callback
cannot seek a new channel or hide a replacement dialog.

## Commands, observations and clocks

A playback command expresses an intended transition; a decoder observation reports
what the current media resource has actually done. `snapshot()` reads the accepted
state. It neither queries a decoder nor turns elapsed wall time into measured media
progress. Managed engines publish their position through the backend lease;
retained device engines use the explicit compatibility sampler described in
[Media backend](media-backend.md). Buffering, a paused decoder and an open dialog
must not advance managed playback merely because the UI redraws.

Keep three kinds of time separate:

- **Broadcast time:** epoch seconds identify the archived programme and requested
  broadcast instant. Archive retention is rechecked against a fresh wall clock
  before a delayed action can open or seek a resource.
- **Media position:** elapsed seconds within the accepted playback target.
  File-relative archive URLs use the selected programme bounds; their decoder
  position is not itself a broadcast timestamp. The backend calibrates observations
  to the current archive origin before publishing them.
- **Interaction delay:** the seek controller accumulates offset requests for
  500 ms. The manual dialog separately waits three idle seconds or Enter before
  submitting its accumulated offset. These timers schedule commands; they are not
  playback clocks. Cancelled/replaced timers must still reject late execution.

The source entrypoints in `channels/index.ts` describe these effects explicitly:

- `pauseLivePlayback()` retains the classic `liveStop` ABI. It requires a playing
  decoder and an archive-capable channel, obtains a guide under the selected
  context, then enters a paused archive target at the accepted current broadcast
  time. It pauses the existing decoder without opening a new stream. It is not
  Stop and does not return archive playback to live.
- `replayFromLiveOffset(seconds)` retains `timeShift`. Positive seconds replay
  `now - seconds`; zero selects the airing programme's start. Here `now` is sampled
  after guide completion, not at the initial button press. Zero with no airing
  programme is a no-op. It is not a signed seek within the existing decoder.
- `showPlaybackSeekDialog(initialDelta)` retains `shiftArchiveSelect`. It accepts
  live channels with archive capability and existing archive/VOD playback. A
  signed accumulated delta is submitted to `shiftArchive`, whose typed planner
  chooses the mode-specific operation. Closing or replacing the owning context
  prevents its handler/timer from seeking or hiding a newer dialog.

The classic names, function arity and replacement behavior remain part of the
compatibility boundary. `legacy-names.ts` emits the established declarations and
installs live English aliases; it does not add a second implementation. Dynamic
remote dispatch strings still use the stable classic names.

### A delayed replay request

Opening a new archive resource follows this path:

```mermaid
sequenceDiagram
    participant Input as Remote or view
    participant Archive as Archive coordinator
    participant Guide as Guide service
    participant Access as Parental access
    participant Driver as Provider URL resolver
    participant Decoder as Current decoder
    Input->>Archive: replayFromLiveOffset(seconds)
    Archive->>Archive: capture source, channel and generation
    Archive->>Access: require access
    Access-->>Archive: allowed (possibly later)
    Archive->>Guide: request schedule
    Guide-->>Archive: detached schedule (possibly cached)
    Archive->>Archive: recheck generation and source; select broadcast time
    Archive->>Access: recheck permission
    Archive->>Driver: resolve archive URL
    Driver-->>Archive: URL (possibly later)
    Archive->>Archive: recheck source, target and current retention
    Archive->>Access: recheck permission
    Archive->>Decoder: open accepted resource
```

Every delayed stage can be superseded. A source/account replacement, Stop, a
new intent or a replaced selection rejects the old continuation even when the
provider returns the same numeric channel ID. URL resolution is not permission to
play later without another check. Reusing a file also requires the same source,
channel, programme identity and time bounds; a changed list index is insufficient.
Guide cancellation and generation guards complement each other: a provider/native
operation may be impossible to abort, and an already queued callback can still run.

Tests in `test_archive_session.cjs` exercise the real pause/replay entrypoints,
missing programmes, duplicate guide completion, expired authorization and source
replacement. `test_archive_entrypoints.cjs` exercises dialog replacement and stale
timers. English-name and full-bundle suites verify the emitted aliases, rather
than injecting differently named source functions into the built artifact.

## Integration and deliberate behavior changes

`setCurrent` and `shiftArchive` delegate to the new boundary. Stop, source and
catalog changes invalidate pending playback work. Timeshift, live pause, archive
history selection and delayed resume seek use guarded callbacks. History binds
the selected channel before PIN/EPG completion and resolves its current category
position. Archive access is rechecked if it expires while EPG is loading.

The following corrections are intentional:

- Live destination history is deduplicated consistently when an optional archive
  argument is omitted.
- Empty channel history is persisted instead of retaining an old stored journal.
- Malformed stored rows do not enter the typed model; missing categories cannot
  crash history selection.
- A stopped or superseded operation cannot seek, pause or start an old stream.
- Replacing the catalog or channel while reusing its ID invalidates callbacks.

## Driver instances and release boundary

`src/provider/drivers.ts` implements factories supplied with storage, transport,
clock, hashing, shared-core and lifetime ports. The declarative inventory in
`driver-profiles.ts` covers Demo, standalone Xtream and 33 API/M3U operator
profiles, including the nested `d/maxtv` entrypoint. Each source owns its requests,
configuration and catalog. Catalog snapshots are detached from driver state;
failed reloads cannot republish streams from the previous account.

Generic profiles retain their established storage prefixes, four credential
fields, API/M3U fallback and empty-EPG capability. Standalone Xtream preserves
its catalog, live/archive URL and short-guide operations; it did not expose a
media catalog before migration. The view codec publishes the narrow callbacks
that the current renderer still consumes. Managed loading never evaluates
`provider.js` or temporarily patches global AJAX/timer functions.

Five additional profiles use explicit session drivers: `1ott`, `only4`,
`shara-tv`, `tvteam` and `bestlist/stalker`. They retain their distinct credential
editors, playlist/authentication chains, guide and archive behavior, and Only4
mode switching. Despite its name, `bestlist/stalker` uses an Xtream/M3U fallback
contract; it is separate from the MAC-based Stalker driver.

`stalker-driver.ts` owns MAC/portal authentication, catalog and guide requests
through the shared-core Stalker session. It preserves the JSON POST protocol,
MAC editor and archive URLs without replacing global AJAX behavior. Its 15 portal
profiles are stored together in `stalker_data` as `{ active, portals }`. Reading a
legacy `{ portal, mac }` record projects it into the first profile; the next save
persists the new format without retaining session tokens. The first profile keeps
the original storage keys and source namespace. Other profiles isolate channel
preferences, favorites and playback history, even when they use the same account.
Selecting a profile retires the previous catalog, guide and temporary stream-link
requests before loading channels. Names and inactive profile edits keep the current
session. In settings, Enter loads a saved profile or edits the active/empty one;
the yellow button edits any profile, and Back discards an unsaved draft.
`catalog-drivers.ts` supplies ITV, OTTCLUB and Shura instances. Their full/current
guide requests, JSONP phases, catalog EPG seeds and credential changes have
explicit lifetimes. The settings codec retains ITV subscription information,
provider-specific mode switching and replay after route-only credential edits.
Subscription data is escaped; a closed or replaced view rejects old responses.
Settings callbacks recheck ownership after saving before restarting or replaying.
Source selection detaches the old driver before aborting its requests and checks
the selection token again afterwards. A synchronous abort that selects a newer
source cannot let the interrupted outer selection overwrite that new driver.

Malformed asynchronous catalog responses now complete startup once with an
empty catalog and a processing error. Malformed Shura guide responses complete
with no guide instead of throwing and leaving the caller pending.
Nested catalog and EPG snapshots are detached from the private driver state.

`playlist-drivers.ts` supplies Antifriz and KB-Team instances, including MAC
identity, playlist selection, archive routes and late guide/logo updates.
Metadata patches update existing host rows without repeating startup. KB-Team
storage remains scoped to its selected playlist. Both use `media-catalog.ts`
for independently owned JSON/XML/M3U media requests. Cancellation retires the
busy dialog and key handler only while that view still owns them.

`edem-driver.ts` owns TV settings and portal navigation, lazy pages, filters,
search and stream quality selection. Published media rows preserve their array
identity while lazy pages arrive. Playback identifies portal media by an opaque
source token and request instead of rewriting every history URL with a matching
title. Existing request-bearing Edem history can be adopted once; its original
portal cannot be reconstructed from old records that never stored that identity.

`m3u-driver.ts` owns 15 playlist slots, archive rules, EPG matching, native XMLTV,
local-file loading and progressive metadata. `m3u-settings.ts` projects the
settings and media UI, retains the portal-client boundary and scopes canonical
journal/history keys to the current slot. Changing a media source rotates its
identity so old navigation items cannot address a new account. Metadata callbacks
recheck ownership after renderer callbacks that may select another provider.

`catalog-xml.ts` handles the XML effect without publishing old operator globals.
The generic XML codec retains Stefan Goessner's attribution and license notice.
The `operator.ts` transport helpers are excluded from the classic bundle.

`provider-assets.cjs` derives the same 48 IDs from the declarative inventory.
Vite and Play packaging omit their old executable scripts from browser, Tauri
and Capacitor roots. UI metadata and logos remain. The excluded scripts are
retained as test fixtures. Managed drivers do not use that script path at runtime.

## Version-2 playback journal

`src/playback/journal.ts` owns the `playbackJournal` provider key. One envelope
stores schema version, source identity, typed bookmark, channel history and
bookmark timestamp. Entries use channel and group identities, not category
indices or numeric playback sentinels. M3U storage scopes this key to the active
playlist slot; the compatibility source identity also includes the slot.

M3U bookmarks and channel history also retain an optional `channelHint` with
the station's guide ID, name and provider group. Some playlists rotate signed
stream URLs on every load, which changes their numeric URL hashes. Restoration
first uses the exact channel reference; if it has disappeared, a unique guide
ID can recover the station. Duplicate or missing guide IDs require an exact
name/group match. Duplicate metadata can be narrowed by an optional `routeId`,
a hash of the stream address without its query or fragment. Unresolved matches
never select a channel by its old
position. This lookup is scoped to the same M3U source and works for both live
and archive bookmarks. It stores no stream URL or token, leaves provider IDs
and library/favorites formats unchanged, and accepts existing journal entries
without a hint. Older entries cannot recover an already changed URL hash until
a new playback checkpoint records station metadata.

The importer reads version-1 `prevArr` and live/archive `continueWatch` without
changing their original bytes. Canonical data takes precedence after the first
successful envelope write. Unknown versions, corrupt envelopes and mismatched
sources are read-only, with an empty safe view instead of reviving stale mirrors.
OTTCLUB retains its existing empty storage prefix. Its instance now uses the
explicit source ID `ottclub`; only that mounted driver may import its previously
written version-2 `classic` envelope. Reading preserves the original bytes, and
the next successful write normalizes the identity without discarding history.
Other sources and unknown envelope versions cannot use this exception.
Writes verify the resulting value. Channel hash migration updates eligible
version-2 channel references but never VOD identities or unsupported envelopes.

New semantic checkpoints record the mode actually entered, fixing the old
mixed outgoing-mode/incoming-channel bookmark. That ambiguity in existing
version-1 data cannot be reconstructed reliably. Media history now has its own
source-scoped [MediaJournal and origin-aware resolver](media-library.md).
Imported old records retain their provider-specific replay metadata; missing
origin identity cannot be reconstructed from an old URL alone. Old channel keys
remain rollback mirrors while compatibility consumers exist.

Playing-position writes are limited to one per five seconds; target/phase
changes checkpoint immediately. Clearing or restoring storage suspends both
canonical and compatibility saves until the next source hydration, preventing
unload/stop callbacks from recreating erased history. Hiding a page saves the
active archive/VOD target without relabeling it as live.

License notices and repository history are retained.

## Verification

`npm test` includes real shipped-core playback, history and provider regressions.
The provider suite also runs actual Xtream provider code with an unabortable
late response. A canceled transport is therefore not assumed to be sufficient
protection. New tests live in `test_playback_session.cjs`,
`test_history_selection.cjs`, `test_playback_state.cjs`,
`test_playback_journal.cjs`, `test_provider_runtime.cjs` and
`test_provider_drivers.cjs`. Archive request/entrypoint tests and
`test_named_provider_drivers.cjs`, `test_stalker_provider_driver.cjs` and
`test_catalog_provider_drivers.cjs` cover those migration stages.
`test_playlist_provider_drivers.cjs`, `test_edem_provider_driver.cjs`,
`test_m3u_provider_driver.cjs` and `test_provider_catalog_xml.cjs` verify the
final four drivers, media formats, slots and cancellation. Driver transport
contracts are also checked against
the captured generic operator cases; `test_provider_assets.cjs --bundle` audits
the absence of retired scripts in all built roots.

Run `npm run typecheck`, `npm run lint`, `npm run build` and
`npm run check:bundle`. Full-bundle smoke loads only the vendored core before
executing the built artifact, verifies private module publication and exercises
history and delayed seeks on modern and legacy JavaScript profiles. This checks
wiring and behavior with simulated host ports; it does not verify decoding on a
physical TV. The build also validates ES5 grammar and native staging receipts.

`npm run test:devices:browser` includes a full-player Chromium test that decodes
frames from the checked-in HLS fixture and exercises the actual pause, seek,
resume and stop APIs plus the canonical journal. Its unload event is dispatched
synthetically; it does not establish real shutdown/restart or device-decoder
behavior. All external media/provider requests are intercepted or blocked.

The session-only iteration increased the classic bundle from 475,644 to 484,540
bytes (gzip: 130,016 to 132,972). Adding owned playback state, the journal and
35 drivers brought it to 514,070 bytes (140,915 gzip). The archive coordinator
and five further drivers brought the bundle to 530,635 bytes / 145,879 gzip bytes.
The Stalker and catalog-driver migration brought it to 547,911 bytes / 150,262
gzip bytes. Completing all 48 instance drivers brings it to 598,720 bytes /
164,996 gzip bytes; the explicit budget is 610,000 bytes / 170,000 gzip bytes.
Packaging removes 363,623 raw bytes of
retired provider scripts from each Full asset root. That asset total is not a
claim about transfer savings: the previous loader fetched provider scripts on
demand. The separately loaded shared-core JavaScript remains at 1,239,827 bytes
after the first iteration. Domain APIs and the temporary compatibility layer
both contribute to the bundle cost.

Core validation is `./gradlew jvmTest jsNodeTest`, followed by distribution and
JavaScript-profile checks documented in the shared-core README. Install the
result through `scripts/distribute.cjs`; do not manually edit vendor artifacts.

## Remaining migration

The new boundaries do not make the entire application independent of its
classic contracts. Settings/drafts, media history/navigation, channel libraries,
guide/reminders and decoder lifetimes now have owners described in
[Player architecture](architecture.md). The remaining compatibility surface
includes classic renderers, provider UI codecs, retained hardware engines and
published globals. Explicit reconciliation accepts external writes from retained
scripts; removing that input path requires converting its callers, not just
changing field names. Older sizes and staged migration descriptions above are
historical; the executable current size gate is `scripts/classic-size.cjs`.

The Full distribution's custom-script extension scope does not intercept arbitrary
raw UI closures, native Promise continuations, cached transport functions or global writes made
by an external script while it evaluates. Script loading is serialized so the
next reset occurs after the previous script finishes. If the loader never calls
either completion callback, replacement waits; allowing the next script to
run on a timeout alone would let late evaluation overwrite the active driver.
All 50 built-in provider profiles publish isolated instances and avoid this
custom-script limitation. The Full dealer extension can still add external script
providers. Play excludes both that entrypoint and its scoped script runtime; its
four managed profiles retain the same source/catalog cancellation behavior.

Structural independence must be assessed against these remaining dependencies,
not identifier changes or a target percentage of textual similarity. This work
does not erase or disprove historical source relationships.

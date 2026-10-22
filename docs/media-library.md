# Media library and journal

`src/media/library.ts` owns navigation frames, selection, request cancellation and
resolution. Its injected ports describe provider rows, load a page and render a
detached view. Back, replacement and close revoke pending completions before
calling transport cleanup. Incremental page updates have the same frame lifetime.

Navigation reads have different copying contracts. `revision()` reads the current
published-view revision without traversing frames. `highlight(index)` changes owned
selection without returning an item or copying its metadata; missing rows leave
selection unchanged. `select(index)` still returns a detached selected item, and
`snapshot()` still detaches the complete view for consumers. Use `capture()` when
work must also be invalidated by a selection change: highlighting another row
does not increment the navigation or published-view revision. Ordinary captures
retire permanently when the effective selected index, presence, item ID or source
changes, even if the original selection later returns. A refresh that preserves
that complete selection retains its capture. Selection checks read scalar state
without copying payloads.
`capture("frame")` retains navigation and filter ownership while allowing a
different highlighted row; explicit folder shuffling uses this scope.

`src/media/classic-adapter.ts` translates existing provider and UI ports. The
`mediaRecords`, `mediaUrls`, `mediaNames`, `mediaSelects`, `medHistory` and
`medFavorites` globals are compatibility projections. The active consumer uses
owned frames and explicit catalog/history/favorites routes; numeric history
routes are accepted only by the old public facade. The playback sentinel remains
an output/legacy codec in the playback adapter, rather than a media identity.

The adapter checks scalar revision when highlighting or releasing a screen, and
captures one detached frame for each favorite action. Reading the same snapshot
repeatedly would copy the entire navigation stack, including nested provider
metadata. Keep detached publication at the boundary without introducing a second
mutable catalog cache for these inexpensive ownership checks.
The recursive copier allocates its ancestor list once per object, not once per
property; cycle detection stays local to each branch, so shared sibling values
are copied independently and the caller's ancestor list is never mutated.

An item is identified by `(sourceId, itemId)`. The shared source identity includes
the provider account and playlist slot, and Edem's separate media portal. Provider
IDs take precedence, followed by canonical provider request objects. When neither
is available, the fallback is catalog location, title and duplicate occurrence.
That fallback cannot promise continuity after title changes or duplicate reorder.
Resolved stream URLs are metadata, not identifiers.

New history and favorite entries retain their origin route. Selection loads that
origin again and matches the stable identity before resolving playback. Thus a
changed signed URL does not lose resume position, and a missing entry does not
silently play an expired URL. Legacy entries without origin metadata retain their
old locator as importer fallback entries. New catalog visits create provider-backed
entries; the importer cannot reconstruct identity that the old data never recorded.

Installation libraries and clients declaring `stableRequests` resolve saved request
IDs directly, without reloading the originating folder. A client's optional
`persist(payload)` projection removes access URLs and credentials before journal
writes while retaining stable identity and resume metadata. An independent NAS
library owns its client, journal and catalog separately from the TV provider;
browsing another library preserves the current NAS playback checkpoint owner.

`src/media/journal.ts` stores version 1 documents at
`mediaJournal.v1:<sourceId>`. Kotlin `mediaCollectionChange` owns deduplication,
capacity, favorites and position mutations. Exact position is stored; the existing
whole-minute resume prompt is an explicit `mediaResumePosition` policy. Position
updates do not resurrect deleted history. Playback checkpoints target an explicit
MediaRef, never the first history row.

The importer reads the legacy media arrays without modifying them and claims their
old namespace once. A different account cannot import the same legacy data again.
Unknown or malformed new documents are read-only. Storage exceptions do not
overwrite accepted state. Disabling favorites persistence pauses journal writes
and can be reversed without recreating the runtime.

The implementation compiles to the existing ES5 bundle and requires no new browser
APIs. Tests cover real UI/playback entrypoints, detached frames, cold URL renewal,
account/slot isolation, cancellation and reentry, quality selection, lazy Edem
pages, journal failures and full compiled-artifact startup.

`tests/helpers/media-read-cost.cjs` uses 1,000 records with observable payload
getters to verify that scalar reads and highlighting do not traverse metadata;
it also verifies selection-guard invalidation and detached item/view results.
The source media suite and actual bundle smoke execute this contract. These are
deterministic allocation/work checks, not elapsed-time measurements on a TV.

Title filtering is owned by each media source runtime and lasts across navigation,
pagination and reopening the list. The Filter row and blue remote key use the same
TV/native editor and SWOP input path. An empty value restores the loaded page;
matching ignores case, repeated whitespace and the Russian е/ё distinction.

Frames retain one full catalog and a derived visible list. Snapshots expose only
visible items; provider projections retain the full catalog so incremental updates
cannot discard hidden rows. Refiltering revokes captured selection/editor actions
without cancelling incremental page updates, and selected identities map into the
visible list. The filter applies to playable items and VPortal multistream folders;
all episodes in a selected series remain available to its playback queue, while
category navigation and page/search controls remain reachable, including on pages
with no matches. Quality variant menus are not filtered. VPortal's advertised
server search is global, so a local title filter does not silently turn a category
into global search or fetch every page.

Internal snapshots can select `current` payloads for rendering or `none` for
navigation metadata. The default `snapshot()` still detaches every page for public
consumers. Rendering and filter setup must not traverse payloads belonging to
ancestor pages. `tests/helpers/media-filter-cost.cjs` measures the actual runtime
copier, and the media-library suite enforces deterministic allocation budgets at
300 and 1,000 records per page; timings are diagnostic rather than test gates.
With 1,000 records on each of six pages, opening Filter falls from 54,072 copied
objects to 18, and Next/Back from 308,395 to 47,133. These are fixture allocation
counts, not television latency measurements.

Folder playback controls reuse the adapter's owned playback sequence. Shuffle
copies eligible items, applies the title filter and runs Fisher–Yates once;
folders and navigation controls never enter the queue. A client may implement
`canCollect(target)` and `collect(target, done, guard) -> cancel` to fetch the
complete current folder, reporting `{items}` or `{items: [], error}`. Plex uses
an independent request owner so collecting pages never replaces the visible
catalog or cancels playback URL resolution. Search hubs do not promise complete
flat pagination, so they expose Repeat without Shuffle.

The controls always show their current mode. Shuffle displays Off, Loading or On;
5 enables a new shuffled queue, cancels pending collection, or restores the
original provider order without restarting the current video. The ordered copy
is retained across automatic transitions, including Repeat One. Play explicitly
starts a fresh shuffle. Keyboard digits, numpad digits and pointer activation use
the same media-list handler; editors and TV hardware key mappings keep ownership.

Plex and VPortal mark continuation rows with `__ottMediaNext` and expose
`page(target, done) -> cancel`, returning `{items}` or `{items: [], error}`.
This independent transport never changes provider globals or cancels playback.
The library prefetches within three rows of the cursor and appends into its
current frame, retaining the route, selected item and parent navigation. A
selected loading row becomes the first visible new item; errors retain a manual
retry row. Closing, navigating, editing the filter or selecting playback cancels
the request. View rendering and stale responses retain source/frame ownership.
Continuation IDs and a 1,000-page/100,000-row bound prevent unbounded traversal.

Repeat defaults to All, preserving existing episode playback, and is stored in
`mediaRepeat.v1:<sourceId>`. One keeps the original queue and repeats its current
item; Off advances normally but stops at the last item. URLs are resolved afresh
and automatic playback starts at zero. A pending natural completion can be
reissued after changing Repeat only while its playback and generation still
belong to that completion. Stop, Back, source changes and stale PIN/transport
callbacks cannot re-admit it. A new Shuffle also revokes an older manual resolve
or PIN intent before collecting its replacement queue.

Plex library-only boot may invoke `restoreLast(onUnavailable)` once on a fresh
runtime. It reads a valid positive checkpoint from this source's history, resolves
its stable request and carries an explicit startup position through prepare,
the playback command and backend open. This bypasses the manual minute-rounded
confirmation without changing manual resume or zero-offset queue transitions.
The new visit retains the saved position while loading. Completion clears the
checkpoint even for a single item without a queue, preventing startup at EOF.
Source/client, navigation, PIN and playback-generation guards also own the
unavailable callback; an old failure cannot reopen the library over a newer task.

Request revision and published-view revision have separate lifetimes: refiltering
and incremental replacement retire old highlight callbacks without invalidating a
current provider page stream. Selection captures also retain the selected item's
source and ID and its selection generation, so replacing a row at the same index
and restoring it cannot authorize an older PIN or editor callback. Paging compares
the final effective selection after cursor replacement; temporary selection
reset during filtering does not retire an unchanged selection. Filter text
commits only after cancellation succeeds without a newer
navigation taking ownership. Favorite removal similarly rechecks its navigation
owner after journal callbacks before updating the visible list.

Natural episode advancement uses a separate resolver lifetime from foreground
catalog navigation. Resolving or starting the next episode therefore preserves
an open Filter/Search editor, its SWOP confirmation and any pending catalog page.
VPortal likewise owns separate foreground and automatic requests, with shared
quality preference. Automatic requests do not claim the busy dialog or quality
picker, and failures use a generic non-modal notice. Navigation, manual playback,
Stop and source replacement still revoke obsolete automatic work; cancelling
only automatic work leaves a foreground request intact. Repeated episode changes
reuse the current screen ownership binding instead of accumulating cleanups.
NAS playback leases also retain their request lane: cancelling automatic work
cannot release a foreground lease, and starting another episode waits for the
previous lease to stop without cancelling an open catalog request.
Regression tests cover both catalog/episode completion orders and confirming
SWOP input across a real browser media-ended event.

## Remote VPortal queues

The control CLI accepts `ott PLAYER vp TITLE_FILTER` to search the active
provider's VPortal and start a repeating queue. `ott PLAYER vp --list TITLE_FILTER`
returns the same numbered titles without changing playback. This supports the
standalone VPortal provider and Edem's media portal. Matching is case-insensitive and uses
the shared title normalization. TV channel numbers and EPG searches are unchanged.

Use `ott PLAYER vpr TITLE_FILTER` to shuffle all matching videos once before
playback. Every result appears once in the queue; natural completion repeats the
same shuffled order after the last video. A new `vpr` request makes a fresh shuffle.
For example, `ott l vpr "wedding"` starts a shuffled repeating selection on `l`.
The `vportal_random` request takes only `{query: TITLE_FILTER}` and returns the
numbered titles in queue order, with `loop: true`, `shuffled: true` and
`dispatched: true` after playback start is dispatched. The acknowledgement does
not prove that a frame was rendered. Ordinary `vp` and `vp --list` preserve
provider order. This command requires updated CLI, control server and player versions.

The collector follows every advertised search page and expands matching series
and their seasons in provider order. It ignores unrelated category navigation,
deduplicates playable entries and completes the whole search before dispatching
playback. A partial or malformed catalog, repeated page, timeout or exceeded limit
rejects the request instead of silently playing an incomplete selection. Limits
are 25 seconds, 100 page requests, 10,000 examined rows and 2,000 unique videos;
use a narrower title filter when needed. Queries are limited to 1,024 UTF-8 bytes.
Canonical page and item identities also have a shared 2 MiB serialization budget
(charged at two bytes per UTF-16 code unit); exceeding it rejects the whole search.

The first video starts from the beginning, natural completion advances to the next,
and the last loops to the first. A one-video queue repeats that video. A new queue
replaces and restarts the selection even when its first video is already playing.
Automatic playback uses the saved quality preference without opening a picker or
resume dialog. Locked adult selections require parental access to be unlocked on
the player before dispatch. Stop, manual playback, source changes and cancellation
revoke pending automatic work; late search replies cannot restart a stopped player.

Each visit resolves a fresh stream URL. Direct-URL catalog entries reload their
origin page using a separate automatic request lane, matched by provider ID or raw
title and duplicate occurrence. An unavailable entry never falls back to its old
URL. Resolution or media errors do not count as natural completion and may leave
the queue stopped; this feature cannot make an unavailable or unsupported stream
playable. The queue is in memory and is not restored after restarting the player.

The command receipt contains only numbered titles, total count and dispatch/loop
flags. It confirms that playback was dispatched, not that the video decoded or
became visible. Credentials, provider request objects and stream URLs remain on the
player. A headless browser regression drives the shipped command-server transport
and real media-ended events through a multi-page movie/series queue and its wrap.

## Finite-media footer

`__ottClassicPlayback.programme()` publishes the owned active media's collection,
current/next titles, playback-start wall clock, duration and relative position.
The start clock is latched on the first real playing event of each playback open;
subsequent buffering, seeking and pausing retain it. A new open receives a new
clock, including startup resume. The next start is a nominal estimate computed
from that fixed clock and full duration, not the remaining playhead duration.
Unknown times remain absent. The footer keeps relative position for its progress
bar while displaying programme clocks separately.

Collection metadata follows the playing item's origin rather than the current
browser selection. Local sources supply the immediate containing folder when
available; provider media supplies its folder/collection label. Footer reads do
not rescan a directory or resolve another provider URL. The predicted successor
must follow playback order and repeat/kiosk policy without changing selection.

#!/usr/bin/env node
// Measure final artifacts, including native transformations, in UTF-8 bytes.
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");

// Bound the shipped outputs after settings and codec deduplication, including
// PLi-HD/Studio layouts, settings fixes and offline credit controls. Allow
// candidate-version suffixes and Node/zlib variation: CI Node 22 compresses
// these bundles less than local Node 26. ES5, persisted menu identities and
// final-artifact checks remain enforced.
// Localized keyboard paging/case-safe cells, translated menus and eight new
// selector entries add <1 KB after shared label reuse. Dictionaries stay external.
// The optional PC2 engine port also fits within these measured budgets.
// Owned episode looping and the natural-ended bridge add about 1.8 KB raw.
// Persistent page-title filtering adds about 1.5 KB, including its TV editor.
// Hosted EPG orchestration and encrypted same-Site input add ~14 KB raw;
// gzip/XML parsing remains in separately loaded worker assets.
// Visible hosted EPG diagnostics and retry add ~5.6 KB raw / 1.5 KB gzip.
// Remote CLI queries, result delivery and provider adapters add ~9 KB raw.
// Discovery, secure pairing and its UI measure 603103 raw / 182299 gzip
// for web 1.1.50 on Node 22.23.3 (native gzip 182353). Retain release headroom.
// Protected iOS sources retain cancellation and session checks after transport
// helper deduplication. Native Node 22 output exceeded the previous gzip cap by
// 16 bytes; allocate 50 bytes for this reviewed feature cost without raising raw
// or complete-payload limits.
// CSP-safe playback controls plus shared color-picker layout reduce raw output
// by 119 bytes and add 210 gzip bytes to native output on Node 22.23.2. The beta
// artifact measures 183726 gzip bytes; allow this reviewed feature cost and
// version suffix headroom while retaining raw and complete-payload limits.
// Producer-owned EPG/LG remote snapshots add 863 raw / 277 gzip bytes over
// published beta.7 (605567 / 183673 on Node 22.23.2). The measured candidate
// is 606430 / 183950 for web and 606388 / 184004 for native. Allocate 500 raw
// and 50 gzip entry bytes for this reviewed feature and version suffix room.
// Unicode remote matching on Node 22.23.3 measures 606636 raw / 184035 gzip
// for web and 606594 raw / 184089 gzip for both native variants. Allocate its
// measured cost plus candidate suffix room; retain the complete gzip limit.
// Native list swipes retain gesture ownership across paginated row replacement.
// Node 26 measures 608740 raw / 184260 gzip (web), 608698 / 184317 (native).
// Include release suffix room and the established Node 22 gzip variation.
// Remote VPortal collection, cancellation and per-visit URL renewal measure
// 615932 raw / 186854 gzip on Node 26.8.2 (native 615890 / 186913).
// Removing redundant canonicalization and metadata work saves 400 raw bytes.
// Budget the new feature explicitly,
// retaining candidate suffix room and the established Node 22 gzip allowance.
// Server EPG metadata snapshots and catalogue-bound playback add 1885 raw /
// 535 gzip bytes: 617817 / 187389 web on Node 26.8.2, without guide downloads.
// M3U profile management and acknowledged playback restarts add 8539 raw /
// at most 2585 gzip bytes on Node 22.23.2: web 626025 / 190382 and native
// 625983 / 190440. Include explicit paused startup for the core and PC2 engines.
// With inline video and native single-tap rows, the combined build measures
// 626111 / 190420 for web and 626069 / 190480 for native, within these limits.
// Cancellable iOS sign-in/proxy requests, peak touch movement and immediate PiP
// Stop add 995 raw / 384 gzip bytes to fe79de1 on Node 22.23.2. With the accepted
// EPG changes, web measures 627267 / 190842 and native 627225 / 190902. Allocate
// this reviewed lifecycle cost while retaining release-version headroom.
// NAS discovery and per-client Plex add bounded library boot and playback routing.
// Folder shuffle and explicit repeat add owned collection/EOS transitions,
// parental checks and source-scoped preference storage. Keep those guards;
// Plex pagination stays in its optional provider asset. Account for this
// reviewed feature cost: Node 26.8.2 web 640894 / 194762 gzip, native
// 640852 / 194822; retain native, Node 22 and release suffix headroom.
// This includes exact Plex cold resume, its guarded startup intent and exit flush.
// One-time VPortal queue shuffling also fits within these entry limits.
// Plex folder restoration retains bounded route metadata and rebuilds sibling
// queues with cancellation guards. Node 26.8.2 measures 644120 raw / 195549
// gzip for web, 644078 / 195613 native; retain Node 22 and release suffix room.
// Continuous catalog browsing adds owned page append/cancellation and a retry
// row without copying catalogs on each highlight. Node 26.8.2 measures
// 647536 raw / 196635 gzip for web; include native, Node 22 and suffix room.
// Visible shuffle/repeat modes, ordered-queue restoration and DOM digit fallback
// measure 650817 raw / 197647 gzip on Node 26.8.2. Preserve the established
// native, Node 22 and candidate-suffix allowance for this control-state feature.
// Catalogue-bound remote archive resolution/playback adds 2553 raw / 735 gzip
// bytes: Node 26.8.2 web measures 653370 / 198382. Retain the existing native,
// Node 22 and candidate-suffix allowance for these admission checks.
// Query-selected HLS Auto fallback reuses the native URL predicate (+93 raw).
// Numbered Stalker preset writes add validation, isolated persistence and safe
// acknowledgements. Missing-category localization adds 22 raw bytes. Combined
// Node 22.23.3 output before Plex is 655714 / 199443 web and 655672 / 199504 native.
// Plex adds owned loading, bounded connection retries and manual queue skips
// with cancellation and parental admission (+1593 raw entry bytes). Combined
// Node 22.23.3 output is 657307 / 199903 web and 657265 / 199963 native;
// retain bounded candidate-version suffix headroom for this feature cost.
// Runtime-scoped diagnostics, consent UI and complete logger cleanup add a
// measured 28 KB raw / 8.4 KB gzip. Node 26 measures 685215 / 208384 for the
// entry; allow native transforms, Node 22 compression and release suffix room.
// Installation-bound trust, durable revocation and acknowledged runtime repairs
// add about 10.5 KB raw, including cross-tab revocation; retain the bounded
// native/Node/version allowance.
// Persistent kiosk policy, admission/input guards and ten-second recovery add
// 6704 raw entry bytes. Node 26.8.2 measures 664011 / 201509 gzip; retain
// native, Node 22 and candidate-version headroom for this optional feature.
// Typed remote controls, semantic input admission and probed native lifecycle
// add about 9.9 KiB raw / 2.9 KiB gzip to the entry; provider assets are unchanged.
// Node 26.8.2 measures 714105 raw / 217220 gzip for web and 714063 / 217278
// for native. Retain bounded Node 22 and release-version suffix headroom.
// Language-switch recovery, generated-label provenance and native dialog labels
// add bounded interface logic; all 28 dictionaries remain external assets.
// Include native transforms, Node 22 compression and release suffix headroom.
// Adjacent-channel control and guarded list/PiP admission add 3272 raw/939 gzip
// bytes over be969d6 on Node 22.23.3: combined web 722437/220327 and native
// 722395/220390. Allocate the reviewed 3300 raw/950 gzip increment in addition
// to the localization budget, preserving both feature reserves.
// Atomic signed channel offsets add 426 raw / at most 186 gzip bytes over
// a845242 on Node 22.23.3. Preserve its 450 raw / 200 gzip feature allowance.
// Independent VPortal profiles load in an optional family. Persisted VOD kiosk
// admission/recovery adds about 6 KB to the entry. Keep both feature reserves
// and bounded native/Node/release-suffix room in the combined cap.
// Preserve the additional 2100 raw / 700 gzip allowance for Tauri native
// frame-loss recovery from main; it does not change optional provider assets.
// Thirty external catalogs add selector labels, script-mark labels and owned
// native composition/explicit-apply handling. Add 3.5 KB raw / 1.2 KB gzip
// while preserving each upstream feature and release-version reserve.
// Thirty more external catalogs and Georgian/combining-mark keyboard support
// add 1293 raw / about 800 gzip entry bytes. Node 22 measures 734887 raw /
// 225215 gzip for web; retain the existing native and candidate suffix reserve.
// Remote screenshots add a bounded capture adapter, local permission UI and
// expiring image delivery. Reserve 13 KB raw / 4 KB gzip for this feature;
// external dictionaries and native capture implementations remain separate.
// Explicit Plex queues keep their implementation in the optional Plex asset.
// Node 22.23.3, level-9 gzip: web entry 750532/230056, native 750490/230118.
// The lazy dispatcher and transactional media handoff exceed the prior caps by
// 1082 raw / 318 gzip bytes. Increase those caps by 1650 / 600, leaving at least
// 568 raw / 282 gzip bytes for native and candidate-version variation.
// Decoder-confirmed state, catalog lease preservation and recoverable native
// errors add 560 raw / 164 gzip bytes on Node 22: web 751092 / 230220.
// Allocate 600 / 200 to preserve the existing release-version headroom.
// Complete localization, system/media language preferences and pinned Unicode 17
// measure 783615 / 243951 web and 783573 / 244023 native on Node 22.23.3,
// compared with 746380 / 228703 web and 746338 / 228765 native at 8c240190.
// Compact ASCII varints keep normalization, grapheme and full case-fold data
// inside the measured entry. Bounded cookie recovery uses part of the original
// reserve; the unchanged cap leaves at least 685 raw / 477 gzip bytes at 1.1.53.
// Do not exclude these tables or storage helpers from the measurement.
// Both branches consumed the same historical reserve: common source 6f497732
// measures 746380 / 228703, below its 749450 / 229800 cap. Adding only cap
// increments therefore undercounts their combined cost. Latest main 3d7b65b7
// measures 783764 / 243995; Plex, decoder ownership and explicit native Resume
// together measure 788914 / 245600 on Node 22.23.3. Add their measured 5150 /
// 1605 cost, rounded to 5200 / 1650, to main's 784300 / 244500 cap so the
// existing native and release-version reserve is retained exactly once.
// Read-only doctor snapshots, exact-target inspection and bounded operation
// receipts, pure capability reads and the integrated Unicode fixes measure
// 804298 raw bytes on Node 22.23.3 before the embedded clean-source hash.
// Allocate 15500 / 4800 over 67618611 for this combined feature cost, retaining
// native transforms, the source hash and release suffix room. No provider moved.
// A cancellable Plex file-selection wait reuses the startup loading UI.
// The entry adds 871 raw bytes to the integrated 804881-byte baseline,
// including pointer/wheel admission behind the dialog and a clean source hash.
// Node 22.23.3 measures a 332-byte native gzip increment before that hash;
// allocate 900 raw / 400 gzip bytes to preserve the release-version reserve.
// Localized remote/touch feedback and language recovery share command playback
// code instead of repeating it. On clean Node 22.23.3 the combined web entry is
// 805979 raw / 251002 gzip; native is 805937 / 251071. Add only 200 raw bytes,
// leaving 121 before the release suffix; gzip and complete-payload caps stay put.
// Explicit Capacitor update dispatch adds 2367 raw bytes; retain release suffix room.
// Bounded kiosk reload and duplicate-item checkpoints measure 809372 raw web
// bytes on Node 26.8.2 (+661); retain native and release suffix headroom.
// Explicit aspect control, fenced persistence and media-only restore add 4889
// raw / at most 1353 gzip bytes over 57d8dd1 on Node 22.23.3.
// Web measures 810945 / 252390; native 810903 / 252458. Add 4900 / 1400
// to preserve the existing native and release-suffix reserve once.
// Combined with Android updates and durable kiosk cooldown checks, Node 22.23.3
// measures 814350 / 253386 web and 814308 / 253454 native within that allowance.
// Guarded kiosk frame-progress sampling and persistent retry evidence measure
// 817201 raw web bytes on Node 26.8.2. Allocate 3200 raw / 1100 gzip bytes for
// this shared recovery feature, retaining native and release-suffix headroom.
// Episode-bound strict-kiosk footer gestures add 2011 raw / 600 gzip bytes on Node 26.8.2.
// Budget this local seek control while retaining native/version headroom.
// Connected-runtime diagnostics add the bounded event ring, loop/frame counters,
// native projection and cancellable inspection. Same Node 26.8.2 toolchain:
// base 5c7bc823 = 819252 / 254180; candidate = 827579 / 256753 before the
// clean-source hash. Allocate 8500 raw / 2800 gzip for this reviewed feature,
// preserving the existing native, clean-source and release-suffix headroom.
// Android screen/lifecycle suspension adds 1640 raw bytes on Node 26.8.2
// (829840 total entry bytes). Retain clean-source and release suffix headroom;
// CI Node 22 measures 258390 gzip entry bytes before the native variant;
// allow the measured ~490-byte compressed feature cost plus suffix headroom.
// Named Plex libraries retain strict eager admission and lazy bounded collection.
// After a 265-byte entry reduction, Node 22.23.3 / zlib 1.3.1-e00f703 at the
// common 1.1.54 version measures base ef31f556 at 829930 / 258405 web and
// 829888 / 258473 native; candidate 23e3fa5c is 831249 / 258803 web and
// 831207 / 258869 native. Allocate the measured +1319 raw / +398 gzip cost
// rounded to +1350 / +400, preserving the existing native/version reserve.
// The 1.1.54-beta.1 entry is 831270 / 258821 web, 831228 / 258889 native.
// Cross-profile remote favorites add a bounded global index, durable source
// references, guarded profile loading and fresh media resolution. Node 22.23.3
// measures 845765 raw / 262584 gzip for the web entry. Allocate 14500 raw /
// 3600 gzip over the prior cap, retaining native and release suffix headroom.
// Standby tears down both lanes, retires pending Plex work and isolates cleanup
// failures. Node 22.23.3 measures 846770 / 262859 web, 846728 / 262927 native:
// +1005 raw / +275 gzip over the prior web entry. Allocate +1000 / +300 while
// preserving bounded native and release-version headroom.
// Cancellable Plex arrow waits and buffered HLS resume add 1282 raw / at most
// 366 gzip bytes on Node 26.8.2 at version 1.1.54. Allocate +1300 / +400, retaining
// the existing native, clean-source identity and release-version reserve.
// Reviewed roadmap cost: bbf9ca7b -> cae971da on the same Node 26.8.2,
// Terser 5.51.2 and zlib 1.2.12: entry 848092/262392 -> 874926/270321
// raw/gzip; native 874884/270372. Retain the prior Node 22/native/version
// reserve, plus the one-byte rooted diagnostic URL fix. Full evidence and
// scope (JavaScript only, separate A/V asset) are in docs/roadmap-size.md.
// Post-beta Plex integration and explicit damaged-journal recovery (including
// scoped cookie reset) measure 879533 / 271761 on Node 26.8.2, Rollup 4.64.5.
// Allocate their measured cost while preserving native/Node 22/version room.
// Transport suspension retains the logical lease while cancelling its engine
// and resolver, then safely reattaches on wake. Node 26.8.2 measures 848868 raw /
// 262607 gzip web bytes. Reserve +1000 raw for this lifecycle path and its
// stale-callback guards; retain the existing compressed budget.
// The required 40-hex source revision adds up to 40 gzip bytes across 68
// identity controls on Node 22.23.3. Native output reaches 263606 gzip bytes.
// Allocate 64 compressed bytes for this metadata and its compression variation;
// keep the raw cap and every staged entry check unchanged.
// Attached-engine diagnostics add 868 raw / at most 233 gzip bytes on Node
// 22.23.3 across beta.10 and final-base web/native output; reserve 900 / 256.
// Explicit debug-v2 negotiation preserves legacy payloads. Node 22.23.3 measures
// +235 raw / at most 108 gzip bytes; existing raw limits fit. Allocate 128 gzip
// bytes per entry and complete payload while keeping all provider assets counted.
// Salted PIN migration, bundled SHA256/HMAC/PBKDF2 primitives and fail-closed
// backup/rollback boundaries add 12549 raw / at most 4203 gzip bytes over 29e44213
// on Node 26.8.2: web 862631/267163, native 862589/267222. Allocate 12600/4250
// once, preserving existing Node22 and release-identity reserves. No payload
// or compatibility checks are removed; the seven provider assets are unchanged.
// Verified startup protection replaces post-unlock legacy migration. Its guarded
// load/publication and complete-copy failover add 480 raw bytes on Node 26.8.2
// (863111 versus 862631). Allocate 500 raw bytes. Recompressing the same
// source with CI Node 22.23.3 (zlib 1.3.1) measures 268281 / 268346 gzip
// web/native, versus 268113 / 268182 before startup protection. Allocate
// 192 gzip bytes for the measured maximum +168, retaining the prior source
// identity and release-version headroom. Node 26 uses a different zlib build.
// The scoped SJCL word-copy fix avoids V8 species-probe startup stalls.
// Node 22.23.3: prior 848f web 863151/268323 -> fixed 863425/268420.
// Reserve +256 raw/+128 gzip once; all five measured outputs fit while
// preserving native transforms and release-identity room.
// Combine the independently reviewed roadmap and main allowances once over
// their common 1ecbc0e7 baseline (848400 raw / 263600 gzip). No artifact or
// provider is excluded, and no additional integration reserve is introduced.
// Source-bound debug-v3 attempt history retains internal retries and EOF counters
// without changing v1/v2 payloads. Same Node 22.23.3, version 1.1.56 and 40-hex
// identity: baseline 1e8973 web 894773/277766, native 894731/277823;
// deduplicated implementation web 896640/278330, native 896598/278387.
// Add exactly +1867 raw/+564 gzip once, preserving the existing 383-byte raw
// and 195-byte worst-native gzip reserve. Beta.1 projects to 896661/278350
// web and 896619/278405 native; no provider or artifact is excluded.
// Local media library adds bounded 16KB raw / 5KB gzip to the entry.
// Offline profile storage, import/export boundaries and local binding UI:
// same-version Node 26 baseline c98c115d entry 912941/282340 vs 928115/286930.
// Allocate the measured +15174/+4590 with bounded release/native room.
// Upstream loading spinner adds 459 raw bytes; count its 512-byte allowance once.
// Upstream desktop volume capture and Ctrl seek add 155 raw bytes; allow 256 once.
// Retain the existing gzip cap and all native/provider artifact checks.
// Desktop volume capture and Ctrl seek add 155 raw bytes; allow 256 once.
// Nonblocking local startup and bounded source recovery add 454 raw bytes.
// Progressive 10k-file scanning, preferred resume and append-only catalogs add
// 3322 raw bytes and ~1.2 KB gzip; reserve 3584/1536 for this feature
// while retaining prior Node/zlib compression headroom.
// Legacy bookmark readiness and scan counters consume the remaining raw headroom;
// allow another 512 bytes while retaining the gzip cap.
// Initial scan phases and metadata progress need 60 more bytes; reserve 256.
// Native progressive polling, bounded requests and first-item playback measure
// 920867 raw / 284799 gzip on Node 26. Use prior headroom plus 2304/768 bytes;
// native artifacts and optional providers remain included in the same gates.
// Reversible list shuffle and stable favorites backup add 4304 raw bytes.
// Allocate 4608/1024 once, plus the 16 KiB / 5 KiB profile allowance.
// Profile persistence and non-scanning snapshots add 15790 raw bytes over
// the progressive native baseline. All provider/native artifacts stay gated.
// Restored profile ownership/atomic recovery and browser/native inactivity
// bounds add 2058 raw bytes to the final integrated entry. Reserve 2304/768.
// Selected Plex/VPortal sources, progressive channel playlists and owned file
// playback add 10941 raw / at most 3105 gzip entry bytes over 4f9aea8a on
// Node 26.8.2: web 952023/293798, native 951981/293855. Allocate 11000/3150
// while retaining the previous native, Node 22 and release-suffix allowance.
// Combined with PR818 recovery guards: 954096/294386 web, 954054/294444
// native on Node 26.8.2; retain both independently measured allowances.
// PR820 local resume/exit and per-profile journal isolation reserve another
// 512 + 256 raw bytes in the entry, with no increase to its gzip allowance.
// Visible progressive-list refresh, owned VPortal failure completion and Local
// file arrows add 1529 raw entry bytes on Node 26.8.2 (956603 total). Reserve
// 1600 raw bytes for these guards. Node 22.23.3 / zlib 1.3.1 measures
// 295986 gzip in CI before the native suffix; reserve another 256 gzip bytes
// for that compressor, native artifacts and release identity. Total caps stay.
// Retain the independently measured standby allowance once: 11264 raw / 3712 gzip.
// Combined with main 4fe571e3 on Node 22.23.3: web 967984/299580,
// native 967942/299643; complete web 1099953/347857 and native 1099911/347920.
// Owned Local EOF transitions and filename rendering add ~1368 raw / 458 gzip
// bytes over afb7e4b9 on Node 26.8.2 (web 968685/298948 before the change).
// Allocate 1536/512 once, retaining native, Node 22 and release identity room.
// Collection/programme clocks and scalar successor reads add 4755 raw / 1481
// gzip entry bytes on Node 26.8.2 (974808 / 300930 total). Reserve 5120 raw / 1536 gzip for
// this feature, retaining native/Node 22 and release suffix headroom.
// Stable-group/history reaches 302000 gzip bytes on the macOS CI Node 22.23.3
// runner. Matching local Node 22 measures 302042 native with a beta suffix.
// Reserve 256 gzip bytes for this measured feature and native/release variation.
// Deferred browser import, source priority and one-shot provider handoff add
// 1107 raw bytes on Node 22; reserve 1280 for the feature and version suffix.
// Web gzip is 302279 bytes; allow the measured native and release suffix delta.
// Browser enumeration phases, honest counters and cold-directory deadlines add
// 1337 raw entry bytes on Node 22; reserve 1536 including release identity room.
// Web gzip is 302703 bytes; retain 448 extra bytes for native/release variation.
// Startup cancellation, sanitized read failures and local standby wake add
// about 2613 raw bytes on Node 22; reserve 2816 for this reviewed feature set.
// Web gzip is 303501 bytes; add 896 for native transforms and release identity.
// Source-bound local-folder kiosk adds 2167 raw / 730 gzip bytes on Node 22.
// Keep bounded native/release room; optional provider budgets are unchanged.
// Completed-source uniqueness and missing-file recovery keep bounded native/beta headroom.
// Android Local screen suspension and deferred EOF add about 1.2 KB raw;
// retain bounded gzip/native/release identity headroom.
// Progressive missing-file fallback, native scan events and cancellable loading
// add bounded startup control. Node 22.23.3 measures 988660/305866 web
// and 988618/305920 native; complete native 1120808/354248 bytes.
// Retain a small reserve for clean-source identity and release suffixes.
// PC random selection adds 3199 raw / 788 gzip bytes to the largest entry.
// Node 22.23.3 measures 991859/306650 web and 991817/306708 native;
// retain about 700 raw / 600 gzip bytes for release identity variation.
const BUDGET = Object.freeze({ bytes: 992600, gzipBytes: 307350 });
// The SJCL repair changes only the entry; retain the previous per-provider caps.
const PROVIDER_BUDGET = Object.freeze({ bytes: 863400, gzipBytes: 268490 });
// Count every optional family as well, so moving code out of the entry bundle
// cannot disguise growth of the complete player payload.
// Classic MAG support adds ~5 KB to the optional Stalker family and a small
// cancellable URL resolver to the shared backend (including release suffix room).
// The combined localization and PC2 changes need 85 more raw bytes; retain
// release suffix room without increasing the complete compressed budget.
// Stalker recovery and settings re-entry measure 192100 gzip bytes in native
// outputs on CI Node 22.23.2 (192106 with a beta version). Keep suffix headroom.
// VOD-owned native metadata and the late-guide guard measure 192222 on Node 22.
// Include the VPortal automatic-quality resolver as part of episode looping.
// The same candidate plus every provider totals 667727 / 206833 for web;
// native variants total 667685 / 206887. All complete payloads remain bounded.
// The same bounded diagnostics addition needs 100 raw complete-payload bytes.
// The same candidate with every provider measures 671260 / 208569 for web
// and 671218 / 208623 for native outputs; retain bounded suffix headroom.
// The gesture candidate totals 673493 raw / 208815 gzip before version suffixes.
// Including the Edem queue bridge, the VPortal candidate totals 681416 raw /
// 211638 gzip (native 681374 / 211697); all provider families remain counted.
// The metadata RPCs add the same measured cost to the complete payload.
// The same profile/restart candidate totals 691509 / 215210 for web and
// 691467 / 215268 for native; all five provider assets remain byte-identical.
// The combined inline-video/tap build totals 691595 / 215248 for web and
// 691553 / 215308 for native, still retaining bounded release suffix room.
// The same combined source plus every provider totals 692751 / 215670 for web
// and 692709 / 215730 for native on Node 22.23.2. Provider assets are unchanged;
// retain the complete-payload guard and release-version headroom.
// Include direct Plex catalogs, PIN sign-in, roaming connections and session cleanup.
// Include bounded, independently cancellable Plex folder collection and title
// fallbacks in the complete payload: web 733963 / 229802 gzip, native
// 733921 / 229862, retaining comparable complete-payload headroom.
// Include complete Plex folder records: 737347 / 230655 web
// and 737305 / 230719 native, with the same bounded release headroom.
// Include independent Plex/VPortal page transports and stable cursor IDs:
// the complete web payload is 742619 raw / 232209 gzip on Node 26.8.2.
// The same control-state change adds 3281 raw / 1012 gzip bytes; provider payloads
// remain unchanged and count toward this complete-output bound.
// Fifteen Stalker profiles, legacy migration and owned switching live in the
// optional provider asset. Combined with the control-state change, Node 22.23.2
// measures 748121 / 234576 for web and 748079 / 234635 for native. Keep the
// entry budget unchanged and allow release suffix room for both feature costs.
// The same archive RPCs leave provider assets unchanged: the complete web
// payload measures 750586 raw / 234697 gzip on Node 26.8.2.
// The HLS predicate, Stalker preset handler and missing-category localization
// change only the entry. Before Plex, Node 22.23.3 complete outputs measure
// 752930 / 235840 web and 752888 / 235901 native, including unchanged providers.
// Plex loading, retry and queue navigation add 1970 raw complete-payload bytes.
// Combined Node 22.23.3 output is 754900 / 236452 web and 754858 / 236512 native;
// retain bounded release-suffix headroom while counting every provider.
// The same diagnostic implementation is counted once; providers are unchanged.
// Kiosk changes only the entry; count the same measured cost in total payloads.
// Count localization logic, optional-provider provenance and adjacent-channel
// admission together with all six provider bundles. Node 22.23.3 combined
// totals are web 819932/256711 and native 819890/256774. Provider assets are
// unchanged by adjacent-channel admission; add its reviewed 3300 raw/950 gzip
// increment to the localization complete-payload cap.
// Include the optional VPortal family and VOD kiosk entry logic, plus the
// 450 raw / 200 gzip allowance for signed channel offsets from main.
// Include the same 2100 raw / 700 gzip frame-loss recovery allowance once.
// Include the same screenshot feature once in the complete payload bound.
// Including all provider assets, explicit queues measure 862700/271732 web
// and 862658/271794 native. The prior caps were 855550/269000: measured excess
// is 7150 raw / 2794 gzip bytes. Add 7650 / 3100, retaining at least 500 / 306
// bytes for native and release-version variation rather than hiding lazy code.
// Apply the same decoder-state increment once; provider assets are unchanged.
// The same localized build plus all seven provider families is 888391 / 283217
// web and 888349 / 283289 native. Only Stalker's locale adds provider bytes
// (+24 raw / +7 gzip). The unchanged complete-payload cap leaves at least
// 2009 raw / 411 gzip bytes at 1.1.53, counting every provider and table.
// Common source 6f497732 totals 851132 / 267962, below its 855550 / 269000
// cap. Latest main totals 888540 / 283261; the combined player totals 901237 /
// 287304, including every optional provider. Add the measured 12697 / 4043
// cost, rounded to 12700 / 4100, to main's 890400 / 283700 cap. This preserves
// main's reserve without counting the common branch reserve twice.
// The workbench entry increment is counted once in the complete payload too.
// The Plex error handoff adds 14 more gzip bytes in its optional provider.
// Include the same 400-byte compressed allowance in the complete player;
// its raw payload remains within the existing cap.
// Native Node 22 output with kiosk recovery measures 293871 gzip bytes.
// Include the Android menu alias and retain candidate-version headroom.
// The same aspect increment is counted here; all seven provider assets are
// unchanged. Complete web measures 923327 / 294108; native 923285 / 294176.
// The integrated Android/aspect build is 926823 / 295139 web and
// 926781 / 295207 native on Node 22.23.3, including the durable kiosk guard.
// Count the same kiosk frame-progress increment once; providers are unchanged.
// The same runtime feature costs 8327 raw / 2573 gzip in the complete payload;
// provider assets are unchanged and all remain included in this size gate.
// Exact movie selection measures 940789 raw web / 940829 native bytes in CI.
// Add 250 raw bytes for this bounded selector and release identity variation;
// retain the compressed and entry limits and count every optional provider.
// Count the same 1640-byte screen suspension addition once in the full payload.
// Count named-library resolution and pagination in all seven provider assets.
// At the same 1.1.54 version/toolchain, base ef31f556 totals 942519 / 300181
// web and 942477 / 300249 native; candidate 23e3fa5c totals 946507 / 301500
// web and 946465 / 301566 native. Allocate +4000 raw / +1350 gzip for the
// measured +3988 / +1319 feature cost, retaining the prior reserve once.
// The 1.1.54-beta.1 totals are 946528 / 301518 web, 946486 / 301586 native.
// Count the favorites entry change and Plex source-binding helper together:
// Node 22.23.3 measures 961572 raw / 305427 gzip including all seven providers.
// Retain bounded native and release suffix room; no optional code is excluded.
// Count the standby entry changes and optional Plex admission guard together.
// Node 22.23.3 totals 962749 / 305746 web and 962707 / 305814 native:
// +1177 raw / +319 gzip over the prior complete web payload. Allocate +1200 / +350.
// Include the shared skip wait, buffered HLS resume and optional Plex retries:
// +1670 raw / at most 488 gzip bytes over fbc80031, measured with all seven
// providers on Node 26.8.2. Allocate +1700 / +500 to preserve the prior reserve.
// All eight provider families remain counted, including lazy Xtream:
// 964459/305344 -> 995587/315103 web; 995545/315154 native.
// The same build, counting all eight optional providers, is 1000388 / 316600.
// Keep every provider inside the bound; no runtime code is excluded or deferred.
// Count the same transport-suspension code once in the complete payload.
// CI Node 22 measures 306569 gzip bytes; retain 81 bytes for release identity.
// Count the same 64-byte source-metadata allowance once in the full payload.
// All seven providers remain included and contribute 43074 gzip bytes.
// Count the same 900 / 256 engine-diagnostic allowance once; providers do not change.
// Count the same 12600/4250 PIN migration allowance once in the total, plus
// the measured startup protection cost of 500 raw / 192 gzip bytes.
// Count the same +256 raw/+128 gzip word-copy repair once; all seven
// provider outputs and every artifact remain in the complete-payload checks.
// Combine both reviewed deltas over the common 964900 / 306550 baseline.
// Count the same +1867/+564 debug-v3 feature cost once; all eight provider
// bundles are unchanged and remain inside the complete-payload measurement.
// Count the same 512-byte loading-spinner allowance once in the full payload.
// Include the same 256-byte desktop input allowance once.
// Count the 512-byte local startup allowance once; gzip limits stay fixed.
// Include the same progressive-catalog allowance once in the full payload.
// Count the 512-byte readiness/counter allowance once in the payload.
// Include the same 256-byte initial progress allowance once.
// Count the same shuffle and profile deltas once across shipped artifacts.
// Count the restored recovery/ownership boundary once across all artifacts.
// Count the channel-playlist entry and both optional provider scanners once.
// The complete payload adds 23671 raw / at most 6957 gzip bytes over 4f9aea8a;
// allocate 23700/7000, preserving the existing complete-payload headroom.
// Count PR820's 768-byte local resume/journal allowance once in the payload.
// Count the same standby allowance once across the complete payload.
// Count the same Local EOF/footer allowance once; providers are unchanged.
// Count the same collection/programme feature once in the full payload.
// Stable-group completion/history adds 536 raw / 184 gzip to the full player
// (1107534 / 349398 on Node 26.8.2). The existing entry and gzip caps fit;
// retain 256 raw aggregate bytes for the frozen beta suffix and native variants.
// Node 22 beta output totals 350370 gzip bytes for native builds; the observed
// CI entry variation leaves only 47 bytes. Retain 128 bytes of aggregate margin.
// Integrated Node 22 native output is 350730 gzip bytes; retain suffix room.
// Count the same local-folder policy and EOF/footer routing once in the total.
// Node 22 measures 1115298/352559 web and 1115256/352616 native.
// The same PC shortcut is counted once across all shipped artifacts.
// Node 22.23.3 totals 1124049/354978 web and 1124007/355036 native.
const TOTAL_BUDGET = Object.freeze({ bytes: 1124800, gzipBytes: 355650 });
const ARTIFACTS = Object.freeze([
    "dist/player.js",
    "src-tauri/frontend/dist/player.js",
    "dist-mobile/dist/player.js",
]);

function measureBundle(source, name, budget = BUDGET) {
    const buffer = Buffer.isBuffer(source)
        ? source
        : Buffer.from(source, "utf8");
    const result = {
        bytes: buffer.length,
        gzipBytes: gzipSync(buffer, { level: 9 }).length,
        path: name,
        sha256: createHash("sha256").update(buffer).digest("hex"),
    };
    if (!result.bytes) throw new Error("Empty classic bundle: " + name);
    for (const key of ["bytes", "gzipBytes"]) {
        if (result[key] > budget[key])
            throw new Error(
                `${name}: ${key} ${result[key]} exceeds budget ${budget[key]}`
            );
    }
    return result;
}

function inspectBundles(root, artifacts = ARTIFACTS) {
    return artifacts.map((file) =>
        measureBundle(fs.readFileSync(path.join(root, file)), file)
    );
}

function inspectBundleSets(root, artifacts = ARTIFACTS, providerKinds) {
    const { CLASSIC_PROVIDER_BUNDLES } = require("./classic-bundle.cjs");
    const kinds = providerKinds || Object.keys(CLASSIC_PROVIDER_BUNDLES);
    if (
        new Set(kinds).size !== kinds.length ||
        kinds.some(
            (kind) =>
                !Object.prototype.hasOwnProperty.call(
                    CLASSIC_PROVIDER_BUNDLES,
                    kind
                )
        )
    )
        throw new Error("Invalid expected provider bundle kinds");
    return inspectBundles(root, artifacts).map((entry) => {
        const directory = path.dirname(entry.path);
        const expected = kinds.map((kind) => "provider-" + kind + ".js");
        for (const name of fs.readdirSync(path.join(root, directory))) {
            if (/^provider-.*\.js$/.test(name) && !expected.includes(name))
                throw new Error(
                    "Unexpected provider bundle: " + path.join(directory, name)
                );
        }
        const providers = expected.map((name) => {
            const file = path.join(directory, name);
            return measureBundle(
                fs.readFileSync(path.join(root, file)),
                file,
                PROVIDER_BUDGET
            );
        });
        const total = [entry, ...providers].reduce(
            (sum, item) => ({
                bytes: sum.bytes + item.bytes,
                gzipBytes: sum.gzipBytes + item.gzipBytes,
            }),
            { bytes: 0, gzipBytes: 0 }
        );
        for (const key of ["bytes", "gzipBytes"]) {
            if (total[key] > TOTAL_BUDGET[key])
                throw new Error(
                    `${entry.path}: complete player ${key} ${total[key]} exceeds budget ${TOTAL_BUDGET[key]}`
                );
        }
        return { entry: entry.path, providers, total };
    });
}

function writeBundleReport(
    root,
    optimizer,
    modules,
    artifacts = ARTIFACTS,
    providerKinds
) {
    const { CLASSIC_PRIVATE_MODULES } = require("./classic-bundle.cjs");
    const measured = inspectBundles(root, artifacts);
    if (measured[0].sha256 !== optimizer.outputSha256)
        throw new Error(
            "Classic optimizer report does not match the server bundle"
        );
    const report = {
        artifacts: measured,
        budget: BUDGET,
        modules,
        optimizer,
        privateModules: Object.fromEntries(
            Object.entries(CLASSIC_PRIVATE_MODULES).filter(([file]) =>
                modules.includes(file)
            )
        ),
        providerBundles: inspectBundleSets(root, artifacts, providerKinds),
        schema: 1,
        toolchain: { node: process.versions.node, zlib: process.versions.zlib },
        totalBudget: TOTAL_BUDGET,
    };
    const output = path.join(root, "build/reports/classic-bundle.json");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    return report;
}

if (require.main === module) {
    try {
        for (const result of inspectBundles(path.resolve(__dirname, "..")))
            console.log(
                `${result.path}: ${result.bytes} bytes; gzip ${result.gzipBytes} bytes`
            );
        for (const result of inspectBundleSets(path.resolve(__dirname, "..")))
            console.log(
                `${result.entry}: complete player ${result.total.bytes} bytes; gzip ${result.total.gzipBytes} bytes`
            );
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
module.exports = {
    ARTIFACTS,
    BUDGET,
    inspectBundleSets,
    inspectBundles,
    measureBundle,
    PROVIDER_BUDGET,
    TOTAL_BUDGET,
    writeBundleReport,
};

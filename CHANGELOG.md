# Changelog

## Unreleased

- Wake Standby from a local click, tap or key press. Consume the wake gesture
  without changing the channel or volume, while preserving native wake ordering
  and kiosk restrictions.

- Keep waiting for a large browser folder's initial directory batch instead of
  expiring after 60 seconds. Show the picker, enumeration and metadata phases
  with discovered-entry and playable-video counts; preserve immediate cancel
  and bounded metadata reads.

- Start browser Add folder/Add files playback from the first readable video
  instead of waiting for the whole source to scan. Report progress, bound stalled
  reads, and ignore cancelled or superseded picker results without copying media.
  Prioritize newly selected sources through the playback handoff so a stalled
  old folder cannot block the new video.

- Retain a Local video's stable group identity for the next-file footer,
  automatic completion and saved playback. Reordering groups cannot select a
  different group's video; deleting the playing group clears its successor
  while preserving the current file's information.

- Show the playing folder or collection in the finite-media footer, with current
  and next file titles below it. Display actual playback-start time and the next
  item's estimated start time instead of elapsed minutes, across Local videos,
  Plex and VPortal in all player builds.

- Advance Local videos to the next file after playback ends, honoring playlist order, repeat and kiosk pinning. Populate the standard local-media footer instead of leaving it blank or retaining television programme details.

- When a valid interface language is already loaded, resume the configured provider and channel after repeated standby/go without reopening language settings. Retain the resolved system language and original popup menu, including hidden provider settings, and ignore stale language callbacks from an earlier startup. Avoid duplicate playback listeners and polling timers, and bound Tauri update checks. Cancel local metadata scans and abandoned media requests between filesystem operations while keeping in-flight reads counted until they actually finish.

- Make remote standby/go suspend playback, provider requests, local scans and EPG work while keeping control connected. Persist the device-local state across reload, block late playback and kiosk watchdog recovery until go, and expose actual background drain status. Allow authenticated standby/go with kiosk/settings locks while retaining other lifecycle restrictions.

- Remove VPortal setup, catalog loading and remote settings from M3U profiles. Use the standalone VPortal provider for selected portal sections; stored legacy device values are preserved but inactive. M3U remote metadata and settings comparisons now cover only TV settings.

- Project selected Plex folders and standalone VPortal sections into the standard channel playlist. Start from the first usable batch, append remaining videos without restarting playback, and ignore results from cancelled loads.
- Update an already open channel list as background batches arrive, preserving the focused item and any active dialog or search.
- Resolve channel-backed media with the existing loading dialog, authentication and watch history. Keep file navigation aligned with the current channel order, including after shuffle or background additions.
- Keep VPortal direct-file identities stable when signed URLs rotate, and refresh the playback URL before selection or repeat.
- Close the owned loading dialog after a VPortal resolution failure so the same item can be retried; ignore cancelled and superseded replies.
- Put media playlist repeat in channel-list Actions; reuse existing search, Shuffle and Reset order instead of a separate media browser during normal playback.
- Apply repeat changes to a pending next-file transition without leaving playback stopped, and open All rather than an empty Favorites category when the saved media file is missing.
- Include tracks from selected Plex music libraries in the standard playlist.
- Keep Local videos Up/Down mapped to previous/next file after finite-media detection, while respecting custom key mappings and open menus.
- Resume the exact selected Local videos file at its saved playback position after Q, page closure, or native app exit. Capture the decoder clock before exit/stop; keep completed files and explicit channel changes starting at zero.

## [1.1.58] - 2026-10-19

### Changes

- Add Shuffle and Reset order to channel-list Actions and the numeric popup. Keep the current video and cursor, preserve the pre-shuffle order across restart, and retain newly discovered files when resetting.
- Play local videos from browser folder handles, Android document sources, iOS bookmarks, and desktop file references without creating another media copy. Retain the original source and selected video across restart; sources that need permission offer explicit recovery.
- Stream large browser-folder catalogs in batches, resume the saved file directly, and append remaining entries without restarting playback. Avoid repeated metadata scans on Android; skip unreadable children without losing the source.
- Scan Tauri folders in the background and start playback from the first eligible result. Show processed entries and playable videos in the standard loading dialog; omit unknown totals and stop waiting on stalled scans.
- Use the standard player settings and loading dialog for local media. Open the player before scanning a saved folder, and offer recovery when a source fails or stops responding.
- On PC, plain Left/Right adjusts volume even with fullscreen video focus. Alt/Option, Ctrl, or Command with Left/Right seeks by ten seconds in local video, VOD, and supported channel archives.
- Treat Local videos as finite media from playback start, including when a slow source reports its duration late. Seeking keeps the same video and pause state instead of restarting it; the timeline updates when duration becomes available.
- Serve the offline worker and hosted runtime assets from the local server, and use content-hashed bootstrap URLs to refresh same-version hosted bundles.

- Add 15 Local videos (`offline`) profile slots with remote save/load/export/import,
  source-subset isolation and saved-file restoration. Portable profiles carry
  descriptions only; browser handles and native grants/bookmarks stay local.
  Foreign imports require an explicit local binding, and generic settings/cloud
  restores preserve rather than replace the installation's private bindings.
  Missing-file recovery clears startup overlays, and JSON settings backups restore
  the imported active slot with its channel and favorites documents.
- Synchronize the standalone fuzz lockfile with the existing Local videos core
  dependencies so baseline regression-corpus checks work with `--locked`.

### Upgrade

- Saved folder references are device-specific. Reconnect moved/removable sources and grant filesystem access when the operating system or browser asks. Access to a server library requires a network connection.
- Existing imported media copies remain readable. Connecting a new direct source does not automatically remove old copies.

### Security

- Keep source media read-only when disconnecting a linked folder. Validate media/source IDs and restrict HTTP imports to generated identifiers and supported extensions; add adversarial path and deletion regression tests.

## [1.1.57] - 2026-10-18

### Changes

- Keep the blank video poster explicit in both main and picture-in-picture players.
- Remove the duplicate NAS settings entry while retaining NAS access from the source popup.
- Refresh the verified shared-core receipt and safe frontend/build dependencies.
- Update pinned CI tooling and check the updater dependency graph on each desktop target.
- Disable the unused ZIP updater archive feature on Windows to remove vulnerable ZIP code from shipped runtime dependency graphs. Raw MSI/EXE installers remain supported; legacy ZIP-wrapped Windows updater payloads are no longer supported. Linux/macOS archive support is unchanged.

### Upgrade

- Install the published package for your platform and architecture. Windows users can install the raw MSI/EXE installers directly; legacy ZIP-wrapped updater payloads are no longer supported. Linux and macOS retain their existing archive support.
- Keep settings backups private and close other player instances before upgrading. Do not reopen migrated parental-PIN settings in an older player; see [PIN migration and limitations](docs/parental-pin-storage.md).

### Security

- The Windows updater no longer selects the vulnerable ZIP extraction dependency. CI checks the actual Windows, Linux and macOS runtime dependency graphs; optional ZIP entries may still appear in the cross-platform lockfile.
- Six informational unmaintained-dependency advisories remain tracked, including the Linux MPRIS zbus dependency family. These are not claimed as fixed by this release; see [Rust dependency security](docs/rust-dependency-security.md) for the current assessment and migration constraints.
- Build the CI Scorecard scanner from the reviewed toolkit revision with Go 1.27.2 and checksum-pinned modules, replacing the older scanner dependency graph.

## [1.1.56] - Development line

### Changes

- Bound playback recovery and backup attempts across engine replacement, preserve
  configured quality limits, and provide an optional hosted picture-and-sound check.
- Add lazy Xtream movie and series browsing, explicit channel-to-guide bindings,
  accessible classic dialogs, and same-source live/archive handoff with a compatible
  controller. VOD handoff is not included.
- Recover interrupted local settings transactions before loading accounts. Recovery
  assumes a single writer; damaged journals require an explicit retry or reset.
- Add English/Russian feature guides, illustrated verification reports and localized
  quick starts for all 88 interface languages. The hosted diagnostic requires internet
  access and is fetched only when explicitly started.

- Avoid V8 array-species deoptimization during legacy-UA PIN startup without reducing PBKDF2 work; retain exact upstream provenance and differential cryptographic tests.
- Preserve playback startup, retry and fallback counters through natural EOF for
  explicit version 3 diagnostics. Existing version 1/2 diagnostics and controller
  capability responses keep their exact schemas.

### Upgrade

- Close other player tabs before upgrading and keep settings backups private.
  PIN records migrate when settings load; do not reopen migrated settings in an
  older player, which may replace an unsupported record with its old default PIN.
- Use a compatible updated controller for same-source live/archive handoff.
  Existing controller commands remain compatible; the new diagnostic counters
  require an explicit version 3 client and are not requested by older controllers.
- The hosted picture-and-sound diagnostic is optional and uses the network only
  when started. Playback checks on synthetic fixtures do not qualify every
  physical TV, decoder, live provider or DRM service.

### Security

- Store new/changed parental PINs using salted PBKDF2-HMAC-SHA256 (600,000 iterations).
  Protect readable legacy PINs and genuinely new default PINs at settings load,
  requiring verified storage before any unlock; convert old backup PINs before
  import/export, preserving existing hash records.
- Keep corrupted or unreadable PIN storage locked instead of restoring the historical
  default. Cancel obsolete derivations across source, policy and screen changes.
- Close all old player tabs before updating and do not downgrade against migrated
  settings: old versions do not understand the new record and may restore `1234`.
  See [PIN migration and limitations](docs/parental-pin-storage.md). Existing plaintext
  can remain after storage failure, but the current player stays locked until
  migration succeeds; no device performance claim is made.

- Backport the upstream inhabited opaque class type for `block` 0.1.6, fixing
  the macOS dependency's uninhabited foreign-static declaration without a
  breaking Blocks API migration. Native copy/call/drop regressions are required.

## [1.1.55] - Development line

### Changes

- Preserve byte-pinned media inputs, generated assets and license texts on
  Windows checkouts, avoiding an unnecessary runtime rebuild while retaining
  strict release source verification.
- Include the upstream GStreamer stream-startup flush fix in an app-private
  Linux playback plugin, preserving Ubuntu's security patches. DEB activation
  is restricted to reviewed Ubuntu 24.04 plugin bytes; AppImages bundle the
  rebuilt plugin and corresponding source without changing system libraries.
- Report the actual attached playback engine in runtime diagnostics, including
  HLS-to-native fallback; stopped or unavailable engines remain explicitly null.
  Explicit debug version 2 requests add this evidence while version 1 remains
  compatible with existing controllers and CLIs.

- Preserve the exact source revision in release frontend diagnostics. Verify
  committed media assets before CI builds and reject release builds whose
  source identity cannot be validated against the frozen version plan.
- Declare the Linux HLS, H.264 and AAC package dependencies, bundle the
  AppImage media framework, and require decoded audio/video buffers and clean
  end-of-stream in the Linux build's codec preflight.
- Keep native Linux builds on the fixed Ubuntu 24.04 baseline for x86_64 and
  ARM64. Run Linux WebKit browser checks on Ubuntu 26.04 x64 and historical
  macOS WebKit checks on Intel, retaining the complete RC browser scenarios.
- Keep loading Plex catalogs after a full page when the server omits the total
  item count, instead of stopping at the first 200 entries.
- Accept JSON and XML during Plex server connection checks while verifying the
  server identity before sending its token.
- Cancel saved Plex playback restoration when its loading screen is replaced,
  so delayed replies cannot start a video behind a newer dialog.
- Preserve the requested next or previous Plex file when the old video ends
  during a pending full-screen switch.
- Release Plex playback sessions with a keepalive request before page-exit
  teardown, avoiding duplicate stop requests and WebKit reload failures.
- Preserve Android kiosk resume after changing strictness remotely while the
  screen is off, including a channel selected while asleep.
- Strengthen release-candidate fuzz evidence with required seed corpora, bounded
  replay and validation of the pinned shared workflow.

### Upgrade

- Install DEB packages with `sudo apt install ./OttPlay.FOSS_*.deb` so media
  dependencies are resolved. On Fedora, use
  `sudo dnf --enablerepo=fedora-cisco-openh264 install ./OttPlay.FOSS-*.rpm`;
  the real `openh264` library is required, not the non-decoding `noopenh264`
  placeholder. Select only the intended architecture's package and see
  [Linux media packaging](docs/linux-media-packaging.md) for requirements and
  the separate browser/native playback checks.
- Update using the package for the same platform as your existing installation.
  This patch preserves saved profiles and settings and introduces no data or
  credential migration.
- Beta and release-candidate packages remain prereleases for validation before
  stable publication.

### Security

- Update rustls to 0.23.46 and quinn-proto to 0.11.18 in application and fuzz
  lockfiles for RUSTSEC-2026-0346, RUSTSEC-2026-0347, RUSTSEC-2026-0348,
  RUSTSEC-2026-0349, RUSTSEC-2026-0338, RUSTSEC-2026-0340 and
  RUSTSEC-2026-0343. Existing TLS verification and remote-control authorization
  remain enabled.

## [1.1.54] - Development line

### Changes

- Gate release candidates on bounded portal-request and XMLTV fuzz campaigns, retaining source-bound validation evidence.
- Show an explicit loading wait when full-screen Plex Up/Down needs to load the
  neighboring file or restore its folder queue. Back cancels the pending switch
  and keeps the current file selected; repeated arrows update the selection.
- Retry transient Plex catalog and file-resolution failures within bounded
  attempts, and reuse Tauri HTTP connections while preserving per-request
  timeouts and separate control-transport security policies.
- Avoid a WebKit stall when resuming HLS after a reload by applying the saved
  position through the stream engine after its initial media buffer is ready.
- Preserve pending HLS seeks through loading retries and decoder recovery,
  including seeks to the beginning of a stream.
- Stop both main and PiP streams on standby, reset native media resource
  selection, and cancel preview and pending Plex playback so background
  callbacks cannot restart those streams. Plex playback remains blocked until
  wake; the remote-control connection stays available.
- Save the currently playing channel or film as a remote favorite, with its
  provider/profile binding and durable item reference. Selecting a favorite
  loads the saved profile and resolves the item through its provider; temporary
  playback URLs are not used as saved launch targets.
- Prepare Plex library queues from the complete, validated catalog without a
  redundant bulk metadata request that could time out and incorrectly report
  playable videos as unavailable. The first video is still resolved before
  playback starts.
- Start or preview a complete Plex movie/TV library by name or section ID,
  optionally shuffled, using the player's saved connection and bounded complete
  pagination. Ambiguous or incomplete selections leave existing playback intact.

### Upgrade

Update the control server and CLI to versions with `plex_library` support, then
update or reload the player to use the new library commands. The player's saved
Plex connection is reused; no settings or data migration is required.

Remote favorites require `favorites` support in the player, control server and
CLI. Existing profile-local favorites retain their storage format and scope.

### Security

Existing remote-control authorization, parental restrictions, runtime binding
and request-cancellation checks remain in force. This release introduces no new
credential format.

## [1.1.53] - Development line

### Changes

- Discover Android XMLTV channels without retaining every channel's schedule.
  Load only the selected channel's programmes, preserving archive entries and
  descriptions, with bounded record, source-set and in-memory cache sizes.
- Stream Android XMLTV downloads, gzip expansion and parsing through bounded
  files/streams, avoiding full-document byte and UTF-16 copies on older tablets.
  Preserve source-specific cache fallback and reject oversized/truncated input.
- Bound Android provider and playlist HTTP responses to 8 MiB, including bodies
  without Content-Length. Oversized responses now fail the request and close the
  connection instead of exhausting the app heap during profile loading.
- Report an unavailable current stream as a rejected restart with a stable
  reason, rather than claiming that the player does not support stream restart.

- Pause Android kiosk playback when the screen turns off or the app leaves the
  foreground; suspend recovery while asleep and resume the same active episode.

- Select an ordered, looping VPortal queue by exact movie titles through OTT,
  rejecting missing or ambiguous titles instead of playing broader search results.

- Keep Android hardware volume buttons working in strict kiosk mode and while
  the WebView is loading or stalled by controlling media volume natively.

- Add bounded runtime debug snapshots with event history, JavaScript scheduling
  and frame counters, Capacitor Android/iOS and Tauri native process metadata,
  and authenticated Rust companion diagnostics; remote connection authorization
  applies without a second player permission switch.

- Allow tapping or dragging the video footer timeline to seek within the current
  episode in strict kiosk mode, while retaining the other input restrictions.

- Plex: up to 500 remote queue items and persistent looping media kiosk across web and native shells.
- Recover stalled kiosks with stream retries and a bounded player reload that
  preserves the locked selection, queue and position; wait while offline.
- Detect a stalled HTML video frame counter in kiosk even when its media clock
  continues advancing, with guarded recovery and remote counter diagnostics.
- Keep Plex connection failures from opening settings or modal errors beneath
  a kiosk lock; explicitly turning kiosk off restores settings access.
- Restore signed Full Capacitor Android APKs in beta, RC and stable releases,
  using the current shared frontend and preserving existing installations.
- Add staged APK updates through OTT with HTTPS, SHA-256, package, version and
  signing-certificate checks. Android may require on-device confirmation.
- Keep Fire tablet system bars hidden after keyboard dismissal and app resume,
  with dark transient bars and the shared proportional startup logo.

- Run a shorter validation suite for beta publication after pull-request checks:
  lint, types and core playback/provider/UI regressions. Pull requests, nightlies
  and release candidates retain full validation; every beta still builds and
  verifies the complete package inventory.
- Make full-screen Plex Left/Right seek backward/forward by 10 seconds on LG TVs
  and other players, including remote Plex queues, instead of triggering the
  configured volume, menu or information shortcuts.
- Translate remote-command notifications and touchscreen-lock messages in all
  88 interface languages. Use the same Unicode search rules for remote channel
  selection and media-library filtering, including filtered shuffle playback.
- Retry the dictionary download when a saved system language fails to load at
  startup. Keep generated phone-input captions translatable when the browser
  dictionary arrives after a legacy TV offer.
- Recognize standard French, Romanian and Latvian audio/subtitle language tags
  without confusing Latin with Latvian.

- Update SQLx and tauri-utils within their existing version requirements and use
  Rustls PKI types for PEM input, removing seven unmaintained packages from the
  application lockfile.

- The 1.1.53 development line adds ordered remote Plex queues, preserves an
  explicit native Play request while buffering, and improves contextual Unicode
  search and grapheme-safe editor input.
- Remote diagnostics now expose read-only UI/media snapshots, capability
  reasons, loaded-bundle identity and a bounded journal of operation receipts.
  Inspection does not create a playback backend, capture a screen or change
  saved settings.
- The webOS Simulator launcher now selects the newest matching installed LG
  Simulator using Node built-ins and passes the app path without a shell.
  Automatic installation of the external webOS CLI is removed.
- Python CI dependencies now use a complete SHA-256 archive lock.
- Security analysis now includes Python release tools, Actions workflows, Rust
  source and the compiled iOS Swift application.
- Release publication now reads this version's reviewed notes from the exact
  source commit and verifies them before writing publication evidence or
  advancing the durable publication counter.

- Version updates preserve quoted TOML keys containing `=` or `#`, including
  unrelated keys, without changing comments or surrounding file layout.

- Release notes accept optional closing hashes in Markdown headings while
  continuing to reject duplicate version sections.

- Plex file selection immediately shows a loading indicator with a cancel action;
  full-screen Up/Down controls select the next/previous file, including remote
  queues, while stale loading callbacks cannot replace a newer selection.
- macOS releases built without Apple signing credentials now receive a complete
  ad-hoc app signature before packaging. Publication verifies both the original
  app and its extracted ZIP copy, rejecting incomplete or damaged signatures.

### Upgrade

Rebuild with the committed Cargo lockfile. The Rust server now rejects supplied
certificate chains with RSA keys below 2048 bits, unsupported or undersized EC
curves, unknown key algorithms or malformed encodings before opening a listener.
Replace affected certificates before upgrading. Certificate PEM and PKCS#8 key
formats are unchanged; malformed later PEM sections still reject startup. No
database migration is required. See the
[supported certificate policy](docs/security-design.md#rust-server-certificate-configuration).

Retain provider profiles and exported settings before replacing a web, desktop or
container installation. Follow the platform-specific build/install instructions;
Full Capacitor Android APKs ship from this repository and support staged updates
through OTT. Android TV APK/AAB packages remain in ottplay-android. Unsigned iOS
packages require operator signing/sideloading.
Validate playback, remote input and saved settings on the intended TV/STB/native
platform; automated tests do not establish physical-device acceptance.

Use a controller and CLI revision supporting `inspect` v1 for the new workbench
commands. Older combinations report unsupported capabilities. The operation
journal retains at most 128 request IDs; retained entries expire after ten
minutes, while eviction or reload makes them unknown. Never replay a mutation
automatically because its receipt is missing.

Default Simulator SDK discovery and automatic installation of the official
Simulator ZIP remain available. Use `--sdk` or `WEBOS_SDK_PATH` for a custom
location. The explicit `--cli` or `WEBOS_CLI` override uses an operator-maintained
external CLI; setup `--cli-only` is now a compatibility no-op. Existing external
CLI installations are left in place.

### Security

The archived Python server handles unmatched parentheses in channel names in a
linear pass, avoiding excessive CPU use from malformed EPG names. Its HTTPS
listener and proxy explicitly require TLS 1.2 or newer while retaining normal
upstream certificate and hostname verification. Archived-server users must
ensure HTTPS peers support TLS 1.2.

The Rust server validates key strength in every supplied TLS certificate,
including intermediates and included roots. This prevents weak server
configuration from being accepted; it does not inspect omitted client trust
anchors or replace clients' normal certificate and hostname verification.

The application dependency update removes seven maintenance warnings while
retaining the existing Tauri/Wry/Tao/GLib patches. Three upstream maintenance
warnings, the already-backported GLib version warning and historical vendor
lockfile findings remain documented in the
[Rust dependency security review](docs/rust-dependency-security.md). No advisory
ignore list is added.

Release artifacts retain their immutable build provenance and checksums. The new
notes validation rejects incomplete publication metadata before modifying durable
publication state. It does not announce a new application CVE. Protect provider
credentials and remote-control consent codes, and keep local server access within
the documented trust boundary.

Diagnostic snapshots omit DOM text, media titles/URLs, settings and credentials.
Runtime and section checks validate inspection responses under the existing
authorized connection; they do not introduce a new authentication mechanism or
exclusive routing for mutation commands. An `accepted` receipt records a queued
effect and can remain after transport cancellation. `invoked` is not proof of
the effect, and the journal does not emit `observed`. Decoder progress does not
prove physical screen or audio output.

The default Simulator setup no longer installs the vulnerable external CLI
dependency tree. Paths are passed as separate process arguments. This does not
repair an external CLI chosen explicitly by the operator; see
[the CLI audit and override boundary](docs/webos-cli-security.md). Automated
launcher tests do not establish a physical TV or vendor Simulator display result.

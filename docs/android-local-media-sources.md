# Android local media: linked sources

Android's `LocalMedia` plugin uses the Storage Access Framework (SAF), available
on the API 22 Fire build as well as the current Capacitor build. **Adding files or
a folder saves document references, not copies of video files.** No broad storage
permission or `MANAGE_EXTERNAL_STORAGE` is requested.

`importFiles` opens `ACTION_OPEN_DOCUMENT`; `importFolder` opens
`ACTION_OPEN_DOCUMENT_TREE` and enumerates media in the selected tree, including
subfolders. Both take a persisted **read-only** URI grant. Application-private
JSON contains names, MIME types, source identifiers, document URIs and sizes.
The original storage (internal storage or SD card) must stay present. Selecting a
cloud document provider does not make its documents offline: use on-device files.
Providers that cannot give a seekable descriptor are rejected, without copying.

The existing loopback HTTP server reads directly from the original
`ContentResolver` descriptor, supports HTTP byte ranges and honors an asset's
start offset and declared length. The server does not expose the original URI or
filesystem path to web content. It listens only on `127.0.0.1` with a per-process
random URL token. It cannot make unsupported device codecs playable.

## Ownership and compatibility

- Old `.media` imports are still readable. They remain private copies until the
  user removes them; the application cannot infer their original source.
- Removing a linked item removes its JSON reference, never the source document.
- Disconnecting a folder removes its source metadata and child references. It
  releases the persisted read grant when no remaining item uses that grant.
- Removing an old private import deletes that application-owned copy.
- If a file is moved/deleted, an SD card disappears, or access is revoked, the
  item remains listed as unavailable. Its URL is empty and the server returns
  HTTP 410 for stale URLs. Re-select a reachable file/folder to restore access.
- Refresh re-scans selected folders with the existing read grant and discovers
  newly added files. Existing IDs and unavailable references are retained; exact
  document URIs are deduplicated.
- Cancelling the picker changes nothing. A folder scan that encounters an error
  may retain already linked items; it never leaves copied video data behind.

## API

`list`, `importFiles`, `importFolder`, `remove({id})` and `removeSource({id})`
return a snapshot. `directSources: true` and `directAccess: true` distinguish
this implementation from older copy-based builds. `sources` contains
`{id,name,kind,available,access}`. Items include `sourceId`, `source` (`linked` or
`imported`), `available`, and `sourceUnavailable` when applicable. The native
picker is the permission request; no browser File System Access API is used.

## Verification

JVM tests exercise full and partial byte ranges from the original file,
backwards seeks, nonzero asset offsets, range bounds, and truncation while
reading. They verify that source contents are unchanged. Compile both normal and
API 22 variants; an Android/Fire device run is additionally required before
claiming SAF picker and persisted permission behavior verified on that device.

Device acceptance sequence:

1. Put an H.264/AAC MP4 on internal storage or an SD card. Record file size and
   free space; select its folder through Local videos.
2. Check only small JSON metadata appears in app-private `offline-media`, with no
   new `.media` file. Play and seek forward/backwards with networking disabled.
3. Force-stop/restart OTT, then reboot: the persisted grant should still work.
4. Remove a linked item and disconnect its folder. Confirm the original file and
   other files in the folder remain unchanged.
5. Re-link; remove the SD card or revoke access using Android settings. Refresh
   Local videos: show source unavailable, do not create a replacement copy.
6. Verify a pre-upgrade private import still plays and is removed normally.

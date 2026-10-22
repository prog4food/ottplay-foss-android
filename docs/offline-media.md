# Local videos and offline playback

The canonical hosted player is [player.ottplay.here.now](https://player.ottplay.here.now/).
Deploy this player to the existing `liminal-sketch-vv8r` site in the `ottplay`
workspace; do not substitute a preview URL for the normal player address.
Preserve its `.herenow` proxy/data configuration, `local/hosted.js`, remote-input
configuration, demo/MSX assets and content-addressed hosted runtimes when staging
a web update. Refresh `build-info.json` and the offline shell after assembling
the production directory.

**Local videos** plays files from connected local sources without making an
additional OTT copy. Open **Settings → Local videos**, or select **Local videos**
from the provider list. Its controls use the player's normal settings list:
**Add folder**, **Add files**, **Grant access** when needed, **Refresh**,
**Play local videos**, and **Disconnect** for each source. There is no separate
file-manager dialog. The operating system's file/folder picker still appears to
let you choose what OTT may read.

In a supported desktop browser or Tauri, **Add folder** and **Add files** start
playback as soon as the first playable file is available. The remaining catalog
loads in the background. The picker saves source references before the scan;
it does not wait for every file to open before reporting progress. Cancelling
the picker keeps the current library and does not start playback. Newly selected
browser sources are read before older sources, so a stalled old folder cannot
block a newly added video. That new selection is carried through the initial
player handoff; ordinary restart/resume and active profile restrictions are
unchanged. Other native
variants use **Play local videos** after loading the catalog. OTT saves
references and small metadata records, not a second copy of the
movies. The original disk, SD card, or directory must remain accessible. Moving
or deleting originals, removing an SD card, or revoking access can make entries
unavailable. Reconnect the source or grant access again; an unavailable source
is not silently copied or substituted. **Disconnect** removes the library
reference and leaves the original media untouched.

When Local videos is restored at startup, the player leaves its splash screen
before reading the saved directory. Scanning uses the normal in-player loading
indicator. Browser folders stream their catalog: a new selection can play the
first available video immediately, while remaining files are appended in the
background. The last selected file is looked up directly before enumerating a
large folder. If that lookup confirms the file is missing, playback starts with
the first available video from the permitted sources while scanning continues.
A pending lookup is not treated as a missing file. Later batches do not restart
playback or reset the selection. If a source fails or does not respond, recovery offers **Continue
playback** without immediately repeating the stalled scan. Menu navigation and
saved source/video selection remain available; retrying does not copy media.
The browser's file picker is allowed to remain open while you choose a source.
The loading dialog distinguishes the browser folder picker, directory enumeration,
and file metadata reads. It shows entries discovered separately from playable
videos; neither counter measures copied or downloaded media. Before the first
playable video, directory enumeration may take up to ten minutes, including
nested folders on a network drive. An unchanged status does not extend this
deadline. File metadata reads and later stalled reads retain the 60-second
inactivity limit. Cancel remains available while waiting; expired or cancelled
reads cannot revive the old dialog or replace a newer selection. Startup loading
has the same Cancel control and returns to source management. When the browser
reports a filesystem error, recovery names the stage and error code without
including private file paths. Cancelling stops OTT from using late results; an
already issued operating-system read can still finish in the background.
The loading dialog exposes **Cancel** for pointer/touch input and Back/Esc.
On PC, **Q** also retires the pending load before exiting the player. Cancelled
results cannot restart playback. Strict kiosk retains its local-input lock.

On a large network folder, Chrome can read the folder's metadata before returning
even the first entry to JavaScript. During that stage, **Entries found: 0** does
not mean that OTT is copying the videos or that the folder is empty. The player
cannot display an entry which the browser has not returned yet. A previously
selected file can start through the direct lookup described above; a first-time
folder selection must wait for that initial browser result. Repeated Refresh or
page reloads do not bypass this operating-system work.

Closing the page, pressing **Q** on a PC, or exiting the native app saves the
current video position before stopping playback. On the next start, the exact
selected file resumes from that position, including when a saved Local videos
profile is active. This applies to here.now/browser, OTT Server, Tauri, and
Capacitor players. Each saved profile keeps its own position; switching profiles
does not overwrite another profile's or the unprofiled library's resume journal.
The original source must still be present and permitted. A confirmed missing
file selects the first playable file allowed by the active profile or folder
kiosk; its old playback position is not applied to the replacement. Revoked
access, unavailable sources and unbound profiles still open recovery.
Local positions do not have the seven-day expiry used for TV archives.

A completed video starts from the beginning. Manually selecting a channel or
file also starts it from the beginning; automatic position restoration applies
to player startup. Closing while a slow file is still opening retains its pending
resume position.

When a local video finishes, playback advances to the next file in the current
channel-list order, including a shuffled order. The playlist repeat setting
controls what happens at the end of the list; repeat-one plays the same file
again. A channel pinned by kiosk mode stays pinned. Automatic transitions start
the next file at zero rather than restoring an old position. The standard player
footer shows the playing file's containing folder as the channel title. Its
programme rows show the current filename and the next filename in playback order,
including shuffle, repeat and kiosk rules. Each row updates when playback changes.
The current row's clock is the local time when this playback actually started,
including seconds, rather than elapsed minutes. The next row's clock is that start
time plus the current file's full duration. It is a nominal estimate: pausing or
seeking does not rewrite the start time, and can change the actual transition time.
Unknown duration leaves the next clock blank; no successor leaves the next row
blank. If the source cannot expose a containing folder, its source label is used.
Reordering channel groups while a file plays keeps its original group for the
next-file prediction and automatic transition. Removing that group (or an old
playback record without its stable group ID) disables automatic advancement;
OTT never substitutes whichever group now occupies the old menu position.
The current file's title and clock remain visible while it finishes.
These controls are shared by browser/server, Tauri and Capacitor players.

Libraries made by the earlier copy-based version remain readable. Their entries
are marked as imported copies and expose **Remove copy**. This deletes OTT's
stored copy, not the original file selected during the old import. OTT cannot
infer the old source location or automatically convert such copies into links.
To reclaim duplicate storage, connect the original first, verify playback, and
then remove the old imported copy.

## Platform behavior

Progressive catalog loading applies to browser-local folders (including here.now
and the browser UI served by OTT Server), updated Tauri and Capacitor builds. Tauri's native
scan publishes available entries while it continues in the background; adding a
folder starts playback once an eligible entry is ready. A saved Tauri selection
is looked up directly before the background scan, so resuming it does not wait
for its place in directory enumeration. The standard loading dialog shows one
loading title and one count of playable videos found. Internal scan counters
remain available for diagnostics and stall detection.

Updated Capacitor Android/iOS bridges publish request-scoped progress and partial
catalogs while scanning. Cancel retires the matching native request and its
listener. Older installed bridges and one-shot server libraries remain compatible
but cannot supply early batches. Browser/native reads reset their inactivity deadline only on actual progress;
unchanged polling does not reset it. Check
the installed build's source revision: earlier 1.1.58 Tauri builds still have the
one-shot scan.

- **Capacitor Android:** Android's Storage Access Framework grants read access to
  selected documents/folders. OTT persists the document URIs and reads the
  original through a private loopback streaming server. This includes the
  API 22 Fire variant, subject to the device providing a working document picker.
  Sources must support seeking; unseekable provider streams are rejected without
  falling back to a copy. **Refresh** rescans connected folders for additions.
  See [Android sources](android-local-media-sources.md).
- **Capacitor iOS:** the Files picker selects files/folders in place. OTT stores
  document bookmarks, keeps scoped read access active for playback, and rescans
  connected directories on refresh. See [iOS sources](offline-media-ios-direct.md).
- **Tauri desktop:** a native picker selects files/folders. OTT retains paths and
  metadata, and a private loopback server reads the originals with byte-range
  support. **Refresh** rescans connected folders for additions. It does not
  upload selected files into
  application storage. OS privacy permissions and drive availability still apply.
- **Browser / here.now / server-hosted player:** supported browsers retain
  File System Access handles in IndexedDB and create playback URLs from the
  original files. Refresh rescans linked directories. If the browser expires
  access, **Continue playback** renews permission and resumes the local provider.
  Chrome/Edge desktop support this mode;
  unsupported browsers display an explicit error and do not use a hidden
  copy-based fallback. Use the native Android app on older Fire tablets.
- **Optional remote server library:** media lives on the server. Its existing
  authenticated upload API is still an explicit copy to server disk. Selecting
  that library is not direct access to a folder on the client. The local-source
  controls do not silently upload browser-selected files to it.

A cloud provider can download/cache a selected file itself. Connecting a cloud
placeholder does not make it offline. Select files physically available on the
device for playback without any network. The feature does not download IPTV
channels, mirror Plex libraries, transcode media, or import multi-file HLS
packages. H.264/AAC in MP4 is a useful starting format for old Fire devices, but
codec support still depends on the installed player/WebView.

Chrome may ask **“Allow this site to view and copy files?”** after a folder is selected. This is its standard read-access prompt. OTT requests `mode: "read"`, stores handles and metadata, and plays the originals; it does not create a second video copy. The browser wording describes the permission granted, not an import or upload in progress. See the [Chromium permission strings](https://chromium.googlesource.com/chromium/src/+/5b8b36772fbb0a49fa285efe5fb585f4093c2cb3%5E%21/).

## Offline application startup

Bundled native applications can start without a website connection. A hosted
browser also needs its application shell installed for offline startup: use
HTTPS or localhost, load the site online once, and wait until **Offline restart**
is ready. Keep the same site address and verify a reload with the network off.
An HTTP LAN page can play already accessible files while open, but cannot
promise an offline cold start. Browser autoplay rules may require pressing Play
or Space after reload.

Local playback automatically reloads the connected sources and restores the
selected file when the browser still grants read access. A saved folder handle
is not itself a permanent permission. In Chrome 122 and later, after reopening
the page, choose **Continue playback**, then **Allow on every visit** in the
browser's permission prompt to retain access for later visits. **Allow this
time** expires when the session ends. An installed web app also retains a grant
after it is allowed. See [Chrome's persistent file permissions](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api).

If permission has expired, OTT keeps the source and previous selection while
showing the recovery action. It cannot silently approve a browser permission
prompt. Renew access instead of disconnecting and adding the same folder again.
An unplugged drive, moved folder, or revoked permission still requires recovery;
the originals must remain available. File access permission and browser audio
autoplay permission are independent.

The service worker caches a finite list of public player assets and revalidates
them online. It does not cache live streams, playlists, credentials, command
traffic, or arbitrary requests. Source handles and old imported copies are
separate from the application shell and profile backups. Loading Home does not
transfer a library to another device. Different browser profiles and site
origins have separate grants and libraries. Clearing site/application data loses
references and old private copies; it does not delete linked originals.

## Optional server library

Configure both variables before starting `ottplay-server`:

```sh
export OTT_OFFLINE_MEDIA_DIR=/srv/ottplay/local-media
# Supply a private random value of at least 32 URL-safe characters via your secret store.
export OTT_OFFLINE_MEDIA_TOKEN=YOUR_PRIVATE_RANDOM_TOKEN
```

In **Local videos → Server library…**, enter
`https://your-server/offline-media/YOUR_PRIVATE_RANDOM_TOKEN` using the player's
normal text editor. Clear the setting to return to browser-local sources.
A remote library needs a network connection even if its files were originally
uploaded from this client. A Tauri application configures its own loopback
endpoint automatically and does not use these remote-server variables.

Treat the entire remote URL as a credential: anyone holding it can list, import,
play and delete that server library's files. Use HTTPS for remote access and keep
the URL out of public screenshots. The API supports `GET` catalog,
`POST /import?name=Film.mp4` with raw bytes, `GET /FILE_ID` with `Range`, and
`DELETE /FILE_ID`. Uploads stream to disk, accept MP4, M4V, WebM, OGV, MP3, M4A and
OGG, and are limited to 16 GiB per file. A 60-second stalled upload is cancelled.
These limits do not guarantee free disk space. The remote API cannot register
arbitrary client/server paths as native picker grants.

## Kiosk and updates

In the video/channel list, open **Actions → Shuffle** to randomize the current
list without restarting the playing item. **Reset order** restores its order
before the first shuffle, even after restart or repeated shuffles. New files
discovered meanwhile remain at the end; deleted entries are not resurrected.
The numeric popup exposes the same actions on **2** and **5**, respectively.
These shared list controls apply to the browser, server-hosted UI, Tauri and
Capacitor. Kiosk locks prevent changing the order.

On the PC interface, **R** jumps to another random video in the current list or
active playback sequence. This is a single selection: it does not enable shuffle
or change the order of the folder. A one-item list keeps its current video.
The shortcut also applies to channel and supported media-library lists; it is
inactive in text editors, other modal controls, and kiosk locks. See
[PC random-item shortcut](browser-window-controls.md#random-item-on-pc).

Select Local videos, choose a playable title, then apply the existing kiosk
command through the authorized command server. Stable entry IDs identify the
saved selection; temporary playback URLs are regenerated. Connect the source
separately on each target device. Kiosk/settings locks prevent local library
changes. Existing screen-off handling continues to govern playback while asleep.

Android, iOS and Tauri native changes require an updated APK, IPA or desktop
application; a hosted JavaScript update cannot add OS picker/bookmark support.
Browser changes arrive through the site and service worker. The files remaining
on a source do not guarantee OTT has permission to access them after an update;
check the actual device and grant access if requested.

## Verification scope

Automated source/range tests and native builds check implementation behavior;
they do not establish codec support or OS permission persistence on every device.
Before claiming a tablet works offline: connect a local MP4/folder; check that
only metadata was added to OTT storage; play and seek; disable the network;
force-stop/restart and reboot; verify the same title; test screen-off/resume;
disconnect the source and confirm the original remains. Also test an absent SD
card or revoked grant and an old imported copy. Real hardware and signed release
validation remain separate from simulator/JVM/browser tests.

## Strict kiosk for one local folder

Connect the folder with **Add folder**, start a file, and use the authenticated
controller to pin that folder:

```sh
ott PLAYER kiosk on --strict 'folder:Winnie-the-Pooh'
```

The folder name must match one connected folder uniquely. This pins the source
reference, not all Local videos and not just the current file. Files in that
folder play in the current list order and wrap to its first file after the last;
the folder policy overrides Repeat One/Off. Other folders and providers remain
blocked. The current file and folder policy survive restart, and new files in
the same folder can join after Refresh. A disconnected folder never falls back
to unrelated videos. `kiosk off` releases the policy. Ordinary channel kiosk
commands retain their existing single-channel behavior.

On Android, switching the screen off with the power button pauses local video
and audio, including when kiosk is disabled. Local EOF and delayed start
callbacks cannot advance to another file while the screen is off. Wake resumes
the owned file at its saved position, or handles a deferred natural completion
once. Changing provider, file, or entering Standby invalidates the old wake
request. This uses the same native screen lifecycle as the Plex kiosk path.

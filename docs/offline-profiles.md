# Local video profiles

The `offline` provider is shown as **Local videos**. It plays connected folders
and files directly on Android, iOS, Tauri and supported desktop browsers. Use
[the main hosted player](https://player.ottplay.here.now/) for the web version.
A profile stores a library selection and a selected video. It never contains
video bytes, browser file handles, Android document grants, iOS bookmarks,
native file paths or playback URLs.

## Save and load with OTT CLI

Update the player, control server and CLI together. Check `ott d1 caps` for
`offline_profiles` version 1. Select the provider before managing its 15 slots:

```sh
ott d1 provider offline
ott d1 profiles
ott d1 profile save 1 Kids
ott d1 profile export 1 kids.json
ott d1 profile load 1
# Short form of load:
ott d1 profile 1
ott d1 profile import 2 kids.json
ott d1 profile load 2
```

First connect the originals through **Settings → Local videos → Add folder**
or **Add files**, and play the desired video before saving. Wait until folder scanning finishes before saving or binding a profile. These operations use the completed catalog already in memory; they never start a second scan or interrupt playback. A request made during scanning is rejected with a retry message. `profile save`
snapshots the active local library and selected file; it does not select the
saved slot. If a profile is already loaded, saving copies its source subset,
not unrelated folders connected to the device. Export writes a portable JSON
file; import saves it into an inactive slot without starting playback. Loading
reloads the local catalogue and restores the saved file when it is available.
The dispatch receipt is not confirmation that a decoder is playing.

An unavailable selected file opens recovery after startup overlays have closed.
JSON settings restore can switch the active local profile and restores its channel
and favorites documents in the same transaction; private file bindings remain
on this installation. A changed active binding or library retires the previous
catalog scan, while edits to an inactive profile leave current playback intact.

`ott d1 stop` stops playback while retaining remote control. `ott d1 start`
runs the player's configured startup flow. Profile operations do not grant
file access or bypass kiosk/parental restrictions. Profile listing is available
while locked; unlock provider settings and kiosk mode for save/load/export/import.

## Restore on the same device or another device

On the same installation and browser origin, a private binding map reconnects
the profile to its saved original source and selected file. Reopening the player
resolves fresh playback URLs; temporary blob/HTTP URLs are never restored from
the profile. Browser access can still require **Grant access**. A folder that
has moved, a disconnected drive, revoked access or cleared app/site data requires
local repair. A saved selection that cannot be found does not fall back to an
unrelated video.

On another installation, the imported profile reports `binding_required: true`.
Loading it opens the local recovery screen. Connect the originals with the local
file/folder picker, then choose **Bind loaded profile to connected sources**.
This is a local action: matching source names alone never authorizes a remote
import. Binding requires exactly one connected source matching each description
and exactly one matching selected file; duplicate source labels and missing files
are rejected. Rename or disconnect ambiguous sources, reconnect the correct
folder, and try again. Then load the profile again.

Browser grants/handles stay in that origin's IndexedDB; native grants/bookmarks
remain in their native storage. The private binding map is excluded from generic
settings JSON, local snapshots and cloud exports. Importing those backups cannot
overwrite or erase existing local bindings. A full app/site-data reset can erase
them. Generic settings JSON still requires the matching current provider/library;
use the dedicated profile import to move a local profile to another slot/device.
On the same installation, loading restores the saved local/server library
selection using its private binding; a portable profile does not transfer server
credentials or URLs. Identical saves reuse their binding. Up to 128 binding
snapshots are retained, always keeping bindings referenced by saved slots;
older exported files whose unreferenced history was evicted require local binding.

## Wire format and limits

The controller uses `profiles {}`, `profile {number}`, `profile_save {number,
name?}`, `profile_export {number}`, and `profile_import {number, profile}`.
The `offline_profiles` capability lists supported operations, `max_profiles: 15`
and `max_sources: 32`. A portable document is version 1:

```json
{
  "version": 1,
  "provider": "offline",
  "name": "Kids",
  "binding_id": "83178465-ef7e-4f78-a5b9-17860c812cd5",
  "sources": [{"key": "s0", "kind": "folder", "name": "Cartoons"}],
  "selected": {"source_key": "s0", "name": "Season 1/episode.mp4"}
}
```

`binding_id` is an opaque reference, not a transferable permission. Unknown
fields and absolute paths/URLs are rejected. Source keys are consecutive `s0`
through `s31`. Profile names are at most 256 UTF-8 bytes, source basenames 512,
and selected relative filenames 1,024. The complete compact document is at most
12,288 UTF-8 bytes. Empty libraries use `sources: []` and `selected: null`.
Exports describe one profile; they are not recursive media backups.

Automated coverage exercises real Chromium IndexedDB handles across page closure,
strict schemas, source isolation, stale asynchronous callbacks, same-installation
and foreign imports, and generic backup boundaries. These checks do not certify
every native document provider, filesystem or decoder; native access can still
require platform-specific permissions or an available original drive.

# iOS: linked local media without an OTT copy

`LocalMedia.importFiles()` now opens Apple's document picker in place
(`asCopy: false`). `importFolder()` selects a directory. OTT stores a bookmark and
small item metadata in Application Support; it does not copy the selected video
or audio bytes. Old imported private files remain readable and are explicitly
marked `source: "imported"`.

The source must remain available. Choose a local Files location for playback
without a network; iCloud Drive and third-party document providers may need a
network or may download/cache content themselves. OTT does not promise that a
cloud placeholder is offline media, and does not silently copy an inaccessible
source into its own library.

A source record contains an opaque UUID, display name, file/folder kind, and a
minimal bookmark. On reload the native plugin resolves that bookmark and opens
security-scoped access. Access stays open while WebKit can read the returned
playback URL, and closes when the source is disconnected or the plugin is
destroyed. Stale bookmarks are refreshed. The implementation follows Apple's
[Providing access to directories](https://developer.apple.com/documentation/uikit/providing-access-to-directories).

`list()` returns `sources` with `id`, `name`, `kind`, `available` and `access`.
Items include `source` (`linked` or `imported`), `sourceId`, `available` and
`access`. Unavailable items retain their stable IDs with an empty playback URL;
they are not quietly removed. `requestAccess({id})` reopens the native picker to
reconnect a source. `removeSource({id})` removes only its bookmark and metadata.
Removing a linked item hides its path in that source and never deletes the source
file. Removing a legacy imported item still deletes OTT's own private copy.

Folder scans skip hidden files, packages, symbolic links, and resolved paths
outside the granted root. They inspect at most 20,000 entries and retain stable
item IDs by relative path. Newly discovered supported audio/video files appear
on the next list refresh. Originals are read through Capacitor's existing
WebKit file handler; its playback URLs are regenerated rather than persisted.

## Verification and limits

Source parsing and an unsigned simulator build validate syntax/API integration;
they do not establish real Files-provider behavior. Before release, test on an
iPhone/iPad with a local MP4 and a folder: play and seek; relaunch with network
disabled; rename or remove a source; reconnect its permission; disconnect it and
verify the original remains; compare application storage before/after selecting
a large file. Test cloud placeholders separately and label their network needs.
A signed native update is required. An HTML-only update cannot install the
bookmark handling or directory picker.

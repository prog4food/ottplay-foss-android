# Base OTT bundles for device testing

The **CI / Build** job uploads `ottplay-foss-modea-<commit>` for pull requests and
main commits. It contains `ottplay-foss-modea.tar.gz` and its SHA-256 checksum.
The archive is the web/STB player root, without a Capacitor or Tauri application.
Its `build-info.json` records the source revision, version and bundle checksum.

Build the same package locally with `npm run build && npm run package:modea`.
The archive and checksum are written to `build/packages/`, outside the `dist/`
web root used by Capacitor, so mobile applications do not embed the archive.
Extract it into a Mode A companion's web root or a static host. The latter needs
an index fallback for `/f/<device>/` while keeping `/dist`, `/devices`, `/js`,
`/styles`, `/images`, `/locales`, `/fonts` and `/providers` at the root. Proxy, EPG and other companion APIs
still require a backend; the static archive does not include that server.

For example, an M3U header can select a separate matching/EPG companion with
`foss-tvg="!epg-server::https://guide.example"`. The companion must be reachable
from the device and permit the browser's cross-origin requests. An HTTPS player
also needs an HTTPS companion. This setting selects the FOSS companion API; it
is not a raw XMLTV URL. A static host such as here.now does not supply that API
unless a backend has been configured separately.

Check both channel matching and actual programme intervals when diagnosing an
empty guide. A loaded XMLTV feed can omit a channel or have no programme covering
the current time; a successful health check or total programme count alone does
not establish guide coverage for the selected playlist.

The Rust companion serves the player index for `/f`, `/f/`, and nested device
paths, so these URLs work without creating per-device directories.

Open the server's address from the TV/STB, selecting its device adapter:

- `/f/dune/`, `/f/mag/`, `/f/hisense/`
- `/f/lg/webos/`, `/f/lg/netcast/`
- `/f/samsung/tizen/`, `/f/samsung/maple/`

The same classic ES5 bundle is used on all these devices. Hardware capabilities,
codecs and DRM remain device-specific. The boot script prefers tested local
libraries on legacy engines, so CDN availability is not needed for startup.

Tagged releases also contain `ottplay-foss-dist.tar.gz`. Docker publishes the
Mode A companion and player as `alvit/ottplay-foss` (`main`, `latest` and revision
tags; amd64/arm64). A downloaded release or existing deployment only contains
changes from its own revision: check the revision before reporting device tests.

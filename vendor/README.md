# GLib 0.18.5 security backport

The Linux Tauri / GTK3 dependency graph requires the `glib` 0.18 series.
Upgrading only this transitive dependency to 0.20 does not satisfy GTK3's
version requirement. The workspace therefore patches crates.io `glib` to
`vendor/glib-0.18.5`, with the upstream version retained unchanged.

The directory contains the complete published [glib 0.18.5 crate](https://crates.io/crates/glib/0.18.5),
including its MIT `LICENSE`, `Cargo.toml.orig`, tests and `.cargo_vcs_info.json`.
The source archive SHA256 is
`233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`,
which matches the original workspace Cargo.lock registry checksum.
`glib-0.18.5.provenance.json` records every published file hash and the sole
patched source hash. The shared Cargo registry cache is never modified.

The only change inside the published crate is the two-line fix in
`src/variant_iter.rs` from upstream
[commit b5a4071](https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34).
The pointer passed as a C out-parameter is declared mutable and passed as `&mut p`. This removes the
invalid write through an immutable Rust reference identified by
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).
`glib-0.18.5-RUSTSEC-2024-0429.patch` records the exact source diff.

Validation:

```sh
node scripts/check-glib-backport.cjs
cargo test --locked --release --manifest-path tests/glib-variant-regression/Cargo.toml
```

The optimized regression exercises forward, reverse, mixed-direction, `nth`,
`nth_back` and `last` borrowed-string iteration using actual GLib FFI. It needs
Rust, pkg-config and the system GLib development package (for example
`libglib2.0-dev` on Debian/Ubuntu). It is a small standalone Cargo workspace,
so it does not compile the Tauri application or all upstream GLib tests.

The package version remains 0.18.5. Its provenance manifest and patch identify
the applied security fix for dependency scanners.
Remove this override and its regression fixture when the application can
move to a supported GTK dependency graph with the upstream fix, or a
compatible official 0.18 security release becomes available. All release
builds must include `vendor/`; Docker copies it before resolving Rust packages.

## macOS file drag pasteboard guards

The workspace also patches the exact locked [Wry 0.55.1](https://crates.io/crates/wry/0.55.1)
and [Tao 0.35.3](https://crates.io/crates/tao/0.35.3) releases. Their complete
published crates, licenses and version numbers are preserved. The archive
SHA256 values below were verified against the original workspace lockfile:

- Wry: `186f9871daa55fd9c016578b810d149de58367113db7fb72b462d2323ce19514`.
- Tao: `d1c93047acf68669466a34690ac58cca7010bd1b201e1ec86f1fd0a75d3dd4a9`.

AppKit can advertise `NSFilenamesPboardType` but return no property list when
the source cannot supply a readable file URL. Wry previously unwrapped this
optional result and both array/string downcasts. Tao unwrapped the result and
cast its array and elements without checking their classes. A panic cannot
unwind safely through these native drag callbacks, and messaging an object of
the wrong class can raise an Objective-C exception.

The local patches check for missing property lists, require an actual array,
and skip entries that are not strings or cannot supply UTF-8 data. Tao rejects
a missing or non-array payload; Wry returns no file paths through its existing
event/fallback path.
Valid file order, Unicode conversion and hover/drop event handling are
unchanged. File dragging remains enabled. These guards do not catch arbitrary
exceptions thrown by AppKit itself or establish that every crash has this cause.
No JavaScript or playback behavior is changed.

Each `.provenance.json` inventories every published file and identifies the
single changed macOS source file. Each `-macos-drag-pasteboard.patch` is the
complete local diff. This is a local hardening patch, not a claimed upstream
release or advisory fix; the shared Cargo cache is never changed. Remove these
overrides after a compatible official release supplies equivalent guards.

```sh
node scripts/check-macos-drag-backport.cjs
```

The checker verifies the complete source inventories, all original/patched
hashes, lockfile overrides and that reversing each exact diff recovers its
published source. All platforms must receive these vendor directories before
Cargo resolves the workspace, even though the code changes are macOS-only.

The macOS CI job also runs the [native drag regression](../tests/macos-drag-regression/README.md).
It invokes both dependencies' real hover/drop callbacks on isolated pasteboards
and verifies 32 cases, including missing data, wrong types and Unicode paths.

## Shared OttPlay domain core

`ottplay-core.js` and `ottplay-core.jar` are generated from the same canonical
Kotlin Multiplatform source. `ottplay-core.manifest.json` records the source
receipt and artifact hashes; `ottplay-core.LICENSE.txt` contains the project
license and bundled runtime notices. Do not edit these generated files.

The ES5 distribution supplies guide rules, 13 provider archive adapters, 43
playlist adapters, three media parsers and the base player's Xtream catalog and
short EPG. Stalker JSON-RPC sessions/catalogs/EPG and BEST LiST Xtream catalogs
also delegate; the latter retains its M3U fallback policy in the core. Captured
fixtures exercise 19 Stalker and 12 BEST LiST contracts. Native Swift and Rust guide bridges evaluate this identical file.
Classic-player now/next selection, time shifts and full-schedule cache policy
also delegate, retaining inclusive end times, one-hour miss retry and 12-hour
response TTL. Forty-four captured scenarios preserve those contracts.
The archived Android bridge uses the JVM artifact. Other provider sessions,
state and playback controllers still need migration.

Update from the canonical core using `scripts/distribute.cjs install-native`
with this repository's absolute path. `node scripts/shared-core.cjs` checks the
pinned distribution; build staging verifies and packages it after polyfills.

Canonical source: [ottplay-core/shared-core](https://github.com/open-ott-play/ottplay-core/tree/main/shared-core).
Rebuild these artifacts from the canonical source repository. The pinned
consumer artifacts are self-contained and carry source and artifact hashes.

## Legacy Apple Blocks FFI backport

The macOS dependency graph still uses [block 0.1.6](https://crates.io/crates/block/0.1.6).
The workspace selects the complete published four-file crate plus the sole
source change recorded in `block-0.1.6-opaque-class.patch`. The original archive
hash matches the prior Cargo.lock registry checksum; per-file original and
patched hashes are in `block-0.1.6.provenance.json`. The [MIT permission and
Steven Sheldon copyright notice](block-0.1.6-LICENSE.txt) is retained separately
from the original four-file crate, with its immutable source and hash in that
manifest.

The patch transfers the inhabited opaque class representation from
[upstream b6438c7](https://github.com/madsmtm/objc2/commit/b6438c733a7a9bfe75e60b62126d1933137f42e4),
retaining the private `Class` name. Only pointers to that class are used. The
crate's public API, version and native `_NSConcreteStackBlock` symbol stay the
same. This removes a real `uninhabited_static` soundness diagnostic; no known
runtime crash or assigned vulnerability identifier is claimed.

```sh
node scripts/check-block-backport.cjs
# macOS with Rust and Xcode command-line tools:
node scripts/check-block-backport.cjs --runtime
```

The runtime check links the actual Apple Blocks runtime and a Clang `-fblocks`
caller. It verifies captured values, 128 copy/release cycles and exactly-once
capture destruction, while the original source must fail the relevant compiler
lint. Remove the override only after a compatible maintained dependency path
includes the equivalent fix and the native regression still passes.

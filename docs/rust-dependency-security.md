# Rust dependency security review

This review covers the application workspace (`Cargo.lock`) and the two
standalone native regression workspaces on 2026-10-08. It also distinguishes
the original upstream lockfiles preserved inside `vendor/` from dependencies
actually selected by the application. It is not a claim that all dependencies
or historical source archives are free of advisories.

## Upgrade

Rebuild the application with the committed lockfile (`cargo build --locked`).
SQLx updates from 0.8.1 to 0.8.6, and `tauri-utils` from 2.9.3 to 2.10.1. These
updates stay within the existing dependency requirements. The Tauri runtime
remains 2.11.5, with the existing Wry, Tao and GLib source patches preserved.

The server now uses the PEM reader supplied by its existing `rustls-pki-types`
dependency, through Rustls, instead of the unmaintained `rustls-pemfile` crate.
Existing certificate chains and PKCS#8 private keys continue to work. The
server still selects the first PKCS#8 key only after parsing the entire file;
malformed later sections fail startup. PKCS#1 and SEC1 private keys are not
newly accepted. No database migration or TLS file conversion is required by
this change.

## Security

The application lockfile no longer selects these seven unmaintained packages:

- `rustls-pemfile`: [RUSTSEC-2025-0134](https://rustsec.org/advisories/RUSTSEC-2025-0134.html).
- `paste`, previously through `sqlx-core`: [RUSTSEC-2024-0436](https://rustsec.org/advisories/RUSTSEC-2024-0436.html).
- `unic-char-property`, `unic-char-range`, `unic-common`, `unic-ucd-ident` and
  `unic-ucd-version`, previously through `tauri-utils` → `urlpattern`:
  [2025-0081](https://rustsec.org/advisories/RUSTSEC-2025-0081.html),
  [2025-0075](https://rustsec.org/advisories/RUSTSEC-2025-0075.html),
  [2025-0080](https://rustsec.org/advisories/RUSTSEC-2025-0080.html),
  [2025-0100](https://rustsec.org/advisories/RUSTSEC-2025-0100.html) and
  [2025-0098](https://rustsec.org/advisories/RUSTSEC-2025-0098.html).

The following findings remain visible and require future upstream migration:

- `derivative` 2.2.0 and `instant` 0.1.13 are unmaintained
  ([2024-0388](https://rustsec.org/advisories/RUSTSEC-2024-0388.html),
  [2024-0384](https://rustsec.org/advisories/RUSTSEC-2024-0384.html)). Both are
  selected through `souvlaki` 0.8.3 → `zbus` 3.15.2 for Linux desktop media
  controls; `instant` is below `async-fs` → `futures-lite` → `fastrand`.
  Souvlaki 0.8.3 is the current published release and requires Zbus 3. Replacing
  that integration needs its own MPRIS compatibility tests. These are not
  dependencies of the standalone server or macOS media-control backend.
- `proc-macro-error` 1.0.4 is unmaintained
  ([2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html)). The Linux
  GTK3 build uses it through `gtk3-macros`. It is a build-time procedural macro,
  not server request handling. The standalone native regression workspaces
  also resolve this GTK3 dependency.
- `glib` 0.18.5 still matches the version-based
  [2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) warning.
  The application and both regression workspaces use the local source with
  the exact upstream safety fix. [Vendor provenance](../vendor/README.md)
  documents the patch and tests; the package version is deliberately unchanged.

No audit ignore list or advisory suppression is added. Using RustSec database
commit `b8a1a33e246a0a9a3b5f377248c41a503defec74`, `cargo audit` reports zero
vulnerability records for the application lockfile, three unmaintained-package
warnings and the GLib warning above. Warnings remain part of the review even
when the command exits successfully.

## Preserved upstream source archives

`vendor/tao-0.35.3/Cargo.lock` and `vendor/wry-0.55.1/Cargo.lock` are part of the
original published crate inventories. Cargo selects the application's root
lockfile when these crates are path dependencies; their bundled lockfiles do
not override it. The provenance checkers verify these original files rather
than rewriting or deleting them to change a scanner score.

These two historical lockfiles additionally reference:

- `anyhow` 1.0.102: [2026-0190](https://rustsec.org/advisories/RUSTSEC-2026-0190.html),
  fixed in 1.0.103; the application resolves 1.0.104.
- `crossbeam-epoch` 0.9.18: [2026-0204](https://rustsec.org/advisories/RUSTSEC-2026-0204.html),
  fixed in 0.9.20; absent from the application lockfile.
- `memmap2` 0.9.10: [2026-0186](https://rustsec.org/advisories/RUSTSEC-2026-0186.html),
  fixed in 0.9.11; absent from the application lockfile.
- `quick-xml` 0.39.2/0.39.4:
  [2026-0194](https://rustsec.org/advisories/RUSTSEC-2026-0194.html) and
  [2026-0195](https://rustsec.org/advisories/RUSTSEC-2026-0195.html), fixed in
  0.41.0; the application already resolves 0.41.0.
- `ttf-parser` 0.25.1: unmaintained
  [2026-0192](https://rustsec.org/advisories/RUSTSEC-2026-0192.html); absent from
  the application lockfile.

Do not build those historical crate workspaces as standalone products with
their original lockfiles. A standalone upstream-development build requires
a separate dependency update and review. Repository-wide scanners can still
report these archived dependency versions, as well as `paste` in the archived
locks, after the application's dependencies are updated.

## Reproduce the review

```sh
cargo audit --json
cargo audit --file tests/glib-variant-regression/Cargo.lock --json
cargo audit --file tests/macos-drag-regression/Cargo.lock --json
cargo audit --file vendor/tao-0.35.3/Cargo.lock --json
cargo audit --file vendor/wry-0.55.1/Cargo.lock --json
cargo tree --locked --target all -i derivative
cargo tree --locked --target all -i proc-macro-error
cargo test --locked -p ottplay-core -p ottplay-server
cargo test --locked -p ottplay-tauri
node scripts/check-glib-backport.cjs
node scripts/check-macos-drag-backport.cjs
```

The Tauri tests require the platform's native development libraries. Run the
documented optimized GLib and macOS drag regression tests on their supported
hosts when changing the corresponding patches. Dependency sources retain
their upstream licenses; SQLx and Tauri utilities are MIT/Apache-2.0, and the
existing Rustls PKI types are MIT/Apache-2.0. This update does not relicense the
vendored source archives.

## Windows updater ZIP extraction (2026-10-18)

RustSec database `999ec89d5d3f10f20be14750ec8c2d8b44e0ac9b` reports
RUSTSEC-2026-0367, RUSTSEC-2026-0368 and RUSTSEC-2026-0369 against `zip` 4.6.1.
The only application edge to that crate is the Windows-only legacy archive
feature of `tauri-plugin-updater` 2.12.0. The current stable updater 2.14.0 also
requires ZIP 4, so upgrading it alone does not remove these findings.

Windows now disables that optional archive feature while retaining Rustls TLS
and system-proxy support. The release collector already publishes raw `.exe`
and `.msi` installers and their signatures when signing is configured; it does
not publish Windows ZIP update wrappers. The updater's existing raw installer
path handles those formats. Legacy ZIP-wrapped Windows updates are no longer
accepted. This does not activate updater signing or change the configured key.

macOS and Linux keep their existing default updater features, including the
`tar`/`flate2` support needed for application and AppImage updates. The ZIP
crate itself is Windows-only upstream and is absent from every selected target
graph. `python3 scripts/check-updater-features.py` checks the resolved Windows,
macOS and Linux runtime dependency graphs in native CI. Native compilation and
release acceptance remain required; graph validation is not an installation test.

Cargo's cross-platform lockfile still retains optional `zip` 4.6.1 because it
records all available target/feature combinations. Consequently lockfile-only
`cargo audit` and repository scanners continue reporting these three records.
No ignore list or advisory suppression is added. Do not enable the updater ZIP
feature on Windows until upstream supports a fixed ZIP release and that path
has been reviewed. The archived source-lockfile findings above are unchanged.

The same 2026-10-18 audit also reports new unmaintained-package advisories
[RUSTSEC-2026-0371](https://rustsec.org/advisories/RUSTSEC-2026-0371.html),
[2026-0370](https://rustsec.org/advisories/RUSTSEC-2026-0370.html), and
[2026-0372](https://rustsec.org/advisories/RUSTSEC-2026-0372.html) for
`zbus_names` 2.6.1, `zvariant` 3.15.2, and `zvariant_derive` 3.15.2. The
Linux runtime selects them through the existing `souvlaki` 0.8.3 / `zbus`
3.15.2 media-control integration. Their upstream APIs moved into Zbus 6;
this requires the same separately tested MPRIS migration as the older
`derivative` and `instant` warnings, rather than a compatible leaf update.
The current application audit therefore retains six unmaintained warnings,
the fixed-source GLib warning, and the three optional-lockfile ZIP records.
These findings remain visible; no additional warning is suppressed.

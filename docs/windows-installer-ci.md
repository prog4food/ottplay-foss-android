# Windows installer qualification

The `Windows installer lifecycle` job in `native-parity.yml` builds the current
frontend and both Tauri Windows installers with the locked Rust dependency graph.
It needs no signing secret and publishes no release. The job installs the two
formats sequentially into one unique runner-temporary directory whose name
contains spaces. Each format starts with no product files or registration.
NSIS deliberately retains its preferred install path on normal uninstall, and
MSI reads that preference. Reusing the exact owned path respects this upstream
behavior without deleting preferences or accepting an unexpected location.
This does not qualify overriding a previously remembered installation path.

`scripts/check-windows-installers.py` requires a disposable GitHub-hosted Windows
runner and refuses a pre-existing product registration. For both NSIS and MSI,
it checks the registered version and install location, compares the entire installed executable with its format-specific reference
derived from the local build, invokes the normal uninstaller,
and waits for both product registration and the install directory to disappear.
The receipt and MSI logs are uploaded even when a later check fails. Cleanup
retries the normal uninstaller after a failed check and removes only the unique
temporary harness directory; cleanup never changes a failed result to a pass.

This qualifies fresh installation and removal of the raw Windows installers.
It does not claim upgrade-path, application playback, Authenticode, or SmartScreen
acceptance. Existing release and playback gates remain separate.

The invocation rules follow the [NSIS command-line documentation](https://nsis.sourceforge.io/Docs/Chapter3.html)
and [Microsoft's msiexec documentation](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/msiexec).
MSI commands are passed directly to CreateProcess without a shell. The
`INSTALLDIR` value is quoted separately from its property name, following
[Microsoft's property syntax](https://learn.microsoft.com/en-us/windows/win32/msi/setting-public-property-values-on-the-command-line).
Both MSI operations must produce a nonempty verbose log, whose size and hash
are retained in the receipt. The 180-second process limit remains unchanged.
The portable guard tests run with `python tests/test_windows_installers.py`.

Tauri CLI 2.12.3 stamps `__TAURI_BUNDLE_TYPE_VAR_UNK` as `NSS` for NSIS or
`MSI` for MSI, then restores the original raw executable after each package.
The harness binds that behavior to the installed and locked CLI version. It
requires exactly one unpatched `UNK` target, then derives the full expected
SHA-256 separately for each format. The pinned `tauri-utils` 2.10.1 runtime also
contains ordinary `NSS` and `MSI` comparison strings; those remain unchanged.
It never normalizes installed
bytes. An unrecognized CLI version or marker layout fails before installation.
The artifact retains the raw build and both successfully verified installed
executables, allowing independent byte-for-byte reproduction of the comparison;
per-file observed hashes are recorded even when identity checking fails.
The raw executable, marker counts and failed receipt are also retained if
reference derivation or the installed/locked CLI comparison rejects the build.

The exact transformation and restoration are in the reviewed upstream
[Tauri bundler source](https://github.com/tauri-apps/tauri/blob/59b63ab500da9859f12d8888c3298bc29bba0b92/crates/tauri-bundler/src/bundle.rs).
A future CLI update requires checking that contract before changing the guard.
The remembered-directory behavior is defined by the pinned
[NSIS template](https://github.com/tauri-apps/tauri/blob/59b63ab500da9859f12d8888c3298bc29bba0b92/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)
and [MSI template](https://github.com/tauri-apps/tauri/blob/59b63ab500da9859f12d8888c3298bc29bba0b92/crates/tauri-bundler/src/bundle/windows/msi/main.wxs).

# macOS drag callback regression

This standalone Cargo project tests the vendored Wry and Tao callbacks used by
OttPlay. It is deliberately outside the app workspace and cannot load the
unpatched crates. The runner only exercises expected-to-pass fixed behavior;
it does not run the intentionally crashing upstream reproduction.

This workspace also applies the application's existing GLib security backport.
Cargo resolves Linux dependencies in its lockfile even for a macOS-only test,
and a standalone workspace does not inherit the root `[patch.crates-io]` table.
`scripts/check-glib-backport.cjs` verifies both workspace overrides and lockfiles.

```sh
python3 tests/macos-drag-regression/run.py --offline
```

Omit `--offline` on a fresh CI host. Requires macOS, a graphical login/WindowServer
session, the Apple SDK/clang, Rust and Python 3. The Python runner starts 32 short
subprocesses: Wry/Tao × enter/drop × eight fixtures. It verifies dependency
provenance and Cargo resolution before starting, then asserts callback return
values, event kinds and exact path order, including Unicode entries surrounding
malformed ones. It stops at the first failure. `--output /path/results.json`
records synthetic diagnostic output.

The hidden, unfocused window uses an incognito inline HTML webview. Activation
and Dock visibility are disabled. Each real pasteboard fixture uses
`pasteboardWithUniqueName`, then releases it globally. No general clipboard,
user settings, provider URLs, media playback, or actual files are accessed.
A process-local AppKit event hook invokes the dependency's actual Objective-C
selector; it does not inject mouse/keyboard input or touch another application.

Fixtures cover a valid path, an empty array, advertised-but-missing data, a real
malformed `public.file-url` conversion, a non-array root, non-string elements,
mixed valid/invalid elements, and a real NSString with an unpaired UTF-16
surrogate (`UTF8String` returns null). Only the malformed object shapes use a
small pasteboard test double; missing/URL conversion use AppKit itself.

The 100 ms completion timer lets Tao deliver queued WindowEvents. The runner
has a 15-second deadline per subprocess and fails on missing callback/path
output, abnormal process exits, or unexpected paths.

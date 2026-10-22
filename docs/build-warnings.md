# Build warning review

Compiler and tool diagnostics stay enabled. A successful build does not mean
that every diagnostic is a source-code defect, or that warnings can be discarded.
Review new messages when the source or toolchain changes.

## Swift source fixes (2026-10-17)

The native build exposed redundant conditional casts of Capacitor's typed
`webView` and `getObject` results. The code now uses those types directly while
retaining optional handling and the checks on each outgoing header value.
The invisible, zero-size `MPVolumeView` used to obtain its public volume slider
no longer calls the deprecated `showsRouteButton` setter. No visible route
picker is changed.

Swift 6.4 also diagnoses the screenshot request's nested capture ownership.
The main-queue block now explicitly retains the plugin until it has registered
request ownership. The stored completion still captures the plugin weakly;
the request limit, cancellation and stale-completion guards remain in place.
This makes the existing lifetime intentional rather than weakening the check.

Run the existing authentication tests and unsigned simulator build documented
in [native-parity.yml](../.github/workflows/native-parity.yml) to validate these
paths. These checks do not substitute for playback or volume acceptance on a
physical iOS device.

## Legacy Blocks FFI repair

The macOS dependency `block` 0.1.6 declared an external class symbol using an
uninhabited empty enum. This is a soundness diagnostic, not a harmless SDK
notice. The workspace now uses the upstream inhabited opaque `repr(C)` type
fix while preserving the crate version, public API, pointer layout and native
symbol. Source hashes and the exact patch are retained under `vendor/`.

`node scripts/check-block-backport.cjs --runtime` first confirms that the
original source fails the `uninhabited_static` diagnostic. It then compiles the
patched source and exercises actual Clang/Apple Blocks invocation, native
copy/release, captured values and exactly-once destruction. The existing macOS
CI job requires this regression in addition to the complete Tauri tests.
See [backport provenance](../vendor/README.md).

## Tool and environment diagnostics

The following messages were observed in the
[October 17 build](https://github.com/open-ott-play/ottplay-foss/actions/runs/39000660642).
That superseded run is evidence of the individual diagnostics, not a claim that
the complete run passed.

- Android SDK manager deprecation is emitted by the installed SDK bootstrap
  tool. Its replacement is a toolchain maintenance item; certificate checking
  and SDK installation errors must still fail the build.
- Capacitor's Android `flatDir` repository and Gradle 8 deprecations remain
  visible. The Android project currently uses AGP 8.13.0 with Gradle 8.14.3;
  changing the Gradle major version requires qualification of both the current
  and API 22 build profiles. These are retained compatibility notices, not
  suppressed source warnings.
- Xcode may skip App Intents metadata extraction because this application has
  no `AppIntents.framework` dependency. No App Intents extension is advertised.
- The ARM runner's missing Renesas USB firmware message belongs to its kernel
  package installation, not the compiled player or a required playback device.
- CodeQL's Python extractor reports unresolved relative imports in scripts
  that support both package and direct-script execution. The runtime fallbacks
  and release-tool contract tests remain enabled. This is a limitation to keep
  visible when reviewing analysis coverage, not proof that extraction covers
  every possible path.

Generated tool help that contains the word "deprecated" is not itself a
diagnostic. Missing artifact warnings must be checked against the job outcome;
an interrupted test step does not establish that a successful test run omitted
its required report. This record does not assert that every platform warning or
every OpenSSF criterion is resolved.

## Android and analysis diagnostics

The Stalker HTTP bridge no longer passes Java `null` as the non-null fallback
argument to `optString`. It reads the optional value and preserves the same
string conversion. Real loopback HTTP regression cases cover strings, empty
values, numbers, booleans, JSON null/objects and missing or removed keys.
Response-body validation uses `checkNotNull`, retaining the nullable OkHttp 4
API 22 contract without redundant-Elvis diagnostics under OkHttp 5. The same
five real JVM test groups pass with both dependency profiles.

The later [qualification run](https://github.com/open-ott-play/ottplay-foss/actions/runs/39002303603)
also exposed D8 8.13.6 Kotlin-metadata rewrite errors with Kotlin 2.4.20.
The build completing does not establish metadata compatibility. The pinned
Android toolchain must be qualified against the
[official Kotlin/D8/R8 compatibility requirements](https://developer.android.com/build/kotlin-support)
before this diagnostic can be considered resolved.

Rust CodeQL reports unavailable dependency manifests and extraction gaps in
the `native_hls.rs` and `lib.rs` macro expansions. Successful analysis of other
code does not establish coverage of those omitted paths. These coverage gaps
and the Android metadata diagnostic remain open; they are not suppressed by
the native Blocks repair or by a passing JavaScript test suite.

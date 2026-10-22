# Release candidate fuzzing

See the [illustrated RC fuzzing process and verified rollout results](https://github.com/victron-venus/venus-os-ci-toolkit/blob/main/docs/rc-fuzzing-results.md)
for the shared release flow, evidence requirements and a dated cross-project
snapshot. The project-specific scope and reproduction guidance below still apply.

OTT-play FOSS runs bounded `cargo-fuzz`/libFuzzer campaigns through the reusable
`victron-venus/venus-os-ci-toolkit` release pipeline. This is not enrollment in
Google OSS-Fuzz and is not continuous fuzzing.

## Trigger, release gate, and badge

`.github/fuzz.json` lists the exact preparation commands, targets, seed paths,
and budgets. The release policy opts into the shared workflow. It checks that
the repository is **public** and the resolved channel is **release candidate**
before allocating a fuzzing runner. Campaigns do not run for PRs, ordinary
pushes, nightlies, betas, schedules, or stable promotion. Ordinary CI replays
the small checked-in corpus as deterministic unit tests without generating new
inputs or executing the libFuzzer engine.

The README's **Fuzzing: RC only** badge describes this policy and links here. It
is not a result badge. The RC workflow's fuzzing job and retained source-bound
report give the actual result for a particular candidate. Every configured
target must succeed before that RC is published. A panic, oracle failure,
crash, timeout, or resource-limit failure blocks it. Fix and test the cause,
then issue a new candidate. Stable promotion reuses evidence only for the
matching accepted RC source and artifacts; it does not repeat the campaign.

## Production code and oracles

- `xmltv` calls the actual server, native, and hosted XMLTV parsers with malformed
  XML, truncated feeds, references, CDATA, aliases, and timestamp boundaries.
  Accepted maps preserve channel identities; the hosted profile retains its
  record limits, positive programme intervals, and chronological ordering.
  Native/server/hosted duplicate policies intentionally differ, so cross-profile
  equality is not an oracle. The native path executes the pinned shared guide
  core through its real embedded JavaScript engine.
- `portal-request` calls the actual Stalker and VPortal request validators using
  JSON envelopes and mutated URLs. Accepted requests retain HTTP(S), hosts,
  credential and fragment restrictions; Stalker keeps its action uniqueness,
  allowed header set, and same-origin referer rule. VPortal retains its bounded
  protocol parameters. Validation does not send a request.

The harness links the production `ottplay-core` crate and its verified shared
core artifact. It never calls feed fetching, proxy request methods, the database,
player startup, or device control. These campaigns do not exercise video
codecs, DRM, browser rendering, live providers, TV firmware, or end-to-end
playback. XMLTV inputs are bounded to 8 KiB and portal inputs to 32 KiB, so large
feed and transport resource limits also require ordinary targeted tests.

The target processes have no network access in the shared runner. Preparation
may download public dependencies, then the instrumented binaries run in an
isolated network namespace. Inputs and fixtures are synthetic; no credentials,
private URLs, captured production payloads, or device data belong in the corpus.

## Budgets and retained evidence

Two targets run sequentially for **60 seconds each** (120 seconds of mutation
budget). The shared runner additionally bounds per-input time, memory, and the
whole job. Compilation is separate from mutation time. Rust is pinned to
`nightly-2026-10-12`; `fuzz/Cargo.lock` starts from the production lockfile and
adds the fuzz tooling. The shared workflow pins its cargo-fuzz and action
versions. Its report identifies the source, manifest hash, target inventory, duration,
and result. The source manifest records the commands.

The runner copies `fuzz/corpus/<executable>/` seeds to its writable diagnostics
area. It retains logs, the report, evolved corpus, and failure inputs as run
artifacts without mutating the checkout. Reports from another source revision
or expired artifacts are not substitutes for the current RC gate. Fuzzing is
bounded evidence, not proof of correctness or complete input coverage.

## Local reproduction

Follow the [official cargo-fuzz guide](https://rust-fuzz.github.io/book/cargo-fuzz.html)
and install the cargo-fuzz version pinned by the shared workflow. From the
repository root:

```sh
rustup toolchain install nightly-2026-10-12 --profile minimal --component rust-src
cargo fetch --locked --manifest-path fuzz/Cargo.toml
cargo test --locked --manifest-path fuzz/Cargo.toml --lib
cargo +nightly-2026-10-12 fuzz build --fuzz-dir fuzz
mkdir -p /tmp/ottplay-fuzz-corpus
cp fuzz/corpus/xmltv/* /tmp/ottplay-fuzz-corpus/
cargo +nightly-2026-10-12 fuzz run xmltv /tmp/ottplay-fuzz-corpus -- \
  -max_total_time=60 -timeout=10 -rss_limit_mb=2048
```

Use a disposable corpus because libFuzzer adds useful mutations there. The
manifest maps the documented target names to executable names (underscores
instead of hyphens). The shared Linux runner uses instrumented
`x86_64-unknown-linux-gnu` binaries directly. Local macOS results do not replace
the Linux RC gate.

Reproduce a retained failure on its exact source and toolchain, then minimize:

```sh
cargo +nightly-2026-10-12 fuzz run xmltv /path/to/crash-input
cargo +nightly-2026-10-12 fuzz tmin xmltv /path/to/crash-input
```

Distinguish a production bug from an incorrect oracle or environmental failure.
Do not suppress the assertion or delete a failing seed just to release. Add a
focused ordinary regression test for a fixed bug and a minimized synthetic seed
when safe. Report sensitive findings under [SECURITY.md](SECURITY.md) before
publishing a reproducer.

### macOS sanitizer compatibility

Apple Clang 21 can instrument QuickJS C objects with an Apple-specific ASan
runtime symbol that the Rust nightly runtime does not provide. A link failure
mentioning `__asan_version_mismatch_check_apple_clang_2100` is a toolchain mismatch,
not a passing fuzz result or a parser finding. Run the required campaign in the
Linux environment used by CI, or use a compatible C/Rust sanitizer toolchain.
A local `cargo fuzz build --sanitizer none` run can still explore inputs and
assertions, but lacks ASan checks and does not qualify the Linux RC gate.

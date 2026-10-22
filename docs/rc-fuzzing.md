# Fuzzing release candidates

The reusable `fuzz.yml` workflow runs bounded, instrumented input tests on public
release candidates. It is not enrollment in Google's OSS-Fuzz service. It does
not run on pull requests, pushes, beta releases, scheduled nightlies or stable
promotion. Existing unit tests and fixed regression cases keep their usual
schedule.

## Adoption

Add meaningful targets that call production parsing, validation or transformation
code. Test application invariants as well as crashes: invalid commands must not
be accepted, normalization must be stable, and numeric results must stay within
their documented domain. Do not replace production functions with copies in the
test, or count random calls to a standard JSON parser as application coverage.

Create `.github/fuzz.json`, commit seed inputs and dependency locks, and add the
following to a public, versioned `.release-policy.json`:

```json
"fuzzing": {"toolkit_ref": "FULL_REVIEWED_TOOLKIT_COMMIT_SHA"}
```

Run `python3 scripts/install_release.py /path/to/consumer` from that reviewed
toolkit checkout. Review the generated release pipeline and vendored release
verification code together. Consumers remain pinned; changing this repository
does not silently change existing consumers.

For an existing adopter, update `fuzzing.toolkit_ref` to the reviewed full SHA,
then run `python3 scripts/install_release.py /path/to/consumer --fuzz-only` from
that toolkit checkout. This updates the wrapper and runner pins together with
the small vendored fuzz/CI contract files; other release recipes remain intact.
Use `--fuzz-only --check` to check the result without writing. Ordinary consumer
CI rejects a wrapper, runtime or policy pin mismatch. Dependency-update tooling
must update these references atomically; a standalone workflow digest update
is not sufficient.

Example manifest:

```json
{
  "schema": 1,
  "language": "go",
  "go-version-file": "go.mod",
  "setup": [
    ["go", "mod", "download"],
    ["go", "test", "-c", "-fuzz=^FuzzParse$", "-o", "/tmp/parse-fuzz.test", "./internal/parser"]
  ],
  "targets": [{
    "name": "parse",
    "engine": "go",
    "command": ["go", "test", "./internal/parser", "-run=^$", "-fuzz=^FuzzParse$"],
    "seconds": 60
  }]
}
```

`language` selects setup for Go, Rust, Python, JavaScript, JVM (`jvm`) or C/C++ (`c`). C/C++
manifests must select an explicit installed compiler, such as `clang-18`, and
build host-only targets with libFuzzer and address/undefined sanitizers. `setup` contains
reviewed argument arrays for dependency installation and compilation, never shell
fragments. Pin dependencies; for Python use a dedicated `.fuzz-venv` and a
hash-locked requirements file. Rust targets should build with pinned cargo-fuzz
and `nightly-2026-10-12`, then execute the compiled libFuzzer binary directly.

JVM targets use Temurin JDK 17 and the `libfuzzer` engine with the official
[Jazzer standalone launcher](https://github.com/CodeIntelligenceTesting/jazzer#jazzer-standalone).
Compile the real Java/Kotlin production sources and harness during `setup`, and
pin the Jazzer distribution and all build dependencies in the consumer. An
Android consumer can compile its pure JVM modules without starting Android or
an emulator. Its ordinary app, device and signing checks remain separate and
required. Pass the launcher its classpath and target class in `command`; the
runner supplies the bounded libFuzzer flags and writable copied corpus. Do not
use a build command that silently falls back to deterministic regression mode.
`JAVA_HOME` is forwarded to the isolated target so Jazzer can locate `libjvm`;
ambient `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS` and credentials are not forwarded.
The same public-default-branch RC gate applies to JVM targets.

Each target needs a unique lowercase kebab-case name, `engine` (`go`, `atheris`
or `libfuzzer`), argument-array `command`, and `seconds` (1–120). Optional `cwd`
is relative to the repository. Optional `corpus` names a committed seed directory;
the runner copies it before mutation. Go uses its native `testdata/fuzz` corpus.
Preserve committed seed bytes, including intentional truncation and missing
newlines. Whitespace and end-of-file hooks exclude `fuzz/corpus/`; changing a
seed is an explicit corpus change, not a formatting repair.
The total mutation budget is at most 600 seconds across at most 12 targets.
`go-version-file` is optional, Go-only and names an existing regular file within
the repository; directories and symlinks are rejected. For a
Go target launched through a build adapter, declare the module file and use the
selected `go` on `PATH`; generated-corpus discovery queries `go env GOCACHE` in
that module directory, not the adapter executable.

## Deterministic checks before mutation

Python targets declare the project functions whose instrumentation must exist:

```json
"instrumentation": [{"module": "my_app.parser", "functions": ["parse", "Request.validate"]}]
```

The shared helper runs each existing harness with its locked interpreter,
intercepts `atheris.Setup`, and resolves those functions only from modules the
harness already loaded. It requires project-local Python bytecode and checks
that applying Atheris instrumentation is idempotent. Missing instrumentation,
dependency code substituted for production code, and missing modules fail the
check. This proves instrumentation for the declared functions, not full program
coverage. The harness keeps responsibility for its offline dependency adapters.

The preflight first runs `pip check`, then replays committed corpus inputs with
`-runs=0`; no timed mutation campaign runs. An explicitly declared corpus must
be an existing directory with at least one regular seed file; missing, empty or
unreadable inputs or any nested symlinks fail the preflight. A zero-byte seed
file remains a valid input. The engine must report positive execution counts;
calling `atheris.Setup` without entering `atheris.Fuzz` cannot pass. Those counts
are saved with the instrumentation proof and checked in the durable RC report.
Every RC performs these checks before
mutation. Python adopters also reuse the existing CI configuration job for this
cheap check on relevant pull-request, merge-group and push changes. The job
caches pip downloads keyed by both fuzz and workflow-contract requirement files; installation still requires
the reviewed hashes. `preflight-paths` is an optional list of literal source
files or directories, without globs or trailing slashes. The path `.` selects
every change. The fuzz manifest, canonical `.github/requirements-fuzz.txt` lock,
release policy, CI workflows and shared helpers always count as relevant. Add
any custom dependency lock path explicitly to `preflight-paths`. Unavailable
diff evidence runs the check; documentation-only unrelated changes can skip it.

Optional top-level `preflight` is a list of reviewed deterministic command argv
arrays, for example `[["node", "--test", "fuzz/parser.test.mjs"]]`. Each command
has a 90-second cap and the whole ordinary-CI preflight, including Python
dependency setup, has a four-minute cap. RC dependency setup runs beforehand
with its existing per-command 600-second bound, followed by the same four-minute
replay check. The enclosing Python configuration job has a ten-minute
cap to preserve time for checkout, existing contracts and failure diagnostics.
Native targets do not repeat their build setup in ordinary
CI: keep fixed-seed regression tests in their existing language test job. Explicit
preflight commands also run in the isolated RC environment after its build.

On Linux with the declared toolchain installed, run the same deterministic check:

```sh
python3 scripts/release_fuzz.py preflight --output /tmp/fuzz-preflight-new
```

The targeted installer also exports the pinned workflow-contract dependencies.
Native adapters with a custom CI graph run `scripts/workflow_contracts.py
--actions-only` in an existing validator job; the full invocation additionally
enforces the single-entry CI graph used by standard consumers.

Use a new output directory. Add `--if-changed` only in hosted CI with its public
repository event and complete Git history; it skips release dispatches because
the RC runner already performs preflight itself. This command does not qualify a
release candidate and never replaces the bounded RC campaign.

Runtime flags are supplied centrally. Do not supply time, worker, crash-output or
memory flags in target commands. Build steps must not run random campaigns; use
compile-only commands or fixed seed replay. Keep setup separate from mutation so
dependency access cannot accidentally enable access to production services.

## Execution and cost boundary

Both the generated caller and reusable workflow check public repository metadata,
`workflow_dispatch`, `channel=rc` and the repository default branch before
allocating a fuzz runner. The Python runner repeats the event checks and binds
the checkout to the run's source SHA. A missing/unknown visibility fails closed.
The workflow uses an ephemeral standard Ubuntu hosted runner, read-only repository
permission, no inherited secrets and no persisted checkout credentials.

Dependency builds may access the network. Each target executes with the runner's
unprivileged UID/GID in a new Linux network namespace, with no access to a real
broker, Cerbo or actuator. Only toolchain environment variables are forwarded.
This is network isolation, not a sandbox for malicious source code: adoption
still requires review of the source, dependencies and commands.

Go uses two fuzz workers and a 1536 MiB runtime memory target; libFuzzer/Atheris
uses a 2048 MiB RSS limit and a 10-second per-input timeout. Go's memory target is
not an operating-system hard limit. Each command has a wall-clock timeout,
including a bounded compile/minimization allowance; the entire job is capped at
30 minutes. Successful exit without positive engine execution statistics fails
qualification, including Go's "no fuzz tests to fuzz" result.

## Evidence, failures and stable promotion

Failed ordinary-CI Python preflights retain setup/replay logs and instrumentation
evidence as `fuzz-preflight-<attempt>` for seven days. Successful preflights add no
artifact storage. The preflight cannot qualify an RC.

Every RC attempt saves `fuzz-diagnostics-<attempt>` for 30 days with setup logs,
target logs, preflight evidence, copied/mutated seed corpora and failure inputs.
Go diagnostics also copy the generated `$GOCACHE/fuzz` subtree, separately from
the build cache and source `testdata/fuzz` regressions. Each generated-corpus
snapshot is limited to 10,000 files / 64 MiB; the report explicitly records
truncation. These snapshots may include earlier targets from the same job, so
the limit can omit inputs generated by later targets. The reported file and
byte counts describe the retained snapshot, not a complete per-target corpus.
The successful
`fuzz-report.json` records repository, source SHA, run/attempt, manifest hash,
target inventory, budgets and outcomes. Schema 2 additionally retains positive
engine execution counts, available coverage/interesting-input metrics and
Python instrumentation evidence. Verification remains compatible with existing
schema-1 releases. Engine counters are not a claim of total application coverage.
`release-assets-fuzz` retains it for 90
days and the candidate publisher includes it in the release asset inventory.
Projects with signed releases include the report in their signed inventory.
The report is covered by `release-inputs-fuzz.json`, which binds it to the same
frozen version plan and declared source inputs as the packages. This is recorded
separately in `validation_receipts`; it is not a platform build that must be
repeated during a final-package rebuild. Adopting fuzzing requires a new RC:
older candidates without fuzz evidence can no longer qualify for promotion.

Missing, failed, cancelled or unexpectedly skipped RC fuzz checks block the
release gate. Signing also waits for successful RC fuzzing. The publisher checks
the report against the actual source manifest and attempt before publication;
stable verification checks the original RC job and policy. Normal byte promotion
does not rerun mutation. Projects already requiring final package rebuilds retain
their separate final-build acceptance rules; fuzzing does not waive those rules.

On failure, download diagnostics, reproduce the smallest input against the same
source, fix the production bug and commit a regression seed/test. Publish a new
RC from the fixed source. If retrying an infrastructure failure, rerun all jobs
so the report and release evidence refer to one coherent attempt.

Successful generated corpora are retained for inspection, not automatically
restored into later RCs. Review and minimize useful inputs offline with the
matching engine and source revision, then commit the selected regression seeds.
Keep this process bounded and synthetic; never copy personal data or production
captures into a public corpus. A future automatic restore must validate
repository, target, manifest compatibility and storage limits before replay.

README badges should state the actual scope, for example:

```markdown
[![Fuzzing: RC only](https://img.shields.io/badge/fuzzing-RC_only-blue)](docs/fuzzing.md)
```

This is a capability badge, not a passing-status badge. Link the repository's
documentation to its real release runs and reports. Never use an "OSS-Fuzz
integrated" or passing badge without corresponding enrollment or test evidence.

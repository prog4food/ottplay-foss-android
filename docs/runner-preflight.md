# Early final-build runner check

A final build can spend an hour compiling and downloading its complete matrix
before the exact RC toolchain comparison discovers a different hosted runner
image. The additive `scripts/runner_preflight.py` check rejects that known
mismatch in the **same build job**, before provisioning and compilation.

This does not speed up GitHub's rollout, pin a hosted image, guarantee the next
runner assignment, or qualify a final release. It checks only `platform`,
`ImageOS`, `ImageVersion`, `RUNNER_OS`, and `RUNNER_ARCH`. Python, Node, Rust,
Cargo, Go, Xcode, and other provisioned inputs remain subject to the existing
full post-build toolchain comparison. A match is explicitly reported as
`runner-identity-match`, with `full_toolchain_verified: false`.

## Consumer integration

The canonical toolkit renderer vendors the helper and its regression tests.
The consumer owns `.github/workflows/release-build.yml`; its real platform jobs
must call the helper after downloading the frozen plan and before installing
project/toolchain dependencies. Give the step a five-minute timeout and the
caller's read-only `github.token` via `GH_TOKEN`. The reusable build workflow
must explicitly declare both `contents: read` and `actions: read`; downloading
a same-run plan with an artifact action does not establish REST API permission:

```sh
python3 scripts/runner_preflight.py --repo "$GITHUB_REPOSITORY" \
  --plan .release-plan.json --channel "$RELEASE_CHANNEL" \
  --receipt release-inputs-android.json
```

Use the same exact receipt name that the target's eventual package receipt will
use. Desktop's six targets are `aarch64-apple-darwin`, `x86_64-apple-darwin`,
`ubuntu-22.04`, `windows-latest`, `ios`, and `android`. The check reads the actual
runner identity in that job. A separate successful probe job is insufficient:
GitHub can assign a different image to the later build job.

The helper has no write/dispatch/retry capability. It returns a nonzero status
for drift or invalid evidence. Beta/RC/nightly plans report `not-applicable`
without remote downloads; they do not yet have an accepted RC expectation.
A caller must not use `continue-on-error`, catch a failing status as success, or
turn the result into an acceptance receipt. The consumer patch and a reviewed
new toolkit pin require a new source-qualified RC before future final builds.
Existing source pins, frozen helpers, accepted RCs, and rejected artifacts stay
unchanged.

## Trust and bounds

The final plan's durable release-state reservation binds the exact parent RC tag,
source, originating run, and manifest SHA-256. The guard verifies the current
run/attempt, checkout, caller workflow/event, exact current main, source policy,
plan/reservation, and dispatch RC against that parent. It then reads only the
RC manifest, its immutable Actions evidence ZIP, and the selected target receipt.
Their hashes, sizes, source/base/policy/plan identity, and published snapshot must
agree. No full package downloads occur. It retains the existing final verifier
and publication/native acceptance gates unchanged.

Every metadata GET is allowlisted and read-only. Each subprocess has a 45-second
deadline, with bounded stdout (8 MB JSON/paginated metadata or 4 MB binary) and
8 KB stderr. Individual manifest/receipt declarations remain capped at 2 MB.
Oversize, stale status, missing identity, missing immutable evidence, changed
hashes, and transport failures fail closed. Raw transport text is never logged.
The consumer step timeout also bounds aggregate metadata time.

`--plan` accepts only the literal `.release-plan.json`. The plan and policy are
read from fixed names in the current checkout, with a 2 MB read limit. A CLI path
cannot select another file. The checkout root is resolved once as a trusted
anchor; symbolic links below it are rejected. The workflow event has a separate
runner-owned anchor: `GITHUB_EVENT_PATH` must name
`RUNNER_TEMP/_github_workflow/event.json`, including its absolute path outside the
checkout. Only the trusted root is normalized (for system aliases such as macOS
`/var`); event directory/file links below it are rejected. The event is bounded
before the unchanged canonical execution check rereads it.
This event layout is the native Actions runner contract. Container jobs that
remap the event path require a separately reviewed adapter and fail closed here.

The structured drift result names the target and differing fixed runner fields
with expected/actual values (bounded, restricted-character identities only).
An invalid provenance or transport response yields `invalid-evidence`, not a
runner drift claim. These diagnostics are not published release evidence.

## Limits

- One target failing early does not prevent already-running sibling matrix jobs
  from compiling. Desktop currently uses separate desktop/mobile matrices with
  `fail-fast: false`; this proposal does not add a cancellation controller.
- A full successful image rollout is advisory information. It neither authorizes
  automatic RC/final dispatch nor guarantees compatibility with a historical RC
  built across mixed images.
- Missing image metadata on a self-hosted builder fails closed. A future immutable
  VM builder needs a separately reviewed truthful image identity contract.
- Fully removing rollout dependence while retaining separate final builds needs
  controlled immutable build environments. That infrastructure is separate from
  this early waste-prevention check.
- Caller-context validation follows GitHub's documented reusable workflow
  semantics: the `github` context belongs to the caller. Hosted integration is
  still required after source review; offline fixtures do not prove runner
  environment behavior.

Reference: [GitHub reusable workflow context](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#github-context).
The event location follows [the Actions runner's event writer](https://github.com/actions/runner/blob/main/src/Runner.Worker/ExecutionContext.cs).

# macOS local delivery and recovery

Use this runbook when replacing a local web player, its macOS server, and an
existing set of Tauri applications while preserving their configuration and
which applications were open. A page reload is not an installation: it can load
new web assets from an already updated server, but cannot replace an installed
Tauri bundle, its embedded frontend, or the server executable.

## Choose the delivery workflow

The repository provides `scripts/install-local-stack.sh` and
`scripts/update-local-stack.sh` for the local HTTP stack. Their setup, ports and
environment variables are documented in [Local HTTP deployment](local-http-deployment.md).
For example, from a checked-out source tree:

```sh
scripts/install-local-stack.sh
# For a later update, leaving the HLS proxy running:
SKIP_HLS_RELOAD=1 scripts/update-local-stack.sh
```

These commands build and install the local server/web stack. They do not perform
the coordinated Tauri bundle transaction, application-state capture and recovery
procedure below. The install command also provisions the HLS proxy and normally
synchronizes its configuration; read its prerequisites before running it.

The coordinated procedure requires a **separately supplied, reviewed operator
toolkit**. Its `tools/planner`, `tools/installer`, `tools/lifecycle`, and
`profile_integrity.py` are task-local tools, not files shipped by this repository,
an npm package, or commands installed by the scripts above. The reviewed online
profile snapshot helper is supplied separately as well. There is no public
one-command installer for that toolkit.

This runbook describes the contracts inspected in `reviewed-tooling-v3.json`.
That manifest supersedes earlier versions after a nested plan-digest comparison
fix. It is evidence about reviewed tooling, not proof that a product artifact
was built, installed or accepted. Obtain the complete toolkit, review manifest,
site-specific inputs and recovery instructions from the delivery owner. Compare
all tool hashes with that independently reviewed manifest before execution.

The inspected implementation contains site-specific paths, instance identities,
provider policy and output-directory restrictions. Changing only a layout JSON
does not make it portable. A different installation needs a reviewed adaptation
and new pins, including the lifecycle inventory and snapshot helper. Do not copy
another operator's device identifiers, tokens or configuration.

## Topology and prerequisites

The coordinated five-origin topology is one `ottplay-server` process serving:

- `http://127.0.0.1:8443`
- `http://127.0.0.1:8444`
- `http://127.0.0.1:8445`
- `http://127.0.0.1:8446`
- `https://127.0.0.1:8447`

The first four listeners are HTTP despite their port numbers. The fifth uses
the existing certificate and private key. This is a separately configured
topology; the repository's default local installer configures four HTTP
listeners. Do not run that installer over a five-origin deployment as a
substitute for the reviewed transaction.

Each scheme/hostname/port combination is a separate browser origin and storage
context. Preserve the actual origins: changing `127.0.0.1` to `localhost`, or
HTTP to HTTPS, does not carry settings across. A process ID is not a port.
Record the server PID and start time separately, then verify that this process
owns all five configured listeners.

The native topology has a default application and three instance wrappers. The
reviewed wrapper queue ports are 18082, 18085 and 18086 for instances 2, 3 and 4;
these are not web-player origins. Instance isolation also depends on launcher
environment and storage identity. In particular, setting `OTTPLAY_INSTANCE=1`
does not reproduce the default application's storage context.

Before starting, require:

- macOS, CPython 3.12 or later (also required by the pinned controller CLI),
  and the native tools used by the supplied adapter (`launchctl`, `ps`, `lsof`,
  `ditto`, `codesign`, and `open`).
- An existing installation matching the reviewed layout, with explicit app,
  web, server, LaunchAgent, certificate, private-key, wrapper and state paths.
  The coordinated installer is an update procedure, not a bootstrap from absent
  files.
- A pinned controller CLI, its adjacent `workbench.py`, and private CLI/server
  configurations mapping the four native aliases to their actual devices.
  Running applications must support normal remote exit and runtime inspection.
  See [Remote workbench](remote-workbench.md).
- Sufficient disk space for old code, incoming code, complete raw state copies,
  normalized SQLite copies and retained recovery evidence.
- A maintenance window in which applications and provider settings are not
  changed during capture, replacement or acceptance. Close or suspend web
  clients before the server's multi-file replacement.

Use private evidence directories (0700) and files (0600), with `umask 077`.
Snapshots contain credentials even when reports expose only hashes. Keep them
out of Git, issue attachments and public logs.

## Bind the candidate to its source and release

Prepare and review the candidate before stopping anything. The source revision
must be a full commit SHA. The staged web tree, native application and optional
server binary must have independently recorded fingerprints and a build receipt
binding their actual bytes to that revision.

For official-release delivery, the planner cross-checks:

1. The published release, successful `release-pipeline.yml` workflow run and
   attempt, source revision, release tag and version.
2. The `release-evidence` Actions artifact digest and the exact manifest bytes
   inside that artifact.
3. The manifest's archive and build-receipt hashes, sizes and source/plan
   identities. The inspected native contract is the Apple Silicon
   `OttPlay.FOSS_aarch64-apple-darwin.app.zip`, with its matching desktop receipt
   and `ottplay-foss-modea.tar.gz` web archive.
4. Every staged application file and mode against the official archive, the
   complete staged public web tree against the web archive, and native
   `codesign --verify --deep --strict` validation.

Do not modify or re-sign the official application to attach local metadata.
Signature verification checks the bundle's signature validity; it does not by
itself establish source provenance, a Developer ID identity or notarization.
Preserve the separate release and build evidence. The local-build route instead
requires a reviewed receipt binding the native binary to its staged embedded
frontend; a version file alone is insufficient.

A clean source tree and an exact frozen release overlay are different accepted
source modes. For an overlay, the tracked source verifier must be unchanged,
`.release-plan.json` must exactly match the official manifest's `version_plan`,
and the verifier must recognize only the declared version changes at the pinned
commit. Do not label this tree clean.

When replacing the server, its receipt must bind the binary hash, source
revision, `Cargo.lock` hash and supported locked Cargo build command. For a
frozen overlay it must additionally bind the exact release-plan object and the
SHA-256 of the release-plan file bytes. A server built from an unprojected
checkout at the same commit is not interchangeable with this evidence. Require
the reviewed server CLI, multi-listener and TLS compatibility results against
the preserved LaunchAgent.

When preserving the server binary, the planner requires reviewed provenance
for that existing binary and compatible server source/dependencies. Do not
silently keep it if the server changes require replacement.

Distinguish these hashes in the run sheet:

- `plan_sha256` and `recipe_sha256` are canonical JSON payload digests excluding
  only their respective **top-level** digest field.
- Checkpoint, CLI, tool, receipt and configuration pins are hashes of file bytes.
- The nested frozen-plan digest is part of delivery provenance. The fresh-plan
  comparison remaps only generated staging/backup paths and excludes only the
  root delivery digest on both sides. Never recursively remove `plan_sha256`
  fields or ignore an unexplained comparison failure.
- A runtime `bundle-…` build ID identifies compiled inputs; it is not the
  downloadable asset hash. Validate both loaded identity and delivered bytes.

## Build the reviewed run sheet

The examples below are Bash templates for the separately supplied toolkit.
Replace all placeholder paths and hashes using the approved local run sheet.
They are not commands available in a fresh repository checkout. Inspect the
matching release's help before using it:

```sh
python3 /absolute/path/to/reviewed-delivery/tools/planner/plan_delivery.py --help
python3 /absolute/path/to/reviewed-delivery/tools/installer/install.py --help
python3 /absolute/path/to/reviewed-delivery/tools/lifecycle/macos_host.py --help
python3 /absolute/path/to/reviewed-delivery/profile_integrity.py --help
```

Use fresh output names. Planner reports must be under its own directory;
lifecycle inventory/recipe reports must be directly in the lifecycle directory.
Transactions belong under `tools/installer/transactions`; lifecycle work
directories belong under `tools/lifecycle/live-runs`. The tools refuse overwrite
or paths outside their permitted roots.

```bash
umask 077
DELIVERY='/absolute/path/to/reviewed-delivery'
PLANNER="$DELIVERY/tools/planner/plan_delivery.py"
INSTALLER="$DELIVERY/tools/installer/install.py"
LIFECYCLE="$DELIVERY/tools/lifecycle/macos_host.py"
LAYOUT="$DELIVERY/tools/planner/layout.local.json"
CANDIDATE='/absolute/path/to/reviewed-candidate.json'
BASELINE="$DELIVERY/tools/planner/baseline-new.json"
PLAN="$DELIVERY/tools/planner/delivery-new.json"
INVENTORY="$DELIVERY/tools/lifecycle/inventory-new.json"
RECIPE="$DELIVERY/tools/lifecycle/recipe-new.json"
WORKDIR="$DELIVERY/tools/lifecycle/live-runs/delivery-new"
TRANSACTION="$DELIVERY/tools/installer/transactions/delivery-new"

python3 "$PLANNER" snapshot --layout "$LAYOUT" --output "$BASELINE"
python3 "$PLANNER" plan --layout "$LAYOUT" --candidate "$CANDIDATE" \
  --expected "$BASELINE" --delivery-mode quiesced_external_lifecycle \
  --output "$PLAN"

python3 "$DELIVERY/tools/lifecycle/lifecycle_plan.py" inventory --output "$INVENTORY"
python3 "$DELIVERY/tools/lifecycle/lifecycle_plan.py" plan \
  --delivery "$PLAN" --inventory "$INVENTORY" --output "$RECIPE"
```

`snapshot` records code/static fingerprints, **not a configuration backup**.
The lifecycle recipe requires inventory no more than 30 seconds old. Its
`prior_apps` must describe the applications actually open at cutover, including
their PID/start identity, launcher and instance environment. If all four are
open, restore all four; if only two are open, restore those two. Never reuse an
older assumption about this set. Regenerate and review the recipe if it changes.

Review the candidate, replacement scope, state roots, static guards, before/after
hashes, origins and recovery paths. Pin the resulting payload digests in the
run sheet. A generated plan or list of command arguments is not authorization
to execute itself; the operator selects each phase explicitly.

The common argument arrays avoid repeating the long list of pinned inputs.
The placeholder hashes below must come from the reviewed inputs; simply
hashing an unexpected changed tool does not approve that change.

```bash
PLAN_SHA256='<reviewed plan_sha256 field>'
RECIPE_SHA256='<reviewed recipe_sha256 field>'
PLANNER_SHA256='<reviewed planner file hash>'

lifecycle_args=(
  --delivery "$PLAN" --recipe "$RECIPE" --layout "$LAYOUT"
  --planner "$PLANNER" --planner-sha256 "$PLANNER_SHA256"
  --approved-delivery-sha "$PLAN_SHA256" --approved-recipe-sha "$RECIPE_SHA256"
  --transaction-module "$DELIVERY/tools/installer/transaction.py"
  --transaction-module-sha256 '<reviewed transaction module file hash>'
  --install-module "$INSTALLER" --install-module-sha256 '<reviewed installer file hash>'
  --cli '/absolute/path/to/pinned/cli/ott.py' --cli-sha256 '<reviewed CLI file hash>'
  --workbench-sha256 '<reviewed adjacent workbench.py file hash>'
  --cli-config '/absolute/path/to/private/cli-config.json'
  --cli-config-sha256 '<reviewed CLI configuration file hash>'
  --server-config-sha256 '<reviewed server configuration file hash>'
  --workdir "$WORKDIR"
)
installer_args=(
  --transaction "$TRANSACTION" --planner "$PLANNER"
  --planner-sha256 "$PLANNER_SHA256" --plan "$PLAN"
  --plan-sha256 "$PLAN_SHA256" --layout "$LAYOUT"
)

# Validates inputs without creating the workdir or executing lifecycle actions.
python3 "$LIFECYCLE" quiesce "${lifecycle_args[@]}"
```

`macos_host.py` is the production adapter and requires `--execute` to act.
`lifecycle_executor.py` has a dry-run CLI and fixture adapter; invoking it does
not stop or start the Mac's applications.

## Quiesce, prepare, apply and restore

Run each phase only after checking the previous result. Do not put the whole
sequence in an unattended shell paste that continues after errors.

1. **Quiesce and capture configuration.** The adapter checks the fresh instance
   set and runtime profiles, records exit request IDs, requests normal app exit,
   and waits for all shared Tauri executables to disappear. It then boots out
   the exact LaunchAgent and verifies no server, registered respawning service,
   listener or state writer remains. It repeats these checks around capture.

   ```bash
   python3 "$LIFECYCLE" quiesce "${lifecycle_args[@]}" --execute
   ```

   Save the returned `checkpoint` and `checkpoint_sha256`. Raw backups include
   complete declared state roots and SQLite WAL/SHM files. Normalization operates
   on copies, preserving the raw backup. Supported SQLite copies require
   `quick_check`; WebKit IndexedDB with unsupported external collation must be
   reported as such, not called fully integrity-verified. Checkpoints are bound
   to the plan and expire within ten minutes. An old checkpoint cannot replace
   live stop checks.

2. **Prepare copies.** Set these values from that successful quiesce result:

   ```bash
   CHECKPOINT='/absolute/path/from/quiesce/checkpoint.json'
   CHECKPOINT_SHA256='<returned checkpoint file hash>'
   python3 "$INSTALLER" prepare "${installer_args[@]}" \
     --checkpoint "$CHECKPOINT" --checkpoint-sha256 "$CHECKPOINT_SHA256"
   ```

   Require `prepared_no_installed_code_changed`. Prepare verifies provenance
   again, signatures, private backups, copied fingerprints and live gates. It
   creates the transaction manifest/journal but does not replace installed code.

3. **Apply the replacement.** Save stdout in a fresh private file; this exact
   receipt will be pinned for restore. Check the command's exit status and JSON
   before continuing.

   ```bash
   APPLY_RESULT="$TRANSACTION/apply-result.json"
   (set -o noclobber; python3 "$INSTALLER" apply "${installer_args[@]}" \
     --checkpoint "$CHECKPOINT" --checkpoint-sha256 "$CHECKPOINT_SHA256" \
     > "$APPLY_RESULT")
   ```

   Require `installed_pending_acceptance`, the expected plan digest and
   transaction, with `services_started`, `state_restored` and
   `physical_runtime_verified` all false. The transaction uses individually
   journaled same-filesystem renames. It is not one atomic swap of the app, web
   tree and server. Nothing should serve the intermediate state.

4. **Restore service and the actual prior app set.** After inspecting the
   successful apply receipt, pin its bytes and pass it to the adapter:

   ```bash
   APPLY_RESULT_SHA256="$(shasum -a 256 "$APPLY_RESULT" | awk '{print $1}')"
   python3 "$LIFECYCLE" restore "${lifecycle_args[@]}" \
     --apply-result "$APPLY_RESULT" --apply-result-sha256 "$APPLY_RESULT_SHA256" \
     --execute
   ```

   Restore validates the complete on-disk transaction before starting the same
   LaunchAgent. It checks the expected server binary, unchanged configuration,
   new PID/start identity, five listener owners, real TLS validation, `/health`
   response `OK`, and every body hash in the plan's `readback.expected_sha256`.
   The inspected plan includes `/`, `/dist/player.js`,
   `/dist/provider-plex.js` and `/dist/provider-vportal.js` on every origin.
   Do not bypass certificate verification with `curl -k`.

   Only then does it open each previously running application through its
   original launcher, verify a new process/runtime identity and compare its
   loaded source revision/build ID with the candidate. It checks the original
   active provider/profile without selecting another one for testing. Plex is
   unnumbered; do not invent a Plex profile number. A previously closed default
   app remains closed; its preserved identity comes from the closed-store proof.

## Acceptance includes complete provider configuration

The adapter's `accepted` result covers its disk, listener, web and running-app
checks. It explicitly reports `configuration_after_start_verified: false`.
Active provider/profile identity alone cannot prove that inactive profiles,
credentials or other provider settings survived.

Capture fresh normalized LocalStorage copies after startup with the separately
reviewed `capture_profile_snapshot.py`, using the pre-install normalization
evidence and its pinned hash. Its site-specific allowlist and output roots must
match the reviewed deployment. For example:

```bash
python3 /absolute/path/to/reviewed/capture_profile_snapshot.py \
  --before '/absolute/path/to/pre-install/sqlite-normalization.json' \
  --before-sha256 '<pre-install evidence file hash>' \
  --proof-tool-sha256 '<reviewed profile_integrity.py file hash>' \
  --output '/absolute/path/under/approved/snapshot-root/new-snapshot'
```

This helper uses one read-only SQLite transaction per source database, including
committed WAL pages, and writes separate self-contained copies. It neither
checkpoints nor rewrites the source. The databases are captured sequentially,
not atomically together. A plain copy of a live `.sqlite3` file, especially
without its WAL, is not an equivalent snapshot.

The helper runs the comparison itself. Alternatively, given independently
validated before/after normalization evidence, the proof tool's interface is:

```bash
python3 "$DELIVERY/profile_integrity.py" \
  --before '/absolute/path/to/before/sqlite-normalization.json' \
  --before-sha256 '<before evidence file hash>' \
  --after '/absolute/path/to/after/sqlite-normalization.json' \
  --after-sha256 '<after evidence file hash>' \
  --device '<default app device ID>' --device '<instance 2 device ID>' \
  --device '<instance 3 device ID>' --device '<instance 4 device ID>' \
  --report '/absolute/path/to/private/new-profile-comparison.json'
```

Require `status: verified` in the comparison, the full expected device set,
matching source identities and no changed keys. The helper additionally reports
`comparison_status: verified`. `snapshot_ready` alone is not a passing comparison.

The policy hashes complete values for supported provider configuration and
identity/remote-control keys; it does not filter secret-bearing fields out of
those values. It validates all 15 slots and the active slot for supported
multi-profile formats, including inactive slots, and explicitly recognizes the
legacy singleton Stalker format. It excludes unrelated playback journals and
other nonconfiguration keys. Thus it proves equality under the recorded policy,
not byte equality of the whole database or preservation of every preference.

Finish acceptance by recording the artifact/source/plan pins, signature checks,
static guards, new process/runtime mapping, five-origin readback, restored app
set, configuration comparison and all recovery locations. A fresh
`build-info.json` alone cannot prove that an existing page loaded the candidate.
Use loaded-runtime inspection where web clients are part of acceptance, and
record any untested origins or clients separately.

Remote exit acknowledgement precedes the eventual exit effect. Process exit
does not prove that the last playback position was durably saved. State capture
has no global atomicity across stores; report observed persistence and any
unsupported checks precisely. Retain recovery data until acceptance is complete
and the delivery's retention policy permits cleanup.

## Failure and recovery

Keep the original plan, recipe, tool/configuration pins, lifecycle workdir,
transaction and journals. Never delete a journal to make a retry appear fresh.
Do not start a mixed installation or overwrite current profile stores merely
because code is being rolled back.

### Failure before replacement

If planning or the dry run fails, no lifecycle action has been requested. Fix
the input/provenance mismatch and review a new plan as needed.

If quiesce or prepare fails before any rename, the old code remains installed.
The quiesce adapter attempts original-state recovery on failure; inspect its
recovery receipt instead of assuming success. With original fingerprints intact,
the explicit recovery action is:

```bash
python3 "$LIFECYCLE" recover-original "${lifecycle_args[@]}" --execute
```

It reconciles prior exit requests, restores the same service and only the
original open app set. An unresolved queued exit blocks safe relaunch. Preserve
the request ID and reconcile its existing controller receipt; do not submit
another exit, infer nonexecution from a timeout, or use force quit as evidence
of a normal checkpoint. Initial `quiesce` is not replayable.

### Failure during renames or an expired stopped transaction

A stopped installer is not proof that rollback completed. Inspect its durable
journal and physical prefix. Ordinary apply failures attempt code rollback while
the stop gates hold; interruption or a failed rollback can leave a partial
prefix. Even a missing installed server/app path may be a
valid partial rename, with the original object still in its recorded stage.
Do not repair this by copying arbitrary files over those locations.

Use `refresh-rollback` with the **prepared transaction** and the same pinned
lifecycle inputs. It verifies the stopped physical prefix and creates a fresh
checkpoint in a new attempt directory without stopping or starting processes:

```bash
python3 "$LIFECYCLE" refresh-rollback "${lifecycle_args[@]}" \
  --transaction "$TRANSACTION" --execute
```

Require `prepared_transaction_quiesced_for_rollback`. Replace `CHECKPOINT` and
`CHECKPOINT_SHA256` with this result's fresh values, then run:

```bash
python3 "$INSTALLER" rollback "${installer_args[@]}" \
  --checkpoint "$CHECKPOINT" --checkpoint-sha256 "$CHECKPOINT_SHA256"
```

Require `rolled_back`, then restore the original runtime:

```bash
python3 "$LIFECYCLE" recover-original "${lifecycle_args[@]}" --execute
```

These are separate operator steps: run `recover-original` only after verified
code rollback, and require `original_runtime_restored` before reporting recovery.
The rollback checkpoint binds the transaction manifest, current
physical prefix and journal tip. It cannot authorize forward apply. Reusing an
expired checkpoint, a different prefix, or an earlier attempt is invalid.

### Failure after candidate startup

Do not invoke code rollback while the candidate server or apps are running.
For the reviewed schema-3 server-replacement path, first use `requiesce` with
the pinned successful apply receipt:

```bash
python3 "$LIFECYCLE" requiesce "${lifecycle_args[@]}" \
  --apply-result "$APPLY_RESULT" --apply-result-sha256 "$APPLY_RESULT_SHA256" \
  --execute
```

This action validates the candidate identities, closes the observed candidate
apps, boots out the owned service and captures current state. Require
`candidate_quiesced_for_rollback`; pass its newly returned checkpoint to
`install.py rollback`, then run `recover-original` as above. The original
pre-install snapshot is historical evidence after startup, not a valid proof
of current stopped state. Code rollback intentionally retains current profile
state; restoring old state backups is a separate recovery decision.

`requiesce` supports resume with the same inputs and workdir. It reconciles
completed exit effects, the exact service identity and partial snapshot attempts.
It never replays an already-recorded exit whose result is pending, unknown or
unaccepted. Such a request deliberately blocks recovery until reconciled.
Retrying bootout of the same owned service to establish its stopped state does
not justify replaying a queued application exit. Once candidate shutdown has
started, candidate `restore` is prohibited.

If the process is already stopped at a partial rollback prefix, use
`refresh-rollback` to obtain another fresh checkpoint. If rollback cannot verify
objects, signatures, backups or gates, leave the service/apps stopped, retain
all surviving paths and escalate with the private recovery evidence. The
inspected `requiesce` command requires schema-3 server replacement; do not claim
that it provides a general post-start recovery path for a schema-2
preserve-server delivery without a separately reviewed implementation.

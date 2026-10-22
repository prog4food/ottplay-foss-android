# Linux WebKit runtime qualification

Linux WebKit runs on the explicit GitHub-hosted `ubuntu-26.04` x64 runner for
Playwright 1.62.1, 1.63.0 and 1.64.0. Chromium, Firefox, branded channels, Windows
and macOS retain their existing targets. All 35 RC targets remain present:
32 require complete UI and HLS playback, and the three documented Windows
WebKit targets require their two UI scenarios. The RC still needs 166 successful
scenario executions. No failed playback scenario becomes optional.

The frontend `Build` job also uses Ubuntu 26.04 because it runs the standalone
Linux WebKit MSE aspect-persistence regression before packaging Mode A. A host
guard verifies Linux, x64 and `/etc/os-release` before installing dependencies.
This changes the JavaScript test host; the Tauri native package build hosts and
their binary compatibility baseline remain unchanged.

## Evidence for the runtime choice

The comparison used the original five Plex scenarios, including strict-kiosk
natural episode completion and reload, with four independent executions per
runtime and no retries. Both sides used the same packaged Mode A artifact
`12033189997` from [run 38870073578](https://github.com/open-ott-play/ottplay-foss/actions/runs/38870073578).
Its build source was `45216821ed2d8284a59b8e0c7d83269ad2373054`, whose Git tree
matches the reviewed PR source `89221396d441e533f0af0bea3745401846de472a`.
The outer artifact ZIP SHA-256 was
`d52092590819b3fcdd3e9f313f4fd0d159c4af58edab677f7f848bf723dced96`;
the packaged Mode A archive SHA-256 was
`081cf437a0648457e045d0b45c3b6943dd797d5f060e7ccef8fdc172cb830c9c`.

The official Playwright 1.64.0 images were pinned by immutable digest:

- Ubuntu 24.04 (Noble):
  `mcr.microsoft.com/playwright@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f`.
- Ubuntu 26.04 (Resolute):
  `mcr.microsoft.com/playwright@sha256:2c4fd97c99d2377e7767ee3c6a86c9fa1e944600d4b198a09a5f235330f498ae`.

The [first comparison](https://github.com/open-ott-play/ottplay-foss/actions/runs/38961444154)
produced 17/20 passing scenarios on Noble and 20/20 on Resolute. Its diagnostic
collector incorrectly required every memory-mapped file, including mutable
browser caches, to remain unchanged. That run therefore did not establish
native-library immutability and was not accepted as a complete qualification.

The [corrected comparison](https://github.com/open-ott-play/ottplay-foss/actions/runs/38962201111)
recorded the actual mapped ELF binaries separately from non-ELF files. Resolute
passed all 20 scenarios and its runtime verification. Noble passed 19/20 and
failed the strict-kiosk transition again. All 312 observed native ELF files on
Resolute and 310 on Noble remained unchanged, as did both installed package
inventories. Three non-ELF JACK shared-memory database files changed on Noble;
the report retained their before/after hashes. Neither container exhausted
memory, and neither reported a native termination signal in this comparison.

These results support changing the complete Linux runtime. They do not identify
one responsible package: the images contain different browser/system builds and
coherent GStreamer 1.24 and 1.28 package sets. No isolated library backport is
installed by the production workflow.

## Reproduction and release requirements

The diagnostic source is pinned at
`1d0e8d1ac6e44d99967adfd2af4c8acd2a79f419`. Its temporary `native-parity.yml`
and `scripts/foss-runtime-generation.py` preserve the exact candidate, runtime
digests, source checks, original assertions, package inventory, loaded files,
per-scenario results and container status. That temporary workflow is diagnostic
only and must not replace the production native workflow.

The production workflow installs the selected browser and its normal supported
system dependencies on the explicit runner. All three pinned Playwright
generations contain Ubuntu 26.04 support and dependency tables; for example,
see the upstream [1.62.1 platform selection](https://github.com/microsoft/playwright/blob/v1.62.1/packages/utils/hostPlatform.ts)
and [native dependencies](https://github.com/microsoft/playwright/blob/v1.62.1/packages/playwright-core/src/server/registry/nativeDeps.ts).
GitHub documents the [Ubuntu 26.04 hosted runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

The fixed-candidate comparison is diagnostic evidence, not approval of a later
source revision or proof of the GitHub runner's complete installed environment.
The final source must pass current PR checks and all three Linux WebKit
generations in the complete RC matrix. A Tauri package or AppImage must also pass
its separate native playback and end-of-episode acceptance on the supported
target system. Browser success does not substitute for that package acceptance.

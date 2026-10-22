# webOS Simulator launcher and external CLI

The default simulator launcher uses only Node.js built-ins. It selects the
highest installed `MAJOR.MINOR.PATCH` release for the requested webOS TV version
and launches the official simulator with the hosted app directory and empty JSON
parameters. macOS uses `/usr/bin/open`; Linux and Windows use the installed
executable. All values are separate process arguments with `shell: false`.
This follows the launch contract in LG's
[Apache-2.0 CLI source](https://github.com/webos-tools/cli).
The simulator itself remains vendor software and is not redistributed.

`setup-webos-simulator.sh` no longer downloads or installs `@webos-tools/cli` or
its dependency tree. The setup `--cli-only` option is a compatibility no-op.
An existing CLI installation is left untouched. The launcher does not search
`PATH` for one; using `--cli` or `WEBOS_CLI` explicitly selects an external tool
that the operator maintains. This override retains the `ares-launch -s VERSION
-sp SDK APP` interface. It does not make that external CLI safe or updated.

On 2026-10-08 the latest official CLI was still 3.2.6 (Apache-2.0). An audit of
its dependency lock reported ten affected package entries, including indirect
entries: one critical, seven high and two moderate. The findings were not
suppressed. Key dependency paths and available fixes were:

- `CLI → express → proxy-addr` 2.0.7: critical
  [IP spoofing](https://github.com/advisories/GHSA-jqcg-44mw-7w3h), fixed in 2.0.8 (MIT).
- `CLI → rimraf/fstream → glob → minimatch → brace-expansion`: high
  [CPU exhaustion](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), fixed in
  1.1.21, 2.1.7 and 5.0.12 for the respective dependency lines (MIT).
- `CLI → shelljs → fast-glob → micromatch → braces` 3.0.3: high
  [stack exhaustion](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), no published
  patched version at the time of review (MIT).
- `CLI → sprintf-js` 1.1.3: moderate
  [unbounded precision](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), no published
  patched version at the time of review (BSD-3-Clause).
- The lock also contained vulnerable `qs` (fixed in 6.16.0, BSD-3-Clause) and
  development `js-yaml` (fixed in 4.3.2, MIT).

Changing only the downloaded archive checksum does not fix these dependencies.
Removing the automatic CLI dependency eliminates this tree from the project's
default simulator setup. Reachability of every finding in other external CLI
operations is not established by our tests. Tests cover native argument passing,
release selection, missing inputs, process failures, shell metacharacters and the
explicit CLI override; they do not certify the vendor simulator or a physical TV.

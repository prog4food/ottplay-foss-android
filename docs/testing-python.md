# Python suites and coverage

Install `python3 -m pip install -r requirements-test.txt`, then run
`npm run test:python`. This is the portable suite used by CI: one manifest,
per-test timeouts/logs, an aggregate result and an 80% statement/branch coverage
gate. Every `tests/test*.py` must appear in the manifest; missing inventory fails.
Artifacts are in `reports/python/` and CI uploads them even when tests fail.

Coverage currently gates four bounded executable Python modules:
`local_proxy.py`, `archive/proxy_security.py`,
`scripts/smoke-xmltv-cache-refresh.py`, and `scripts/prepare-container-workspace.py`.
The offline workspace integration tests also use Cargo. Tests themselves never contribute to the
coverage denominator. Missing coverage for any of these files fails. The
legacy `archive/server.py` is exercised by proxy tests but is not covered by
this first threshold; native Kotlin/Swift behavior is tested in its platform
harnesses and cannot count as Python runtime coverage.

`python3 scripts/test-python.py --profile android` and `--profile ios` group
platform harnesses for local execution. They need the same Kotlin/Swift/native
prerequisites as the existing native-parity workflow. They do not emit a fake
Python coverage pass. The CI inventory audit understands executable suite
profiles and rejects `--help`, comments and unused npm scripts as test coverage.

The settings backup, import and text editor implementation now lives in
`src/settings/transfer-ui.ts`; `src/index.ts` keeps the legacy window exports
and wiring. Existing DOM, clipboard, editor teardown and native/browser backup
regressions execute the extracted implementation. This is a bounded first
extraction; the remaining startup/player/settings compatibility hub still
needs incremental decomposition.

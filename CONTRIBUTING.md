# Contributing

Use [GitHub issues](https://github.com/open-ott-play/ottplay-foss/issues) for non-sensitive bug reports, questions and
feature proposals. Include the exact version/commit, environment, expected and
actual behavior, and a minimal sanitized reproduction. Check existing issues
first and keep follow-up evidence in the original thread. For vulnerabilities,
use the [private security process](SECURITY.md).

Submit a focused pull request against `main`. Describe the user-visible problem,
the resulting behavior, compatibility implications and checks performed. Preserve
existing authorship and third-party license/provenance records. Discuss changes
to protocols, storage, device safety or dependency/runtime requirements before
making an incompatible change. English is the common language for code review
and project documentation.

## Development and validation

```sh
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm test
cargo test --locked -p ottplay-core -p ottplay-server
```

See README Build from Source and docs/build-pipeline.md for browser/native build prerequisites. CI includes browser journeys, Python contracts, Rust tests and bundle/ES5 checks. A headless browser run does not qualify every TV firmware, decoder, DRM provider or native device.

The [CI workflow](.github/workflows/ci.yml) is the authoritative list of required jobs.
Use isolated test data and temporary outputs. Never run a device write, unlock,
deployment or publication command merely to validate a documentation change.

## Test and review policy

Changes to behavior must add or update automated tests that fail for the old
defect and cover the new boundary; regression fixes should include the relevant
failure case. If automation is infeasible, explain why in the PR and document
the reproducible manual procedure and limits. Update user/API documentation and
release notes for user-visible changes. Keep compiler, lint, static-analysis and
test assertions enabled, resolve new warnings, and document any remaining
warning with its reason and scope. Do not suppress a real security finding to
obtain a passing check. Wait for required checks and independent review before
merging; do not use an administrator bypass.

## Python test dependency lock

Install coverage with `python3 -m pip install --require-hashes --only-binary=:all: -r requirements-test.txt`. The `.in` file contains the direct requirement;
regenerate the reviewed cross-platform hashes with:

```sh
uv pip compile requirements-test.in --generate-hashes --universal --python-version 3.12 --output-file requirements-test.txt
```

Run `npm run test:python` in the resulting Python environment.

## Project decisions and conduct

See [governance](GOVERNANCE.md), the [maintenance roadmap](ROADMAP.md) and
[Code of Conduct](CODE_OF_CONDUCT.md), including confidential reporting.

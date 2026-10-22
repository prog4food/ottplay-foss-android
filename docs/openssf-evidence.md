# OpenSSF Passing evidence

This is a source-backed work record for the [OpenSSF Best Practices Passing
criteria](https://www.bestpractices.dev/en/criteria/0). The
[public assessment for this repository](https://www.bestpractices.dev/en/projects/15593)
is the current record; its dynamic badge is linked from the README. The partial
[machine-readable assessment](../.bestpractices.json) is an earlier local snapshot,
not a substitute for the current published answers. Unverified requirements must
remain explicitly unverified.

## Available evidence

- Purpose, installation and operating limitations: [README](../README.md).
- Public Git source, commit history and change proposals: [open-ott-play/ottplay-foss](https://github.com/open-ott-play/ottplay-foss).
- Bug reports and retained discussion: [issues](https://github.com/open-ott-play/ottplay-foss/issues).
- Contribution requirements, test policy and test invocation: [CONTRIBUTING](../CONTRIBUTING.md).
- Private reporting process and response policy: [SECURITY](../SECURITY.md).
- Trust boundaries, source references and negative-test evidence: [security design](security-design.md).
- Build/test automation: [workflow](../.github/workflows/ci.yml) and [actual run results](https://github.com/open-ott-play/ottplay-foss/actions).
- Compiler fixes and retained tool diagnostics: [build warning review](build-warnings.md).
- Project license: [MIT](../LICENSE); third-party terms still apply.

## Initial scanner inventory — 2026-10-08

The authenticated GitHub inventory found 15 open code-scanning alerts
(including Scorecard policy findings) and 0 open Dependabot alerts.
This is a dated baseline, not a statement about the post-merge state. A scanner
configuration error or disabled scanner must not be recorded as zero findings.
Check [Code scanning](https://github.com/open-ott-play/ottplay-foss/security/code-scanning) and
[Dependabot](https://github.com/open-ott-play/ottplay-foss/security/dependabot) after the changed default branch is
analyzed.

## Unresolved criteria and applicability

Complete language-by-language cryptography and dynamic memory-safety review, assess tracked vendor binaries with provenance, and verify release notes/security history before asserting full Passing.

On 2026-10-16 the maintainer explicitly confirmed knowledge of secure-design
principles and common implementation/network vulnerabilities, and confirmed
that no bug, enhancement or vulnerability reports arrived outside GitHub during
the preceding 12 months. The same date's GitHub inventory found no non-PR issues,
private vulnerability reporting enabled, 13 open Scorecard findings and zero
open Dependabot alerts. The latter is not a complete dependency audit or a
claim that all 13 findings are resolved.

[Governance](../GOVERNANCE.md), [conduct](../CODE_OF_CONDUCT.md) and the
[roadmap](../ROADMAP.md) identify responsibility and reporting channels. There
is no designated backup or tested recovery mechanism within a week; continuity
and bus-factor criteria remain unmet.

The earlier Linux WebKit qualification failure was resolved for
[v1.1.55](https://github.com/open-ott-play/ottplay-foss/releases/tag/v1.1.55).
The [verified RC run](https://github.com/open-ott-play/ottplay-foss/actions/runs/38992291032)
used source `a9eab3594b1be4bb713aa4da2610fa43029f008b`: 35 browser targets
completed 166 scenarios, and 10 ARM64 Linux playback cases passed on Ubuntu
24.04/26.04 DEB/AppImage and Fedora 44 RPM with independent visual review.
The [stable run](https://github.com/open-ott-play/ottplay-foss/actions/runs/38998136329)
promoted the same 32 verified RC assets without rebuilding them.

These receipts qualify that release and those environments; they do not assert
physical-device, Windows/macOS native, or later PIN-migration acceptance. Full
outbound/native/platform cryptography, third-party provider scope, source
coverage and dependency closure remain separate open assessments.

Record each completed analysis with its source SHA, commands/tool versions,
result and material limitations. Verify the public answers and this repository's
own README badge after each published assessment update.

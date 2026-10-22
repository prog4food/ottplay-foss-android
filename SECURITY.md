# Security Policy

## Reporting a Vulnerability

Private vulnerability reporting is enabled for this repository. Use
[Report a vulnerability](https://github.com/open-ott-play/ottplay-foss/security/advisories/new)
to send a confidential report to the maintainers. Follow
[GitHub's private reporting instructions](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
if you need help submitting the report.

Include the affected version or commit, steps to reproduce, expected and actual
behavior, and potential impact. Remove access tokens, credentials and personal
data from examples. Do not disclose exploit details in public issues before
coordinating with the maintainers.

## Response commitments

Maintainers aim to acknowledge private reports within 14 days; follow up
privately if there is no response. Triage confirmed issues by impact, prioritize
critical defects, and coordinate remediation/disclosure with the reporter.
Security changes must have release notes with affected versions and upgrade
actions. Fixes target the current default branch and latest release, rather than
unmaintained historical versions. These are project policies, not assertions
about the existence or response times of past reports.

See [security design](docs/security-design.md) for project-specific trust boundaries.
See the [Rust dependency review](docs/rust-dependency-security.md) for resolved
advisories, remaining maintenance warnings and preserved upstream lockfiles.

Confirmed critical vulnerabilities are addressed immediately after validation.
Other confirmed medium-or-higher project vulnerabilities should be remediated
within 60 days of a public report, including an update, mitigation or removal of
the affected supported feature. Record unresolved cases and affected versions;
a policy target does not prove that every dependency already meets it.

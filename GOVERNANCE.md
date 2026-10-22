# Governance

`4alvit` is the primary maintainer, responsible for reviews, merge decisions,
source and signed releases, dependency updates, private security reports and
conduct enforcement. Contributors propose changes through public issues and
pull requests with tests and documentation. Automated checks assist review;
they do not replace maintainer accountability.

Technical decisions are discussed in the relevant issue or pull request. The
maintainer resolves disagreements using scope, compatibility, evidence,
security and maintenance cost. A contributor can request reconsideration with
new evidence in the same discussion. Private matters use [SECURITY](SECURITY.md)
or the [Code of Conduct](CODE_OF_CONDUCT.md).

Follow required checks and independent review before normal GitHub merging.
Release approval also requires the source-bound checks and platform acceptance
in [the release strategy](RELEASING.md). A merge does not establish physical
TV, decoder, commercial provider or app-store acceptance. Link any earned OpenSSF
badge in README within 48 hours and correct it when supporting evidence changes.

## Continuity limitation

There is no designated backup maintainer or tested mechanism that can restore
repository, CI and release access within one week of the primary maintainer's
unavailability. Bots and hypothetical account recovery do not establish this.
OpenSSF access continuity and bus-factor requirements remain unmet.

# CI orchestration

Quality gate owns pull request and merge queue validation. The release pipeline
owns default branch and nightly checks for applications; validation-only projects
run those events through Quality gate. Callable validators do not launch duplicate
runs. Superseded PR runs are cancelled, and validation jobs have explicit timeouts.

The required CI configuration contracts check CodeQL pin compatibility, validation
triggers, timeouts, and complete gate dependencies. Dependency Review, where present,
blocks the same gate for pull requests and reports other events as not applicable.
CodeQL action updates are grouped where Dependabot Actions updates are configured.

Auto-merge verifies strict branch protection for CI gate, requests native GitHub
auto-merge, and exits. GitHub waits for CI, external checks and required reviews.
External check contexts retain their required status and are bound to their source GitHub App. Removing automerge
or converting a PR to draft disables an existing request. The metadata-only workflow
runs from the trusted base without executing PR code. BOT_PAT remains the merger token;
Dependabot approval uses GITHUB_TOKEN and human PR approval uses the bot's BOT_PAT.

#!/usr/bin/env bash
# Native build identity comes from the allocated release plan, never SemVer arithmetic.
set -euo pipefail
cd "$(dirname "$0")/.."
plan_path="${1:-${RELEASE_VERSION_PLAN:-.release-plan.json}}"
if [[ ! -f "$plan_path" ]]; then
  echo "A frozen release plan is required: bump-mobile-version.sh PATH_TO_PLAN" >&2
  exit 1
fi
python3 scripts/version_plan.py sync --root . --plan "$plan_path"

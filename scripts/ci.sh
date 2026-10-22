#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm test
npm run build
npm run check:bundle
npm run check:es5
npx playwright install chromium
npm run test:devices:browser
npm run package:modea
cargo test --locked -p ottplay-core -p ottplay-server
cargo test --locked --release --manifest-path tests/glib-variant-regression/Cargo.toml

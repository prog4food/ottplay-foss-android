#!/usr/bin/env bash
# Build local artifacts without publishing or deploying. Dependencies must be installed.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?Usage: release-build.sh X.Y.Z [nightly|beta|rc]}"
CHANNEL="${2:-rc}"
python3 scripts/check-release-version.py "$VERSION" "$CHANNEL"
mkdir -p release-output
npm run build
npm run check:bundle
npm run check:es5
npm run package:modea
cp build/packages/ottplay-foss-modea.tar.gz build/packages/ottplay-foss-modea.sha256 release-output/
# The legacy filename contains exactly the same audited server web root.
cp release-output/ottplay-foss-modea.tar.gz release-output/ottplay-foss-dist.tar.gz
sed 's/  ottplay-foss-modea\.tar\.gz$/  ottplay-foss-dist.tar.gz/' \
  release-output/ottplay-foss-modea.sha256 > release-output/checksums.txt

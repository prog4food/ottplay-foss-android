#!/usr/bin/env bash
# Install LG's official Apple Silicon simulator only when missing.
set -euo pipefail

VERSION=26
SIMULATOR_VERSION=1.5.0
ARCHIVE_SIZE=111268559
# SHA-256 of the official RF00021097 download, verified on 2026-09-15.
ARCHIVE_SHA256=f09068359f5cbab4da6fae3faac6239da17ea63ee34560df2471e469becf1cd4
APP_NAME="webOS_TV_${VERSION}_Simulator_${SIMULATOR_VERSION}"

usage() {
    cat <<'EOF'
Usage: scripts/setup-webos-simulator.sh [options]

  --version NUMBER   Simulator version (automatic installation supports 26)
  --destination DIR  Directory containing the installed Simulator .app
                     (default: ~/.local/share/ottplay/webos-tv-simulator/26)
  --archive FILE     Use an already downloaded official ZIP (checksum checked)
  --cli-only         Compatibility no-op; the launcher no longer needs a CLI
  --dry-run          Print the plan without downloading or installing
  -h, --help         Show this help

Installs LG webOS TV 26 Simulator 1.5.0 on macOS ARM64. Existing working
installations are reused. Downloads are temporary and removed after setup.
Python 3 and macOS ditto are required for missing components.
The bundled Node.js launcher needs no npm packages or webOS CLI installation.
LG SDK terms: https://webostv.developer.lge.com/develop/tools/simulator-installation
EOF
}

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
need_value() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "$1 requires a value"; }

version="${WEBOS_VERSION:-26}"
destination="${WEBOS_SDK_PATH:-}"
archive=""
cli_only=0
dry_run=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --version) need_value "$@"; version="$2"; shift 2 ;;
        --destination) need_value "$@"; destination="$2"; shift 2 ;;
        --archive) need_value "$@"; archive="$2"; shift 2 ;;
        --cli-only) cli_only=1; shift ;;
        --dry-run) dry_run=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown option: $1 (see --help)" ;;
    esac
done
[[ "$version" =~ ^[1-9][0-9]*$ ]] || die "webOS version must be a positive integer"
if [[ "$cli_only" == 1 ]]; then
    printf 'No CLI installation is needed; the bundled launcher starts the Simulator directly.\n'
    exit 0
fi
simulator_ready() {
    local candidate
    [[ -d "$1" ]] || return 1
    for candidate in "$1/webOS_TV_${version}_Simulator_"*; do
        if [[ "$candidate" == *.app && -x "$candidate/Contents/MacOS/$(basename "$candidate" .app)" ]]; then return 0; fi
        if [[ ( "$candidate" == *.appimage || "$candidate" == *.AppImage || "$candidate" == *.exe ) && -x "$candidate" ]]; then return 0; fi
    done
    return 1
}
if [[ "$cli_only" == 0 && -z "$destination" ]]; then
    registered_sdk=""
    if command -v node >/dev/null; then
        registered_sdk="$(node - "$version" <<'JS'
const fs = require('node:fs'), path = require('node:path');
try {
    const config = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.webos/tv/simulator-config.json'), 'utf8'));
    if (typeof config[process.argv[2]] === 'string') process.stdout.write(config[process.argv[2]]);
} catch (_) { /* Missing or stale registrations fall back to local discovery. */ }
JS
)"
    fi
    for candidate in "$registered_sdk" "$HOME/.local/share/ottplay/webos-tv-simulator/$version" \
        "$HOME/Applications/webOS_TV_${version}_Simulator_"* \
        "${LG_WEBOS_TV_SDK_HOME:-$HOME/.local/share/ottplay/webos-sdk}/Simulator/webOS_TV_${version}_Simulator_"*; do
        if simulator_ready "$candidate"; then destination="$candidate"; break; fi
    done
fi
destination="${destination:-$HOME/.local/share/ottplay/webos-tv-simulator/$version}"
install_simulator=0
if [[ "$cli_only" == 0 ]]; then
    if simulator_ready "$destination"; then
        printf 'LG Simulator already installed: %s\n' "$destination"
    else
        [[ "$version" == "$VERSION" ]] || die "Automatic installation supports webOS 26; use --destination with an existing Simulator for webOS $version."
        [[ ! -e "$destination" && ! -L "$destination" ]] || die "Destination exists but is incomplete; refusing to overwrite: $destination"
        install_simulator=1
        printf 'Install LG webOS TV %s Simulator %s (%s bytes): %s\n' "$VERSION" "$SIMULATOR_VERSION" "$ARCHIVE_SIZE" "$destination"
        printf 'Official source: https://webostv.developer.lge.com/develop/tools/simulator-installation (RF00021097)\n'
    fi
fi
[[ "$dry_run" == 0 ]] || exit 0

if [[ "$install_simulator" == 1 ]]; then
    [[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || die "Automatic LG Simulator installation requires macOS ARM64; use --sdk for another installed version."
    for required_command in python3 ditto; do
        command -v "$required_command" >/dev/null || die "$required_command is required"
    done
    parent="$(dirname "$destination")"
    mkdir -p "$parent"
    staging="$(mktemp -d "$parent/.webos-simulator-install.XXXXXX")"
    trap 'rm -rf "$staging"' EXIT
    if [[ -n "$archive" ]]; then
        [[ -f "$archive" ]] || die "Archive not found: $archive"
    else
        archive="$staging/simulator.zip"
        # Follow the same download API used by LG's Simulator Installation page.
        # LG issues an expiring GFTS link; do not hard-code or cache that link.
        python3 - "$archive" <<'PY'
import json, sys, urllib.parse, urllib.request, xml.etree.ElementTree as ET

base = 'https://webostv.developer.lge.com'
headers = {'User-Agent': 'Mozilla/5.0', 'Referer': base + '/develop/tools/simulator-installation', 'Origin': base}
try:
    request = urllib.request.Request(base + '/api/downloadSDK',
        data=json.dumps({'fileId': 'RF00021097'}).encode(),
        headers={**headers, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        file_id = json.load(response)['fileIdEnc']
    query = urllib.parse.urlencode({'fileId': file_id})
    request = urllib.request.Request('https://developer.lge.com/common/file/DownloadFilePath.ajax?' + query,
        data=b'', headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        link = ET.fromstring(response.read()).find('.//LMultiData').attrib['gftsUrl']
    parsed = urllib.parse.urlsplit(link)
    if parsed.scheme != 'https' or parsed.hostname not in ('gfts.lge.com', 'ngfts.lge.com'):
        raise ValueError('LG returned an unexpected download host')
    request = urllib.request.Request(link, headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response, open(sys.argv[1], 'wb') as output:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > 111268559:
                raise ValueError('Download exceeds the pinned archive size')
            output.write(chunk)
except Exception as error:
    # Do not print the temporary download URL or its token.
    raise SystemExit('LG download failed (' + type(error).__name__ + '). Retry setup, or use --archive with the official webOS TV 26 Simulator 1.5.0 mac ZIP.')
PY
    fi
    python3 - "$archive" "$ARCHIVE_SIZE" "$ARCHIVE_SHA256" "$APP_NAME" <<'PY'
import hashlib, pathlib, posixpath, stat, sys, zipfile

archive = pathlib.Path(sys.argv[1])
if archive.stat().st_size != int(sys.argv[2]):
    raise SystemExit('Archive size differs from the pinned official LG package.')
digest = hashlib.sha256()
with archive.open('rb') as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(chunk)
if digest.hexdigest() != sys.argv[3]:
    raise SystemExit('Archive checksum differs from the pinned official LG package.')
with zipfile.ZipFile(archive) as package:
    for info in package.infolist():
        path = pathlib.PurePosixPath(info.filename)
        if path.is_absolute() or '..' in path.parts or '\\' in info.filename:
            raise SystemExit('Unsafe path in archive: ' + info.filename)
        if stat.S_ISLNK(info.external_attr >> 16):
            target = package.read(info).decode('utf-8')
            resolved = posixpath.normpath(posixpath.join(str(path.parent), target))
            if target.startswith('/') or resolved == '..' or resolved.startswith('../') or '\\' in target:
                raise SystemExit('Unsafe symlink in archive: ' + info.filename)
    expected = sys.argv[4] + '/' + sys.argv[4] + '.app/Contents/MacOS/' + sys.argv[4]
    if expected not in package.namelist():
        raise SystemExit('The official Simulator executable is missing from the archive.')
PY
    ditto -x -k "$archive" "$staging/extracted"
    [[ -x "$staging/extracted/$APP_NAME/$APP_NAME.app/Contents/MacOS/$APP_NAME" ]] || die "Extracted Simulator executable is missing or not executable"
    [[ ! -e "$destination" && ! -L "$destination" ]] || die "Destination appeared during installation; refusing to overwrite"
    mv "$staging/extracted/$APP_NAME" "$destination"
    rm -rf "$staging"
    trap - EXIT
    printf 'LG Simulator installed: %s\n' "$destination"
fi
printf 'LG Simulator setup complete.\n'

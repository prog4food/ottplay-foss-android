#!/usr/bin/env bash
# Fetch only Samsung's pinned TV Web Simulator, without the firmware emulator.
# Extract vendor files; do not run installers, accept licenses or alter an SDK.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION=10.0.6
ARCHIVE_NAME="tv-samsung-websimulator-core_${VERSION}_macos-64.zip"
ARCHIVE_SIZE=207640744
ARCHIVE_SHA256=d1454e448742d75580917b91f6a21953785af0b53fd78f148162fb1005ed708f
DOWNLOAD_URL="https://download.tizen.org/sdk/extensions/tv_extensions/binary/$ARCHIVE_NAME"

usage() {
    cat <<'EOF'
Usage: scripts/setup-tizen-simulator.sh [options]

  --destination DIR  Directory for the macOS simulator (reuse if installed)
                     (default: ~/.local/share/ottplay/tizen-tv-simulator/10.0.6)
  --cache DIR        Download cache (default: build/vendor-tools/samsung)
  --keep-archive     Keep a newly downloaded ZIP after successful extraction
  --dry-run          Print paths and commands without downloading or extracting
  -h, --help         Show this help

Downloads the official Samsung TV Web Simulator 10.0.6 package (207,640,744
bytes). Requires macOS, curl, Python 3 and ditto. The Intel application uses
Rosetta. A complete existing installation is reused; other existing destinations
are never overwritten. Without --destination, also reuses ~/tizen-studio or
the explicitly configured TIZEN_SIMULATOR_SDK (which must already be valid).
New downloads are removed after successful extraction
unless --keep-archive is set; pre-existing cache files are preserved. No license acceptance,
vendor installer execution, firmware download or simulator launch occurs.
EOF
}

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
need_value() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "$1 requires a value"; }

destination="$HOME/.local/share/ottplay/tizen-tv-simulator/$VERSION"
destination_explicit=0
cache="$PROJECT_ROOT/build/vendor-tools/samsung"
dry_run=0
keep_archive=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --destination) need_value "$@"; destination="$2"; destination_explicit=1; shift 2 ;;
        --cache) need_value "$@"; cache="$2"; shift 2 ;;
        --keep-archive) keep_archive=1; shift ;;
        --dry-run) dry_run=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown option: $1 (see --help)" ;;
    esac
done

has_simulator() {
    local directory="$1" app_relative_path="" candidate
    [[ -d "$directory" ]] || return 1
    if [[ -f "$directory/simulator-app-path.txt" ]]; then
        app_relative_path="$(cat "$directory/simulator-app-path.txt")"
        case "$app_relative_path" in
            ""|/*|..|../*|*/..|*/../*|*$'\n'*|*$'\r'*|*\\*) die "Invalid local simulator path marker" ;;
        esac
        case "$app_relative_path" in
            nwjs.app|*/nwjs.app) ;;
            *) die "Invalid local simulator path marker" ;;
        esac
    else
        for candidate in tools/sec-tv-simulator/nwjs.app data/tools/sec-tv-simulator/nwjs.app nwjs.app .; do
            if [[ -x "$directory/$candidate/Contents/MacOS/nwjs" ]]; then
                app_relative_path="$candidate"
                break
            fi
        done
    fi
    [[ -n "$app_relative_path" && -x "$directory/$app_relative_path/Contents/MacOS/nwjs" ]]
}

if [[ "$destination_explicit" == 0 ]]; then
    if [[ -n "${TIZEN_SIMULATOR_SDK:-}" ]]; then
        has_simulator "$TIZEN_SIMULATOR_SDK" || die "Samsung TV Web Simulator not found at TIZEN_SIMULATOR_SDK: $TIZEN_SIMULATOR_SDK. Correct or unset it, or set --destination."
        printf 'Samsung TV Web Simulator already installed: %s\n' "$TIZEN_SIMULATOR_SDK"
        exit 0
    fi
    for existing_directory in "$destination" "$HOME/tizen-studio"; do
        if has_simulator "$existing_directory"; then
            printf 'Samsung TV Web Simulator already installed: %s\n' "$existing_directory"
            exit 0
        fi
    done
fi
if [[ -e "$destination" || -L "$destination" ]]; then
    [[ -d "$destination" && ! -L "$destination" ]] || die "Destination already exists; refusing to overwrite: $destination"
    if has_simulator "$destination"; then
        printf 'Samsung TV Web Simulator already installed: %s\n' "$destination"
        exit 0
    fi
    die "Destination already exists without a working simulator; refusing to overwrite: $destination"
fi
archive="$cache/$ARCHIVE_NAME"
printf 'Samsung TV Web Simulator %s; archive: %s bytes\n' "$VERSION" "$ARCHIVE_SIZE"
printf 'Source: %s\nDestination: %s\n' "$DOWNLOAD_URL" "$destination"
if [[ "$dry_run" == 1 ]]; then
    printf 'Download:'
    printf ' %q' curl --fail --location --output "$archive" "$DOWNLOAD_URL"
    printf '\nExtract after validation:'
    printf ' %q' ditto -x -k "$archive" "$destination"
    printf '\n'
    if [[ "$keep_archive" == 0 && ! -f "$archive" ]]; then
        printf 'Remove newly downloaded archive after successful extraction: %s\n' "$archive"
    fi
    exit 0
fi

[[ "$(uname -s)" == Darwin ]] || die "This package is for macOS"
for required_command in curl python3 ditto; do
    command -v "$required_command" >/dev/null || die "$required_command is required"
done
mkdir -p "$cache"
downloaded=0
if [[ ! -f "$archive" ]]; then
    download_temp="$(mktemp "$cache/.tizen-simulator-download.XXXXXX")"
    trap 'rm -f "$download_temp"' EXIT
    curl --fail --location --show-error --connect-timeout 10 --max-time 900 \
        --output "$download_temp" "$DOWNLOAD_URL"
    mv "$download_temp" "$archive"
    downloaded=1
    trap - EXIT
fi

# Validate before extraction, including archive paths and bundled symlinks.
# SDK packages can have a data/ prefix; find the actual app instead of guessing.
app_relative_path="$(python3 - "$archive" "$ARCHIVE_SIZE" "$ARCHIVE_SHA256" <<'PY'
import hashlib, pathlib, posixpath, stat, sys, zipfile

archive = pathlib.Path(sys.argv[1])
if archive.stat().st_size != int(sys.argv[2]):
    raise SystemExit('Archive size differs from the official package; remove the cached file and retry.')
with archive.open('rb') as source:
    digest = hashlib.sha256()
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(chunk)
if digest.hexdigest() != sys.argv[3]:
    raise SystemExit('Archive checksum differs from the pinned official package; remove the cached file and retry.')
apps = []
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
        if info.filename.endswith('nwjs.app/Contents/MacOS/nwjs'):
            apps.append(str(path.parents[2]))
    if len(apps) != 1:
        raise SystemExit('Expected one nwjs.app in the official archive; found ' + str(len(apps)))
    print(apps[0])
PY
)"

destination_parent="$(dirname "$destination")"
mkdir -p "$destination_parent"
staging="$(mktemp -d "$destination_parent/.tizen-simulator-extract.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
ditto -x -k "$archive" "$staging"
[[ -x "$staging/$app_relative_path/Contents/MacOS/nwjs" ]] || die "Extracted Simulator executable is missing or not executable"
printf '%s\n' "$app_relative_path" > "$staging/simulator-app-path.txt"
[[ ! -e "$destination" && ! -L "$destination" ]] || die "Destination appeared during extraction; refusing to overwrite"
mv "$staging" "$destination"
trap - EXIT
if [[ "$downloaded" == 1 && "$keep_archive" == 0 ]]; then rm -f "$archive"; fi
printf 'Vendor files extracted: %s\n' "$destination"
printf 'Review the Samsung license files supplied with the package before launching.\n'
printf 'Launch:'
printf ' %q' "$SCRIPT_DIR/run-tizen-simulator.sh" --sdk "$destination"
printf '\n'

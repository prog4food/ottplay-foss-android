#!/usr/bin/env bash
# Remove the ottplay-foss-local launchd user agents and stop the services.
# Removes the player job and any owned legacy instance jobs.
# ~/ottplay-foss-local is left untouched.
#
# Usage: scripts/uninstall-ottplay-local-service.sh
# Env override: OTTPLAY_LABEL (single label only).
set -euo pipefail

if [ -n "${OTTPLAY_LABEL:-}" ]; then
    LABELS="${OTTPLAY_LABEL}"
else
    LABELS="com.ottplay-foss-local"
    for plist in "$HOME/Library/LaunchAgents/com.ottplay-foss-local-"*.plist; do
        [ -f "$plist" ] || continue
        label="$(basename "$plist" .plist)"
        LABELS="$LABELS $label"
    done
fi

for LABEL in $LABELS; do
    case "$LABEL" in
        *[!A-Za-z0-9.-]*|.*|-*) echo "error: invalid service label" >&2; exit 1 ;;
    esac
    TARGET="gui/$(id -u)/$LABEL"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    launchctl bootout "$TARGET" 2>/dev/null || true
    stopped=0
    status_error="$(mktemp)"
    for _ in $(seq 1 30); do
        if ! LC_ALL=C launchctl print "$TARGET" >/dev/null 2>"$status_error"; then
            case "$(cat "$status_error")" in
                *"Could not find service"*) stopped=1; break ;;
                *) rm -f "$status_error"; echo "error: cannot inspect service: $LABEL" >&2; exit 1 ;;
            esac
        fi
        sleep 1
    done
    rm -f "$status_error"
    if [ "$stopped" != "1" ]; then
        echo "error: service is still loaded: $LABEL" >&2
        exit 1
    fi
    if [ -f "$PLIST" ]; then
        rm -f "$PLIST"
        echo "removed: $PLIST"
    else
        echo "not installed: $PLIST"
    fi
done

# Certificates and keychain trust belong to the operator. Keep them, and never
# terminate unrelated processes merely because they occupy a former player port.
echo "done (~/ottplay-foss-local kept; reinstall with scripts/install-local-stack.sh)"

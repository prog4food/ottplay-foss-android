#!/usr/bin/env bash
#
# Deploy ottplay-foss Docker container.
#
# Usage:
#   ./deploy.sh             # SSH to host alias "synology", deploy there
#   ./deploy.sh <host>      # SSH to <host> instead
#   ./deploy.sh --local     # deploy on THIS machine (when run on the NAS)
#
# Configuration (forwarded to the remote side):
#   IMAGE       image tag             (default alvit/ottplay-foss:latest)
#   CONTAINER   container name        (default ottplay-foss)
#   PORT        host port             (default 8080)
#   EXTRA_ARGS  extra docker run args
#
# Optional future SWOP auto-allow (not implemented yet — docs only):
#   SWOP_BASE_URL / SWOP_ADMIN_TOKEN / SWOP_CLIENT_ID on the deploy host.
#   See README "Remote text entry (swop)" and ottplay-swop Access control.
#   Never bake ADMIN_TOKEN into the image or git.
#

set -euo pipefail

run_deploy() {
    IMAGE="${IMAGE:-alvit/ottplay-foss:latest}"
    CONTAINER="${CONTAINER:-ottplay-foss}"
    PORT="${PORT:-8095}"  # ponytail: NAS-specific default; override via PORT env
    EXTRA_ARGS="${EXTRA_ARGS:-}"
    BASE_URL="http://localhost:${PORT}"

    log() { echo "[deploy] $*"; }
    fail() { echo "[deploy] FAIL: $*" >&2; exit 1; }

    # non-interactive SSH shells miss Synology's /usr/local/bin
    case ":$PATH:" in
        *":/usr/local/bin:"*) ;;
        *) PATH="/usr/local/bin:/opt/bin:$PATH" ;;
    esac

    command -v docker >/dev/null || fail "docker not found (PATH=$PATH)"
    command -v curl >/dev/null || fail "curl not found"

    # docker usually needs root on Synology; fall back to passwordless sudo
    DOCKER="docker"
    if ! docker info >/dev/null 2>&1; then
        if command -v sudo >/dev/null && sudo -n docker info >/dev/null 2>&1; then
            DOCKER="sudo -n docker"
            log "using sudo for docker"
        else
            fail "no docker access: add user to 'docker' group or enable passwordless sudo"
        fi
    fi

    log "Pulling ${IMAGE}..."
    $DOCKER pull "$IMAGE" || fail "docker pull failed"

    if $DOCKER ps -a --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
        log "Removing existing container '${CONTAINER}'..."
        $DOCKER rm -f "$CONTAINER" >/dev/null || fail "failed to remove old container"
    fi

    # shellcheck disable=SC2086
    $DOCKER run -d \
        --name "$CONTAINER" \
        --restart unless-stopped \
        -p "${PORT}:8080" \
        $EXTRA_ARGS \
        "$IMAGE" >/dev/null || fail "docker run failed"

    wait_for() {
        local url="$1" tries="${2:-30}" code=""
        for _ in $(seq 1 "$tries"); do
            code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$url" || true)"
            [ "$code" = "200" ] && return 0
            sleep 2
        done
        return 1
    }

    log "Waiting for ${BASE_URL}/ ..."
    wait_for "${BASE_URL}/" || {
        $DOCKER logs --tail 20 "$CONTAINER" >&2 || true
        fail "endpoint ${BASE_URL}/ did not return HTTP 200"
    }

    wait_for "${BASE_URL}/dist/player.js" 15 || fail "player bundle endpoint not reachable"

    log "OK: container '${CONTAINER}' is up."
    log "  Image:   $($DOCKER inspect -f '{{.Config.Image}}' "$CONTAINER")"
    log "  Started: $($DOCKER inspect -f '{{.State.StartedAt}}' "$CONTAINER")"
    log "  URL:     ${BASE_URL}/"
}

if [ "${1:-}" = "--local" ]; then
    run_deploy
    exit 0
fi

HOST="${1:-synology}"
[ $# -gt 0 ] && shift

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
if [ -s "$SCRIPT_PATH" ] && [ -f "$SCRIPT_PATH" ]; then
    # forward IMAGE/CONTAINER/PORT/EXTRA_ARGS to the remote shell
    env_str=""
    for v in IMAGE CONTAINER PORT EXTRA_ARGS; do
        [ -n "${!v:-}" ] && env_str+="$v=$(printf '%q' "${!v}") "
    done
    exec ssh "$HOST" "${env_str}bash -s" < "$SCRIPT_PATH"
else
    # streamed over SSH ($0=bash): we are already on the target machine
    run_deploy
fi

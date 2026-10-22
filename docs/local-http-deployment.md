# Local HTTP player deployment

This page describes the repository's source-build installation scripts and
their default four-HTTP-listener layout. For coordinated replacement of an
existing macOS app, local server and web files, see the
[local delivery and recovery runbook](macos-local-delivery.md). That runbook
distinguishes the separately supplied deployment toolkit from these scripts,
and covers backups, preserved profiles, runtime acceptance and rollback.

The local macOS player runs one `ottplay-server` process with four HTTP
listeners bound to `0.0.0.0` (all IPv4 interfaces, including loopback and LAN).
On this Mac the addresses remain:

- `http://127.0.0.1:8443/`
- `http://127.0.0.1:8444/`
- `http://127.0.0.1:8445/`
- `http://127.0.0.1:8446/`

From a TV or another computer, replace `127.0.0.1` with this Mac's LAN IP or
hostname. All four ports serve the same player with independent browser storage.
In Media Station X, open **Settings → Start Parameter → Setup**, enter
`MAC_LAN_IP:8443` (or another configured port), and leave the HTTPS lock off.
The server provides `/msx/start.json` and `/msx/content.json` with CORS enabled.
The launch URL preserves the requested hostname, port and HTTP/HTTPS listener;
it never substitutes the server's loopback address. MSX automatically opens the
player, with an **Open OTT-play FOSS** tile available if startup is interrupted.

The port numbers do not imply TLS. These endpoints deliberately use HTTP so
legacy portals and media sources can be requested without HTTPS mixed-content
blocking. Port 8095 is retired. The HLS proxy remains on HTTP port 8090.
Browser CORS restrictions and provider authorization still apply.

Run `scripts/install-local-stack.sh` for a full local stack installation or
`scripts/update-local-stack.sh` to rebuild an existing stack. Use
`SKIP_HLS_RELOAD=1 scripts/update-local-stack.sh` to leave the running HLS proxy
alone while updating the player. The installer archives old instance plists
outside `LaunchAgents`, so legacy listeners do not restart at the next login.

The player installer downloads npm and Cargo packages directly. For those
commands it clears inherited proxy variables and overrides package-manager
proxy settings, including proxies injected by office shell configuration.
The reset is scoped to those commands; shell settings, npm/Cargo configuration
files, registry selection and the running HLS proxy are not modified by it.

`OTTPLAY_HTTP_PORTS` can override the space-separated HTTP port list. Port 8095,
empty lists, duplicates and invalid ports are rejected before installation.
The old `OTTPLAY_PORT` and `OTTPLAY_HTTPS_PORTS` overrides are rejected with a
migration message. Certificates and existing keychain trust are preserved;
the HTTP installation does not generate, trust, or remove certificates.

Each scheme, hostname and port defines a separate browser origin. Switching
from HTTPS to HTTP creates a different storage context: existing HTTPS player
settings remain in the browser but are not automatically copied to HTTP.
Likewise, use either `localhost` or `127.0.0.1` consistently for a given profile.
An exported player configuration can be imported into the chosen HTTP origin.

The separate command server must also be reachable from the TV, and its exact
player origin (for example `http://192.168.1.20:8443`) must be in the command
server's `allowed_origins`. Device and administrator tokens still apply.

Remote text entry (SWOP) authorizes the server installation, with no device
allowlist. Register an installation token and the exact player origins in the
SWOP Worker, then run the installer with `SWOP_BASE_URL` (an HTTPS Worker URL)
and `SWOP_INSTALLATION_TOKEN`. The installer keeps both values across updates
in its mode-0600 launchd plist. `/local/swop.json` advertises only `/swop`.
The Rust server proxies `/swop/session` and `/swop/val`, checks that browser
Origin or Referer matches the current listener, and adds the installation
credential upstream. These routes have no permissive CORS. Each text-entry
session has separate read and phone-write tokens and expires on the Worker.
For a new LAN address, port, or hostname, update the Worker's installation
origins. A copied player on another server does not have the installation
credential; ordinary Origin headers alone do not authorize Worker requests.

The server CLI accepts repeated `--port` arguments for these listeners. Its
general default remains HTTP port 8080 when no port is supplied; explicitly
configured TLS and remote Docker/NAS mappings are unaffected. Desktop debug
launchers and local smoke tests default to HTTP 8443. Embedded native builds
retain their existing application URL schemes.

# Build the TS bundle (dist/player.js)
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json vite.config.ts ./
COPY src ./src
# Keep the build helpers together so new transitive dependencies are available.
# The final image receives only the validated web root, not these scripts.
COPY scripts ./scripts
COPY LICENSE ./
COPY licenses/android/Apache-2.0.txt ./licenses/android/Apache-2.0.txt
COPY licenses/native ./licenses/native
COPY vendor/ottplay-core.js vendor/ottplay-core.manifest.json vendor/ottplay-core.LICENSE.txt ./vendor/
COPY vendor/hosted-epg ./vendor/hosted-epg
COPY index.html favicon.ico ./
COPY fonts ./fonts
COPY js ./js
COPY devices ./devices
COPY styles ./styles
COPY images ./images
COPY locales ./locales
COPY providers ./providers
COPY src-tauri/pip ./src-tauri/pip
RUN npm run typecheck && npm run build:server

# Resolve the server workspace before the target compilation cache boundary.
# Desktop release version changes must not invalidate unchanged server inputs.
FROM --platform=$BUILDPLATFORM rust:1.99-alpine@sha256:557a94c82b485a14b569120e00867267108c734efe33f10cc31ca0cd5dd1eca9 AS server-inputs
RUN apk add --no-cache python3
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY vendor ./vendor
COPY src-rs ./src-rs
COPY scripts/prepare-container-workspace.py ./scripts/prepare-container-workspace.py
RUN python3 scripts/prepare-container-workspace.py --workspace /app --output /prepared

# Build Rust server against musl so the published image does not need
# GLIBC_2.38+ (Hub :latest built on a newer glibc toolchain failed on
# Synology DSM Docker / x86_64). Alpine = musl host target by default.
FROM rust:1.99-alpine@sha256:557a94c82b485a14b569120e00867267108c734efe33f10cc31ca0cd5dd1eca9 AS rust-build
RUN apk add --no-cache musl-dev build-base
WORKDIR /app
COPY --from=server-inputs /prepared/Cargo.toml /prepared/Cargo.lock ./
COPY vendor ./vendor
COPY src-rs ./src-rs
RUN cargo build --locked --release --bin ottplay-server

# Musl runtime (no glibc). ca-certificates for outbound HTTPS (EPG / M3U).
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN apk add --no-cache ca-certificates \
 && adduser -D -H -u 65532 -g nonroot nonroot
WORKDIR /app
COPY --from=rust-build /app/target/release/ottplay-server ./ottplay-server
# Use the validated web root, including the runtime-only player image allowlist.
# Copying source trees here would reintroduce retired and private assets.
COPY --from=build /app/dist/index.html ./index.html
COPY --from=build /app/dist/favicon.ico ./favicon.ico
COPY --from=build /app/dist/dist ./dist
COPY --from=build /app/dist/fonts ./fonts
COPY --from=build /app/dist/js ./js
COPY --from=build /app/dist/devices ./devices
COPY --from=build /app/dist/styles ./styles
COPY --from=build /app/dist/images ./images
COPY --from=build /app/dist/locales ./locales
COPY --from=build /app/dist/providers ./providers
USER nonroot
EXPOSE 8080
CMD ["./ottplay-server", "--port", "8080"]

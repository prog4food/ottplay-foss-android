# Native container builds and cache verification

The release workflow builds Linux AMD64 and ARM64 on matching native runners.
Each job exports an OCI archive with SBOM and provenance attestations, using a
separate GitHub Actions cache scope. Neither platform job publishes an image.
The final container job combines the original image and attestation blobs,
checks both platforms and their release labels, and verifies that they serve the
same web files. The existing frozen-input receipt and release publication gates
then verify the combined archive. Stable promotion still copies those verified
bytes without rebuilding.

## Cache boundaries

The frontend stage runs on the build platform. Dependency installation precedes
application source copies, so source edits do not reinstall unchanged npm
dependencies. The final image still receives only the validated web root.

The root Cargo workspace also contains the desktop shell. Release overlays
change its package version in `Cargo.lock` on every beta and nightly, even when
the server and all of its dependencies are unchanged. The `server-inputs` stage
uses Cargo to derive a server-only workspace and lockfile. It rejects dependency
versions, sources or checksums absent from the committed lockfile. Only the
derived manifests cross the compilation cache boundary; desktop release
metadata remains in the normal release inputs and image labels.

The target stage builds with `--locked`, the pinned Rust image, musl, LTO and the
existing release profile. Changes to server source, manifests, dependencies or
compiler still invalidate the relevant compilation inputs. This does not replace
a dependency update with an older cached binary.

## Measurements and validation

The completed September 19, 2026 builds on source
`5304dcb7e7b3435239129b4146b29570a2e938d4` demonstrate the old behavior:

- [Beta.25](https://github.com/open-ott-play/ottplay-foss/actions/runs/35418693050/job/105840118320):
  container job 65m13s, ARM64 Rust 61m45s, AMD64 Rust 12m56s.
- [Following nightly](https://github.com/open-ott-play/ottplay-foss/actions/runs/35435569854/job/105877986502):
  container job 62m26s, ARM64 Rust 59m33s, AMD64 Rust 12m53s.

Both rebuilt 195 crates per architecture after successfully importing the cache.
OCI archive export took less than one second. Parallel stage times overlap and
must not be added when estimating elapsed build time.

`Container validation` runs when a PR changes container build infrastructure and
can also be dispatched manually. Each native runner measures a cold build, an
unchanged build using exported cache in a fresh builder, and a next-beta build
with a frontend edit using the same restored cache. The warm cases must report
the actual Rust compilation vertex as cached. Synthetic versions are confined to
temporary diagnostic contexts; no tags, release counters or registry objects are
created.

The validation also starts the exact archived image as its nonroot user on a
loopback-only ephemeral port and checks HTTP health and frontend serving. A join
job validates the combined archive, attestations, version/revision labels and
cross-platform web parity. Reports and build logs are retained as workflow
artifacts. Compare measured cold and warm durations, not merely a successful
cache import or a green workflow.

References: [Docker multi-platform strategies](https://docs.docker.com/build/building/multi-platform/),
[cache invalidation](https://docs.docker.com/build/cache/invalidation/).

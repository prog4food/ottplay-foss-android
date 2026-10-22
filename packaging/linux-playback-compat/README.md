# App-private Noble playback compatibility build

This recipe builds only `libgstplayback.so` from Ubuntu's
`gst-plugins-base1.0` source version `1.24.2-1ubuntu0.5`, preserving all 15
distribution patches. It then applies GStreamer's
[stream-synchronizer flush fix](https://github.com/GStreamer/gstreamer/commit/03febb5048d0612157fad0ddadeaaeed924aadf0).
`upstream.patch` preserves the original change; `backport.patch` adjusts only
its indentation to the older Noble source. The exact before/after source
hashes, archives, patch series and original host plugin hashes are pinned in
`sources.json`.

The build does not install or overwrite any system library. It requires
Ubuntu 24.04 and the exact reviewed official `gstreamer1.0-plugins-base`
package bytes for the current architecture. A newer or locally modified
package fails closed and requires a reviewed source/pin update. This is a
small compatibility build, not a replacement distribution of GStreamer.

## Build and corresponding source

On a matching Ubuntu 24.04 amd64 or arm64 builder, install the normal native
build dependencies plus `python3`, `build-essential`, `dpkg-dev`, `meson`,
`ninja-build`, `pkg-config`, `patch`, `patchelf`, `binutils`,
`libgstreamer1.0-dev`, `libgstreamer-plugins-base1.0-dev`, and
`gstreamer1.0-tools`. Then run from the repository root:

```sh
python3 scripts/build-linux-playback-compat.py --output build/linux-playback-compat
```

The output directory must not already exist. The recipe enforces Debian's
`hardening=+all` flags, verifies immediate binding and RELRO, removes build
RPATHs, compares the original plugin's ABI/dependencies/glibc requirements,
and checks actual dynamic loading with `ldd -r` and `gst-inspect-1.0`.
It also compiles the pinned `regression.c` and runs its bounded
stream-start/flush/segment sequence against the newly built plugin. The
segment must complete and be accepted, without needing a cleanup flush.
Compiler file/debug prefix mappings keep the temporary build directory out
of the plugin's source paths.
`build-receipt.json` records source and binary identities, flags, the builder's
package inventory, ABI checks and source archive digest. These build checks
are not native playback acceptance.

Every full CI run builds and qualifies this exact recipe on the hosted
Ubuntu 24.04 AMD64 and ARM64 runners before the pull request can merge.
The existing documentation-only change scope skips the full CI workflow;
ordinary source changes and release validation require both native builds.
Their `ci-linux-playback-compat-*` artifacts preserve the receipts and logs
separately from the release package evidence. Neither build is a fuzz run.

Outputs are `private/gstreamer-1.0/libgstplayback.so`, deterministic
`runtime-manifest.json`, a full `appimage-plugins/` directory with exactly
the playback plugin replaced, and `corresponding-source.tar.xz`. The source
archive contains the original and Debian source archives, patch files,
license notices, this documentation, input manifest, regression source and
exact build script.
After extracting that archive, enter `linux-playback-compat/` and rebuild
without downloads using:

```sh
python3 scripts/build-linux-playback-compat.py --source-cache sources --output rebuilt
```

`COPYING` is the upstream LGPL license; `debian-copyright` preserves the
distribution's file-specific copyright and license notices. Modified source
is reproducible by applying the recorded Debian patch series and then
`backport.patch`; the recipe verifies the final source file digest. There is
no change to the surrounding application's license.

## Updates and retirement

Review this recipe whenever Ubuntu updates `gst-plugins-base1.0`, including
security updates. Recheck official source/package identities for both
architectures, retain distribution security fixes, build and compare the
ABI/hardening, and rerun actual native acceptance before updating pins.
Retire the compatibility replacement when the supported host package
includes the upstream fix. Do not weaken the exact host-byte check to retain
an old override on newer, unknown, or customized systems.

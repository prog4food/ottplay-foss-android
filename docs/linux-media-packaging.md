# Linux media packaging

The native Linux player uses WebKitGTK and GStreamer. Installing WebKitGTK alone
is insufficient: on Ubuntu, HLS and libav plugins are suggested dependencies,
so an otherwise successful installation can still report a missing
`application/x-hls` decoder. A playing indicator without decoded frames or an
advancing playback position is not a successful playback test.

## Package contents and installation

- **DEB:** declares the GStreamer base, good, bad and libav packages. Use
  `sudo apt install ./OttPlay.FOSS_*.deb` so APT resolves dependencies.
- **RPM:** declares the Fedora package names verified against Fedora 44 metadata,
  including libav for AAC and both the GStreamer OpenH264 plugin and the real
  `openh264` library for H.264. On Fedora, use
  `sudo dnf --enablerepo=fedora-cisco-openh264 install ./OttPlay.FOSS-*.rpm`.
  The plugin alone can resolve to Fedora's `noopenh264` placeholder, which cannot
  decode video. The configured distribution repositories must provide the real
  codec; this project does not automatically enable repositories or claim
  compatibility with every RPM distribution.
- **AppImage:** enables Tauri's `bundle.linux.appimage.bundleMediaFramework` so
  the GStreamer plugins and their dependencies are included. Installing codecs
  on a developer's computer does not repair an already published AppImage.

Use a supported distribution and its maintained packages. Do not copy isolated
GStreamer libraries from another distribution into a system installation. An
AppImage also retains the build system's C library compatibility requirements.

## Private compatibility fix for Ubuntu 24.04

Ubuntu's `gst-plugins-base1.0` version `1.24.2-1ubuntu0.5` lacks the upstream
stream-synchronizer fix for an early flush during stream startup. That race can
leave HLS playback seeking indefinitely even after audio and video data arrive.
The Linux build preserves all 15 distribution patches and adds the narrow
[upstream correction](https://github.com/GStreamer/gstreamer/commit/03febb5048d0612157fad0ddadeaaeed924aadf0)
to an app-private `libgstplayback.so`. It does not install over system libraries.
The source, original patch, adapted patch and LGPL notices travel with the DEB
and AppImage under `/usr/share/doc/ottplay-foss/linux-playback-compat/` (inside
the mounted AppImage for that format). See the
[rebuild recipe and pinned inputs](../packaging/linux-playback-compat/README.md).

For a DEB installation, the native launcher selects this plugin before starting
Tauri only when the OS is Ubuntu 24.04, the architecture and official installed
playback-plugin digest match the reviewed inputs, and the private files match
the manifest digest compiled into the executable. Package paths must be owned
by root and protected against group or other writes; symlinks are rejected.
The GStreamer registry uses a separate private user cache keyed by the plugin
digest, so a previously cached system plugin cannot hide the replacement.

Custom GStreamer paths, explicit loader paths, user-installed GStreamer plugins,
unknown or newer host plugins, and untrusted package/cache paths skip the
replacement with a diagnostic on stderr. Those systems continue to use their
configured runtime; skipping is not a claim that an old custom runtime contains
the fix. Keep distribution security updates enabled. A changed Ubuntu package
must receive a fresh source and compatibility review before it is added to the
allowlist. The normal RPM path uses its maintained distribution runtime.

AppImages use the standard Tauri GStreamer launcher with a complete staged
plugin set containing the rebuilt playback plugin. They do not activate the
DEB host override. The package verifier checks the extracted plugin's code and
static data against the build output, validates its ABI and hardening, records
the final hash, and permits only the expected AppImage-relative search path.
The final package digest, embedded corresponding source and private manifest
are checked independently from the original build receipt. The platform's
published `release-inputs-desktop-*.json` retains these results in its
`linux_playback_compat` section, including the runtime manifest, source build
receipt and final DEB/AppImage identities. The release manifest hashes that
entire receipt, so the proof remains available with the release after temporary
CI artifacts expire. This section records build verification, not playback
acceptance.

The recipe runs with Debian hardening flags and verifies RELRO, immediate
binding, exported ABI, shared-library dependencies and glibc requirements. It
rejects unexpected source archives, distribution patch changes, unknown host
plugin bytes and host-package changes during the build. These are build checks;
actual candidate playback, startup, seeking and EOF still require the separate
native acceptance below on every qualified package/runtime. A source-level
regression or patched diagnostic fixture alone does not qualify a release.

## Build and release checks

Native Linux packages use the fixed Ubuntu 24.04 build baseline on both x86_64
and ARM64. The separate Linux WebKit browser checks use Ubuntu 26.04. Moving a
browser check to a newer runtime must not silently raise the native packages'
glibc requirement through a moving `ubuntu-latest` build label.

`scripts/ci-tauri-linux-deps.sh` explicitly installs the media plugin sets.
`scripts/check-linux-media-codecs.sh` verifies plugin discovery and decodes both
the H.264 video and AAC audio streams from the checked-in MPEG-TS fixture to EOS,
requiring decoded buffers from both streams.
It runs before the desktop build, with a bounded timeout and no network source.
A missing parser, decoder or HLS plugin fails the build.

This preflight proves codec availability and fixture decoding in the build
image. It does not prove that a packaged player can play, seek, advance episodes
or reload correctly. Before stable publication, exercise those operations in
the actual release candidate on each qualified native runtime. Preserve the
package checksum, runtime package versions, decoded-frame/playback evidence and
any failures. Package metadata verification does not qualify a native Fedora
release; that still requires the actual RPM playback test. Keep native package
acceptance separate from Playwright browser qualification and from the public
RC fuzzing result.

Exercise the default HLS path and the hls.js fMP4/MSE path separately. Record the
engine actually used, decoded frames, natural end, second-film playback and
playback after reload. A saved hls.js preference is insufficient if the player
falls back to native HLS. Record the loaded build identity and media libraries:
an AppImage can retain its bundled WebKit/GStreamer even on a newer host system.

The Linux WebKit regression investigation retains failed stock and partially
patched runtime results. Adding missing codecs does not by itself resolve the
separate WebKit playback failures observed in browser qualification or qualify a
previously failed release candidate.

## References

- [Tauri AppImage media framework option](https://v2.tauri.app/distribute/appimage/)
- [Tauri Linux package configuration](https://v2.tauri.app/reference/config/)
- [GStreamer Linux installation guidance](https://gstreamer.freedesktop.org/documentation/installing/on-linux.html)
- [Fedora 44 libav package and AAC decoder provides](https://packages.fedoraproject.org/pkgs/gstreamer1-plugin-libav/gstreamer1-plugin-libav/fedora-44-updates.html)
- [Fedora 44 OpenH264 package and H.264 decoder provides](https://packages.fedoraproject.org/pkgs/gstreamer1-plugins-bad-free/gstreamer1-plugin-openh264/fedora-44-updates.html)
- [Fedora's non-decoding OpenH264 placeholder](https://packages.fedoraproject.org/pkgs/noopenh264/noopenh264/)
- [Fedora-Cisco OpenH264 repository](https://codecs.fedoraproject.org/openh264/44/)
- [RC fuzzing and evidence requirements](../FUZZING.md)

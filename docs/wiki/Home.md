# OTT-play documentation wiki

[Русский](Home.ru.md) · [README](../../README.md) · [All interface languages](../readme/README.md)

This is the versioned documentation home in the source repository. GitHub can
render these Markdown pages directly; maintaining them here keeps the instructions,
diagrams and tests in the same review as the code. The separate [GitHub Wiki](https://github.com/open-ott-play/ottplay-foss/wiki)
is exported from these sources and identifies its source revision on each page.
See the [publishing instructions](../wiki-publishing.md).

## Start and install

- [English practical guide](../../README.md) and [Russian practical guide](../../README.ru.md).
- [Localized quick starts for all 88 interface languages](../readme/README.md).
  These reuse translated UI captions and navigation steps. They are not 88
  translated engineering manuals; detailed guides are maintained in EN/RU.
- [Android Full/API 22 packages and updates](../android-distributions.md),
  [Android build](../../android/README.md) and [Capacitor iOS/Android](../capacitor-mobile.md).
- [Desktop delivery on macOS](../macos-local-delivery.md),
  [Tauri signing/updater](../tauri-updater-notarize.md) and
  [local HTTP instances](../local-http-deployment.md).

## Process and results

- [Browser qualification and candidate verification](../browser-compatibility.md)
  ([Русский](../browser-compatibility.ru.md)): configured targets, colorful diagrams,
  exact-package checks and the separate local results.

- [Implementation report and colored diagrams](../implementation-report.md)
  ([Русский](../implementation-report.ru.md)): reviewed changes, fixed regressions,
  measured output and remaining release gates.

## Use the new capabilities

- [Feature delivery and platform boundaries](../roadmap-delivery.md)
  ([Русский](../roadmap-delivery.ru.md)).
- [Quality ceilings, explicit live backups and bounded recovery](../playback-stream-policy.md)
  ([Русский](../playback-stream-policy.ru.md)).
- [Manual XMLTV binding and classic accessibility](../guide-binding-accessibility.md)
  ([Русский](../guide-binding-accessibility.ru.md)).
- [Hosted picture-and-sound check](../audio-video-check.md)
  ([Русский](../audio-video-check.ru.md)): **Information → Audio → Play**,
  expected tones, hosting diagram and return to live TV. The clip is fetched
  on demand, requires internet and is absent from player packages.
  The separate online moving-pattern demo is silent.
- [Xtream movie/series library](../xtream-media.md) ([Русский](../xtream-media.ru.md)).
- [Same-source player handoff](../remote-handoff.md) ([Русский](../remote-handoff.ru.md)).
- [Local settings journal and recovery](../settings-recovery.md) ([Русский](../settings-recovery.ru.md)).
- [Reliable control, resumable profiles and handoff](https://github.com/open-ott-play/ottplay-control-server/blob/9b28c08eefca3948c78336e7e16a45e6fc492e31/docs/reliable-control.md)
  ([Русский](https://github.com/open-ott-play/ottplay-control-server/blob/9b28c08eefca3948c78336e7e16a45e6fc492e31/docs/reliable-control.ru.md)).
  Requires a matching controller/CLI revision and configured permissions.
- [Semantic audio/subtitle preferences in native Android](https://github.com/open-ott-play/ottplay-android/blob/be0d8008c75b0badede7022dbb9096e11914227f/docs/TRACK-PREFERENCES.md)
  ([Русский](https://github.com/open-ott-play/ottplay-android/blob/be0d8008c75b0badede7022dbb9096e11914227f/docs/TRACK-PREFERENCES.ru.md)).
  The native Kotlin application is separate from this repository's Capacitor APKs.

## Configure sources and inspect problems

- [Plex sign-in and playback](../plex-provider.md), [server-side media library](../synology-library.md),
  [guide architecture](../guide-architecture.md) and [hosted EPG diagnostics](../hosted-epg-diagnostics.md).
- [Interface settings](../interface-settings.md), [design history and credits](../interface-history.md)
  and [language catalogs/keyboards](../localization.md).
- [Remote workbench](../remote-workbench.md), [runtime diagnostics](../runtime-debug.md)
  and [diagnostic consent, redaction and retention](../diagnostic-security.md).
- [Native device checklist](../mode-b-device-smoke.md), [Tauri device checklist](../mode-b-tauri-smoke.md)
  and [browser window controls](../browser-window-controls.md).

- [Measured feature cost](../roadmap-size.md), raw evidence and SVG chart.

## Develop and release

- [Architecture and ownership](../architecture.md), [playback sessions](../playback-session-architecture.md)
  and [classic ES5 build](../build-pipeline.md).
- [Runtime asset names](../asset-layout.md), [release policy](../../RELEASING.md),
  [release operator runbook](../release-workflow.md) and [RC fuzzing](../../FUZZING.md).
- [Privacy policy](../privacy-policy.md) and [MIT license](../../LICENSE).

For documentation changes, run `npm run docs:generate` when a UI caption or
quick-start template changes, then `npm run check:docs`. Keep EN/RU guides paired,
keep capability restrictions next to claims, and distinguish local validation
from physical device testing. Diagrams are reviewable repository assets; see
[the guide binding SVG](../images/guide-binding.svg) and the diagrams linked from
the feature guides. The checker validates relative file destinations, not remote
website uptime or every Markdown heading anchor.

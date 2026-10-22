> **Archived Capacitor Android reference.** This document describes the retired wrapper before extraction. Its Android build/signing commands no longer run in this repository. Native Android development is in [ottplay-android](https://github.com/open-ott-play/ottplay-android), currently a private preview requiring repository access. These notes do not describe that application.

# Google Play submission preparation

**Draft, reviewed 2026-09-12.** Package: `play.ott.foss.play`; proposed display name:
**OTT-play FOSS**. These materials are ready for publisher review, not submitted
Console declarations. No Play Console state, store listing or rights documents
have been independently inspected. Use the version, versionCode, SHA256 and upload
certificate from the final signed AAB verification report; do not infer them from
its filename. This submission targets Android phones and tablets; it does not
claim Android TV qualification.

## Proposed listing copy

**Short description:** Play your own streams and playlists, with a guide and a synthetic video demo.

**Full description:**

OTT-play FOSS is a media player for streams and playlists you are authorized to
use. Add your own M3U playlist or compatible Xtream or Stalker service details.
Browse channels, keep favorites and load a program guide from your chosen source.

Try the original moving test pattern to explore playback without a subscription
or account. The demo is streamed over HTTPS and requires an internet connection.
It is a silent synthetic video, not a television channel.

The app includes no subscription, commercial channel catalog or provider
activation service. Playback depends on your source and device capabilities.
Provider credentials and preferences are kept on your device and sent to your
chosen provider when required to use that service. There are no in-app ads.

**Listing inputs still required:** publisher/legal identity and support contact
confirmation; category and intended audience; territory selection; completed
content-rating answers; final app icon and device screenshots; permission for
any third-party marks or content shown in those screenshots. Use the synthetic
demo for screenshots. Do not claim affiliation with providers or guaranteed
compatibility with every service.

## Reviewer access instructions (English)

1. Install the Play product, package `play.ott.foss.play`. On a fresh launch choose
   **Try demo**. No login, subscription, provider code or payment is required.
2. Choose **Demo — moving test pattern (MP4)** if a channel list is shown. A moving
   color pattern should play and repeat. It is intentionally silent. The hosted
   demo requires working HTTPS internet access. Keep its hosting available during
   review; do not supply personal provider credentials.
3. Open the channel list and Settings using the on-screen menu. Navigate by touch
   or directional keys/Enter where available; Back closes the current menu. The
   interface uses landscape orientation.
4. On the initial screen, **Privacy policy** opens the packaged text without a
   separate browser or network request. It is also available from the player menu.
5. **Manual setup** lists Demo, M3U, Xtream and Stalker. These optional sources
   require the user's own authorized endpoint and, where applicable, credentials.
   Demo permits basic review without them. Validate the exact supported provider
   workflows before advertising them as review-complete.
6. To repeat a fresh-install test, use Android Settings → Apps → OTT-play FOSS →
   Storage → Clear storage. This removes this app's local configuration, not
   records held by external providers.

Confirm the actual menu labels and these steps on the final signed build. Add
review-only test accounts through Console if a feature cannot be reviewed using
the demo; obtain authorization for the test service first. Do not commit account
credentials. [Google's access guidance](https://support.google.com/googleplay/android-developer/answer/15748846)
requires usable review access to restricted functionality.

## Data safety worksheet — facts and pending decisions

This worksheet is not a completed declaration. Under
[Google's Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469),
transmission off the device can count as collection even when a third party
receives it. Local-only processing is excluded. User-initiated transfers and
service-provider processing can affect the separate sharing answer. Ephemeral
processing still belongs in the form; confirm actual retention before selecting
it. The publisher must reconcile all active Play versions and SDK behavior.

- **Accounts:** the player creates no publisher-operated user account. A user can
  enter provider usernames/passwords, token-bearing URLs or a Stalker MAC-style
  identifier. These are sent to that configured service for authentication and
  playback. Draft types to assess: **User IDs**, **Device or other IDs**, and any
  additional information actually present in credentials or submitted URLs.
  Purpose: **App functionality**. Optional: users can use Demo without provider
  credentials. A user-entered MAC is not necessarily the device's hardware MAC.
- **Playback requests:** the chosen service sees requested channels/files,
  timestamps, source IP and normal connection headers. Determine whether the
  publisher's hosts or SDKs retain app interactions, diagnostics or identifiers.
  Do not label every IP connection as location collection: record whether a
  recipient actually derives location from it.
- **Demo hosting:** HTTPS requests go to here.now. The demo adapter adds no player
  device ID or provider credentials. Publisher confirmation is needed for the
  hosting relationship, access-log fields, retention, geographic derivation,
  secondary use and deletion handling. Until confirmed, do not mark hosting data
  as ephemeral or assert that nothing is collected/shared.
- **Preferences/favorites/caches:** stored locally. Android backup and device
  transfer exclusions cover app-private root, files, databases, preferences and
  external-app data, including WebView credentials/cookies; verify the merged manifest
  and XML rules of the final release. Local-only data does not by itself require
  a collection declaration. User-initiated exports, if enabled in a distribution,
  must be assessed separately.
- **Command integration:** the inbound HTTP command listener is off by default.
  An explicitly enabled listener requires authentication and uses loopback.
  Opt-in integration can process commands and a generated routing identifier;
  polling a user-configured endpoint sends requests to that endpoint. Do not
  describe the optional integration as a publisher-operated analytics service.
- **Tracking:** no advertising, analytics or crash-reporting SDK is deliberately
  configured in this client. There is no advertising-ID permission. Check the
  resolved native dependency inventory and a device network capture before the
  final answer; absence of an analytics SDK is not absence of network data.
- **Transport:** the Android Play product requires HTTPS for remote requests and
  reports an error for HTTP-only sources. Full has a different HTTP policy.
  Confirm redirects and media segment, image, XMLTV and portal requests on the
  final Play artifact before selecting the encrypted-in-transit answer. The
  hosting and deletion answers still require publisher confirmation.
- **Deletion:** Clear storage removes local data. Provider and hosting records
  require their own deletion/retention process. The existing privacy contact must
  be monitored. Confirm what the publisher can actually delete before promising
  deletion of off-device data.

Provisional collection answer: **do not submit “No data collected” without
resolving the above flows**. Sharing, exact data types, retention and deletion
answers remain publisher inputs. Do not claim a Google-authorized independent
security assessment on the basis of repository tests.

## Foreground service declaration draft

The merged Android manifest declares **mediaPlayback**, with
`FOREGROUND_SERVICE_MEDIA_PLAYBACK`. It declares no location, microphone,
camera, media-projection or full-screen-intent permission for this feature.
The service is not exported and does not restart itself after termination. Verify the final compiled manifest, service lifecycle
and notification on a device before copying this draft into Console.

**Purpose:** Continue the user's selected audio/video playback while the app is
in the background or displaying picture-in-picture, and provide media controls
in Android's media notification/session.

**User initiation and control:** The user starts a selected stream. Android media
controls provide play/pause and Stop; Stop ends playback and removes the service's
foreground notification. Pausing can retain the existing media session. Exit
and destruction of its owning activity stop the session. No foreground task is
needed merely to read settings.

**Impact of deferral or interruption:** Playback would fail to start promptly or
would pause unexpectedly when the user switches applications. A scheduled job
cannot deliver continuous, immediately requested playback.

**Video evidence to record:** start from a cold launch; choose Demo or an authorized
test stream; show playback; press Home; show the ongoing media notification or PiP;
return to the app; pause/resume; press Stop; show that playback and the foreground
notification end. Record notification visibility under the device's media/notification settings;
the app does not request `POST_NOTIFICATIONS`. The silent demo alone cannot prove background audio;
use an authorized audible test source if claiming that behavior.

**Pending:** actual device recording and an accessible reviewer video URL. Do not
invent a URL or claim a recording exists. Google's
[foreground-service instructions](https://support.google.com/googleplay/android-developer/answer/13392821)
request the use case, interruption impact and a video showing how the feature is
started. The declaration is subject to review.

## Release checklist and unresolved inputs

- [ ] Resolve the scoped original-core permission evidence in
  [the inherited component notices](../legacy-provenance.md); preserve applicable attribution.
- [ ] Build and verify the signed Play AAB, including package identity, release
  debug flag, permissions, backup rules, runtime hashes and required licenses.
- [x] Publish the reviewed [privacy policy](../privacy-policy.md) to `main`.
  The [public GitHub page](https://github.com/open-ott-play/ottplay-foss/blob/main/docs/privacy-policy.md)
  is published by the `main` update itself; no separate website deployment is
  needed. Anonymous GitHub content retrieval confirmed the reviewed text after
  commit `50434fda30631b0650c0ee0b121bed066bae1cc5` was published.
- [ ] Compare the packaged policy in the final signed Play AAB with that public
  text. Earlier test packages do not establish this check for a later revision.
- [ ] Confirm publisher identity, privacy contact, here.now data handling and the
  final Data safety answers. Keep evidence for those answers.
- [ ] Confirm the Console app record, upload certificate and Play App Signing
  enrollment. No Console state is inferred from CI secret availability.
- [ ] Validate real-device first run, Back/touch navigation, MP4/HLS, configured
  providers, resume, PiP, background playback, notifications and Stop. Tests and
  emulator builds do not establish every physical-device behavior.
- [ ] Record the foreground-service demonstration and complete its declaration.
- [ ] Complete content rating, audience, ads, listing screenshots and any testing
  eligibility requirements shown in the publisher's actual Console account.
- [ ] Check the final reviewer instructions and demo availability from a fresh
  install without private network access or existing player settings.

No publishing, Console edits, external author messages or grant requests are
performed by this document.

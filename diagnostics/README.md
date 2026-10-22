# A/V diagnostic fixture v1

User instructions: [English](../docs/audio-video-check.md) ·
[Русский](../docs/audio-video-check.ru.md).

In the player, choose **Information → Audio → Play**. With the Russian interface,
choose **Информация → Звук → Воспроизвести**. The check is explicit: opening the
menu or starting the player does not preload this file.

## Hosted file and repository source

The runtime URL is
[`https://mantra-basin-76mq.here.now/diagnostics/av-v1.mp4`](https://mantra-basin-76mq.here.now/diagnostics/av-v1.mp4).
The player needs internet access and HTTPS connectivity to this host. It has no
bundled offline fallback or alternate diagnostic URL. Web, OTTPlay Server, Tauri,
Capacitor and container packages do not include the clip.

[`av-v1.mp4`](av-v1.mp4) remains in this repository as the source fixture for
verification and deliberate developer tests. Its presence here does not make
it available offline through the installed player's menu. Opening the hosted
file directly tests that browser's playback, not the player's restoration logic.

Published v1 identity:

- Size: **464,652 bytes**.
- SHA-256: `866c273d576d3db09a0e62596f011793d66f6fbb54db727ff2045e5d744105bb`.
- Eight seconds, 640×360 / 25 fps, H.264 baseline, yuv420p; AAC stereo at 48 kHz.
- The hosted file matches the repository bytes and supports HTTPS, CORS and
  HTTP Range requests. Hosting availability is a network dependency, not a
  property established by the local verifier.

This is original synthetic media under the repository's [MIT license](../LICENSE).
Unlike the silent onboarding moving-pattern demo, it contains audible stereo.
See the [hosting privacy details](../docs/privacy-policy.md#optional-hosted-audio-video-check).

## Expected picture and sound

The background is a moving test pattern. White markers in its upper left/right
halves accompany approximately 150 ms pulses at the start of each second:

- **0–2 seconds:** left channel, 440 Hz; left marker.
- **2–4 seconds:** right channel, 880 Hz; right marker.
- **4–6 seconds:** both channels and both markers.
- **6–8 seconds:** moving pattern only, intentionally silent.

The pulses are quiet (approximately −26 dBFS peak). Start with a comfortable
television/speaker volume. The player uses its current volume and temporarily
unmutes the video; it does not raise system volume. A mono output may reproduce
both channel phases from one speaker.

This is a manual check of one known H.264/AAC MP4. Automated decoding does not
prove physical picture or sound, speaker routing, A/V latency, or compatibility
with a provider's HLS/DASH/DRM stream. Observe the actual device separately.

## Runtime lifecycle

The managed core HTML5 playback path borrows the main decoder only while idle
or on an already playing/paused live channel. It rejects VOD/archive, loading
live requests and standby. Any device engine override also makes the check
unavailable, including PC2/Video.js and native engines; an HTML5 video element
alone is not enough. It ends naturally, on explicit
**Audio → Stop**, on media error, or at a **15-second deadline including loading**.
It attempts to return to the still-current captured live request at the live
edge with the saved pause state. Ordinary playback Stop, standby, replacement
playback or a changed source prevent that return. There is no automatic local
media fallback. The [user guide](../docs/audio-video-check.md#how-playback-returns)
describes mute, cleanup and troubleshooting in detail.

## Verification and regeneration

From the repository root, verify the checked-in bytes with:

```sh
python3 scripts/check-av-diagnostic.py diagnostics/av-v1.mp4
```

The verifier uses FFmpeg/FFprobe to inspect the streams and decode the encoded
audio. It checks dimensions, duration, stereo routing, audible energy, intended
silence and peak amplitude; it prints the file size and SHA-256. FFmpeg/FFprobe
are developer verification dependencies, not playback requirements.

To inspect regenerated output without overwriting published v1:

```sh
bash scripts/generate-av-diagnostic.sh /tmp/ottplay-av-review.mp4
python3 scripts/check-av-diagnostic.py /tmp/ottplay-av-review.mp4
```

The generator also runs the verifier. Different encoder versions/settings can
produce different bytes. Keep the published v1 URL and bytes stable: for changed
content, use a new versioned filename and deliberately update the player URL
and documented identity after verification. Regeneration does not publish files.

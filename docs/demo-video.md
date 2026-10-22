# Demo recordings with video-use

The optional local editing integration uses the pinned helpers from
[browser-use/video-use](https://github.com/browser-use/video-use/tree/9575612f066aa517354790a645fd90f9f95a743b).
Install the tool separately as described below before running the wrapper.
The player runtime and published player bundle do not include this editing tool.

## Record and render the real interface

The automated scenario opens first-run setup, selects **Try demo**, plays the
HLS channel, opens the channel list and returns to playback. It waits for decoded
video frames, so an empty player cannot count as a successful recording. The demo
provider has no programme guide data; this recording does not demonstrate EPG.

HTTP requests are fulfilled from the local build and the checked-in synthetic
HLS fixture. All other requests and all WebSockets are blocked. No public media
server, account, provider URL or existing browser profile is used.

From the repository root:

```sh
npm ci
npx playwright install chromium
npm run build
node scripts/record-demo.cjs --output .local-artifacts/demo-video/walkthrough
python3 scripts/demo_video.py doctor
python3 scripts/demo_video.py prepare .local-artifacts/demo-video/walkthrough/screen.webm
# The initial edit/edl.json preserves the whole recording without cuts.
python3 scripts/demo_video.py render .local-artifacts/demo-video/walkthrough/edit/edl.json
python3 scripts/demo_video.py render .local-artifacts/demo-video/walkthrough/edit/edl.json --final
```

Choose a new output directory for every run; the recorder refuses to overwrite
an existing directory. Omitting `--output` creates a timestamped directory under
`.local-artifacts/demo-video/`. This directory is ignored by Git. The recorder
requires the repository's Playwright development dependency and its Chromium
browser. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` optionally selects a local Chromium.

Each successful run produces a silent 1280×720 `screen.webm`, checkpoint PNGs and
`recording.json` with the scenario, isolation settings and approximate checkpoint
times. UI assertions or browser script errors fail the command. A failed run can
leave partial footage for debugging and must not be treated as a completed demo.
The continuous recording includes short pauses for reading each screen.

Preparation creates a full-length cut list and session notes without modifying
the source. All outputs remain in the source folder's `edit/` directory. Existing
outputs require `--overwrite`; preparation never replaces an existing session.
Rendering is local. Silent recordings skip audio loudness normalization. Nothing
is published or added to a release automatically. For further editing, review the
cut list and verify the rendered footage before sharing.

Speech transcription is optional and needs `ELEVENLABS_API_KEY` in the environment
or the skill's private `.env` file. It sends audio to ElevenLabs and can incur
provider charges. Local cuts and rendering work without this key. Do not paste
keys into tracked project files. The wrapper never initiates transcription.

## Reproduce the installation

The wrapper reads `VIDEO_USE_HOME`, defaulting to `~/.codex/skills/video-use`;
it does not install the tool. Clone the upstream repository into a dedicated
directory, check out commit
`9575612f066aa517354790a645fd90f9f95a743b`, install its Python dependencies with
`uv sync --python 3.12`, and install FFmpeg. Write that commit ID to
`UPSTREAM_REVISION` inside the checkout and set `VIDEO_USE_HOME` to its path.
Keep `helpers/` in that checkout. Registering `SKILL.md` with an agent is optional
and is not required by `scripts/demo_video.py`. Do not silently update the pinned
revision; review helper changes first.

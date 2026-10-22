# Synthetic media runtime fixture

`segment00.ts` is the first two-second segment of the original synthetic HLS
fixture in `open-ott-play/ottplay-android`, copied from
`app/src/androidTest/assets/playback/hls/segment00.ts`. It contains generated
colour-pattern H.264 baseline video (640 x 360, 25 fps) and silent AAC audio.
The source project licenses it under MIT; its license is included here.
There is no external provider, commercial stream, encryption, or DRM dependency.

The local one-segment VOD playlist is sufficient to test real TS-to-fMP4
transmuxing and browser MSE playback. Tests read only these checked-in files;
they do not require an Android checkout, FFmpeg, or network access.

The source fixture was generated from the Android project's original
`app/src/main/res/raw/demo.mp4` with:

```sh
ffmpeg -hide_banner -loglevel error -y -i app/src/main/res/raw/demo.mp4 \
  -map 0:v:0 -map 0:a:0 -map_metadata -1 -fflags +bitexact \
  -flags:v +bitexact -flags:a +bitexact -c:v libx264 -profile:v baseline \
  -preset veryfast -b:v 450k -maxrate 450k -bufsize 900k -pix_fmt yuv420p \
  -g 50 -keyint_min 50 -sc_threshold 0 -c:a aac -b:a 48k -ac 2 -ar 48000 \
  -hls_time 2 -hls_playlist_type vod \
  -hls_segment_filename segment%02d.ts -f hls index.m3u8
```

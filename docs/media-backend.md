# Device and media backend ownership

`src/device/media-backend.ts` owns one decoder lease per lane. Main playback
and PiP have independent lifetimes. A lease owns its event listeners, transport
controls, track selection and position sampling. Replacement retires the old
lease before installing the next one; late decoder events cannot update its
replacement. Snapshot reads do not sample a decoder or change playback state.

The core engine port retains the existing HLS, Shaka, native HLS and direct-video
implementations and their device workarounds. `stbPlay`, `stbPause`,
`stbContinue`, `stbStop` and `stbSetPosTime` remain the public device boundary.
The application binds native effects explicitly instead of replacing these
functions with chains of Tauri/Capacitor wrappers. OS media metadata subscribes
to backend events; it does not own playback commands or a decoder.

Backend ownership follows the source, stable playback target and generation.
User group order and renderer array identity are not decoder identity. The
classic playback adapter therefore exposes separate guards for temporary UI
callbacks and the decoder. Replacing a source revokes both. Republishing a
channel-library view revokes its old UI callbacks while the same channel keeps
playing.

A captured handle cannot adopt another request by seeking. The explicit
backend seek port may rebind an existing archive decoder to a new generation
only while its original source and target remain current and its playback kind
matches. This preserves file-relative archive seeking without authorizing a
departed source to seek the next source's decoder.

`src/device/adapter.ts` supplies device capabilities, key translation and the
explicit input boundary for retained STB scripts. Their public globals remain
supported. The adapter owns the retained-device clock and accepts explicit
position changes before adding elapsed playback time. The UI timer renders
position; it does not advance it. Native PiP ports own asynchronous window/plugin
startup, cancellation, fallback and teardown independently from main playback.

All four device modules compile into private ES5 scopes in the classic bundle.
The compiler, optimizer, shipped-script grammar gate and legacy API bootstrap
remain unchanged. See [Legacy engine compatibility](es5-compatibility.md).

Verification includes lease disposal/reentry, late native PiP events, OS
pause/resume, source replacement before the next playback command, group
reorder during archive playback, controlled archive seeking and retained-device
clock corrections. Full/Play artifact and browser suites exercise the actual
compiled entrypoints. These checks do not substitute for playback on physical
legacy TV/STB firmware.

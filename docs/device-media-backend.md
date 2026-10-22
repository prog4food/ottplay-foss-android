# Device and decoder ownership

The browser/Tauri/Capacitor transport now enters `__ottMediaBackend` through
`stbPlay`, `stbPause`, `stbContinue`, `stbStop` and the PiP entrypoints. Each
main or PiP request receives one handle and one engine lease. Replacement
releases listeners, position sampling and its decoder; late observations and
track-picker callbacks cannot operate on a replacement request. HLS, Shaka and
HTML media remain engine ports. Shaka teardown must complete before the next
request attaches its observation listeners.

`__ottOsMediaSession` subscribes to these lifecycle events. It owns delayed
metadata refresh and the seekable-position timer, including pause/playing events
originating from native controls. Native startup no longer replaces transport
functions to insert metadata behavior. `__ottCoreTransport.configure` supplies
native standby, volume, fullscreen and PiP effects explicitly. `__ottNativePip`
owns asynchronous platform request IDs, serialized iOS operations and guarded
CSS fallback; main and PiP lifetimes are separate.

Native media-session timer ports call the corresponding `window` methods through
wrappers. Passing browser timer functions directly as port methods changes their
receiver and throws in WKWebView. During startup that error can trigger the
first-channel fallback after the saved channel was correctly restored. The native
session regression tests enforce the Window receiver for all four timer methods
in both Tauri and Capacitor wiring.

Playback snapshots are pure reads. Managed decoders publish measured media
position through semantic playback commands. Archive position uses an origin
calibrated to the decoder time, so buffering and idle timers cannot advance it.
The UI clock only renders the resulting projection. `importLegacy` is an
explicit ingress at classic transport and selection boundaries, rather than a
side effect of reading state.

`__ottDeviceAdapter` provides the selected device route, capabilities and a copy
of its key map. Hardware key values and retained STB function names are
unchanged. Retained TV/STB scripts still own their device-specific engines; an
explicit compatibility sampler imports their state and uses elapsed time for
archive clocks when no managed decoder is available. This does not claim those
hardware adapters or every classic UI function have been rewritten.

All four new private modules compile into the ES5 classic artifact. They add no
required `fetch`, `AbortController`, `Proxy`, `WeakRef` or native-class dependency.
Native PiP uses the existing Promise runtime. Tests cover compiled factory
lifetimes, actual native configuration and engine entrypoints, full-bundle API
registration, browser media pipelines and retained device ABI. Physical TV/STB
hardware validation remains separate from those automated checks.

// Use the same IPC bridge as the packaged player. No screenshot API is mocked.
window.runScreenshotSmokeInvoke = async function (event, label, command) {
    var reply;
    try {
        reply = {
            ok: true,
            value: await window.__TAURI__.core.invoke(command, {}),
        };
    } catch (error) {
        reply = { ok: false, error: String(error) };
    }
    // Existing production core event permissions let main and pip report their
    // results; the fixture adds no command permissions of its own.
    await window.__TAURI__.event.emitTo(label, event, reply);
};

// Serialized into the browser by Playwright. Read the actual candidate's Hls
// default, then follow the pinned instance backend order (not Hls.isSupported,
// whose standalone helper prefers ManagedMediaSource by default).
function readBrowserMediaCapabilities() {
    if (window.Hls?.DefaultConfig.preferManagedMediaSource !== false) {
        throw new Error(
            "HLS backend preference changed; review the capability probe"
        );
    }
    const mse =
        window.MediaSource ||
        window.ManagedMediaSource ||
        window.WebKitMediaSource;
    return {
        aacMse: !!mse?.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'),
        h264Mse: !!mse?.isTypeSupported('video/mp4; codecs="avc1.42c01e"'),
        hlsVersion: window.Hls.version,
        managedMediaSource: typeof window.ManagedMediaSource === "function",
        mediaSource: typeof window.MediaSource === "function",
        mseBackend: !mse
            ? "none"
            : mse === window.MediaSource
              ? "MediaSource"
              : mse === window.ManagedMediaSource
                ? "ManagedMediaSource"
                : "WebKitMediaSource",
        nativeHls: document
            .createElement("video")
            .canPlayType("application/vnd.apple.mpegurl"),
        webkitMediaSource: typeof window.WebKitMediaSource === "function",
    };
}
module.exports = { readBrowserMediaCapabilities };

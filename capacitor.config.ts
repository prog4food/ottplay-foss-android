import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    android: {
        allowMixedContent: true,
        backgroundAudio: true,
    },
    appId: "play.ott.foss",
    appName: "OTT-play FOSS",
    ios: {
        backgroundAudio: true,
        contentInset: "automatic",
    },
    // Bridge debug logs include native call options/results (SWOP drafts/tokens).
    loggingBehavior: "none",
    plugins: {
        MobileCommandQueue: {
            // Internal queue only by default; HTTP requires explicit opt-in and a token.
        },
    },
    server: {
        hostname: "localhost",
    },
    webDir: "dist-mobile",
};

export default config;

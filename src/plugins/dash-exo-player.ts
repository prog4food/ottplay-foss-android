/**
 * DashExoPlayer — explicit native DASH/HLS bridge, outside normal OTT playback.
 *
 * Android: Media3/ExoPlayer with PlayerView overlay.
 * iOS: honest {ok:false, unsupported:true} (WKWebView has no MSE; no AVPlayer DASH).
 * WebPlugin fallback for non-Cap builds only.
 * The main player never selects this plugin automatically: the native overlay
 * does not implement the complete TS player state, controls and layout contract.
 */

import { resolveNativePlugin } from "./native-bridge";
import { nativeWebFallback, nativeWebUnsupported } from "./web-fallback";

export interface DashPlaybackState {
    duration: number;
    ended: boolean;
    error?: string;
    ok: boolean;
    playing: boolean;
    position: number;
    unsupported?: boolean;
}

export interface DashExoPlayerPlugin {
    getPlaybackState(): Promise<DashPlaybackState>;
    isDashSupported(): Promise<{ ok: boolean; unsupported?: boolean }>;
    pauseDash(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }>;
    playDash(opts: {
        url: string;
        position?: number;
    }): Promise<{ ok: boolean; unsupported?: boolean; error?: string }>;
    resumeDash(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }>;
    seekDash(opts: {
        position: number;
    }): Promise<{ ok: boolean; unsupported?: boolean; error?: string }>;
    stopDash(): Promise<{ ok: boolean; unsupported?: boolean; error?: string }>;
}

class DashExoPlayerWeb implements DashExoPlayerPlugin {
    getPlaybackState(): Promise<DashPlaybackState> {
        return nativeWebFallback(function () {
            return {
                duration: 0,
                ended: false,
                ok: false,
                playing: false,
                position: 0,
                unsupported: true,
            };
        });
    }

    seekDash(_opts: {
        position: number;
    }): Promise<{ ok: boolean; unsupported?: boolean }> {
        return nativeWebFallback(function () {
            return { ok: false, unsupported: true };
        });
    }

    isDashSupported(): Promise<{ ok: boolean; unsupported?: boolean }> {
        return nativeWebUnsupported("DashExoPlayer", "isDashSupported");
    }

    playDash(_opts: {
        url: string;
        position?: number;
    }): Promise<{ ok: boolean; unsupported?: boolean; error?: string }> {
        return nativeWebUnsupported("DashExoPlayer", "playDash");
    }

    pauseDash(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }> {
        return nativeWebUnsupported("DashExoPlayer", "pauseDash");
    }

    resumeDash(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }> {
        return nativeWebUnsupported("DashExoPlayer", "resumeDash");
    }

    stopDash(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }> {
        return nativeWebUnsupported("DashExoPlayer", "stopDash");
    }
}

export const DashExoPlayer = resolveNativePlugin<DashExoPlayerPlugin>(
    "DashExoPlayer",
    () => new DashExoPlayerWeb()
);

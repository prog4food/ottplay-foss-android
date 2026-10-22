/**
 * MobileNativeMedia — Capacitor 4.4 native media + 4.5 background audio bridges.
 *
 * Real native calls; WebPlugin fallback no-ops with console.warn.
 * Gate on `window.Capacitor` in src/index.ts so Mode A / Tauri stay untouched.
 * Inlined under src/ so tsc rootDir is satisfied.
 */

import { resolveNativePlugin } from "./native-bridge";
import { nativeWebFallback, nativeWebUnsupported } from "./web-fallback";

/** Metadata pushed into OS Now Playing / MediaSession (Mode B Cap only). */
export interface BackgroundAudioMeta {
    artist?: string;
    /** Optional channel logo / artwork URL (http/https or data:). Fetched when possible. */
    artworkUrl?: string;
    /** Duration in seconds when known (VOD/archive). Omit / non-finite for live. */
    durationSec?: number;
    /** Position in seconds when known. */
    positionSec?: number;
    /** When false/omitted, OS seek controls are disabled / no-op (live IPTV). */
    seekable?: boolean;
    title?: string;
}

export interface MobileNativeMediaPlugin {
    /** Release sleep prevention → device may idle/sleep. */
    allowSleep(): Promise<{ ok: boolean; unsupported?: boolean }>;
    /** Android only: minimize the current Activity into OS PiP, without changing its stream. */
    enterSystemPip(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }>;
    /** Finish the native Activity / leave the Cap app. */
    exitApp(): Promise<{ ok: boolean; unsupported?: boolean; error?: string }>;
    /** OS output volume 0–100. Fails loudly when platform cannot report. */
    getVolume(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        volume: number;
    }>;
    /** Pause background audio session / MediaSession (FGS may stay up). */
    pauseBackgroundAudio(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }>;
    /** iOS native second-channel PiP. Android OTT PiP uses the shared video element. */
    playPip(opts: { url: string; loop?: boolean }): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }>;
    /** Acquire sleep prevention → keep device awake. */
    preventSleep(): Promise<{ ok: boolean; unsupported?: boolean }>;
    /** Resume background audio after pause. */
    resumeBackgroundAudio(
        opts?: BackgroundAudioMeta
    ): Promise<{ ok: boolean; unsupported?: boolean; error?: string }>;
    /** Full-window fullscreen (immersive on Android). */
    setFullscreen(opts: { fullscreen: boolean }): Promise<{
        ok: boolean;
        unsupported?: boolean;
    }>;
    /** Set OS output volume 0–100. Fails loudly when platform cannot set. */
    setVolume(opts: { volume: number }): Promise<{
        ok: boolean;
        unsupported?: boolean;
        volume: number;
    }>;
    /**
     * Enable background playback: iOS AVAudioSession `.playback` + Now Playing;
     * Android mediaPlayback foreground service (real startForegroundService).
     */
    startBackgroundAudio(
        opts?: BackgroundAudioMeta
    ): Promise<{ ok: boolean; unsupported?: boolean; error?: string }>;
    /** Tear down background audio / stop mediaPlayback FGS. */
    stopBackgroundAudio(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }>;
    /** Stop iOS native second-channel PiP. System Android PiP uses OS controls. */
    stopPip(): Promise<{ ok: boolean; unsupported?: boolean }>;
    /**
     * Refresh Now Playing / MediaSession metadata + timeline without restarting
     * the session. Seekable=false keeps OS seek disabled (live).
     */
    updateBackgroundAudio(
        opts?: BackgroundAudioMeta
    ): Promise<{ ok: boolean; unsupported?: boolean; error?: string }>;
}

class MobileNativeMediaWeb implements MobileNativeMediaPlugin {
    enterSystemPip(): Promise<{
        ok: boolean;
        unsupported?: boolean;
    }> {
        return nativeWebFallback(function () {
            return { ok: false, unsupported: true };
        });
    }
    getVolume(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        volume: number;
    }> {
        return nativeWebFallback(function () {
            console.warn(
                "[MobileNativeMedia] web fallback: getVolume unsupported"
            );
            return { ok: false, unsupported: true, volume: 0 };
        });
    }

    setVolume(_opts: { volume: number }): Promise<{
        ok: boolean;
        unsupported?: boolean;
        volume: number;
    }> {
        return nativeWebFallback(function () {
            console.warn(
                "[MobileNativeMedia] web fallback: setVolume unsupported"
            );
            return { ok: false, unsupported: true, volume: 0 };
        });
    }

    playPip(_opts: { url: string; loop?: boolean }): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }> {
        return nativeWebUnsupported("MobileNativeMedia", "playPip");
    }

    stopPip(): Promise<{ ok: boolean; unsupported?: boolean }> {
        return nativeWebUnsupported("MobileNativeMedia", "stopPip");
    }

    setFullscreen(_opts: {
        fullscreen: boolean;
    }): Promise<{ ok: boolean; unsupported?: boolean }> {
        return nativeWebUnsupported("MobileNativeMedia", "setFullscreen");
    }

    allowSleep(): Promise<{ ok: boolean; unsupported?: boolean }> {
        return nativeWebUnsupported("MobileNativeMedia", "allowSleep");
    }

    exitApp(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }> {
        return nativeWebUnsupported("MobileNativeMedia", "exitApp");
    }

    preventSleep(): Promise<{ ok: boolean; unsupported?: boolean }> {
        return nativeWebUnsupported("MobileNativeMedia", "preventSleep");
    }

    startBackgroundAudio(
        _opts?: BackgroundAudioMeta
    ): Promise<{ ok: boolean; unsupported?: boolean; error?: string }> {
        return nativeWebUnsupported(
            "MobileNativeMedia",
            "startBackgroundAudio"
        );
    }

    pauseBackgroundAudio(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }> {
        return nativeWebUnsupported(
            "MobileNativeMedia",
            "pauseBackgroundAudio"
        );
    }

    resumeBackgroundAudio(
        _opts?: BackgroundAudioMeta
    ): Promise<{ ok: boolean; unsupported?: boolean; error?: string }> {
        return nativeWebUnsupported(
            "MobileNativeMedia",
            "resumeBackgroundAudio"
        );
    }

    updateBackgroundAudio(
        _opts?: BackgroundAudioMeta
    ): Promise<{ ok: boolean; unsupported?: boolean; error?: string }> {
        return nativeWebUnsupported(
            "MobileNativeMedia",
            "updateBackgroundAudio"
        );
    }

    stopBackgroundAudio(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }> {
        return nativeWebUnsupported("MobileNativeMedia", "stopBackgroundAudio");
    }
}

export const MobileNativeMedia = resolveNativePlugin<MobileNativeMediaPlugin>(
    "MobileNativeMedia",
    () => new MobileNativeMediaWeb()
);

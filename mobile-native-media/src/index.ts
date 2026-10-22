/**
 * MobileNativeMedia — Capacitor 4.4 native media + 4.5 background audio bridges.
 *
 * Real native calls; WebPlugin fallback no-ops with console.warn.
 * Gate on `window.Capacitor` in src/index.ts so Mode A / Tauri stay untouched.
 * Inlined under src/ so tsc rootDir is satisfied.
 */

import { registerPlugin, WebPlugin } from "@capacitor/core";

export interface MobileNativeMediaPlugin {
    /** Release sleep prevention → device may idle/sleep. */
    allowSleep(): Promise<{ ok: boolean; unsupported?: boolean }>;
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
    /** Enter picture-in-picture. Fails loudly when unavailable. */
    playPip(): Promise<{ ok: boolean; unsupported?: boolean }>;
    /** Acquire sleep prevention → keep device awake. */
    preventSleep(): Promise<{ ok: boolean; unsupported?: boolean }>;
    /** Resume background audio after pause. */
    resumeBackgroundAudio(opts?: {
        title?: string;
        artist?: string;
    }): Promise<{ ok: boolean; unsupported?: boolean; error?: string }>;
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
    startBackgroundAudio(opts?: {
        title?: string;
        artist?: string;
    }): Promise<{ ok: boolean; unsupported?: boolean; error?: string }>;
    /** Tear down background audio / stop mediaPlayback FGS. */
    stopBackgroundAudio(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }>;
    /** Exit picture-in-picture. */
    stopPip(): Promise<{ ok: boolean; unsupported?: boolean }>;
}

class MobileNativeMediaWeb
    extends WebPlugin
    implements MobileNativeMediaPlugin
{
    async getVolume(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        volume: number;
    }> {
        console.warn("[MobileNativeMedia] web fallback: getVolume unsupported");
        return { ok: false, unsupported: true, volume: 0 };
    }

    async setVolume(_opts: { volume: number }): Promise<{
        ok: boolean;
        unsupported?: boolean;
        volume: number;
    }> {
        console.warn("[MobileNativeMedia] web fallback: setVolume unsupported");
        return { ok: false, unsupported: true, volume: 0 };
    }

    async playPip(): Promise<{ ok: boolean; unsupported?: boolean }> {
        console.warn("[MobileNativeMedia] web fallback: playPip unsupported");
        return { ok: false, unsupported: true };
    }

    async stopPip(): Promise<{ ok: boolean; unsupported?: boolean }> {
        console.warn("[MobileNativeMedia] web fallback: stopPip unsupported");
        return { ok: false, unsupported: true };
    }

    async setFullscreen(_opts: {
        fullscreen: boolean;
    }): Promise<{ ok: boolean; unsupported?: boolean }> {
        console.warn(
            "[MobileNativeMedia] web fallback: setFullscreen unsupported"
        );
        return { ok: false, unsupported: true };
    }

    async allowSleep(): Promise<{ ok: boolean; unsupported?: boolean }> {
        console.warn(
            "[MobileNativeMedia] web fallback: allowSleep unsupported"
        );
        return { ok: false, unsupported: true };
    }

    async preventSleep(): Promise<{ ok: boolean; unsupported?: boolean }> {
        console.warn(
            "[MobileNativeMedia] web fallback: preventSleep unsupported"
        );
        return { ok: false, unsupported: true };
    }

    async startBackgroundAudio(_opts?: {
        title?: string;
        artist?: string;
    }): Promise<{ ok: boolean; unsupported?: boolean; error?: string }> {
        console.warn(
            "[MobileNativeMedia] web fallback: startBackgroundAudio unsupported"
        );
        return { ok: false, unsupported: true };
    }

    async pauseBackgroundAudio(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }> {
        console.warn(
            "[MobileNativeMedia] web fallback: pauseBackgroundAudio unsupported"
        );
        return { ok: false, unsupported: true };
    }

    async resumeBackgroundAudio(_opts?: {
        title?: string;
        artist?: string;
    }): Promise<{ ok: boolean; unsupported?: boolean; error?: string }> {
        console.warn(
            "[MobileNativeMedia] web fallback: resumeBackgroundAudio unsupported"
        );
        return { ok: false, unsupported: true };
    }

    async stopBackgroundAudio(): Promise<{
        ok: boolean;
        unsupported?: boolean;
        error?: string;
    }> {
        console.warn(
            "[MobileNativeMedia] web fallback: stopBackgroundAudio unsupported"
        );
        return { ok: false, unsupported: true };
    }
}

export const MobileNativeMedia = registerPlugin<MobileNativeMediaPlugin>(
    "MobileNativeMedia",
    {
        web: () => new MobileNativeMediaWeb(),
    }
);

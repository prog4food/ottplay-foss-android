/**
 * Mobile command queue — Capacitor plugin + web fallback.
 *
 * Native: internal queue by default. HTTP control requires explicit opt-in and
 * a random bearer token; binds loopback :18081..18090 or OTTPLAY_QUEUE_PORT.
 * Web:    no-op fallback; web layer polls a configurable URL instead.
 */
import { registerPlugin, WebPlugin } from "@capacitor/core";

export interface QueueListenInfo {
    httpEnabled: boolean;
    port: number;
    running: boolean;
}

export interface QueueStartOptions {
    httpEnabled?: boolean;
    /** Required for HTTP control: random 32–256 URL-safe ASCII characters. */
    token?: string;
}

export interface CommandQueuePlugin {
    /** Drain the native in-memory queue for a device (empty = broadcast). */
    get(options?: { deviceId?: string }): Promise<{ commands: unknown[] }>;
    isRunning(): Promise<QueueListenInfo>;
    /** Capacitor passes one options object to both native implementations. */
    post(options: {
        data: Record<string, unknown>;
        deviceId?: string;
    }): Promise<{ queued: number }>;
    /** Default starts internal queue only; HTTP requires httpEnabled + token. */
    start(options?: QueueStartOptions): Promise<QueueListenInfo>;
    /** Close HTTP connections and clear pending commands. */
    stop(): Promise<void>;
}

class MobileCommandQueueWeb extends WebPlugin implements CommandQueuePlugin {
    async start(_options?: QueueStartOptions): Promise<QueueListenInfo> {
        console.warn("[MobileCommandQueue] web fallback: no native server");
        return { httpEnabled: false, port: 0, running: false };
    }

    async stop(): Promise<void> {}

    async post(_options: {
        data: Record<string, unknown>;
        deviceId?: string;
    }): Promise<{ queued: number }> {
        console.warn("[MobileCommandQueue] web fallback: post no-op");
        return { queued: 0 };
    }

    async get(_options?: {
        deviceId?: string;
    }): Promise<{ commands: unknown[] }> {
        console.warn("[MobileCommandQueue] web fallback: get no-op");
        return { commands: [] };
    }

    async isRunning(): Promise<QueueListenInfo> {
        return { httpEnabled: false, port: 0, running: false };
    }
}

const MobileCommandQueue = registerPlugin<CommandQueuePlugin>(
    "MobileCommandQueue",
    { web: async () => new MobileCommandQueueWeb() }
);

export { MobileCommandQueue };

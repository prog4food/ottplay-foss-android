/** Resolve typed native proxies without importing an SDK into the classic STB bundle. */
interface NativePluginRegistry {
    Plugins?: Record<string, unknown>;
    registerPlugin?<T>(name: string, options: { web: () => T }): T;
}

export function resolveNativePlugin<T>(name: string, createWeb: () => T): T {
    const capacitor: NativePluginRegistry | undefined =
        typeof window === "undefined" ? undefined : window.Capacitor;
    const registered = capacitor?.Plugins?.[name];
    if (registered) return registered as T;
    if (typeof capacitor?.registerPlugin === "function") {
        return capacitor.registerPlugin<T>(name, { web: createWeb });
    }
    return createWeb();
}

/**
 * Shared Tauri invoke helper. Uses @tauri-apps/api/core if available,
 * falls back to window.__TAURI__.invoke for bundled apps.
 */
export function tauriInvoke<T>(
    command: string,
    args: Record<string, unknown>
): Promise<T> {
    // Prefer core.invoke (Tauri v2 core API), fallback to global __TAURI__
    const core = (window as any).__TAURI__?.core;
    if (core?.invoke) {
        return core.invoke(command, args) as Promise<T>;
    }
    return (window as any).__TAURI__.invoke(command, args) as Promise<T>;
}

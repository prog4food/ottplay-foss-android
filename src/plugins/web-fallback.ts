/** Run a synchronous fallback with the same Promise boundary as an async method. */
export function nativeWebFallback<T>(
    action: () => T | PromiseLike<T>
): Promise<T> {
    // The executor runs now, catches thrown errors, and adopts returned thenables.
    return new Promise<T>(function (resolve) {
        resolve(action());
    });
}

/** Shared unsupported response; the public native methods keep their own ABI. */
export function nativeWebUnsupported(
    plugin: string,
    method: string
): Promise<{ ok: boolean; unsupported: boolean }> {
    return nativeWebFallback(function () {
        console.warn(
            "[" + plugin + "] web fallback: " + method + " unsupported"
        );
        return { ok: false, unsupported: true };
    });
}

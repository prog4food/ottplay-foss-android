/**
 * Augment the global `Window` interface with all globals used by the
 * ottplay-foss codebase. These globals are set by the old player.js
 * and accessed via `window.X` throughout the codebase.
 *
 * All members are typed as `any` since they originate in untyped JS.
 * Callers that need stricter types can narrow locally. The interface
 * mirrors `biome.json` javascript.globals so biome and TypeScript agree
 * on what's in scope.
 */
declare global {
    interface Window {
        [key: string]: any;
    }
}

export {};

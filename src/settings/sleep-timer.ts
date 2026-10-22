/**
 * Sleep timer — setSleepTimeout leaf (Phase C).
 *
 * Moved from src/index.ts. Keeps a module-local sleepTimer binding
 * (app/state is OFF MODULES — do not import setSleepTimer from there).
 */
import { stbIsStandby, stbToggleStandby } from "../core";
import { settings } from "./index";

/** Module-local timer handle (matches former index.ts var). */
var sleepTimer: any = null;
var sleepGeneration = 0;

/**
 * Set (or clear) the sleep timer using the selected inactivity duration.
 * The player enters standby via stbToggleStandby().
 *
 * Side effects: Sets/clears a setTimeout; calls stbToggleStandby() when
 * the timer fires.
 */
export function setSleepTimeout(): void {
    const generation = ++sleepGeneration;
    if (sleepTimer) clearTimeout(sleepTimer);
    sleepTimer = null;
    if ((window as any).__ottKiosk && (window as any).__ottKiosk.enabled())
        return;
    const durations = [0, 30, 60, 120, 180];
    const minutes = durations[settings.sleepTimeout] || 0;
    if (minutes > 0 && !stbIsStandby()) {
        sleepTimer = setTimeout(
            function () {
                // A queued callback must not interrupt a renewed or disabled timeout.
                if (
                    generation !== sleepGeneration ||
                    stbIsStandby() ||
                    ((window as any).__ottKiosk &&
                        (window as any).__ottKiosk.enabled())
                )
                    return;
                sleepGeneration++;
                if (typeof window.stbToggleStandby === "function")
                    window.stbToggleStandby();
                else stbToggleStandby();
            },
            minutes * 60 * 1000
        );
    }
}

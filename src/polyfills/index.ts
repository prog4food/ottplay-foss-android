/** Application-specific compatibility; standard APIs come from runtime-polyfills.js. */
import { applyWebRuntimePolyfills } from "./runtime";

var polyfillsApplied = false;

/** Preserve the selected application timezone when initialization repeats. */
export function applyPolyfills(): void {
    if (polyfillsApplied) return;
    polyfillsApplied = true;
    applyWebRuntimePolyfills();
    polyfillDateTimezone();
}

/**
 * Polyfill custom timezone-offset support on `Date` (legacy STB feature).
 *
 * @remarks
 * Adds a `timezoneOffset` property to Date instances and a set of static /
 * instance methods (`Date.setTimezoneOffset`, `Date.getTimezoneOffset`,
 * `Date.prototype.toString`, etc.) that shift the UTC getters/setters by a
 * configurable offset in minutes.
 *
 * Also overrides `Date.prototype.toString` to output UTC time shifted by the
 * stored offset.
 *
 * The patch modifies all `get*` / `set*` method pairs (Milliseconds, Seconds,
 * Minutes, Hours, Date, Month, FullYear, Year, Day) to behave as UTC
 * equivalents adjusted by the custom offset.
 *
 * @sideEffects
 * - Adds `Date.prototype.timezoneOffset` (instance property, default =
 *   system offset at polyfill time)
 * - Adds `Date.setTimezoneOffset(offset)` / `Date.getTimezoneOffset()`
 * - Adds `Date.prototype.setTimezoneOffset(offset)` / `Date.prototype.getTimezoneOffset()`
 * - Overrides `Date.prototype.toString()`
 * - Overrides all `Date.prototype.get*` / `set*` date/time accessors
 */
function polyfillDateTimezone(): void {
    (Date as any).nativeGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    var baseDate = new Date();
    (Date.prototype as any).timezoneOffset = baseDate.getTimezoneOffset();
    (Date as any).setTimezoneOffset = function (offset: number): number {
        return ((this as any).prototype.timezoneOffset = offset);
    };
    (Date.prototype as any).setTimezoneOffset = function (
        offset: number
    ): number {
        return ((this as any).timezoneOffset = offset);
    };
    (Date as any).getTimezoneOffset = function (_offset?: number): number {
        return (this as any).prototype.timezoneOffset;
    };
    (Date.prototype as any).getTimezoneOffset = function (): number {
        return (this as any).timezoneOffset;
    };
    (Date.prototype as any).toString = function (): string {
        var offsetMs = (this as any).timezoneOffset * 60 * 1000;
        baseDate.setTime(this.getTime() - offsetMs);
        return baseDate.toUTCString();
    };
    var dateParts = [
        "Milliseconds",
        "Seconds",
        "Minutes",
        "Hours",
        "Date",
        "Month",
        "FullYear",
        "Year",
        "Day",
    ];
    dateParts.forEach(function (part: string) {
        (Date.prototype as any)["get" + part] = function () {
            var offsetMs = (this as any).timezoneOffset * 60 * 1000;
            baseDate.setTime(this.getTime() - offsetMs);
            return (baseDate as any)["getUTC" + part]();
        };
        (Date.prototype as any)["set" + part] = function (value: number) {
            var offsetMs = (this as any).timezoneOffset * 60 * 1000;
            baseDate.setTime(this.getTime() - offsetMs);
            (baseDate as any)["setUTC" + part](value);
            var result = baseDate.getTime() + offsetMs;
            this.setTime(result);
            return result;
        };
    });
}

// Run after the shared web runtime and before application modules.
applyPolyfills();

// Settings helpers and timezone utilities

import { applyTimezoneSetting, settings } from "../settings";

/** Apply the configured timezone; zero restores the system timezone. */
export function setTimezone(): void {
    settings.timezone = applyTimezoneSetting(settings.timezone);
}

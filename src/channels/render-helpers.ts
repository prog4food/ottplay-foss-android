/** Optional ESM presentation helpers; active guide rendering is owned by GuideScreen. */
import { formatEpgTime } from "./index";
import type { EPGEntry } from "./types";

/** List of module state keys that should be persisted via the provider storage API. */
export const persistedKeys: string[] = [
    "catsArray",
    "cats",
    "favoritesArray",
    "favoritesLists",
    "parentalArray",
    "catIndex",
    "primaryIndex",
    "prevArr",
    "epgTimers",
    "aAspects",
    "aZooms",
    "aAudios",
    "aSubs",
    "sSortAbc",
    "sPlayers",
    "medHistory",
    "medFavorites",
    "continueWatch",
];

/**
 * Render an array of EPG entries into a complete HTML string for use in
 * legacy view containers. Shows time range and optional description for each entry.
 *
 * @param epgData - Array of EPG entries to render.
 * @returns Concatenated HTML string (empty if input is null/empty).
 */
export function renderEpgHTML(epgData: EPGEntry[]): string {
    var html = "";
    if (!(epgData && epgData.length)) return html;
    epgData.forEach(function (entry: EPGEntry) {
        html +=
            '<div class="epg-entry"><span class="epg-time">' +
            formatEpgTime(entry.time) +
            '</span> <span class="epg-name">' +
            entry.name +
            "</span>";
        if (entry.descr)
            html += '<div class="epg-descr">' + entry.descr + "</div>";
        html += "</div>";
    });
    return html;
}

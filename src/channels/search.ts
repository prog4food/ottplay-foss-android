import { normalizeSearchText } from "../localization";
/** Optional ESM filter helpers. The classic search screen owns its own query and selection. */

/** Minimal history row shape used by getFilteredHistory. */
export interface SearchHistoryEntry {
    name?: string;
    title?: string;
}

/** Channel-name filter string, updated through setSearchText. */
export let searchText = "";

/** Assign searchText (index cannot assign to an import binding). */
export function setSearchText(value: string): void {
    searchText = value || "";
}

/** History filter string (set via searchHistoryChannel). */
export let historySearchText = "";

/* Ambient: provided by channels/index.js later in the classic concat bundle. */
declare var curList: number[];
declare var channels: Record<number, { channel_name?: string; name?: string }>;
declare var medHistory: SearchHistoryEntry[];

/**
 * Set the history search query string.
 * @param query - The search text to filter history entries by.
 * Side effects: Sets `historySearchText`.
 */
export function searchHistoryChannel(query: string): void {
    historySearchText = query;
}

/**
 * Returns history entries that match `historySearchText` (case-insensitive).
 * If the filter is empty, returns a copy of `medHistory`.
 */
export function getFilteredHistory(): SearchHistoryEntry[] {
    if (!historySearchText) return medHistory.slice();
    const lower = normalizeSearchText(historySearchText);
    return medHistory.filter(
        (entry) =>
            normalizeSearchText(entry.name || "").indexOf(lower) >= 0 ||
            normalizeSearchText(entry.title || "").indexOf(lower) >= 0
    );
}

/**
 * Returns channel IDs that match `searchText` (case-insensitive) within the
 * current category. If the filter is empty, returns a copy of `curList`.
 */
export function getFilteredChannelList(): number[] {
    if (!searchText) return curList.slice();
    const lower = normalizeSearchText(searchText);
    return curList.filter((chId) => {
        const ch = channels[chId];
        return (
            normalizeSearchText(ch?.channel_name || "").indexOf(lower) >= 0 ||
            normalizeSearchText(ch?.name || "").indexOf(lower) >= 0
        );
    });
}

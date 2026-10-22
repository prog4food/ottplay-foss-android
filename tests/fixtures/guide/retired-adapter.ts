/** Frozen compatibility oracle, excluded from production.
 * Copied from src/channels/index.ts at 4144b6594f4b0ebaf591a85f47f24272109349e0.
 * Legacy provenance/license remains documented in docs/legacy-provenance.md.
 * New GuideService uses the explicit half-open GuideTimeline contract instead. */
function epgCacheLimit(): number {
    var configured =
        typeof window !== "undefined" &&
        typeof (window as any).epgCacheCapacity !== "undefined"
            ? Number((window as any).epgCacheCapacity)
            : epgCacheCapacity;
    return (window as any).OttPlayCore.legacyGuideCacheCapacity(configured);
}

function readEpgCache(channelId: number): EPGEntry[] | null {
    var data = epg[channelId];
    var core = (window as any).OttPlayCore;
    var state = core.legacyGuideCacheRead(
        data,
        epgCacheFetchedAt[channelId],
        epgCacheLimit(),
        function () {
            return Date.now();
        }
    );
    if (state === 0) return null;
    if (state < 0) {
        delete epg[channelId];
        delete epgCacheByChannel[channelId];
        delete epgCacheFetchedAt[channelId];
        core.legacyGuideCacheOrder(epgCacheChannelOrder, channelId, null, true);
        return null;
    }
    core.legacyGuideCacheOrder(epgCacheChannelOrder, channelId, null, false);
    return data;
}

function cacheFetchedEpg(channelId: number, data: EPGEntry[] | null): void {
    var limit = epgCacheLimit();
    if (!limit || !data || !data.length) return;
    epg[channelId] = data;
    epgCacheByChannel[channelId] = data;
    epgCacheFetchedAt[channelId] = Date.now();
    (window as any).OttPlayCore.legacyGuideCacheOrder(
        epgCacheChannelOrder,
        channelId,
        limit,
        false
    ).forEach(function (id: number) {
        delete epg[id];
        delete epgCacheByChannel[id];
        delete epgCacheFetchedAt[id];
    });
}

export function applyChannelTvgShift(
    ch: any,
    epgData: EPGEntry[] | null
): EPGEntry[] | null {
    return (window as any).OttPlayCore.legacyGuideShift(epgData, ch && ch.ts);
}

export function setCurProg(
    channelId: number,
    epgData: EPGEntry[] | null,
    callback?: ((chId: number) => void) | (() => void)
): void {
    // Legacy always updates channels[id] even when epgData is null/empty, and sets
    // time_request=now+3600 on miss so updateChannelInfo → getCurProgData cannot
    // re-queue forever (sync getChannelEpg(null) path).
    var safeChannelId = Number(channelId);
    if (!Number.isFinite(safeChannelId) || !Number.isInteger(safeChannelId))
        return;
    var hasData = Array.isArray(epgData) && epgData.length > 0;
    var nextCount =
        typeof (window as any).sNextCount === "number"
            ? (window as any).sNextCount
            : 0;
    var selection = (window as any).OttPlayCore.legacyGuideSelection(
        hasData ? epgData : [],
        Date.now() / 1000,
        nextCount
    );
    var ch = (window as any).channels
        ? (window as any).channels[safeChannelId]
        : window.channels
          ? window.channels[safeChannelId]
          : undefined;
    if (ch) {
        if (!selection.current) {
            ch.name = "";
            ch.time = 0;
            ch.time_to = 0;
            ch.descr = "";
            ch.nextpr = null;
            ch.time_request = selection.retryAt;
            if (hasData) ch.outdated = true;
        } else {
            var cur = selection.current;
            ch.name = cur.name;
            ch.time = cur.time;
            ch.time_to = cur.time_to;
            ch.descr = cur.descr || "";
            ch.time_request = 0;
            if (cur.icon !== undefined) ch.icon = cur.icon;
            ch.nextpr = selection.following;
            if (ch.nextpr.length === 0) ch.nextpr = null;
            if (typeof ch.outdated !== "undefined") delete ch.outdated;
        }
    }
    if (callback) (callback as (chId: number) => void)(safeChannelId);
}

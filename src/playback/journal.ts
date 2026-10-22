/** Versioned playback persistence. No UI, classic globals or media effects. */
interface PlaybackJournalPorts {
    /** Numeric entries now come from canonical commands; raw references carry an explicit origin. */
    channelReferences?: 1;
    get(key: string): string | null | undefined;
    /** Explicit identity migration within the same already selected storage namespace. */
    importSourceId?: string;
    isCurrent(): boolean;
    now(): number;
    set(key: string, value: string): void;
    sourceId: string;
}

interface PlaybackJournalEntry {
    archiveStart?: number;
    channelHint?: {
        guideId: string;
        name: string;
        group: string;
        routeId?: string;
    };
    channelId: string;
    groupId?: string;
    kind: "live" | "archive" | "vod";
    label?: string;
    position?: number;
}

interface PlaybackJournalDocument {
    bookmark: PlaybackJournalEntry | null;
    channelReferences?: 1;
    history: PlaybackJournalEntry[];
    sourceId: string;
    updatedAt: number;
    version: 2;
}

function createPlaybackJournal(ports: PlaybackJournalPorts) {
    var key = "playbackJournal";
    function finite(value: any): boolean {
        return typeof value === "number" && isFinite(value) && value >= 0;
    }
    function identity(value: any): string | null {
        return typeof value === "string" && value.trim().length > 0
            ? value
            : typeof value === "number" && isFinite(value)
              ? String(value)
              : null;
    }
    function entry(value: any): PlaybackJournalEntry | null {
        if (!value || typeof value !== "object") return null;
        var id = identity(value.channelId);
        if (!id || ["live", "archive", "vod"].indexOf(value.kind) < 0)
            return null;
        if (value.kind === "archive" && !finite(value.archiveStart))
            return null;
        var result: PlaybackJournalEntry = { channelId: id, kind: value.kind };
        var hint = value.channelHint;
        if (
            hint &&
            typeof hint.guideId === "string" &&
            typeof hint.name === "string" &&
            typeof hint.group === "string" &&
            (hint.guideId.trim() || hint.name.trim())
        ) {
            result.channelHint = {
                group: hint.group,
                guideId: hint.guideId,
                name: hint.name,
            };
            if (typeof hint.routeId === "string" && hint.routeId.trim())
                result.channelHint.routeId = hint.routeId;
        }
        if (value.kind === "archive") result.archiveStart = value.archiveStart;
        if (finite(value.position)) result.position = value.position;
        if (typeof value.label === "string") result.label = value.label;
        if (typeof value.groupId === "string") result.groupId = value.groupId;
        return result;
    }
    function history(values: any): PlaybackJournalEntry[] {
        var result: PlaybackJournalEntry[] = [];
        if (Array.isArray(values)) {
            values.slice(0, 1000).forEach(function (value: any): void {
                var item = entry(value);
                if (item) result.push(item);
            });
        }
        return result;
    }
    function empty(): PlaybackJournalDocument {
        return {
            bookmark: null,
            history: [],
            sourceId: ports.sourceId,
            updatedAt: 0,
            version: 2,
        };
    }
    function legacyValue(name: string): any {
        try {
            return JSON.parse(ports.get(name) || "null");
        } catch (_) {
            return null;
        }
    }
    function migrate(): PlaybackJournalDocument {
        var result = empty();
        var groups = legacyValue("catsArray");
        var previous = legacyValue("prevArr");
        var bookmark = legacyValue("continueWatch");
        if (Array.isArray(previous)) {
            previous.slice(0, 1000).forEach(function (row: any): void {
                if (!row || typeof row !== "object") return;
                var item = entry({
                    archiveStart: row.t,
                    channelId: row.ci,
                    groupId: Array.isArray(groups) ? groups[row.c] : undefined,
                    kind: row.t === undefined ? "live" : "archive",
                    label: row.e,
                });
                if (item) result.history.push(item);
            });
        }
        // Version-1 VOD bookmarks refer to a channel position, not a media ID.
        // Media history retains its dedicated importer until that schema migrates.
        if (
            bookmark &&
            bookmark.v === 1 &&
            ["live", "archive"].indexOf(bookmark.mode) >= 0
        ) {
            result.bookmark = entry({
                archiveStart: bookmark.playType,
                channelId: bookmark.channelId,
                groupId: Array.isArray(groups)
                    ? groups[bookmark.catIndex]
                    : undefined,
                kind: bookmark.mode,
                position: bookmark.playTime,
            });
            if (finite(bookmark.updatedAt))
                result.updatedAt = bookmark.updatedAt;
        }
        return result;
    }
    function read(): { document: PlaybackJournalDocument; writable: boolean } {
        var fallback = { document: empty(), writable: false };
        if (!ports.isCurrent()) return fallback;
        try {
            var raw = ports.get(key);
            if (raw == null || raw === "")
                return { document: migrate(), writable: true };
            var value = JSON.parse(raw);
            // Unknown versions, corrupt envelopes and another source are retained
            // byte-for-byte. Falling back to old mirrors could resurrect stale data.
            if (
                !value ||
                value.version !== 2 ||
                (value.sourceId !== ports.sourceId &&
                    (!ports.importSourceId ||
                        value.sourceId !== ports.importSourceId)) ||
                !Array.isArray(value.history) ||
                !finite(value.updatedAt)
            )
                return fallback;
            return {
                document: {
                    bookmark: entry(value.bookmark),
                    history: history(value.history),
                    sourceId: ports.sourceId,
                    updatedAt: value.updatedAt,
                    version: 2,
                },
                writable: true,
            };
        } catch (_) {
            return fallback;
        }
    }
    return {
        active: ports.isCurrent,
        read: read,
        update: function (change: {
            bookmark?: PlaybackJournalEntry | null;
            history?: PlaybackJournalEntry[];
        }): boolean {
            var loaded = read();
            if (!loaded.writable || !ports.isCurrent()) return false;
            var document = loaded.document;
            if (Object.prototype.hasOwnProperty.call(change, "bookmark")) {
                var bookmark = entry(change.bookmark);
                if (change.bookmark !== null && !bookmark) return false;
                document.bookmark = bookmark;
                document.updatedAt = ports.now();
                if (!finite(document.updatedAt)) return false;
            }
            if (Object.prototype.hasOwnProperty.call(change, "history"))
                document.history = history(change.history);
            try {
                // One envelope write commits both data and migration version.
                if (!ports.isCurrent()) return false;
                if (ports.channelReferences === 1)
                    document.channelReferences = 1;
                var serialized = JSON.stringify(document);
                ports.set(key, serialized);
                return ports.isCurrent() && ports.get(key) === serialized;
            } catch (_) {
                return false;
            }
        },
    };
}

(window as any).__ottPlaybackJournal = { create: createPlaybackJournal };

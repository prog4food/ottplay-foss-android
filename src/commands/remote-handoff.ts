/** Explicit same-source handoff. The receiver resolves its own stream, never a supplied URL. */
export function executeRemoteHandoff(
    w: any,
    request: any,
    done: (result: any) => void
): void {
    function reject(code: string): void {
        done({ data: { error: code }, status: "rejected" });
    }
    function object(value: any): boolean {
        return !!value && typeof value === "object" && !Array.isArray(value);
    }
    function text(value: any, limit: number): boolean {
        if (
            typeof value !== "string" ||
            !value.trim() ||
            value.length > limit ||
            /[\u0000-\u001f\u007f]/.test(value)
        )
            return false;
        try {
            return (
                encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, "x")
                    .length <= limit
            );
        } catch (_) {
            return false;
        }
    }
    var driver = w.__ottActiveProviderDriver,
        playback = w.__ottClassicPlayback;
    if (
        !driver ||
        ["m3u", "xtream", "stalker"].indexOf(driver.id) < 0 ||
        !playback ||
        !w.__ottSourceIdentity
    )
        return reject("unsupported");
    var source = w.__ottSourceIdentity.current(w),
        channels = w.channels;
    // A provider ID may itself contain a credential-bearing URL (Stalker),
    // while classic M3U rows have no itemId. Keep both raw forms local.
    function identity(row: any): string {
        if (!row) return "";
        var explicit = typeof row.itemId === "string" && row.itemId;
        var value =
            explicit ||
            (driver.id === "m3u" && typeof row.url === "string" && row.url);
        if (!value || value.length > 65536) return "";
        var input = driver.id + (explicit ? ":id:" : ":url:") + value;
        var first = 2166136261,
            second = 5381;
        for (var at = 0; at < input.length; at++) {
            first ^= input.charCodeAt(at);
            first +=
                (first << 1) +
                (first << 4) +
                (first << 7) +
                (first << 8) +
                (first << 24);
            second = ((second << 5) + second) ^ input.charCodeAt(at);
        }
        // This fingerprint identifies a row; it grants no authority. Reject
        // collisions/duplicate identities on both sides instead of guessing.
        return (
            "channel-v1:" +
            ("00000000" + (first >>> 0).toString(16)).slice(-8) +
            "." +
            ("00000000" + (second >>> 0).toString(16)).slice(-8)
        );
    }
    function matching(key: string): string[] {
        return Object.keys(channels || {}).filter(function (id) {
            return identity(channels[id]) === key;
        });
    }
    var params = request.params || {};
    if (!object(params)) return reject("invalid_request");
    if (request.action === "playback_handoff_export") {
        if (Object.keys(params).length) return reject("invalid_request");
        var state = playback.snapshot(),
            target = state.target;
        if (
            !target ||
            ["live", "archive"].indexOf(target.kind) < 0 ||
            ["playing", "paused"].indexOf(state.phase) < 0 ||
            target.sourceId !== source
        )
            return reject("no_current_item");
        var row = channels && channels[target.channelId];
        var key = identity(row);
        if (!key || !text(source, 256)) return reject("item_unavailable");
        if (matching(key).length !== 1) return reject("ambiguous_item");
        var handoff: any = {
            item_id: key,
            kind: target.kind,
            provider: driver.id,
            source_id: source,
            version: 1,
        };
        if (target.kind === "archive") {
            var start = Math.floor(
                Number(target.archiveStart) + Number(state.position)
            );
            if (!isFinite(start) || start < 1 || start > Date.now() / 1000)
                return reject("no_current_item");
            handoff.archive_start = start;
        }
        done({ data: { handoff: handoff }, status: "ok" });
        return;
    }
    var item = params.handoff;
    if (
        Object.keys(params).join(",") !== "handoff" ||
        !object(item) ||
        item.version !== 1 ||
        !text(item.source_id, 256) ||
        !text(item.item_id, 512) ||
        !/^channel-v1:[0-9a-f]{8}\.[0-9a-f]{8}$/.test(item.item_id) ||
        ["live", "archive"].indexOf(item.kind) < 0 ||
        Object.keys(item).sort().join(",") !==
            (item.kind === "live"
                ? "item_id,kind,provider,source_id,version"
                : "archive_start,item_id,kind,provider,source_id,version")
    )
        return reject("invalid_request");
    if (item.source_id !== source || item.provider !== driver.id)
        return reject("source_mismatch");
    if (
        (w.__ottKiosk && w.__ottKiosk.enabled()) ||
        !w.__ottParental ||
        !Array.isArray(w.parentalArray)
    )
        return reject("policy_denied");
    var matches = matching(item.item_id);
    if (matches.length !== 1)
        return reject(matches.length ? "ambiguous_item" : "item_unavailable");
    var id = matches[0];
    if (
        w.parentalArray.some(function (value: any) {
            return String(value) === id;
        }) &&
        w.__ottParental.needs("channels")
    )
        return reject("policy_denied");
    var category = -1,
        index = -1;
    (w.catsArray || []).some(function (name: string, at: number) {
        return (w.cats[name] || []).some(function (
            value: any,
            position: number
        ) {
            if (String(value) !== id) return false;
            category = at;
            index = position;
            return true;
        });
    });
    if (category < 0 || typeof w.playChannel !== "function")
        return reject("item_unavailable");
    var programme: any;
    if (item.kind === "archive") {
        var now = Math.floor(Date.now() / 1000),
            hours = Number(channels[id].rec);
        if (
            typeof item.archive_start !== "number" ||
            !isFinite(item.archive_start) ||
            Math.floor(item.archive_start) !== item.archive_start ||
            item.archive_start < 1 ||
            !isFinite(hours) ||
            !(hours > 0) ||
            item.archive_start < now - hours * 3600 ||
            item.archive_start >= now ||
            !w.__ottClassicArchive ||
            typeof w.__ottClassicArchive.open !== "function" ||
            typeof w.setCurrent !== "function" ||
            typeof w.getArchiveUrl !== "function"
        )
            return reject("item_unavailable");
        programme = {
            descr: "",
            name: channels[id].channel_name || "",
            time: item.archive_start,
            time_to: now,
        };
        // Like remote archive playback, reject an unavailable resolver before
        // changing selection or acknowledging dispatch. URLs remain local.
        var resolved: any;
        try {
            resolved = w.getArchiveUrl(id, item.archive_start, now, programme);
        } catch (_) {
            return reject("playback_failed");
        }
        if (typeof resolved !== "string" || !/^https?:\/\//i.test(resolved))
            return reject("item_unavailable");
    }
    if (
        driver !== w.__ottActiveProviderDriver ||
        source !== w.__ottSourceIdentity.current(w) ||
        channels !== w.channels
    )
        return reject("context_changed");
    try {
        if (item.kind === "live") w.playChannel(category, index);
        else {
            w.setCurrent(category, index, true);
            w.epgArray = [programme];
            w.__ottClassicArchive.open(item.archive_start);
        }
        done({ data: { dispatched: true, kind: item.kind }, status: "ok" });
    } catch (_) {
        reject("playback_failed");
    }
}

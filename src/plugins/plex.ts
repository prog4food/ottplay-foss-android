interface PlexConfig {
    address: string;
    folders?: Array<{ path: string; title: string }>;
    playback: "auto" | "original" | "compatible";
    token: string;
}

/** Configuration belongs to one player/profile; no server environment or shared credentials. */
function normalizePlexConfig(value: any): PlexConfig | null {
    if (!value || typeof value !== "object") return null;
    var address = String(value.address || value.server || "")
        .trim()
        .replace(/\/+$/, "");
    var token = typeof value.token === "string" ? value.token.trim() : "";
    if (
        !/^https?:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?(?:\/[a-z0-9_./~-]*)?$/i.test(
            address
        ) ||
        /(?:^|\/)\.\.(?:\/|$)/.test(address) ||
        !token ||
        token.length > 1024 ||
        /[\s\u0000-\u001f\u007f]/.test(token)
    )
        return null;
    var port = /^https?:\/\/(?:\[[^\]]+\]|[^/:]+):(\d+)(?:\/|$)/i.exec(address);
    if (port && (+port[1] < 1 || +port[1] > 65535)) return null;
    var folders: Array<{ path: string; title: string }> | undefined;
    if (value.folders !== undefined) {
        if (!Array.isArray(value.folders) || value.folders.length > 1000)
            return null;
        folders = [];
        var seen: any = Object.create(null);
        for (var index = 0; index < value.folders.length; index++) {
            var folder = value.folders[index];
            var path = folder && plexFolderPath(folder.path);
            if (
                !path ||
                typeof folder.title !== "string" ||
                folder.title.length > 1024
            )
                return null;
            if (seen[path]) continue;
            seen[path] = true;
            folders.push({
                path: path,
                title: folder.title
                    .replace(/[\u0000-\u001f\u007f]/g, " ")
                    .trim(),
            });
        }
    }
    var result: PlexConfig = {
        address: address,
        playback:
            value.playback === "original" || value.playback === "compatible"
                ? value.playback
                : "auto",
        token: token,
    };
    if (folders !== undefined) result.folders = folders;
    return result;
}

function plexRows(value: any): any[] {
    return Array.isArray(value)
        ? value
        : value && typeof value === "object"
          ? [value]
          : [];
}

/** PMS installations may return XML even when JSON was requested. */
function plexContainer(value: any, host: any): any {
    if (typeof value === "string") {
        if (value.length > 8 * 1024 * 1024)
            throw new Error("Invalid Plex response");
        if (/^\s*\{/.test(value)) value = JSON.parse(value);
        else {
            if (/<!DOCTYPE/i.test(value)) throw new Error("Invalid Plex XML");
            var xml = new host.DOMParser().parseFromString(value, "text/xml");
            if (
                xml.getElementsByTagName("parsererror").length ||
                !xml.documentElement ||
                xml.documentElement.nodeName !== "MediaContainer"
            )
                throw new Error("Invalid Plex XML");
            var convert = function (node: any, depth = 0): any {
                if (depth > 16) throw new Error("Invalid Plex XML");
                var result: any = Object.create(null);
                for (var i = 0; i < node.attributes.length; i++)
                    result[node.attributes[i].name] = node.attributes[i].value;
                for (
                    var child = node.firstChild;
                    child;
                    child = child.nextSibling
                ) {
                    if (child.nodeType !== 1) continue;
                    var key = child.nodeName;
                    if (!Array.isArray(result[key])) result[key] = [];
                    result[key].push(convert(child, depth + 1));
                }
                return result;
            };
            value = { MediaContainer: convert(xml.documentElement) };
        }
    }
    if (
        !value ||
        !value.MediaContainer ||
        typeof value.MediaContainer !== "object"
    )
        throw new Error("Invalid Plex response");
    return value.MediaContainer;
}

function plexPath(value: any): string {
    if (
        typeof value !== "string" ||
        !/^\/(?:library\/(?:sections|metadata|parts)(?:[/?]|$)|hubs\/search(?:[?]|$))/.test(
            value
        ) ||
        /[\\#\u0000-\u0020]/.test(value) ||
        /[?&]X-Plex-/i.test(value)
    )
        return "";
    try {
        if (
            /(?:^|\/)\.\.(?:\/|$)|\\/.test(
                decodeURIComponent(value.split("?")[0])
            )
        )
            return "";
    } catch (_) {
        return "";
    }
    return value;
}

/** Only selected library or folder roots may enter a profile playlist. */
function plexFolderPath(value: any): string {
    var path = plexPath(value);
    return /^\/library\/(?:sections\/[1-9][0-9]{0,19}\/(?:all(?:\?type=(?:[134]|10))?|folder(?:\?parent=[0-9]{1,20})?)|metadata\/[1-9][0-9]{0,19}\/children)$/.test(
        path
    )
        ? path
        : "";
}

function createPlexClient(
    configuration: any,
    options: {
        host?: any;
        isCurrent?(): boolean;
        onRetry?(): void;
        sourceId: string;
        title?: string;
    }
): any {
    var config = normalizePlexConfig(configuration);
    if (
        !config ||
        !options ||
        !options.sourceId ||
        options.sourceId.indexOf(config.token) !== -1
    )
        return null;
    var w = options.host || (window as any);
    var jq = w.jQuery || w.$;
    if (!jq || typeof jq.ajax !== "function") return null;
    var source = options.sourceId;
    var revision = 0;
    var disposed = false;
    var unloading = false;
    var pending: any = null;
    var connectTimer: any = null;
    var resolveTimer: any = null;
    var cancelCollection: (() => void) | null = null;
    var cancelPage: (() => void) | null = null;
    var cancelScan: (() => void) | null = null;
    var scanRevision = 0;
    var pageRevision = 0;
    var sections: any = null;
    var sectionsAt = 0;
    var search: any = null;
    var session: any = null;
    var releasing = 0;
    var waiting: Array<() => void> = [];
    var sequence = 0;
    var clientId =
        "ottplay-" +
        Date.now().toString(36) +
        "-" +
        Math.random().toString(36).slice(2);

    function current(token: number): boolean {
        return (
            !disposed &&
            token === revision &&
            (!options.isCurrent || options.isCurrent())
        );
    }
    function translate(value: string): string {
        return typeof w._ === "function" ? w._(value) : value;
    }
    function failure(): void {
        if (typeof w.infoBox === "function")
            w.infoBox(translate("Plex connection failed"));
    }
    function url(path: string, params: any = {}): string {
        var pairs: string[] = [];
        Object.keys(params).forEach(function (key) {
            pairs.push(
                encodeURIComponent(key) +
                    "=" +
                    encodeURIComponent(String(params[key]))
            );
        });
        pairs.push("X-Plex-Token=" + encodeURIComponent(config!.token));
        return (
            config!.address +
            path +
            (path.indexOf("?") === -1 ? "?" : "&") +
            pairs.join("&")
        );
    }
    function retryableRead(xhr: any, status: string): boolean {
        var code = Number(xhr && xhr.status) || 0;
        return (
            status !== "abort" &&
            status !== "parsererror" &&
            (!code ||
                code === 408 ||
                code === 429 ||
                (code >= 500 && code < 600))
        );
    }
    function request(
        path: string,
        params: any,
        token: number,
        done: (data: any, error?: string, retryable?: boolean) => void
    ): void {
        var finished = false;
        var settled = false;
        var owned: any = null;
        var headers: any = { Accept: "application/json" };
        ["X-Plex-Container-Start", "X-Plex-Container-Size"].forEach(
            function (key) {
                if (params[key] !== undefined)
                    headers[key] = String(params[key]);
            }
        );
        try {
            var xhr = jq.ajax({
                complete: function () {
                    finished = true;
                    if (pending === owned) pending = null;
                },
                dataType: "text",
                error: function (xhr: any, status: string) {
                    if (settled) return;
                    settled = true;
                    if (current(token) && status !== "abort")
                        done(
                            null,
                            "Plex connection failed",
                            retryableRead(xhr, status)
                        );
                },
                headers: headers,
                success: function (data: any) {
                    if (settled || !current(token)) return;
                    settled = true;
                    var parsed: any;
                    try {
                        parsed = plexContainer(data, w);
                    } catch (_) {
                        done(null, "Plex connection failed");
                        return;
                    }
                    done(parsed);
                },
                timeout: 30000,
                type: "GET",
                url: url(path, params),
            });
            owned = xhr;
            if (!finished && !settled && current(token)) pending = xhr;
        } catch (_) {
            if (!settled && current(token)) {
                settled = true;
                done(null, "Plex connection failed");
            }
        }
    }
    function control(path: string, active: any, done?: () => void): any {
        try {
            if (unloading && typeof w.fetch === "function") {
                w.fetch(url(path, { session: active.id }), {
                    credentials: "omit",
                    keepalive: true,
                    method: "GET",
                }).then(done, done);
                return null;
            }
            return jq.ajax({
                complete: done,
                dataType: "text",
                timeout: 5000,
                type: "GET",
                url: url(path, { session: active.id }),
            });
        } catch (_) {
            if (done) done();
            return null;
        }
    }
    function release(): void {
        var active = session;
        session = null;
        if (!active) return;
        w.clearInterval(active.timer);
        if (active.pending) active.pending.abort();
        releasing++;
        var complete = false;
        control("/video/:/transcode/universal/stop", active, function () {
            if (complete) return;
            complete = true;
            if (--releasing) return;
            var next = waiting;
            waiting = [];
            next.forEach(function (run) {
                run();
            });
        });
    }
    function cancel(): void {
        revision++;
        if (connectTimer !== null) w.clearTimeout(connectTimer);
        connectTimer = null;
        if (resolveTimer !== null) w.clearTimeout(resolveTimer);
        resolveTimer = null;
        var xhr = pending;
        pending = null;
        if (xhr && typeof xhr.abort === "function") xhr.abort();
        if (session && !session.started) release();
    }
    function persist(value: any): any {
        if (typeof value === "string")
            return value.indexOf(config!.token) !== -1 ||
                value.indexOf(encodeURIComponent(config!.token)) !== -1 ||
                /[?&]X-Plex-Token=/i.test(value)
                ? undefined
                : value;
        if (!value || typeof value !== "object") return value;
        var clean: any = Array.isArray(value) ? [] : {};
        Object.keys(value).forEach(function (key) {
            if (
                /^(?:stream_url|__ottPlexPlayback|__ottNativeFile|__proto__|constructor|prototype|token|stop|heartbeat|sessions)$/i.test(
                    key
                )
            )
                return;
            var child = persist(value[key]);
            if (child !== undefined) clean[key] = child;
        });
        return clean;
    }
    function escaped(value: any): string {
        return String(value || "").replace(/[&<>"']/g, function (character) {
            return "&#" + character.charCodeAt(0) + ";";
        });
    }
    function target(path: string, title: string): any {
        return { path: path, plexSource: source, title: title };
    }
    function items(container: any): any[] {
        var rows = plexRows(container.Metadata).concat(
            plexRows(container.Directory),
            plexRows(container.Video),
            plexRows(container.Track)
        );
        plexRows(container.Hub).forEach(function (hub) {
            rows = rows.concat(items(hub));
        });
        return rows;
    }
    function hasPlayablePart(item: any): boolean {
        var media = plexRows(item && item.Media)[0];
        var part = media && plexRows(media.Part)[0];
        return !!(part && plexPath(part.key));
    }
    function itemTitle(item: any): string {
        function text(value: any): string {
            return typeof value === "string" || typeof value === "number"
                ? String(value)
                      .replace(/[\u0000-\u001f\u007f]/g, " ")
                      .replace(/\s+/g, " ")
                      .trim()
                : "";
        }
        var names = [item.title, item.name, item.originalTitle, item.titleSort];
        for (var i = 0; i < names.length; i++) {
            var title = text(names[i]);
            if (title) return title;
        }
        var media = plexRows(item.Media);
        for (var m = 0; m < media.length; m++) {
            if (!media[m] || typeof media[m] !== "object") continue;
            var parts = plexRows(media[m].Part);
            for (var p = 0; p < parts.length; p++) {
                if (!parts[p] || typeof parts[p] !== "object") continue;
                var file = parts[p].file;
                // Part.file is a filesystem path, never a playback URL. Only
                // its final component belongs in the visible catalog label.
                if (
                    typeof file !== "string" ||
                    /^[a-z][a-z0-9+.-]*:\/\//i.test(file)
                )
                    continue;
                var filename = text(file.split(/[\\/]/).pop());
                if (filename && filename !== "." && filename !== "..")
                    return filename;
            }
        }
        return "";
    }
    function records(
        container: any,
        path: string,
        params: any,
        navigation = true,
        title?: string
    ): any[] {
        var root = path === "/library/sections";
        var result: any[] = [];
        var section = /^\/library\/sections\/(\d+)\/all(?:\?|$)/.exec(path);
        if (navigation && section && !Number(params["X-Plex-Container-Start"]))
            result.push({
                __ottMediaLabel: {
                    key: "Browse folders",
                    value: translate("Browse folders"),
                },
                playlist_url: target(
                    "/library/sections/" + section[1] + "/folder",
                    translate("Browse folders")
                ),
                title: translate("Browse folders"),
            });
        items(container).forEach(function (item) {
            if (!item || typeof item !== "object") return;
            var key = plexPath(item.key);
            if (root && /^\d+$/.test(String(item.key)))
                key = "/library/sections/" + item.key + "/all";
            var playable =
                /^(?:movie|episode|clip|track)$/.test(item.type) ||
                plexRows(item.Media).length > 0;
            var id = String(item.ratingKey || "");
            var suppliedTitle = itemTitle(item);
            var titleKey =
                playable && /^\d+$/.test(id) ? "Untitled" : "Untitled folder";
            var title = suppliedTitle || translate(titleKey);
            var record: any = null;
            if (playable && /^\d+$/.test(id)) {
                record = {
                    __ottMediaSequence:
                        item.type === "episode" || item.type === "track",
                    adult: Number(item.adult) === 1 ? 1 : 0,
                    description: escaped(item.summary),
                    plexSource: source,
                    request: { path: "/library/metadata/" + id },
                    stream_url: "plex:request",
                    title: title,
                };
            } else if (key) {
                if (/^\/library\/metadata\/\d+$/.test(key)) key += "/children";
                record = {
                    description: escaped(item.summary),
                    playlist_url: target(key, title),
                    title: title,
                };
            }
            if (record) {
                if (!suppliedTitle)
                    record.__ottMediaLabel = { key: titleKey, value: title };
                result.push(record);
            }
        });
        var offset =
            Number(container.offset) ||
            Number(params["X-Plex-Container-Start"]) ||
            0;
        var count =
            container.size === undefined
                ? items(container).length
                : Number(container.size);
        if (
            navigation &&
            count > 0 &&
            (Number(container.totalSize) > offset + count ||
                // Some PMS responses omit totals. A full page may have more
                // rows; a short or empty page ends this bounded cursor walk.
                (container.totalSize === undefined &&
                    count === 200 &&
                    items(container).length === count &&
                    offset + count < 100000))
        )
            result.push({
                __ottMediaLabel: { key: "Next", value: translate("Next") },
                __ottMediaNext: true,
                playlist_url: {
                    offset: offset + count,
                    path: path,
                    plexSource: source,
                    query: params.query,
                    title: String(
                        title ||
                            container.title2 ||
                            container.title1 ||
                            options.title ||
                            "Plex"
                    ),
                },
                title: translate("Next"),
            });
        if (navigation && root)
            result.push({
                __ottMediaLabel: { key: "Search", value: translate("Search") },
                playlist_url: "plexsearch",
                search_on: 1,
                title: translate("Search"),
            });
        return result;
    }
    function catalogTitle(value: any, data: any): string {
        var selected =
            value && typeof value.title === "string" && value.title.trim();
        return String(
            selected ||
                (data && (data.title2 || data.title1)) ||
                options.title ||
                "Plex"
        );
    }
    /** One cursor request owns neither visible navigation nor playback resolution. */
    function page(
        value: any,
        done: (result: { items: any[]; error?: string }) => void
    ): () => void {
        var token = ++pageRevision;
        if (cancelPage) cancelPage();
        if (token !== pageRevision) return function () {};
        var ended = false;
        var settled = false;
        var pendingPage: any = null;
        function cancelOwned(): void {
            ended = true;
            if (cancelPage === cancelOwned) cancelPage = null;
            var xhr = pendingPage;
            pendingPage = null;
            if (xhr && typeof xhr.abort === "function") xhr.abort();
        }
        function active(): boolean {
            return (
                !ended &&
                !disposed &&
                token === pageRevision &&
                (!options.isCurrent || options.isCurrent())
            );
        }
        function finish(data: any, failed = false): void {
            if (!active()) return;
            var rows: any[] = [];
            try {
                if (!failed) {
                    if (path === "/hubs/search") {
                        var found = items(data);
                        data = {
                            Metadata: found.slice(offset, offset + 200),
                            offset: offset,
                            size: Math.min(
                                200,
                                Math.max(0, found.length - offset)
                            ),
                            totalSize: found.length,
                        };
                    } else if (
                        (data.offset !== undefined &&
                            Number(data.offset) !== offset) ||
                        items(data).length > 200
                    )
                        throw new Error();
                    rows = records(
                        data,
                        path,
                        params,
                        true,
                        catalogTitle(value, data)
                    );
                }
            } catch (_) {
                failed = true;
            }
            ended = true;
            settled = true;
            pendingPage = null;
            if (cancelPage === cancelOwned) cancelPage = null;
            done(
                failed
                    ? { error: translate("Unable to load playlist"), items: [] }
                    : { items: rows }
            );
        }
        cancelPage = cancelOwned;
        if (!active()) {
            cancelOwned();
            return cancelOwned;
        }
        var path =
            value && value.plexSource === source ? plexPath(value.path) : "";
        var offset = value && Number(value.offset);
        var params: any = {
            "X-Plex-Container-Size": 200,
            "X-Plex-Container-Start": offset,
        };
        if (value && typeof value.query === "string")
            params.query = value.query;
        if (
            !/^\/(?:library\/(?:sections(?:\/\d+\/(?:all|folder))?|metadata\/\d+\/children)(?:\?|$)|hubs\/search(?:\?|$))/.test(
                path
            ) ||
            !isFinite(offset) ||
            offset < 0 ||
            Math.floor(offset) !== offset
        ) {
            finish(null, true);
            return cancelOwned;
        }
        if (
            path === "/hubs/search" &&
            search &&
            search.query === params.query &&
            Date.now() - search.at < 15000
        ) {
            finish(search.data);
            return cancelOwned;
        }
        var query =
            path === "/hubs/search"
                ? {
                      limit: 200,
                      query: params.query,
                      "X-Plex-Container-Size": 1000,
                      "X-Plex-Container-Start": 0,
                  }
                : params;
        try {
            var xhr = jq.ajax({
                complete: function () {},
                dataType: "text",
                error: function () {
                    finish(null, true);
                },
                headers: {
                    Accept: "application/json",
                    "X-Plex-Container-Size": String(
                        query["X-Plex-Container-Size"]
                    ),
                    "X-Plex-Container-Start": String(
                        query["X-Plex-Container-Start"]
                    ),
                },
                success: function (raw: any) {
                    if (!active()) return;
                    var data: any;
                    try {
                        data = plexContainer(raw, w);
                    } catch (_) {
                        finish(null, true);
                        return;
                    }
                    if (path === "/hubs/search")
                        search = {
                            at: Date.now(),
                            data: data,
                            query: params.query,
                        };
                    finish(data);
                },
                timeout: 30000,
                type: "GET",
                url: url(path, query),
            });
            if (active()) pendingPage = xhr;
            else if (!settled && xhr && typeof xhr.abort === "function")
                xhr.abort();
        } catch (_) {
            finish(null, true);
        }
        return cancelOwned;
    }
    function collectionPath(value: any): string {
        var path =
            value === "" || value === null || value === undefined
                ? "/library/sections"
                : value &&
                    typeof value === "object" &&
                    value.plexSource === source
                  ? plexPath(value.path)
                  : "";
        // Hub search uses per-hub limits instead of flat offset pagination;
        // never present its possibly truncated snapshot as a complete queue.
        return /^\/library\/(?:sections(?:\/\d+\/(?:all|folder))?|metadata\/\d+\/children)(?:\?|$)/.test(
            path
        )
            ? path
            : "";
    }
    /** Collect a flat catalog independently from the visible navigation request. */
    function collect(
        value: any,
        done: (result: {
            items: any[];
            records: any[];
            error?: string;
        }) => void,
        guard?: () => boolean,
        limits?: {
            kind: string;
            limit: number;
            deadline: number;
            type?: string;
        }
    ): () => void {
        if (cancelCollection) cancelCollection();
        var ended = false;
        var pendingPage: any = null;
        var timer: any = null;
        var started = Date.now();
        var deadline = Math.min(
            started + 120000,
            limits ? limits.deadline : started + 120000
        );
        var offset = 0;
        var pages = 0;
        var total: number | null = null;
        var characters = 0;
        var collected: any[] = [];
        var catalog: any[] = [];
        var seen: any = Object.create(null);
        var seenPages: any = Object.create(null);
        var path = collectionPath(value);
        function cancelOwned(): void {
            if (ended) return;
            ended = true;
            if (cancelCollection === cancelOwned) cancelCollection = null;
            if (timer !== null) w.clearTimeout(timer);
            timer = null;
            var previous = pendingPage;
            pendingPage = null;
            collected = [];
            catalog = [];
            seen = seenPages = null;
            if (previous && previous.xhr) previous.xhr.abort();
        }
        function active(): boolean {
            if (ended) return false;
            var valid =
                !disposed && (!options.isCurrent || options.isCurrent());
            try {
                if (guard && !guard()) valid = false;
            } catch (_) {
                valid = false;
            }
            if (!valid) cancelOwned();
            return valid;
        }
        function finish(error: boolean | string = false): void {
            if (!active()) return;
            var result = error
                ? {
                      error:
                          typeof error === "string"
                              ? error
                              : limits
                                ? "incomplete_library"
                                : translate("Unable to load playlist"),
                      items: [],
                      records: [],
                  }
                : { items: collected, records: catalog };
            cancelOwned();
            done(result);
        }
        function integer(value: any): number | null {
            var number = Number(value);
            return value !== null &&
                value !== "" &&
                isFinite(number) &&
                number >= 0 &&
                Math.floor(number) === number
                ? number
                : null;
        }
        function accept(data: any): void {
            if (!active()) return;
            if (Date.now() >= deadline) {
                finish(true);
                return;
            }
            var rows: any[];
            var page: any[];
            try {
                rows = items(data);
                if (limits && limits.kind === "libraries") {
                    page = rows.map(function (row) {
                        var id = row && String(row.key);
                        if (
                            !id ||
                            !/^[1-9][0-9]{0,19}$/.test(id) ||
                            /\s/.test(id) ||
                            typeof row.title !== "string" ||
                            !row.title.trim() ||
                            typeof row.type !== "string"
                        )
                            throw new Error();
                        var name = row.title
                            .replace(/[\u0000-\u001f\u007f]/g, " ")
                            .replace(/\s+/g, " ")
                            .trim();
                        if (!name) throw new Error();
                        // Reject malformed Unicode before truncating public labels.
                        encodeURIComponent(name);
                        return { id: id, title: name, type: row.type };
                    });
                } else {
                    if (
                        limits &&
                        rows.some(function (row) {
                            return (
                                !row ||
                                row.type !==
                                    (limits.type === "show"
                                        ? "episode"
                                        : "movie") ||
                                !/^[1-9][0-9]{0,19}$/.test(
                                    String(row.ratingKey)
                                ) ||
                                /\s/.test(String(row.ratingKey))
                            );
                        })
                    )
                        throw new Error();
                    if (
                        limits &&
                        rows.some(function (row) {
                            return !hasPlayablePart(row);
                        })
                    ) {
                        finish(
                            "One or more Plex items are unavailable or not playable."
                        );
                        return;
                    }
                    page = records(
                        data,
                        path,
                        { "X-Plex-Container-Start": offset },
                        false
                    );
                    if (limits && page.length !== rows.length)
                        throw new Error();
                }
            } catch (_) {
                finish(true);
                return;
            }
            var count =
                data.size === undefined ? rows.length : integer(data.size);
            var start =
                data.offset === undefined ? offset : integer(data.offset);
            var reported =
                data.totalSize === undefined ? null : integer(data.totalSize);
            if (
                count === null ||
                count !== rows.length ||
                count > 200 ||
                start !== offset ||
                (data.totalSize !== undefined && reported === null) ||
                (reported !== null &&
                    (reported > 100000 ||
                        reported < offset + count ||
                        (total !== null && total !== reported))) ||
                offset + count > 100000
            ) {
                finish(true);
                return;
            }
            if (
                limits &&
                ((reported !== null && reported > limits.limit) ||
                    offset + count > limits.limit)
            ) {
                finish(
                    limits.kind === "libraries"
                        ? "too_many_libraries"
                        : "too_many_items"
                );
                return;
            }
            if (reported !== null) total = reported;
            var signature = JSON.stringify(
                rows.map(function (row) {
                    return row && [row.ratingKey, row.key, row.type];
                })
            );
            if (count && seenPages[signature]) {
                finish(true);
                return;
            }
            if (count) seenPages[signature] = true;
            var duplicate = false;
            page.forEach(function (record) {
                var library = limits && limits.kind === "libraries";
                var playable =
                    library ||
                    (record.request &&
                        record.stream_url &&
                        !record.playlist_url);
                var id = library
                    ? "library:" + record.id
                    : playable
                      ? "item:" + record.request.path
                      : record.playlist_url && record.playlist_url.path
                        ? "folder:" + record.playlist_url.path
                        : "";
                if (!id) return;
                if (seen[id]) {
                    duplicate = true;
                    return;
                }
                seen[id] = true;
                characters += JSON.stringify(record).length;
                catalog.push(record);
                if (playable) collected.push(record);
            });
            if ((limits && duplicate) || characters > 8 * 1024 * 1024) {
                finish(true);
                return;
            }
            offset += count;
            if (
                (total !== null && offset === total) ||
                (total === null && count === 0)
            ) {
                finish();
            } else if (!count || pages >= 1000 || offset >= 100000) {
                finish(true);
            } else {
                // Yield between pages, including transports with synchronous
                // callbacks. Collection never walks into child directories.
                timer = w.setTimeout(function () {
                    timer = null;
                    next();
                }, 0);
            }
        }
        function next(attempt = 1): void {
            if (!active()) return;
            if (Date.now() >= deadline) {
                finish(true);
                return;
            }
            if (attempt === 1) pages++;
            var owner: any = { xhr: null };
            pendingPage = owner;
            var params = {
                "X-Plex-Container-Size": 200,
                "X-Plex-Container-Start": offset,
            };
            function complete(
                data: any,
                error = false,
                retryable = false
            ): void {
                if (!active() || pendingPage !== owner) return;
                pendingPage = null;
                if (
                    error &&
                    retryable &&
                    attempt < 3 &&
                    Date.now() < deadline
                ) {
                    // Retry this offset only; failed reads consume time, not pages.
                    timer = w.setTimeout(
                        function () {
                            timer = null;
                            next(attempt + 1);
                        },
                        Math.min(attempt * 500, deadline - Date.now())
                    );
                } else if (error) finish(true);
                else accept(data);
            }
            try {
                var xhr = jq.ajax({
                    dataType: "text",
                    error: function (xhr: any, status: string) {
                        complete(null, true, retryableRead(xhr, status));
                    },
                    headers: {
                        Accept: "application/json",
                        "X-Plex-Container-Size": "200",
                        "X-Plex-Container-Start": String(offset),
                    },
                    success: function (raw: any) {
                        var data: any;
                        try {
                            data = plexContainer(raw, w);
                        } catch (_) {
                            complete(null, true);
                            return;
                        }
                        complete(data);
                    },
                    timeout: Math.min(
                        30000,
                        Math.max(1, deadline - Date.now())
                    ),
                    type: "GET",
                    url: url(path, params),
                });
                if (pendingPage === owner) owner.xhr = xhr;
            } catch (_) {
                complete(null, true);
            }
        }
        cancelCollection = cancelOwned;
        if (!path) finish(true);
        else next();
        return cancelOwned;
    }
    /** Build the profile playlist progressively, independently of playback and remote queues. */
    function scanFolders(
        folders: Array<{ path: string; title: string }>,
        onBatch: (rows: any[], scanned: number) => void,
        done: (error?: string) => void,
        guard?: () => boolean
    ): () => void {
        var scan = ++scanRevision;
        if (cancelScan) cancelScan();
        if (scan !== scanRevision) return function () {};
        var ended = false;
        var pendingScan: any = null;
        var timer: any = null;
        var watchdog: any = null;
        var roots: string[] = [];
        var paths: any = Object.create(null);
        var labels: any = Object.create(null);
        var seen: any = Object.create(null);
        var signatures: any = Object.create(null);
        var offset = 0;
        var scanned = 0;
        var pages = 0;
        var characters = 0;
        var total: number | null = null;
        function cancelOwned(): void {
            if (ended) return;
            ended = true;
            if (cancelScan === cancelOwned) cancelScan = null;
            if (timer !== null) w.clearTimeout(timer);
            if (watchdog !== null) w.clearTimeout(watchdog);
            var previous = pendingScan;
            pendingScan = null;
            if (previous && previous.xhr) previous.xhr.abort();
        }
        function active(): boolean {
            if (ended) return false;
            if (
                disposed ||
                scan !== scanRevision ||
                (options.isCurrent && !options.isCurrent()) ||
                (guard && !guard())
            ) {
                cancelOwned();
                return false;
            }
            return true;
        }
        function finish(error?: string): void {
            if (!active()) return;
            cancelOwned();
            done(error);
        }
        function heartbeat(): void {
            if (watchdog !== null) w.clearTimeout(watchdog);
            watchdog = w.setTimeout(function () {
                finish("Plex source did not respond");
            }, 60000);
        }
        function enqueue(path: string, title: string): void {
            if (!path || paths[path]) return;
            paths[path] = true;
            labels[path] = title;
            roots.push(path);
        }
        function later(run: () => void, delay = 0): void {
            if (active())
                timer = w.setTimeout(function () {
                    timer = null;
                    if (active()) run();
                }, delay);
        }
        function next(attempt = 1): void {
            if (!active()) return;
            if (!roots.length) return finish();
            if (pages >= 1000 || Object.keys(paths).length > 1000)
                return finish("Plex playlist is too large");
            var path = roots[0];
            var owner: any = { xhr: null };
            pendingScan = owner;
            function complete(
                raw: any,
                failed = false,
                retryable = false
            ): void {
                if (!active() || pendingScan !== owner) return;
                pendingScan = null;
                if (failed) {
                    if (retryable && attempt < 3)
                        return later(function () {
                            next(attempt + 1);
                        }, attempt * 500);
                    return finish("Plex connection failed");
                }
                var data: any;
                var rows: any[];
                try {
                    data = plexContainer(raw, w);
                    rows = items(data);
                } catch (_) {
                    return finish("Invalid Plex response");
                }
                var count =
                    data.size === undefined ? rows.length : Number(data.size);
                var start =
                    data.offset === undefined ? offset : Number(data.offset);
                var reported =
                    data.totalSize === undefined
                        ? null
                        : Number(data.totalSize);
                if (
                    count !== rows.length ||
                    count > 200 ||
                    start !== offset ||
                    (reported !== null &&
                        (!isFinite(reported) ||
                            Math.floor(reported) !== reported ||
                            reported < offset + count ||
                            (total !== null && total !== reported)))
                )
                    return finish("Invalid Plex response");
                var signature =
                    path +
                    ":" +
                    JSON.stringify(
                        rows.map(function (row) {
                            return row && [row.ratingKey, row.key, row.type];
                        })
                    );
                if (count && signatures[signature])
                    return finish("Invalid Plex response");
                signatures[signature] = true;
                pages++;
                if (count) heartbeat();
                scanned += count;
                if (scanned > 100000)
                    return finish("Plex playlist is too large");
                if (reported !== null) total = reported;
                var batch: any[] = [];
                records(data, path, {}, false).forEach(function (record) {
                    if (record.playlist_url) {
                        enqueue(
                            plexFolderPath(record.playlist_url.path),
                            record.title || labels[path]
                        );
                        return;
                    }
                    var id = record.request && record.request.path;
                    if (!id || seen[id]) return;
                    seen[id] = true;
                    record.__ottMediaCollection = labels[path] || "Plex";
                    characters += JSON.stringify(record).length;
                    batch.push(record);
                });
                if (characters > 8 * 1024 * 1024)
                    return finish("Plex playlist is too large");
                onBatch(batch, scanned);
                if (!active()) return;
                offset += count;
                if (
                    (total !== null && offset === total) ||
                    (total === null && count === 0)
                ) {
                    roots.shift();
                    offset = 0;
                    total = null;
                } else if (!count) return finish("Invalid Plex response");
                later(next);
            }
            try {
                var xhr = jq.ajax({
                    dataType: "text",
                    error: function (xhr: any, status: string) {
                        complete(null, true, retryableRead(xhr, status));
                    },
                    headers: {
                        Accept: "application/json",
                        "X-Plex-Container-Size": "200",
                        "X-Plex-Container-Start": String(offset),
                    },
                    success: function (data: any) {
                        complete(data);
                    },
                    timeout: 30000,
                    type: "GET",
                    url: url(path, {
                        "X-Plex-Container-Size": 200,
                        "X-Plex-Container-Start": offset,
                    }),
                });
                if (pendingScan === owner) owner.xhr = xhr;
            } catch (_) {
                complete(null, true);
            }
        }
        cancelScan = cancelOwned;
        if (
            !Array.isArray(folders) ||
            folders.some(function (folder) {
                return !folder || !plexFolderPath(folder.path);
            })
        ) {
            finish("Invalid Plex folder selection");
        } else {
            heartbeat();
            folders.forEach(function (folder) {
                enqueue(plexFolderPath(folder.path), folder.title);
            });
            next();
        }
        return cancelOwned;
    }
    function load(value: any, callback: any): void {
        cancel();
        var token = revision;
        var path = "/library/sections";
        var params: any = {
            "X-Plex-Container-Size": 200,
            "X-Plex-Container-Start": 0,
        };
        if (typeof value === "string" && /^plexsearch\?search=/.test(value)) {
            path = "/hubs/search";
            try {
                params.query = decodeURIComponent(
                    value.slice(value.indexOf("=") + 1)
                );
            } catch (_) {
                params.query = "";
            }
        } else if (
            value &&
            typeof value === "object" &&
            value.plexSource === source
        ) {
            path = plexPath(value.path);
            params["X-Plex-Container-Start"] = Math.max(
                0,
                Number(value.offset) || 0
            );
            if (typeof value.query === "string") params.query = value.query;
        } else if (value !== "" && value !== null && value !== undefined)
            path = "";
        function accept(data: any, error?: string): void {
            if (
                !current(token) ||
                (callback.isCurrent && !callback.isCurrent())
            )
                return;
            if (error) failure();
            if (data && path === "/hubs/search") {
                var found = items(data);
                var offset = Number(params["X-Plex-Container-Start"]) || 0;
                data = {
                    Metadata: found.slice(offset, offset + 200),
                    offset: offset,
                    size: Math.min(200, Math.max(0, found.length - offset)),
                    totalSize: found.length,
                };
            }
            var title = catalogTitle(value, data);
            w.mediaRecords = data
                ? records(data, path, params, true, title)
                : [];
            w.mediaName = title;
            callback();
        }
        if (!path) {
            accept(null, "Invalid catalog");
            return;
        }
        if (
            path === "/library/sections" &&
            sections &&
            Date.now() - sectionsAt < 15000
        )
            accept(sections);
        else if (path === "/hubs/search") {
            if (
                search &&
                search.query === params.query &&
                Date.now() - search.at < 15000
            )
                accept(search.data);
            else
                request(
                    path,
                    {
                        limit: 200,
                        query: params.query,
                        "X-Plex-Container-Size": 1000,
                        "X-Plex-Container-Start": 0,
                    },
                    token,
                    function (data, error) {
                        if (data)
                            search = {
                                at: Date.now(),
                                data: data,
                                query: params.query,
                            };
                        accept(data, error);
                    }
                );
        } else request(path, params, token, accept);
    }
    function codec(media: any, video: boolean): string {
        var name = String(
            video ? media.videoCodec : media.audioCodec
        ).toLowerCase();
        if (video) {
            if (name === "h264") return "avc1.42E01E";
            if (name === "hevc" || name === "h265") {
                var ten = plexRows(
                    plexRows(media.Part)[0] && plexRows(media.Part)[0].Stream
                ).some(function (stream) {
                    return (
                        Number(stream.streamType) === 1 &&
                        Number(stream.bitDepth) > 8
                    );
                });
                return ten ? "hvc1.2.4.L153.B0" : "hvc1.1.6.L123.B0";
            }
            return name === "vp9"
                ? "vp09.00.10.08"
                : name === "vp8"
                  ? "vp8"
                  : name === "av1"
                    ? "av01.0.08M.08"
                    : "";
        }
        return name === "aac"
            ? "mp4a.40.2"
            : name === "mp3"
              ? "mp3"
              : name === "opus" || name === "vorbis" || name === "flac"
                ? name
                : "";
    }
    function originalMime(media: any): string {
        var format = String(media.container || "").toLowerCase();
        if (/^(mp4|m4v|mov)$/.test(format)) return "video/mp4";
        if (format === "webm") return "video/webm";
        if (format === "mkv") return "video/x-matroska";
        if (format === "mp3") return "audio/mpeg";
        if (format === "flac") return "audio/flac";
        if (format === "m4a" || format === "aac") return "audio/mp4";
        if (format === "ogg" || format === "opus") return "audio/ogg";
        return "application/octet-stream";
    }
    function supports(media: any): boolean {
        var mime = originalMime(media);
        if (mime === "application/octet-stream" || mime === "video/x-matroska")
            return false;
        var video = codec(media, true),
            audio = codec(media, false);
        if (
            (!video && media.videoCodec) ||
            (!audio && media.audioCodec) ||
            (!video && !audio)
        )
            return false;
        try {
            return !!w.document
                .createElement("video")
                .canPlayType(
                    mime +
                        '; codecs="' +
                        [video, audio].filter(Boolean).join(",") +
                        '"'
                );
        } catch (_) {
            return false;
        }
    }
    function resolve(item: any, done: (item: any) => void): void {
        cancel();
        var token = revision;
        var finished = false;
        var attempts = 0;
        function finish(playable: any): void {
            if (finished || !current(token)) return;
            finished = true;
            // An owned launch wait must yield before the error dialog takes
            // its place; replacing the wait otherwise cancels this completion.
            var beforeError = (done as any).beforeError;
            if (!playable && typeof beforeError === "function") beforeError();
            if (!current(token)) return;
            if (!playable) failure();
            // A visible error may itself retire this source or navigate away.
            if (current(token)) done(playable);
        }
        if (
            !item ||
            item.plexSource !== source ||
            !item.request ||
            !/^\/library\/metadata\/\d+$/.test(item.request.path)
        ) {
            finish(null);
            return;
        }
        var requestPath = item.request.path;
        release();
        function run(): void {
            if (finished || !current(token)) return;
            attempts++;
            request(requestPath, {}, token, function (data, error, retry) {
                if (finished || !current(token)) return;
                if (retry && attempts < 3) {
                    resolveTimer = w.setTimeout(function () {
                        if (!current(token)) return;
                        resolveTimer = null;
                        run();
                    }, attempts * 500);
                    return;
                }
                if (error || !data) {
                    finish(null);
                    return;
                }
                var entry = items(data)[0];
                var media = entry && plexRows(entry.Media)[0];
                var part = media && plexRows(media.Part)[0];
                var path = part && plexPath(part.key);
                if (!path) {
                    finish(null);
                    return;
                }
                var playable = persist(item);
                playable.plexSource = source;
                if (
                    config!.playback === "original" ||
                    (config!.playback === "auto" && supports(media)) ||
                    !media.videoCodec
                ) {
                    playable.stream_url = url(path);
                    playable.__ottNativeFile = true;
                    playable.__ottPlexPlayback = {
                        mime: originalMime(media),
                        type: "file",
                    };
                    finish(playable);
                    return;
                }
                var active: any = {
                    id: clientId + "-" + ++sequence,
                    started: false,
                    url: "",
                };
                session = active;
                var params: any = {
                    audioBoost: 100,
                    directPlay: 0,
                    directStream: 1,
                    fastSeek: 1,
                    maxVideoBitrate: 12000,
                    mediaIndex: 0,
                    partIndex: 0,
                    path: requestPath,
                    protocol: "hls",
                    session: active.id,
                    videoQuality: 100,
                    videoResolution: "1920x1080",
                    "X-Plex-Client-Identifier": clientId,
                    "X-Plex-Platform": "Chrome",
                    "X-Plex-Product": "OTTPlay",
                };
                var videoCodec = codec(media, true);
                var mse = false;
                try {
                    if (
                        /^hvc1\./.test(videoCodec) &&
                        w.Hls &&
                        typeof w.Hls.isSupported === "function" &&
                        w.Hls.isSupported() &&
                        w.MediaSource &&
                        w.MediaSource.isTypeSupported(
                            'video/mp4; codecs="' + videoCodec + '"'
                        )
                    ) {
                        mse = true;
                        params["X-Plex-Client-Profile-Extra"] =
                            "add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mp4&videoCodec=h264,hevc&audioCodec=aac&replace=true)";
                        if (Number(media.width) > 0 && Number(media.height) > 0)
                            params.videoResolution =
                                media.width + "x" + media.height;
                    }
                } catch (_) {
                    /* Unknown decoder capability keeps the compatible profile. */
                }
                request(
                    "/video/:/transcode/universal/decision",
                    params,
                    token,
                    function (decision, decisionError) {
                        if (finished || !current(token) || session !== active)
                            return;
                        if (
                            decisionError ||
                            !decision ||
                            Number(decision.transcodeDecisionCode || 1001) >=
                                2000
                        ) {
                            release();
                            finish(null);
                            return;
                        }
                        playable.stream_url = active.url = url(
                            "/video/:/transcode/universal/start.m3u8",
                            params
                        );
                        playable.__ottPlexPlayback = {
                            mime: "application/vnd.apple.mpegurl",
                            type: "hls",
                        };
                        if (mse) playable.__ottPlexPlayback.engine = "mse";
                        active.started = true;
                        try {
                            finish(playable);
                        } catch (error) {
                            if (session === active) release();
                            throw error;
                        }
                        if (session !== active) return;
                        active.timer = w.setInterval(function () {
                            if (session !== active || active.pending) return;
                            var finished = false;
                            var ping = control(
                                "/video/:/transcode/universal/ping",
                                active,
                                function () {
                                    finished = true;
                                    active.pending = null;
                                }
                            );
                            if (!finished && session === active)
                                active.pending = ping;
                        }, 30000);
                    }
                );
            });
        }
        if (releasing) waiting.push(run);
        else run();
    }
    function pagehide(): void {
        unloading = true;
        if (cancelPage) cancelPage();
        if (cancelCollection) cancelCollection();
        if (cancelScan) cancelScan();
        cancel();
        release();
        unloading = false;
    }
    // Release before queue/player pagehide handlers attempt a regular stop.
    if (typeof w.addEventListener === "function")
        w.addEventListener("pagehide", pagehide, true);
    return {
        canCollect: function (value: any): boolean {
            return !!collectionPath(value);
        },
        cancel: cancel,
        collect: collect,
        collectLibrary: function (
            library: any,
            done: (result: any) => void,
            guard: () => boolean,
            deadline: number
        ) {
            return collect(
                target(
                    "/library/sections/" +
                        library.id +
                        "/all?type=" +
                        (library.type === "show" ? "4" : "1"),
                    library.title
                ),
                done,
                guard,
                {
                    deadline: deadline,
                    kind: "items",
                    limit: 500,
                    type: library.type,
                }
            );
        },
        connect: function (done: (error?: string) => void) {
            cancel();
            var token = revision;
            var attempts = 0;
            function attempt() {
                connectTimer = null;
                if (!current(token)) return;
                attempts++;
                request(
                    "/library/sections",
                    {},
                    token,
                    function (data, error, retryable) {
                        if (retryable && attempts < 3) {
                            if (options.onRetry) options.onRetry();
                            if (current(token))
                                connectTimer = w.setTimeout(
                                    attempt,
                                    attempts * 2000
                                );
                            return;
                        }
                        if (data) {
                            sections = data;
                            sectionsAt = Date.now();
                        }
                        done(error);
                    }
                );
            }
            attempt();
            return function () {
                if (current(token)) cancel();
            };
        },
        dispose: function () {
            if (typeof w.removeEventListener === "function")
                w.removeEventListener("pagehide", pagehide, true);
            disposed = true;
            if (cancelPage) cancelPage();
            if (cancelCollection) cancelCollection();
            if (cancelScan) cancelScan();
            cancel();
            release();
            sections = null;
            search = null;
        },
        folderChoices: function (value: any, done: (result: any) => void) {
            var cursor = value || target("/library/sections", "Plex");
            var request = {
                offset: cursor.offset === undefined ? 0 : cursor.offset,
                path: cursor.path,
                plexSource: cursor.plexSource,
                title: cursor.title,
            };
            return page(request, function (result) {
                if (result.error) return done(result);
                done({
                    items: result.items
                        .filter(function (row) {
                            return (
                                row.playlist_url &&
                                typeof row.playlist_url === "object" &&
                                (row.__ottMediaNext ||
                                    plexFolderPath(row.playlist_url.path))
                            );
                        })
                        .map(function (row) {
                            var entry = row.playlist_url;
                            if (row.__ottMediaNext)
                                return {
                                    next: true,
                                    target: entry,
                                    title: row.title,
                                };
                            var path = entry.path;
                            var browse = entry;
                            var section =
                                /^\/library\/sections\/([0-9]+)\/all$/.exec(
                                    path
                                );
                            if (section) {
                                var matches = sections
                                    ? items(sections).filter(function (item) {
                                          return (
                                              String(item.key) === section![1]
                                          );
                                      })
                                    : [];
                                path +=
                                    "?type=" +
                                    (matches[0] && matches[0].type === "show"
                                        ? "4"
                                        : matches[0] &&
                                            matches[0].type === "artist"
                                          ? "10"
                                          : "1");
                                browse = target(
                                    "/library/sections/" +
                                        section[1] +
                                        "/folder",
                                    row.title
                                );
                            }
                            return {
                                browse: browse,
                                path: path,
                                title: row.title,
                            };
                        }),
                });
            });
        },
        libraries: function (
            done: (result: any) => void,
            guard: () => boolean,
            deadline: number
        ) {
            return collect(null, done, guard, {
                deadline: deadline,
                kind: "libraries",
                limit: 1000,
            });
        },
        load: load,
        page: page,
        persist: persist,
        play: function (item: any) {
            resolve(item, function (playable) {
                w._playMedia(playable);
            });
        },
        queue: function (ids: string[], done: (result: any) => void) {
            cancel();
            var token = revision;
            request(
                "/library/metadata/" + ids.join(","),
                {},
                token,
                function (data, error) {
                    if (!data || error) return done(null);
                    var found: { [id: string]: any } = Object.create(null);
                    var playable: { [id: string]: boolean } =
                        Object.create(null);
                    items(data).forEach(function (item: any) {
                        if (hasPlayablePart(item))
                            playable[String(item.ratingKey)] = true;
                    });
                    records(data, "", {}, false).forEach(function (row: any) {
                        var match =
                            row.request &&
                            /^\/library\/metadata\/([1-9][0-9]{0,19})$/.exec(
                                row.request.path
                            );
                        if (match && playable[match[1]]) found[match[1]] = row;
                    });
                    var ordered = ids.map(function (id) {
                        return found[id];
                    });
                    done(ordered.every(Boolean) ? ordered : null);
                }
            );
        },
        resolve: resolve,
        scanFolders: scanFolders,
        stableRequests: true,
        stop: function (expected?: string) {
            if (session && expected && session.url !== expected) return;
            cancel();
            release();
        },
    };
}

function plexConfiguredSource(w: any, text: string): string | null {
    try {
        var raw = JSON.parse(text);
        var config = normalizePlexConfig(raw);
        if (!config) return null;
        var account = w.__ottPlexAuth && w.__ottPlexAuth.routing(raw.account);
        return w.__ottSourceIdentity.media({
            __ottActiveProviderDriver: {
                credentials: function () {
                    return {
                        password: config!.token,
                        plexAccount: account,
                        server: config!.address,
                        username: "",
                    };
                },
                id: "plex",
            },
            p_pref: "plex",
        });
    } catch (_) {
        return null;
    }
}

(window as any).__ottPlex = {
    configuredSource: plexConfiguredSource,
    create: createPlexClient,
    folderPath: plexFolderPath,
    normalize: normalizePlexConfig,
    parseContainer: plexContainer,
};

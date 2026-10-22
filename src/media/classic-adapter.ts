/** The provider/UI codec is the only media module that reads the classic host. */
var mediaClassicInstance: any = null;
var mediaClassicSource = "";
var mediaClassicProvider: any = null;
var mediaClassicPlayback: any = null;

/** Installation libraries own their loader and storage independently of TV providers. */
interface ClassicMediaSource {
    client: any;
    read(key: string): string | null;
    readPersisted?(key: string): string | null;
    sourceId: string;
    title: string;
    write(key: string, value: string): void;
}
var mediaClassicContext: ClassicMediaSource | null = null;
var mediaClassicContextRevision = 0;
var mediaClassicSourceHandoff: any = null;

/** A label is generated only while its original value has not been edited. */
function classicMediaLabel(item: any): any {
    var label = item && item.__ottMediaLabel;
    return label &&
        typeof label.key === "string" &&
        typeof label.value === "string" &&
        label.value === item.title
        ? label
        : null;
}
function classicMediaTitle(item: any): string {
    var w = window as any;
    if (item && item.__ottMediaRoute === "history")
        return w._("History of watched movies");
    if (item && item.__ottMediaRoute === "favorites") return w._("Favorites");
    if (item && item.__ottMediaFilter)
        return w._("Filter") + ": " + (item.__ottMediaFilterText || "");
    var label = classicMediaLabel(item);
    // Explicit keys keep the catalog inventory auditable and exclude arbitrary provider keys.
    switch (label && label.key) {
        case "Untitled":
            return w._("Untitled");
        case "Untitled folder":
            return w._("Untitled folder");
        case "??? No channel name":
            return w._("??? No channel name");
        case "Browse folders":
            return w._("Browse folders");
        case "Search":
            return w._("Search");
        case "Filters":
            return w._("Filters");
        case "Next":
            return w._("Next");
        case "Media Library":
            return w._("Media Library");
    }
    return String(
        (item && (item.title || item.name || item.playlist_name)) ||
            w._("Untitled")
    );
}
function classicMediaDescription(item: any, text: string): string {
    var label = classicMediaLabel(item);
    if (!label || label.heading !== true || typeof text !== "string")
        return text;
    function escape(value: string): string {
        return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
    var prefix = "<table><h2><center>" + escape(label.value) + "</center></h2>";
    return text.slice(0, prefix.length) === prefix
        ? "<table><h2><center>" +
              escape(classicMediaTitle(item)) +
              "</center></h2>" +
              text.slice(prefix.length)
        : text;
}
function classicMediaRouteTitle(route: any): string {
    return classicMediaTitle({
        __ottMediaLabel: route.label,
        __ottMediaRoute: route.kind,
        title: route.title,
    });
}

function classicMediaSourceId(): string {
    return mediaClassicContext
        ? mediaClassicContext.sourceId
        : (window as any).__ottSourceIdentity.media(window);
}

/** Scalar neighbours avoid cloning large channel lists on every footer tick. */
function classicMediaNeighbours(list: any, id: any): any {
    if (list.neighbours) return list.neighbours(id);
    var members = list.members();
    var index = -1;
    for (var i = 0; i < members.length; i++)
        if (String(members[i]) === String(id)) {
            index = i;
            break;
        }
    return index < 0
        ? null
        : {
              id: members[index],
              index: index,
              length: members.length,
              nextId: members[(index + 1) % members.length],
          };
}

/** Project the playing collection and its already-known successor without I/O. */
function classicMediaProgramme(): any {
    var w = window as any;
    var state = w.__ottClassicPlayback.snapshot();
    var target = state.target;
    if (!target || target.kind !== "vod") return null;
    var playing = mediaClassicPlayback;
    var local = w.__ottActiveProviderDriver?.id === "offline";
    var history = state.historyTarget;
    var sequence: any = null;
    var payload: any = null;
    var channel: any = null;
    var mode = "all";
    if (
        history?.kind === "live" &&
        target.channelId === "channel:" + history.channelId
    ) {
        if (target.sourceId !== w.__ottClassicPlayback.sourceId()) return null;
        payload = w.channels[history.channelId];
        if (!payload) return null;
        if (local && typeof history.payload?.groupId === "string") {
            var category = w.__ottChannels?.index(history.payload.groupId);
            var list =
                category >= 0 ? w.__ottChannels?.capture(category) : null;
            var neighbour = list?.active()
                ? classicMediaNeighbours(list, history.channelId)
                : null;
            if (neighbour) channel = { id: neighbour.id, list: list };
        }
        if (mediaClassicInstance?.active())
            mode = mediaClassicInstance.repeatMode();
        else {
            var saved = w.providerGetItem?.(
                "mediaRepeat.v1:" + classicMediaSourceId()
            );
            if (saved === "one" || saved === "off") mode = saved;
        }
    } else {
        if (
            !playing ||
            playing.ref.sourceId !== target.sourceId ||
            playing.ref.itemId !== target.channelId
        )
            return null;
        payload = playing.payload;
        sequence = playing.sequence;
        channel = sequence?.channel;
        mode = sequence?.repeat || "all";
    }
    if (!payload) return null;
    var collection =
        payload.__ottMediaCollection ||
        payload.__ottMediaOrigin?.title ||
        payload.category?.name ||
        "";
    var title = payload.channel_name || classicMediaTitle(payload);
    var nextTitle = "";
    if (channel && channel.list.active()) {
        var neighbours = classicMediaNeighbours(channel.list, channel.id);
        if (neighbours) {
            var folderId = w.__ottKiosk?.folderLoop?.()
                ? w.__ottKiosk.folderNext(channel.id, channel.list.members())
                : null;
            var pinned =
                !w.__ottKiosk?.folderLoop?.() &&
                w.__ottKiosk?.locked() &&
                w.__ottKiosk.allowed(channel.id);
            var repeatOne = pinned || mode === "one";
            if (
                repeatOne ||
                folderId !== null ||
                mode !== "off" ||
                neighbours.index + 1 < neighbours.length
            ) {
                var nextRow =
                    w.channels[
                        folderId !== null
                            ? folderId
                            : repeatOne
                              ? neighbours.id
                              : neighbours.nextId
                    ];
                nextTitle =
                    nextRow?.channel_name ||
                    (nextRow?.__ottMediaItem
                        ? classicMediaTitle(nextRow.__ottMediaItem)
                        : "");
            }
        }
        var currentRow = w.channels[channel.id];
        collection =
            currentRow?.__ottMediaCollection ||
            collection ||
            currentRow?.category?.name ||
            "";
    } else if (sequence?.items?.length) {
        var next = mode === "one" ? sequence.index : sequence.index + 1;
        if (mode !== "off" || next < sequence.items.length) {
            var item = sequence.items[next % sequence.items.length];
            nextTitle = item ? classicMediaTitle(item.payload || item) : "";
        }
    }
    return {
        collection: String(collection),
        nextTitle: String(nextTitle),
        title: String(title),
    };
}

function classicMediaClient(): any {
    return mediaClassicContext
        ? mediaClassicContext.client
        : (window as any).providerMediaClient;
}

function serializeMediaIdentity(value: any): string {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return "[" + value.map(serializeMediaIdentity).join(",") + "]";
    return (
        "{" +
        Object.keys(value)
            .sort()
            .filter(function (key) {
                return (
                    typeof value[key] !== "function" && value[key] !== undefined
                );
            })
            .map(function (key) {
                return (
                    JSON.stringify(key) +
                    ":" +
                    serializeMediaIdentity(value[key])
                );
            })
            .join(",") +
        "}"
    );
}

function classicMediaRuntime(): any {
    var w = window as any;
    var context = mediaClassicContext;
    var mediaClient = classicMediaClient();
    var source = classicMediaSourceId();
    var provider = context ? context.client.load : w.getMediaArray;
    if (
        mediaClassicInstance &&
        mediaClassicInstance.active() &&
        mediaClassicSource === source &&
        mediaClassicProvider === provider
    )
        return mediaClassicInstance;
    var previous = mediaClassicInstance;
    mediaClassicInstance = null;
    if (previous) previous.cancel();
    if (
        mediaClassicInstance ||
        context !== mediaClassicContext ||
        source !== classicMediaSourceId()
    )
        return classicMediaRuntime();
    mediaClassicSource = source;
    mediaClassicProvider = provider;
    // A playing installation keeps its journal and catalog when another library is browsed.
    if (
        context &&
        mediaClassicPlayback &&
        mediaClassicPlayback.runtime.active()
    ) {
        mediaClassicInstance = mediaClassicPlayback.runtime;
        mediaClassicInstance.restoreProjection();
        return mediaClassicInstance;
    }
    var get = context ? context.read : w.providerGetItem;
    var set = context ? context.write : w.providerSetItem;
    var copy = w.__ottMediaLibrary.copy;
    var library: any;
    var checkpointTime = 0;
    var checkpointItem = "";
    var rendering = false;
    var filterText = "";
    var pendingStart: any = null;
    var automaticRequest: any = null;
    var automaticGeneration = 0;
    var completedLocalGeneration = -1;
    var collectionRequest: any = null;
    var shuffleRequest: any = null;
    var completionRequest: any = null;
    var skipRequest: any = null;
    var startupLoading: ScreenOwner | null = null;
    var manualLoading: any = null;
    var restored = false;
    var repeat = "all";
    var repeatKey = "mediaRepeat.v1:" + source;
    var screenOwner: any = null;
    var screenRevision = -1;
    var pageScheduled = -1;
    function finishStartupLoading() {
        var owner = startupLoading;
        startupLoading = null;
        if (owner) owner.close();
    }
    function finishManualLoading(request: any, cancelled = false) {
        if (!request) return;
        if (cancelled) request.cancelled = true;
        if (manualLoading !== request) return;
        manualLoading = null;
        request.owner.close();
    }
    function showLoading(
        cancel: () => void,
        item?: MediaLibraryItem,
        navigate?: (direction: number) => void
    ) {
        var owner = w.__ottClassicScreenPort.setOwnedCallback(
            "dialog",
            function (key: number) {
                if (key === w.keys.RETURN || key === w.keys.EXIT) cancel();
                else if (navigate && (key === w.keys.UP || key === w.keys.DOWN))
                    navigate(key === w.keys.UP ? 1 : -1);
            }
        ).owner;
        var title = w.document.createElement("div");
        if (item) title.textContent = classicMediaTitle(item.payload);
        w.$("#dialogbox")
            .html(
                '<center><div class="ott-spinner" aria-hidden="true"><span class="blob"></span><span class="blob"></span><span class="blob"></span><span class="blob"></span></div></center><br/>' +
                    w._("Loading. Please wait...") +
                    "<br/>" +
                    title.innerHTML +
                    "<br/><br/>" +
                    w.renderButtonHint(w.keys.RETURN, w.strRETURN, "Cancel")
            )
            .show();
        return owner;
    }
    function finishSkipLoading(request: any) {
        var owner = request && request.loading;
        if (!owner) return;
        request.loading = null;
        owner.close();
    }
    function beginSkipLoading(request: any, item?: MediaLibraryItem) {
        var screen = w.__ottClassicScreenPort;
        // Explicit full-screen navigation may show a wait. Background queue
        // changes and a foreground list, editor or dialog keep their own UI.
        if (!request.feedback || screen.screens.current() || w.isListVisible)
            return;
        var owner = showLoading(
            function () {
                if (skipRequest === request) api.cancelAuto();
            },
            item,
            skipPlayback
        );
        request.loading = owner;
        owner.own(function () {
            if (skipRequest === request && request.loading === owner)
                api.cancelAuto();
        });
    }
    function restoreLoadingList(request: any) {
        if (!current()) return;
        if (request && request.channel) {
            if (w.channelsList) w.channelsList(w.catIndex, w.primaryIndex);
        } else library.show();
    }
    function beginManualLoading(item: MediaLibraryItem, channel = false) {
        if (!channel && !item.payload.plexSource && w.p_pref !== "plex")
            return null;
        var request: any = { cancelled: false, channel: channel, owner: null };
        request.owner = showLoading(function () {
            if (manualLoading !== request) return;
            api.cancelAuto();
            restoreLoadingList(request);
        }, item);
        manualLoading = request;
        request.owner.own(function () {
            // Replacing the dialog or leaving its list also retires the launch.
            if (manualLoading === request) api.cancelAuto();
        });
        return request;
    }
    function bindScreen() {
        var screen = w.__ottClassicScreenPort;
        var owner = screen && screen.listOwner();
        if (!owner) return;
        var revision = library.revision();
        if (screenOwner === owner && screenRevision === revision) return;
        screenOwner = owner;
        screenRevision = revision;
        owner.own(function () {
            if (!rendering && revision === library.revision()) api.cancel();
        });
    }
    function current() {
        return (
            context === mediaClassicContext &&
            source === classicMediaSourceId() &&
            (context
                ? provider === context.client.load
                : provider === w.getMediaArray &&
                  get === w.providerGetItem &&
                  set === w.providerSetItem)
        );
    }
    function ownsPlayback() {
        return (
            context &&
            mediaClassicPlayback &&
            mediaClassicPlayback.runtime === api
        );
    }
    function persistent() {
        return current() || ownsPlayback();
    }
    function limit() {
        return (
            [0, 10, 20, 30, 40, 50][Number(w.sMedCount)] ||
            (Number(w.sMedCount) === 0 ? 0 : 20)
        );
    }
    function describe(records: any[], route: MediaRoute): MediaLibraryItem[] {
        var titles: { [key: string]: number } = Object.create(null);
        return records
            .filter(function (row) {
                return row && typeof row === "object" && !row.__ottMediaFilter;
            })
            .map(function (row) {
                var payload = copy(row);
                var title = String(
                    row.title || row.name || row.playlist_name || ""
                );
                var ref = row.__ottMediaRef;
                var explicit =
                    row.itemId !== undefined
                        ? row.itemId
                        : row.media_id !== undefined
                          ? row.media_id
                          : row.episode_id !== undefined
                            ? row.episode_id
                            : row.stream_id !== undefined
                              ? row.stream_id
                              : row.id;
                var id: string;
                if (
                    ref &&
                    ref.sourceId === source &&
                    typeof ref.itemId === "string" &&
                    ref.itemId
                )
                    id = ref.itemId;
                else if (
                    explicit !== undefined &&
                    explicit !== null &&
                    String(explicit)
                )
                    id = "provider:" + String(explicit);
                else if (row.request)
                    id = "request:" + serializeMediaIdentity(row.request);
                else if (row.playlist_url && !row.submenu)
                    id = "route:" + serializeMediaIdentity(row.playlist_url);
                else {
                    var origin = row.__ottMediaOrigin || route;
                    var location = origin.target || "";
                    var label = classicMediaLabel(row);
                    var identityTitle = label ? "\u0000" + label.key : title;
                    var titleKey = serializeMediaIdentity([
                        location,
                        identityTitle,
                    ]);
                    var occurrence = titles[titleKey] || 0;
                    titles[titleKey] = occurrence + 1;
                    // Providers without IDs get a catalog-local identity, never a signed stream URL.
                    id =
                        "catalog:" +
                        serializeMediaIdentity([
                            location,
                            identityTitle,
                            occurrence,
                        ]);
                }
                var identity = { itemId: id, sourceId: source };
                payload.__ottMediaRef = identity;
                if (!payload.__ottMediaOrigin && route.kind === "catalog")
                    payload.__ottMediaOrigin = copy(route);
                return { payload: payload, ref: identity, title: title };
            });
    }
    function entry(item: MediaLibraryItem, position = 0) {
        var payload = copy(item.payload);
        // Direct sources resolve access URLs afresh; journals keep stable IDs only.
        if (mediaClient && typeof mediaClient.persist === "function")
            payload = mediaClient.persist(payload);
        return {
            itemId: item.ref.itemId,
            payload: payload,
            position: position,
            sourceId: source,
        };
    }
    var journal = w.__ottMediaJournal.create({
        core: w.OttPlayCore,
        enabled: function () {
            return w.sFavorites !== -1;
        },
        importRows: function (rows: any[]) {
            return describe(rows, { kind: "history", title: "" })
                .map(function (item) {
                    item.payload.__ottMediaImported = true;
                    var position = Number(item.payload.current);
                    return entry(
                        item,
                        isFinite(position) && position >= 0 ? position : 0
                    );
                })
                .slice(0, 1000);
        },
        legacyId: context ? source : w.__ottSourceIdentity.legacy(w),
        limit: limit,
        read: function (key: string) {
            if (!persistent()) throw new Error("Media source replaced");
            var result = typeof get === "function" ? get.call(w, key) : null;
            if (!persistent()) throw new Error("Media source replaced");
            return result;
        },
        sourceId: source,
        write: function (key: string, value: string) {
            if (!persistent() || w.sFavorites === -1)
                throw new Error("Media persistence unavailable");
            if (typeof set === "function") set.call(w, key, value);
        },
    });
    function collections() {
        var document = journal.read().document;
        if (!current()) return document;
        function project(rows: any[]) {
            return rows.map(function (row) {
                var payload = copy(row.payload);
                payload.current = row.position;
                payload.__ottMediaRef = {
                    itemId: row.itemId,
                    sourceId: source,
                };
                payload.__ottMediaRefresh = true;
                return payload;
            });
        }
        w.medHistory = project(document.history);
        w.medFavorites = project(document.favorites);
        return document;
    }
    function project(view: MediaLibraryView, render = true) {
        if (!current()) return;
        (view as any).filter = filterText;
        decorate(view);
        var frame = view.frame;
        // Provider codecs may append incremental rows to this full-page projection.
        w.mediaRecords = library
            .catalog()
            .filter(function (item: MediaLibraryItem) {
                return !item.payload.__ottMediaRoute;
            })
            .map(function (item: MediaLibraryItem) {
                return item.payload;
            });
        w.mediaName = frame ? classicMediaRouteTitle(frame.route) : "";
        w.mediaNames = view.frames.map(function (row) {
            return classicMediaRouteTitle(row.route);
        });
        // Read-only projections for provider codecs. Navigation never reads these arrays back.
        w.mediaUrls = view.frames.map(function (row) {
            return row.route.target === undefined
                ? row.route.kind
                : row.route.target;
        });
        w.mediaSelects = view.frames
            .slice()
            .reverse()
            .map(function (row) {
                return row.selected;
            });
        w.mediaRecordsPar = null;
        if (render && typeof w.__ottRenderMedia === "function") {
            rendering = true;
            try {
                w.__ottRenderMedia(view);
            } finally {
                rendering = false;
            }
            bindScreen();
        }
    }
    function load(route: MediaRoute, done: any) {
        bindScreen();
        if (!current() || typeof provider !== "function") {
            done([], route.title);
            return;
        }
        var marker = {};
        w._mediaLoadState = marker;
        var complete: any = function () {
            if (!complete.isCurrent()) {
                if (mediaClassicInstance)
                    mediaClassicInstance.restoreProjection();
                return;
            }
            var records = w.mediaRecords;
            var title = w.mediaName;
            project(library.snapshot("none"), false);
            done(copy(records || []), title);
        };
        complete.isCurrent = function () {
            return (
                current() &&
                w._mediaLoadState === marker &&
                (done.active ? done.active() : done.isCurrent())
            );
        };
        complete.publish = function (
            records: any[],
            title?: string,
            selected?: number
        ) {
            if (complete.isCurrent() && done.update)
                done.update(copy(records), title, selected);
        };
        provider(route.target === undefined ? "" : route.target, complete);
        return function () {
            if (current() && classicMediaClient())
                classicMediaClient().cancel();
        };
    }
    function collectionItems(kind: string) {
        collections();
        return describe(kind === "history" ? w.medHistory : w.medFavorites, {
            kind: kind as any,
            title: "",
        });
    }
    function normalizedFilter(value: string) {
        return w
            .normalizeSearchText(value)
            .replace(/ё/g, "е")
            .replace(/\s+/g, " ")
            .trim();
    }
    function playable(item: MediaLibraryItem) {
        var payload = item.payload;
        return (
            !payload.__ottMediaFilter &&
            !payload.__ottMediaRoute &&
            !payload.playlist_url &&
            !!(payload.stream_url || payload.request)
        );
    }
    function authorize(
        item: MediaLibraryItem,
        proceed: () => void,
        rejected?: () => void
    ) {
        if (
            Number(item.payload.adult) === 1 &&
            w.sPSchannels &&
            w.parentPIN !== "*" &&
            !w.parentAccess
        )
            w.enterPinAndSetAccess(proceed, rejected);
        else proceed();
    }
    function decorate(view: any) {
        view.repeat = repeat;
        view.shuffle = shuffleRequest
            ? "loading"
            : mediaClassicPlayback &&
                mediaClassicPlayback.runtime === api &&
                mediaClassicPlayback.sequence &&
                mediaClassicPlayback.sequence.ordered
              ? "on"
              : "off";
        view.canRepeat = !!(
            !view.loading &&
            view.frame &&
            view.frame.route.kind === "catalog" &&
            view.frame.items.some(playable)
        );
        view.canShuffle = view.canRepeat && canCollect(view.frame.route.target);
    }
    function updateControls() {
        if (!current() || typeof w.__ottUpdateMediaControls !== "function")
            return;
        var view = {};
        decorate(view);
        w.__ottUpdateMediaControls(view);
    }
    function canCollect(target: any) {
        return (
            !mediaClient ||
            typeof mediaClient.canCollect !== "function" ||
            mediaClient.canCollect(target)
        );
    }
    var libraryPorts = {
        describe: function (records: any[], route: MediaRoute) {
            var items = describe(records, route);
            if (
                library.snapshot("none").frames.length === 1 &&
                w.sFavorites !== -1
            ) {
                if (limit())
                    items.push({
                        payload: {
                            __ottMediaRoute: "history",
                            title: w._("History of watched movies"),
                        },
                        ref: { itemId: "view:history", sourceId: source },
                        title: w._("History of watched movies"),
                    });
                items.push({
                    payload: {
                        __ottMediaRoute: "favorites",
                        title: w._("Favorites"),
                    },
                    ref: { itemId: "view:favorites", sourceId: source },
                    title: w._("Favorites"),
                });
            }
            return items;
        },
        filter: function (items: MediaLibraryItem[], route: MediaRoute) {
            if (route.kind === "variants") return items;
            var query = normalizedFilter(filterText);
            var result = items.filter(function (item) {
                var payload = item.payload;
                return (
                    !query ||
                    (route.kind === "catalog" && payload.__ottMediaSequence) ||
                    !(
                        payload.__ottMediaFilterable ||
                        (!payload.playlist_url &&
                            (payload.stream_url || payload.request))
                    ) ||
                    normalizedFilter(classicMediaTitle(item.payload)).indexOf(
                        query
                    ) !== -1
                );
            });
            var title = w._("Filter") + ": " + filterText;
            result.push({
                payload: {
                    __ottMediaFilter: true,
                    __ottMediaFilterText: filterText,
                    title: title,
                },
                ref: { itemId: "view:filter", sourceId: source },
                title: title,
            });
            return result;
        },
        items: function (route: MediaRoute) {
            return route.kind === "variants"
                ? describe(route.target || [], route)
                : collectionItems(route.kind);
        },
        load: load,
        page:
            mediaClient && typeof mediaClient.page === "function"
                ? function (route: MediaRoute, done: any) {
                      return mediaClient.page(
                          route.target,
                          function (result: any) {
                              if (!current() || !done.isCurrent()) return;
                              // Replacing the list would dismiss an editor or
                              // dialog opened while the quiet request ran.
                              if (screenOwner && !screenOwner.foreground()) {
                                  library.cancelPage();
                                  return;
                              }
                              var records = copy(result.items || []);
                              if (mediaClient.stableRequests) {
                                  var frame = library.snapshot("none").frame;
                                  if (frame)
                                      records.forEach(function (row: any) {
                                          row.__ottMediaOrigin = copy(
                                              frame.route
                                          );
                                      });
                              }
                              done(records, result.error);
                          }
                      );
                  }
                : undefined,
        render: project,
    };
    library = w.__ottMediaLibrary.create(libraryPorts);
    // Background episode resolution must not revoke catalogue or editor ownership.
    var automaticLibrary = w.__ottMediaLibrary.create(libraryPorts);
    function cancelNavigationAuto() {
        var admitted = library.capture();
        api.cancelAuto();
        return current() && admitted();
    }
    function navigate(route: MediaRoute, reset = false) {
        if (cancelNavigationAuto()) library.open(route, reset);
    }
    function sequenceFor(item: MediaLibraryItem, complete = true) {
        var frame =
            complete && item.payload.__ottMediaSequence
                ? library.snapshot("current").frame
                : null;
        if (!frame || frame.route.kind !== "catalog")
            return repeat === "one" && playable(item)
                ? { index: 0, items: [item], placeholder: true, repeat: repeat }
                : null;
        var items = frame.items.filter(function (row: MediaLibraryItem) {
            return (
                row.payload.__ottMediaSequence &&
                !row.payload.playlist_url &&
                (row.payload.stream_url || row.payload.request)
            );
        });
        var index = -1;
        items.forEach(function (row: MediaLibraryItem, position: number) {
            if (row.ref.itemId === item.ref.itemId) index = position;
        });
        return index < 0
            ? null
            : { index: index, items: items, repeat: repeat };
    }
    function navigationFor(item: MediaLibraryItem) {
        var origin = item.payload.__ottMediaOrigin;
        if (!origin || origin.kind !== "catalog") return [];
        var saved = item.payload.__ottMediaTrail;
        var trail =
            Array.isArray(saved) &&
            saved.length > 0 &&
            saved.length <= 64 &&
            saved.every(function (frame: any) {
                return (
                    frame &&
                    frame.route &&
                    frame.route.kind === "catalog" &&
                    typeof frame.route.title === "string" &&
                    typeof frame.selected === "number" &&
                    frame.selected >= 0
                );
            })
                ? copy(saved)
                : [];
        if (!trail.length) {
            if (origin.target)
                trail.push({
                    route: {
                        kind: "catalog",
                        target: "",
                        title: context ? context.title : w._("Media Library"),
                    },
                    selected: 0,
                });
            trail.push({ route: copy(origin), selected: 0 });
        }
        // Collected catalogs start at zero even when the saved file was chosen
        // from a later page. Its stable ID supplies the restored selection.
        var last = trail[trail.length - 1];
        last.route = copy(origin);
        if (last.route.target && typeof last.route.target === "object")
            delete last.route.target.offset;
        return trail;
    }
    function collectFolder(
        item: MediaLibraryItem,
        guard: () => boolean,
        done: (folder: any) => void
    ) {
        var origin = item.payload.__ottMediaOrigin;
        if (
            !mediaClient ||
            !mediaClient.stableRequests ||
            typeof mediaClient.collect !== "function" ||
            !origin ||
            origin.kind !== "catalog" ||
            !canCollect(origin.target)
        ) {
            done(null);
            return;
        }
        rememberNavigation(item);
        var revision = automaticGeneration;
        var generation = w.__ottClassicPlayback.snapshot().generation;
        var ticket: any = { cancel: null };
        collectionRequest = ticket;
        var received = false;
        function valid() {
            return (
                current() &&
                guard() &&
                automaticGeneration === revision &&
                w.__ottClassicPlayback.snapshot().generation === generation
            );
        }
        function accept(result: any) {
            if (received || collectionRequest !== ticket || !valid()) return;
            received = true;
            collectionRequest = null;
            var folder: any = false;
            if (result && !result.error && Array.isArray(result.items)) {
                var seen: any = Object.create(null);
                var items = describe(result.items, origin).filter(
                    function (row) {
                        if (!playable(row) || seen[row.ref.itemId])
                            return false;
                        seen[row.ref.itemId] = true;
                        return true;
                    }
                );
                var index = -1;
                items.forEach(function (row, position) {
                    row.payload.__ottMediaTrail = item.payload.__ottMediaTrail;
                    if (row.ref.itemId === item.ref.itemId) index = position;
                });
                // A moved or removed file must never continue in another folder.
                if (index >= 0)
                    folder = {
                        catalog: describe(
                            result.records || result.items,
                            origin
                        ),
                        sequence: {
                            index: index,
                            items: items,
                            repeat: repeat,
                        },
                    };
            }
            done(folder);
        }
        try {
            var cancel = mediaClient.collect(origin.target, accept, valid);
            if (typeof cancel === "function" && !received) {
                if (collectionRequest === ticket && valid())
                    ticket.cancel = cancel;
                else cancel();
            }
        } catch (_) {
            accept(null);
        }
    }
    function skipPlayback(direction: number) {
        var playback = mediaClassicPlayback;
        var sequence = playback && playback.sequence;
        if (!playback || playback.runtime !== api || !direction) return;
        if (sequence && sequence.channel) {
            movePlaylistEntry(playback, direction, false);
            return;
        }
        var owner = w.__ottClassicScreenPort.screens.current();
        var feedback =
            /^plex(?:@|$)/.test(playback.ref.sourceId) &&
            w.playType < 0 &&
            !w.isListVisible &&
            (!owner || (skipRequest && owner === skipRequest.loading));
        var recovering =
            !sequence || !sequence.items.length || sequence.placeholder;
        if (
            recovering &&
            skipRequest &&
            skipRequest.playback === playback &&
            skipRequest.recovering &&
            skipRequest.valid()
        ) {
            skipRequest.offset += direction;
            return;
        }
        var index = recovering
            ? 0
            : (skipRequest && skipRequest.playback === playback
                  ? skipRequest.index
                  : sequence.index) + direction;
        if (
            !recovering &&
            sequence.repeat === "off" &&
            (index < 0 || index >= sequence.items.length)
        )
            return;
        var admitted = library.capture();
        var generation = w.__ottClassicPlayback.snapshot().generation;
        var revision = automaticGeneration + 1;
        var request: any;
        api.cancelAuto();
        function valid(afterEnd = false) {
            var state = w.__ottClassicPlayback.snapshot();
            return (
                current() &&
                admitted() &&
                mediaClassicPlayback === playback &&
                (!request || skipRequest === request) &&
                automaticGeneration === revision &&
                state.generation === generation + (afterEnd ? 1 : 0) &&
                state.target &&
                state.target.kind === "vod" &&
                state.target.sourceId === source &&
                state.target.channelId === playback.ref.itemId
            );
        }
        if (!valid()) return;
        // A resumed file can outlive a failed folder request. Recover its
        // original siblings when an arrow is pressed, including Repeat One.
        if (recovering) {
            request = {
                feedback: feedback,
                offset: direction,
                playback: playback,
                recovering: true,
                valid: valid,
            };
            skipRequest = request;
            beginSkipLoading(request);
            if (!valid()) return;
            var saved = describe([playback.payload], {
                kind: "history",
                title: "",
            })[0];
            collectFolder(saved, valid, function (folder) {
                if (!valid()) return;
                finishSkipLoading(request);
                skipRequest = null;
                if (!folder) {
                    if (w.showShift)
                        w.showShift(w._("Unable to load playlist"));
                    return;
                }
                playback.sequence = folder.sequence;
                skipPlayback(request.offset);
            });
            return;
        }
        index =
            ((index % sequence.items.length) + sequence.items.length) %
            sequence.items.length;
        if (index === sequence.index) return;
        request = {
            feedback: feedback,
            index: index,
            playback: playback,
            valid: valid,
        };
        skipRequest = request;
        var item = sequence.items[index];
        function finish() {
            finishSkipLoading(request);
            if (skipRequest === request) skipRequest = null;
        }
        authorize(
            item,
            function () {
                if (!valid()) return;
                beginSkipLoading(request, item);
                if (!valid()) return;
                resolve(
                    item,
                    {
                        explicit: sequence.explicit,
                        index: index,
                        items: sequence.items,
                        onError: sequence.onError,
                        ordered: sequence.ordered,
                        queueId: sequence.queueId,
                        repeat: sequence.repeat,
                    },
                    true,
                    valid,
                    undefined,
                    undefined,
                    finish
                );
            },
            finish
        );
    }
    function rememberNavigation(item: MediaLibraryItem) {
        if (!mediaClient || !mediaClient.stableRequests) return;
        var view = library.snapshot("none");
        if (
            view.frame &&
            view.frame.route.kind === "catalog" &&
            item.payload.__ottMediaOrigin &&
            serializeMediaIdentity(view.frame.route.target) ===
                serializeMediaIdentity(item.payload.__ottMediaOrigin.target)
        )
            item.payload.__ottMediaTrail = view.frames
                .slice(-64)
                .map(function (frame) {
                    return { route: frame.route, selected: frame.selected };
                });
    }
    function restoreFolder(item: MediaLibraryItem, folder: any) {
        var trail = navigationFor(item);
        if (!library.restore(trail, folder.catalog, item.ref)) return false;
        // Every next sibling carries the same breadcrumb, not a playlist copy.
        item.payload.__ottMediaTrail = trail;
        folder.sequence.items.forEach(function (row: MediaLibraryItem) {
            row.payload.__ottMediaTrail = trail;
        });
        project(library.snapshot("none"), false);
        return true;
    }
    function deferLocalEnd(generation: number): boolean {
        if (
            w.__ottActiveProviderDriver?.id !== "offline" ||
            !w.__ottKiosk?.screenBlocked?.()
        )
            return false;
        var revision = automaticGeneration;
        w.__ottKiosk.deferScreenEnd(function () {
            if (
                current() &&
                automaticGeneration === revision &&
                w.__ottClassicPlayback.snapshot().generation === generation
            ) {
                if (completedLocalGeneration === generation)
                    completedLocalGeneration = -1;
                api.ended(generation);
            }
        });
        return true;
    }
    /** Channel order remains owned by the standard list, including live appends. */
    function movePlaylistEntry(
        playback: any,
        direction: number,
        natural: boolean,
        admit?: () => boolean
    ) {
        if (
            natural &&
            (w.__ottStandby?.blocked() ||
                deferLocalEnd(w.__ottClassicPlayback.snapshot().generation))
        )
            return;
        var channel = playback.sequence && playback.sequence.channel;
        if (!channel || !channel.list || !channel.list.active()) return;
        var members = channel.list.members();
        var index = members.indexOf(channel.id);
        if (index < 0 || !members.length) return;
        if (natural && w.__ottKiosk?.folderLoop?.()) {
            var folderId = w.__ottKiosk.folderNext(channel.id, members);
            var folderIndex = members.indexOf(folderId);
            var folderCategory = channel.list.category();
            if (folderIndex < 0 || folderCategory < 0) return;
            w.playChannel(
                folderCategory,
                folderIndex,
                false,
                admit,
                undefined,
                true,
                true
            );
            return;
        }
        var pinned =
            natural &&
            w.__ottKiosk &&
            w.__ottKiosk.locked() &&
            w.__ottKiosk.allowed(channel.id);
        var next =
            natural && (pinned || repeat === "one") ? index : index + direction;
        if (natural && !pinned && repeat === "off" && next >= members.length)
            return;
        next = ((next % members.length) + members.length) % members.length;
        var category = channel.list.category();
        if (category < 0) return;
        w.playChannel(
            category,
            next,
            !natural,
            admit,
            undefined,
            natural,
            true
        );
    }
    function resolve(
        item: MediaLibraryItem,
        sequence: any = null,
        automatic = false,
        guard: () => boolean = current,
        dispatched?: () => void,
        startup?: { position: number; unavailable(): void; resolved?: any },
        settled?: (dispatched?: boolean) => void,
        admit?: (payload: any) => boolean
    ) {
        var loading =
            automatic && !(sequence && sequence.channel && !sequence.background)
                ? null
                : manualLoading;
        var skipped =
            automatic && skipRequest && skipRequest.loading
                ? skipRequest
                : null;
        if (!automatic && !loading && !cancelNavigationAuto()) return;
        rememberNavigation(item);
        var request = {};
        if (automatic) automaticRequest = request;
        function valid() {
            return (
                current() &&
                guard() &&
                (!loading || !loading.cancelled) &&
                (!automatic || automaticRequest === request)
            );
        }
        (automatic ? automaticLibrary : library).resolve(
            function (done: any) {
                bindScreen();
                if (loading || skipped || startup)
                    done.beforeError = function () {
                        if (!valid()) return;
                        if (skipped) finishSkipLoading(skipped);
                        if (startup) finishStartupLoading();
                        if (!loading || manualLoading !== loading) return;
                        // Retire the wait before Plex replaces it with its error
                        // dialog. Keep the selected file available for retry.
                        finishManualLoading(loading);
                        restoreLoadingList(loading);
                    };
                var abortLoad: any = null;
                function accept(payload: any) {
                    if (!done.isCurrent() || !valid()) return;
                    if (admit && !admit(payload)) {
                        done(null);
                        return;
                    }
                    payload.__ottMediaRef = copy(item.ref);
                    delete payload.__ottMediaRefresh;
                    var client = classicMediaClient();
                    if (client && typeof client.resolve === "function")
                        client.resolve(payload, done, automatic);
                    else done(payload);
                }
                var origin = item.payload.__ottMediaOrigin;
                if (
                    item.payload.__ottMediaRefresh &&
                    // Installation requests resolve stable IDs directly, independent of catalog pagination.
                    !(
                        item.payload.request &&
                        (context || (mediaClient && mediaClient.stableRequests))
                    ) &&
                    origin &&
                    origin.kind === "catalog"
                ) {
                    var refreshed: any = function (rows: any[]) {
                        if (!done.isCurrent()) return;
                        var found = describe(rows, origin).filter(
                            function (candidate) {
                                return candidate.ref.itemId === item.ref.itemId;
                            }
                        );
                        if (found.length === 1) accept(found[0].payload);
                        else {
                            if (startup) startup.unavailable();
                            if (settled) settled(false);
                            if (typeof w.infoBox === "function")
                                w.infoBox(
                                    w._("Media item is no longer available")
                                );
                        }
                    };
                    refreshed.isCurrent = done.isCurrent;
                    abortLoad = load(origin, refreshed);
                } else if (startup && startup.resolved) {
                    var ready = copy(startup.resolved);
                    ready.__ottMediaRef = copy(item.ref);
                    done(ready);
                } else accept(copy(item.payload));
                return function () {
                    if (abortLoad) abortLoad();
                    if (current() && classicMediaClient()) {
                        var client = classicMediaClient();
                        if (
                            automatic &&
                            typeof client.cancelAutomatic === "function"
                        )
                            client.cancelAutomatic();
                        else client.cancel();
                    }
                };
            },
            function (payload: any) {
                if (!valid()) return;
                if (skipped) finishSkipLoading(skipped);
                if (admit && payload && !admit(payload)) payload = null;
                if (automatic) automaticRequest = null;
                if (!payload) {
                    if (manualLoading === loading && loading) {
                        finishManualLoading(loading);
                        restoreLoadingList(loading);
                    }
                    if (sequence && sequence.onError) sequence.onError();
                    if (settled) settled();
                    if (startup) startup.unavailable();
                    return;
                }
                // The backend's buffering indicator now owns media readiness.
                finishManualLoading(loading);
                if (!automatic && typeof w.closeList === "function")
                    w.closeList();
                if (startup) finishStartupLoading();
                var start = {
                    automatic: automatic,
                    ref: item.ref,
                    sequence: sequence,
                    startup: startup,
                    valid: guard,
                };
                var previousPlayback = mediaClassicPlayback;
                var previousGeneration =
                    w.__ottClassicPlayback.snapshot().generation;
                pendingStart = start;
                try {
                    if (!admit || admit(payload))
                        w._playMedia(payload, automatic);
                } finally {
                    if (pendingStart === start) pendingStart = null;
                    var state = w.__ottClassicPlayback.snapshot();
                    var started = !!(
                        current() &&
                        mediaClassicPlayback &&
                        mediaClassicPlayback !== previousPlayback &&
                        mediaClassicPlayback.ref.itemId === item.ref.itemId &&
                        state.generation !== previousGeneration &&
                        state.target &&
                        state.target.kind === "vod" &&
                        state.target.sourceId === source &&
                        state.target.channelId === item.ref.itemId &&
                        state.phase !== "stopped"
                    );
                    if (settled) settled(started);
                    if (started && dispatched && current()) dispatched();
                }
            }
        );
    }
    var api = {
        active: current,
        back: function () {
            if (!cancelNavigationAuto()) return;
            var result = library.back();
            if (!result && w.popupList) w.popupList(w.popMedia);
        },
        cancel: function () {
            var admitted = library.capture();
            api.cancelAuto();
            if (!admitted()) return;
            library.close();
            if (current() && classicMediaClient())
                classicMediaClient().cancel();
        },
        cancelAuto: function () {
            automaticGeneration++;
            if (manualLoading) {
                finishManualLoading(manualLoading, true);
                library.cancel();
            }
            finishStartupLoading();
            completionRequest = null;
            var skipped = skipRequest;
            skipRequest = null;
            finishSkipLoading(skipped);
            shuffleRequest = null;
            var collecting = collectionRequest;
            collectionRequest = null;
            var resolving = automaticRequest;
            automaticRequest = null;
            if (resolving) automaticLibrary.cancel();
            if (collecting && collecting.cancel) collecting.cancel();
            updateControls();
        },
        capture: function () {
            var valid = library.capture();
            return function () {
                return current() && valid();
            };
        },
        captureAuto: function () {
            var revision = automaticGeneration;
            return function () {
                return current() && automaticGeneration === revision;
            };
        },
        captureFavorite: function () {
            var playing = mediaClassicPlayback;
            var state = w.__ottClassicPlayback.snapshot();
            if (
                !persistent() ||
                !playing ||
                playing.runtime !== api ||
                /^catalog:/.test(playing.ref.itemId) ||
                !state.target ||
                state.target.kind !== "vod" ||
                state.target.sourceId !== source ||
                state.target.channelId !== playing.ref.itemId ||
                state.phase === "idle" ||
                state.phase === "stopped" ||
                w.sFavorites === -1
            )
                return null;
            var payload = copy(playing.payload);
            if (!payload.request && !payload.__ottMediaOrigin) return null;
            // A favorite is a provider identity, never a retained access URL.
            delete payload.stream_url;
            delete payload.__ottPlexPlayback;
            delete payload.__ottNativeFile;
            var item = {
                payload: payload,
                ref: copy(playing.ref),
                title: classicMediaTitle(payload),
            };
            var record = entry(item);
            delete record.payload.stream_url;
            if (
                !journal.change("favorite", record) ||
                !persistent() ||
                mediaClassicPlayback !== playing
            )
                return null;
            var reader = context
                ? context.readPersisted
                : w.providerGetPersistedItem;
            var stored =
                reader &&
                reader.call(context || w, "mediaJournal.v1:" + source);
            if (stored !== JSON.stringify(journal.read().document)) return null;
            collections();
            return {
                context: !!context,
                payload: record.payload,
                ref: copy(playing.ref),
                title: item.title,
            };
        },
        channelLaunch: function (payload: any) {
            return current() &&
                pendingStart &&
                pendingStart.sequence &&
                pendingStart.sequence.channel &&
                pendingStart.valid() &&
                payload &&
                payload.__ottMediaRef &&
                payload.__ottMediaRef.itemId === pendingStart.ref.itemId
                ? pendingStart.sequence.channel.id
                : null;
        },
        checkpoint: function (ref: MediaRef, position: number, force = false) {
            if (
                !persistent() ||
                !ref ||
                ref.sourceId !== source ||
                !isFinite(position) ||
                position < 0
            )
                return;
            if (
                mediaClassicPlayback &&
                mediaClassicPlayback.ended &&
                mediaClassicPlayback.ref.itemId === ref.itemId &&
                mediaClassicPlayback.ref.sourceId === ref.sourceId
            )
                position = 0;
            var now = Date.now();
            if (
                !force &&
                checkpointItem === ref.itemId &&
                now - checkpointTime < 5000
            )
                return;
            var document = journal.read().document;
            var rows = document.history.concat(document.favorites);
            var found = rows.filter(function (row: any) {
                return row.itemId === ref.itemId;
            })[0];
            if (found) {
                found.position = position;
                if (journal.change("position", found)) {
                    checkpointTime = now;
                    checkpointItem = ref.itemId;
                }
                collections();
            }
        },
        cycleRepeat: function () {
            if (
                mediaClassicPlayback &&
                mediaClassicPlayback.sequence &&
                mediaClassicPlayback.sequence.explicit
            )
                return;
            var admitted = library.capture();
            var completion = completionRequest;
            var reschedule =
                completion && automaticRequest && completion.valid();
            var revision = automaticGeneration + 1;
            api.cancelAuto();
            if (!current() || !admitted() || automaticGeneration !== revision)
                return;
            repeat =
                repeat === "all" ? "one" : repeat === "one" ? "off" : "all";
            if (mediaClassicPlayback && mediaClassicPlayback.runtime === api) {
                var playback = mediaClassicPlayback;
                if (!playback.sequence) {
                    var payload = copy(playback.payload);
                    payload.__ottMediaRefresh = true;
                    playback.sequence = {
                        index: 0,
                        items: [
                            {
                                payload: payload,
                                ref: copy(playback.ref),
                                title: String(playback.payload.title || ""),
                            },
                        ],
                        placeholder: true,
                    };
                }
                playback.sequence.repeat = repeat;
            }
            try {
                if (typeof set === "function") set.call(w, repeatKey, repeat);
            } catch (_) {
                // Playback controls remain usable when optional persistence fails.
            }
            if (current() && admitted()) updateControls();
            if (
                reschedule &&
                current() &&
                admitted() &&
                automaticGeneration === revision &&
                mediaClassicPlayback === completion.playback &&
                w.__ottClassicPlayback.snapshot().generation ===
                    completion.generation
            ) {
                // Only the pending natural completion is re-admitted. Old
                // resolver/PIN callbacks retain their cancelled generation.
                completion.playback.ended = false;
                api.ended(completion.generation);
            }
        },
        ended: function (generation: number) {
            if (w.__ottStandby?.blocked() || deferLocalEnd(generation)) return;
            // Local files use the channel catalog, not a media-library queue.
            // Their finite target therefore has no mediaClassicPlayback owner.
            var state = w.__ottClassicPlayback.snapshot();
            var history = state.historyTarget;
            if (
                w.__ottActiveProviderDriver?.id === "offline" &&
                state.generation === generation &&
                state.phase === "stopped" &&
                state.target?.kind === "vod" &&
                history?.kind === "live" &&
                state.target.channelId === "channel:" + history.channelId &&
                state.target.sourceId === source &&
                history.sourceId === source
            ) {
                if (completedLocalGeneration === generation || !current())
                    return;
                if (!w.channels[history.channelId]) return;
                var category =
                    typeof history.payload?.groupId === "string"
                        ? w.__ottChannels?.index(history.payload.groupId)
                        : -1;
                var list =
                    category >= 0 ? w.__ottChannels?.capture(category) : null;
                if (!list || !list.active()) return;
                var members = list.members();
                var id = members.filter(function (value: any) {
                    return String(value) === history.channelId;
                })[0];
                if (id === undefined) return;
                completedLocalGeneration = generation;
                var revision = automaticGeneration;
                function localAdmitted(): boolean {
                    if (w.__ottStandby?.blocked() || deferLocalEnd(generation))
                        return false;
                    var latest = w.__ottClassicPlayback.snapshot();
                    return (
                        current() &&
                        list.active() &&
                        revision === automaticGeneration &&
                        latest.generation === generation &&
                        latest.phase === "stopped"
                    );
                }
                movePlaylistEntry(
                    { sequence: { channel: { id: id, list: list } } },
                    1,
                    true,
                    localAdmitted
                );
                return;
            }
            var playback = mediaClassicPlayback;
            var sequence = playback && playback.sequence;
            var revision = automaticGeneration;
            function valid() {
                var state = w.__ottClassicPlayback.snapshot();
                return (
                    current() &&
                    mediaClassicPlayback === playback &&
                    automaticGeneration === revision &&
                    state.generation === generation &&
                    state.phase === "stopped" &&
                    state.target &&
                    state.target.kind === "vod" &&
                    state.target.sourceId === source &&
                    state.target.channelId === playback.ref.itemId
                );
            }
            if (!playback || playback.ended || !valid()) return;
            playback.ended = true;
            // A newly selected channel owns the pending resolver. Completion
            // of the departing decoder must neither cancel it nor select again.
            if (manualLoading && manualLoading.channel) {
                manualLoading.endedGeneration = generation;
                api.checkpoint(playback.ref, 0, true);
                return;
            }
            if (sequence && sequence.channel) {
                api.checkpoint(playback.ref, 0, true);
                if (valid()) movePlaylistEntry(playback, 1, true);
                return;
            }
            // Natural completion retires the old decoder generation, but must
            // not replace an explicit pending arrow with its automatic sibling.
            var skipped = skipRequest;
            var skip =
                skipped && skipped.playback === playback && skipped.valid(true)
                    ? skipped.recovering
                        ? skipped.offset
                        : skipped.index - sequence.index
                    : null;
            var skipAdmitted = skip !== null ? library.capture() : null;
            var skipRevision = automaticGeneration + 1;
            // A completed standalone item also loses its resume checkpoint.
            // It must not cancel a new shuffle being collected in parallel.
            if (sequence || skip !== null) api.cancelAuto();
            revision = automaticGeneration;
            var admitted = library.capture();
            api.checkpoint(playback.ref, 0, true);
            if (skip !== null) {
                // Restart ownership against the completed generation so late
                // responses from its old folder/metadata request stay stale.
                if (
                    skipAdmitted!() &&
                    automaticGeneration === skipRevision &&
                    admitted() &&
                    valid()
                )
                    skipPlayback(skip);
                return;
            }
            if (!sequence || !admitted() || !valid()) return;
            var mode = sequence.repeat || "all";
            if (
                !sequence.items.length ||
                (mode === "off" && sequence.index + 1 >= sequence.items.length)
            )
                return;
            automaticRequest = {};
            var completion = {
                generation: generation,
                playback: playback,
                valid: function () {
                    return admitted() && valid();
                },
            };
            completionRequest = completion;
            var index =
                mode === "one"
                    ? sequence.index
                    : (sequence.index + 1) % sequence.items.length;
            var item = sequence.items[index];
            function proceed() {
                if (admitted() && valid())
                    resolve(
                        item,
                        {
                            explicit: sequence.explicit,
                            index: index,
                            items: sequence.items,
                            onError: sequence.onError,
                            ordered: sequence.ordered,
                            placeholder: sequence.placeholder,
                            queueId: sequence.queueId,
                            repeat: mode,
                        },
                        true,
                        valid,
                        function () {
                            if (completionRequest === completion)
                                completionRequest = null;
                        }
                    );
            }
            authorize(item, proceed);
        },
        favorite: function (payload: any) {
            if (payload.__ottMediaFilter || payload.__ottMediaNext) return;
            var admitted = api.capture();
            var frame = library.snapshot("none").frame;
            var item = describe(
                [payload],
                frame ? frame.route : { kind: "catalog", target: "", title: "" }
            )[0];
            if (!item || w.sFavorites === -1) return;
            var removing = frame && frame.route.kind === "favorites";
            if (
                !journal.change(
                    removing ? "unfavorite" : "favorite",
                    entry(item)
                ) ||
                !admitted()
            )
                return;
            collections();
            if (!admitted()) return;
            if (removing) {
                var items = collectionItems("favorites");
                if (admitted()) library.replaceItems(items);
            } else if (w.showShift)
                w.showShift(
                    classicMediaTitle(item.payload) + w._(" added to favorites")
                );
        },
        filter: function () {
            var admitted = api.capture();
            library.cancelPage();
            if (!admitted()) return;
            if (shuffleRequest) {
                var revision = automaticGeneration + 1;
                api.cancelAuto();
                if (!admitted() || automaticGeneration !== revision) return;
            }
            var frame = library.snapshot("none").frame;
            if (!frame || frame.route.kind === "variants") return;
            w.editCaption = w._("Filter");
            w.editvar = filterText;
            w.setEdit = function () {
                if (!current() || !admitted()) return;
                var value = String(w.editvar || "").trim();
                api.cancelAuto();
                if (!current() || !admitted()) return;
                library.refilter(function () {
                    filterText = value;
                });
            };
            if (typeof w.showEditKey === "function") w.showEditKey();
        },
        highlight: function (index: number, revision: number) {
            if (manualLoading) return;
            if (!current() || library.revision() !== revision) return;
            library.highlight(index);
            if (pageScheduled === revision || !library.nearEnd(index)) return;
            pageScheduled = revision;
            // Highlight runs inside detail painting. Defer cached responses so
            // the old detail cannot overwrite the newly appended page.
            w.setTimeout(function () {
                if (pageScheduled !== revision) return;
                pageScheduled = -1;
                if (
                    current() &&
                    library.revision() === revision &&
                    (!screenOwner || screenOwner.foreground()) &&
                    !shuffleRequest &&
                    !collectionRequest &&
                    !automaticRequest
                )
                    library.more();
            }, 0);
        },
        open: function (target: any, title?: string, label?: any) {
            if (skipRequest && skipRequest.loading && !cancelNavigationAuto())
                return;
            var view = library.snapshot("none");
            if (target === null && view.frame) {
                if (
                    mediaClassicPlayback &&
                    mediaClassicPlayback.runtime === api
                )
                    library.highlightRef(mediaClassicPlayback.ref);
                library.show();
                return;
            }
            if (target === -1 || target === -2) {
                navigate({
                    kind: target === -1 ? "history" : "favorites",
                    title:
                        target === -1
                            ? w._("History of watched movies")
                            : w._("Favorites"),
                });
                return;
            }
            if (target === "submenu") {
                var item = library.select(w.selIndex);
                if (item && Array.isArray(item.payload.submenu))
                    navigate({
                        kind: "variants",
                        label: classicMediaLabel(item.payload),
                        target: item.payload.submenu,
                        title: item.title,
                    });
                return;
            }
            if (
                typeof target === "string" &&
                /^(cmd:info|alert)/.test(target)
            ) {
                var match = /(?:cmd:info|alert)\(([^)]+)\)/.exec(target);
                w.infoBox(match ? match[1] : target);
                return;
            }
            var reset =
                target === null ||
                !view.frame ||
                (view.frames[0].route.kind === "catalog" &&
                    serializeMediaIdentity(view.frames[0].route.target) ===
                        serializeMediaIdentity(target));
            navigate(
                {
                    kind: "catalog",
                    label:
                        label ||
                        (!title && reset && !context
                            ? {
                                  key: "Media Library",
                                  value: w._("Media Library"),
                              }
                            : undefined),
                    target: target === null ? "" : target,
                    title:
                        title ||
                        (reset
                            ? context
                                ? context.title
                                : w._("Media Library")
                            : w.mediaName),
                },
                reset
            );
        },
        playChannel: function (
            payload: any,
            id: any,
            guard?: () => boolean,
            background = false,
            positionMode = "prompt"
        ) {
            if (!current() || (guard && !guard())) return false;
            var list = w.__ottChannels && w.__ottChannels.capture(w.catIndex);
            if (!list || !list.active() || list.members().indexOf(id) < 0)
                return false;
            var item = describe([payload], {
                kind: "catalog",
                target: "",
                title: "",
            })[0];
            if (!item || !playable(item)) return false;
            api.cancelAuto();
            var revision = automaticGeneration;
            var generation = w.__ottClassicPlayback.snapshot().generation;
            var loading: any = null;
            function valid() {
                var state = w.__ottClassicPlayback.snapshot();
                return (
                    current() &&
                    list.active() &&
                    (!loading || !loading.cancelled) &&
                    automaticGeneration === revision &&
                    (!guard || guard()) &&
                    (state.generation === generation ||
                        (loading &&
                            state.generation === loading.endedGeneration)) &&
                    list.members().indexOf(id) >= 0
                );
            }
            if (!valid()) return false;
            var playback = mediaClassicPlayback;
            if (
                background &&
                playback &&
                playback.runtime === api &&
                playback.ended
            )
                // Reuse natural-completion admission when Repeat changes while
                // this channel is still resolving. Its old callbacks stay stale.
                completionRequest = {
                    generation: generation,
                    playback: playback,
                    valid: valid,
                };
            authorize(item, function () {
                if (!valid()) return;
                loading = background ? null : beginManualLoading(item, true);
                if (!valid()) return;
                var position = 0;
                if (positionMode === "resume") {
                    var saved = journal
                        .read()
                        .document.history.filter(function (row: any) {
                            return row.itemId === item.ref.itemId;
                        })[0];
                    position = saved ? saved.position || 0 : 0;
                }
                if (!valid()) return;
                resolve(
                    item,
                    {
                        background: background,
                        channel: { id: id, list: list },
                        repeat: repeat,
                        replace: true,
                    },
                    true,
                    valid,
                    undefined,
                    positionMode === "prompt"
                        ? undefined
                        : {
                              position: position,
                              unavailable: function () {},
                          },
                    undefined,
                    function (candidate) {
                        return (
                            valid() &&
                            (Number(candidate.adult) !== 1 ||
                                !(w.__ottParental
                                    ? w.__ottParental.needs("channels")
                                    : w.sPSchannels &&
                                      w.parentPIN !== "*" &&
                                      !w.parentAccess))
                        );
                    }
                );
            });
            return true;
        },
        playFavorite: function (
            ref: MediaRef,
            guard: () => boolean,
            done: (ok: boolean) => void
        ) {
            if (
                !current() ||
                !guard() ||
                !ref ||
                ref.sourceId !== source ||
                /^catalog:/.test(ref.itemId)
            )
                return false;
            var rows = journal.read().document.favorites.filter(function (
                row: any
            ) {
                return (
                    row.sourceId === ref.sourceId && row.itemId === ref.itemId
                );
            });
            if (rows.length !== 1) return false;
            var payload = copy(rows[0].payload);
            if (!payload.request && !payload.__ottMediaOrigin) return false;
            delete payload.stream_url;
            payload.__ottMediaRef = copy(ref);
            payload.__ottMediaRefresh = true;
            var item = describe([payload], { kind: "favorites", title: "" })[0];
            if (
                !item ||
                (Number(payload.adult) === 1 &&
                    (w.__ottParental
                        ? w.__ottParental.needs("channels")
                        : w.sPSchannels &&
                          w.parentPIN !== "*" &&
                          !w.parentAccess))
            )
                return false;
            api.cancelAuto();
            if (!current() || !guard()) return false;
            var completed = false;
            function finish(ok: boolean) {
                if (completed) return;
                completed = true;
                done(ok);
            }
            resolve(
                item,
                null,
                true,
                guard,
                function () {
                    finish(true);
                },
                {
                    position: 0,
                    unavailable: function () {
                        finish(false);
                    },
                },
                function (ok) {
                    if (!ok) finish(false);
                },
                function (candidate) {
                    return (
                        guard() &&
                        (Number(candidate.adult) !== 1 ||
                            !(w.__ottParental
                                ? w.__ottParental.needs("channels")
                                : w.sPSchannels &&
                                  w.parentPIN !== "*" &&
                                  !w.parentAccess))
                    );
                }
            );
            return true;
        },
        playOrderedQueue: function (
            records: any[],
            index: number,
            queueId: string,
            resolved: any,
            guard: () => boolean,
            dispatched: () => void,
            failed: () => void
        ) {
            var items = describe(records, {
                kind: "catalog",
                target: "",
                title: "Plex",
            });
            if (!items[index] || !current() || !guard()) return failed();
            api.cancelAuto();
            resolve(
                items[index],
                {
                    explicit: true,
                    index: index,
                    items: items,
                    onError: failed,
                    queueId: queueId,
                    repeat: "off",
                    replace: true,
                },
                true,
                guard,
                dispatched,
                { position: 0, resolved: resolved, unavailable: failed },
                function (started) {
                    if (!started) failed();
                }
            );
            return function () {
                api.cancelAuto();
            };
        },
        playQueue: function (
            records: any[],
            query: string,
            guard: () => boolean,
            dispatched: () => void
        ) {
            var items = describe(records, {
                kind: "catalog",
                target: "search?query=" + encodeURIComponent(query),
                title: query,
            });
            if (!items.length || !current() || !guard()) return;
            items.forEach(function (item: MediaLibraryItem) {
                item.payload.__ottVPortalQueue = true;
            });
            var revision = automaticGeneration + 1;
            api.cancelAuto();
            var generation = w.__ottClassicPlayback.snapshot().generation;
            function valid() {
                return (
                    current() &&
                    guard() &&
                    automaticGeneration === revision &&
                    w.__ottClassicPlayback.snapshot().generation === generation
                );
            }
            var started = false;
            resolve(
                items[0],
                { index: 0, items: items, replace: true },
                true,
                valid,
                function () {
                    started = true;
                    dispatched();
                }
            );
            return function () {
                if (!started && revision === automaticGeneration)
                    api.cancelAuto();
            };
        },
        prepare: function (payload: any, url: string) {
            var channel = api.channelLaunch(payload);
            if (
                w.__ottKiosk &&
                typeof w.__ottKiosk.allowedMedia === "function" &&
                !(channel != null
                    ? w.__ottKiosk.allowed(channel)
                    : w.__ottKiosk.allowedMedia(payload.__ottMediaRef))
            )
                return null;
            if (
                payload.__ottMediaRef &&
                payload.__ottMediaRef.sourceId !== source
            )
                return null;
            var item = describe([payload], { kind: "history", title: "" })[0];
            if (!item) return null;
            var start =
                pendingStart && pendingStart.ref.itemId === item.ref.itemId
                    ? pendingStart
                    : null;
            function admitted() {
                return (
                    current() && (!start || !start.automatic || start.valid())
                );
            }
            if (!admitted()) return null;
            var state = w.__ottClassicPlayback.snapshot();
            if (
                !(start && start.sequence && start.sequence.replace) &&
                state.target &&
                state.target.sourceId === source &&
                state.target.channelId === item.ref.itemId &&
                state.target.kind === "vod" &&
                state.phase !== "stopped" &&
                mediaClassicPlayback &&
                mediaClassicPlayback.payload.stream_url === url
            )
                return null;
            var previous = journal.read().document.history.filter(function (
                row: any
            ) {
                return row.itemId === item.ref.itemId;
            })[0];
            if (!admitted()) return null;
            item.payload.stream_url = url;
            journal.change(
                "visit",
                entry(item, start && start.startup ? start.startup.position : 0)
            );
            if (!admitted()) return null;
            collections();
            if (!admitted()) return null;
            var departing = mediaClassicPlayback;
            if (
                departing &&
                departing.context &&
                departing.client !== classicMediaClient() &&
                !(
                    mediaClassicSourceHandoff &&
                    mediaClassicSourceHandoff.playback === departing
                )
            ) {
                departing.client.stop(departing.payload.stream_url);
                if (!admitted()) return null;
            }
            var ticket = {};
            mediaClassicPlayback = {
                client: classicMediaClient(),
                context: context,
                payload: copy(item.payload),
                ref: item.ref,
                runtime: api,
                sequence: start && start.sequence,
                ticket: ticket,
            };
            return {
                channel: start && start.sequence && start.sequence.channel,
                item: item.payload,
                ref: item.ref,
                resume:
                    start && start.startup
                        ? start.startup.position
                        : start &&
                            start.automatic &&
                            !(start.sequence && start.sequence.channel)
                          ? 0
                          : w.OttPlayCore.mediaResumePosition(
                                previous ? previous.position : 0,
                                60
                            ),
                resumeStartup: !!(start && start.startup),
                valid: function () {
                    return (
                        current() &&
                        mediaClassicPlayback &&
                        mediaClassicPlayback.ticket === ticket
                    );
                },
            };
        },
        randomPlay: function (fromList: boolean) {
            if (!current() || manualLoading || shuffleRequest) return;
            var playback = mediaClassicPlayback;
            if (!fromList && playback && playback.runtime === api) {
                var sequence = playback.sequence;
                if (!sequence || sequence.channel || sequence.placeholder)
                    return;
                var choices: number[] = [];
                sequence.items.forEach(function (
                    item: MediaLibraryItem,
                    index: number
                ) {
                    if (index !== sequence.index && playable(item))
                        choices.push(index);
                });
                if (choices.length)
                    skipPlayback(
                        choices[Math.floor(Math.random() * choices.length)] -
                            sequence.index
                    );
                return;
            }
            var view = library.snapshot("current");
            if (view.loading || !view.frame) return;
            var indexes: number[] = [];
            view.frame.items.forEach(function (
                item: MediaLibraryItem,
                index: number
            ) {
                if (
                    playable(item) &&
                    (!playback ||
                        playback.runtime !== api ||
                        item.ref.itemId !== playback.ref.itemId)
                )
                    indexes.push(index);
            });
            if (indexes.length)
                api.select(indexes[Math.floor(Math.random() * indexes.length)]);
        },
        repeatMode: function () {
            return repeat;
        },
        restoreKiosk: function (selection: any, guard: () => boolean) {
            if (
                !current() ||
                !guard() ||
                selection.source !== source ||
                !Array.isArray(selection.records) ||
                !selection.records.length
            )
                return false;
            var items = describe(selection.records, {
                kind: "history",
                title: "Media",
            });
            var index = selection.index;
            if (
                !items[index] ||
                items.some(function (item: MediaLibraryItem) {
                    return (
                        !item.payload.request || item.ref.sourceId !== source
                    );
                })
            )
                return false;
            var revision = automaticGeneration + 1;
            api.cancelAuto();
            if (!current() || !guard() || automaticGeneration !== revision)
                return false;
            if (typeof w.__ottClassicPlayback.reconcile === "function")
                w.__ottClassicPlayback.reconcile();
            var generation = w.__ottClassicPlayback.snapshot().generation;
            function valid() {
                return (
                    current() &&
                    guard() &&
                    revision === automaticGeneration &&
                    w.__ottClassicPlayback.snapshot().generation === generation
                );
            }
            if (!valid()) return false;
            authorize(items[index], function () {
                if (!valid()) return;
                resolve(
                    items[index],
                    {
                        index: index,
                        items: items,
                        queueId: selection.queueId,
                        repeat: "all",
                    },
                    true,
                    valid,
                    undefined,
                    {
                        position: selection.position || 0,
                        unavailable: function () {},
                    }
                );
            });
            return true;
        },
        restoreLast: function (onUnavailable?: () => void) {
            if (!current() || restored) return false;
            restored = true;
            if (
                w.sFavorites === -1 ||
                !limit() ||
                !mediaClient ||
                !mediaClient.stableRequests ||
                typeof mediaClient.resolve !== "function" ||
                (mediaClassicPlayback && mediaClassicPlayback.runtime === api)
            )
                return false;
            var saved = journal.read();
            var row = saved.document.history[0];
            if (
                !current() ||
                !saved.writable ||
                !row ||
                row.sourceId !== source ||
                !isFinite(row.position) ||
                row.position <= 0 ||
                !row.payload.request
            )
                return false;
            var payload = copy(row.payload);
            payload.__ottMediaRef = { itemId: row.itemId, sourceId: source };
            payload.__ottMediaRefresh = true;
            var item = describe([payload], { kind: "history", title: "" })[0];
            if (!playable(item)) return false;
            var admitted = library.capture();
            var revision = automaticGeneration + 1;
            api.cancelAuto();
            if (!current() || !admitted() || revision !== automaticGeneration)
                return true;
            if (typeof w.__ottClassicPlayback.reconcile === "function")
                w.__ottClassicPlayback.reconcile();
            var generation = w.__ottClassicPlayback.snapshot().generation;
            function valid() {
                return (
                    current() &&
                    mediaClient === classicMediaClient() &&
                    admitted() &&
                    revision === automaticGeneration &&
                    w.__ottClassicPlayback.snapshot().generation === generation
                );
            }
            function unavailable() {
                if (!valid()) return;
                finishStartupLoading();
                if (onUnavailable) onUnavailable();
            }
            authorize(item, function () {
                if (!valid()) return;
                var loading = showLoading(function () {
                    if (!valid()) return;
                    api.cancelAuto();
                    if (current() && onUnavailable) onUnavailable();
                });
                startupLoading = loading;
                loading.own(function () {
                    if (startupLoading === loading) api.cancelAuto();
                });
                try {
                    collectFolder(item, valid, function (folder) {
                        if (!valid()) return;
                        if (folder) {
                            if (!restoreFolder(item, folder)) return;
                            admitted = library.capture();
                        }
                        if (valid())
                            resolve(
                                item,
                                folder
                                    ? folder.sequence
                                    : sequenceFor(item, folder !== false),
                                true,
                                valid,
                                undefined,
                                {
                                    position: row.position,
                                    unavailable: unavailable,
                                }
                            );
                    });
                } catch (_) {
                    if (valid()) {
                        automaticRequest = null;
                        unavailable();
                    }
                }
            });
            return true;
        },
        restoreProjection: function () {
            collections();
            project(library.snapshot("none"), false);
        },
        select: function (index: number) {
            if (manualLoading) return;
            var item = library.select(index);
            if (!item) return;
            if (item.payload.__ottMediaNext) {
                library.more(true);
                return;
            }
            var admitted = api.capture();
            library.cancelPage();
            if (!admitted()) return;
            api.cancelAuto();
            if (!admitted()) return;
            function proceed() {
                if (!admitted()) return;
                var payload = item.payload;
                if (payload.__ottMediaFilter) api.filter();
                else if (payload.__ottMediaRoute)
                    navigate({
                        kind: payload.__ottMediaRoute,
                        title: item.title,
                    });
                else if (payload.playlist_url) {
                    if (payload.search_on) w.searchMedia(payload);
                    else if (
                        payload.playlist_url === "submenu" &&
                        Array.isArray(payload.submenu)
                    )
                        navigate({
                            kind: "variants",
                            label: classicMediaLabel(payload),
                            target: payload.submenu,
                            title: item.title,
                        });
                    else
                        api.open(
                            payload.playlist_url,
                            item.title,
                            classicMediaLabel(payload)
                        );
                } else if (payload.stream_url || payload.request) {
                    var loading = beginManualLoading(item);
                    var revision = automaticGeneration;
                    var generation =
                        w.__ottClassicPlayback.snapshot().generation;
                    collectFolder(
                        item,
                        function () {
                            return (
                                admitted() && (!loading || !loading.cancelled)
                            );
                        },
                        function (folder) {
                            if (!admitted()) return;
                            if (folder) {
                                if (!restoreFolder(item, folder)) return;
                                // Retiring the old resolver can synchronously Stop
                                // or replace playback. A new navigation capture must
                                // not erase that cancellation.
                                if (
                                    !current() ||
                                    automaticGeneration !== revision ||
                                    w.__ottClassicPlayback.snapshot()
                                        .generation !== generation
                                )
                                    return;
                                admitted = api.capture();
                            }
                            if (admitted())
                                resolve(
                                    item,
                                    folder
                                        ? folder.sequence
                                        : sequenceFor(item, folder !== false)
                                );
                        }
                    );
                } else if (w.infoMedia) w.infoMedia();
            }
            authorize(item, proceed);
        },
        show: function () {
            if (!skipRequest || !skipRequest.loading || cancelNavigationAuto())
                library.show();
        },
        shufflePlay: function () {
            var view = library.snapshot("none");
            var frame = view.frame;
            if (
                !current() ||
                view.loading ||
                (screenOwner && !screenOwner.foreground()) ||
                !frame ||
                frame.route.kind !== "catalog"
            )
                return;
            if (!canCollect(frame.route.target)) return;
            var admitted = library.capture();
            var revision = automaticGeneration + 1;
            api.cancelAuto();
            if (!current() || !admitted() || automaticGeneration !== revision)
                return;
            var cancelledView = library.revision();
            library.cancel();
            // Revoke manual resolver/PIN ownership too, without changing the
            // frame. An abort callback may navigate elsewhere synchronously.
            if (
                !current() ||
                library.revision() !== cancelledView + 1 ||
                automaticGeneration !== revision
            )
                return;
            // cancel() changes the revision captured by screen disposal and UI
            // highlight callbacks. Rebind both before admitting async work.
            library.show();
            if (
                !current() ||
                library.revision() !== cancelledView + 1 ||
                automaticGeneration !== revision
            )
                return;
            // The shuffle intent belongs to the folder, not its highlighted row.
            admitted = library.capture("frame");
            // This explicit new queue replaces the old queue's future EOS action,
            // while its currently playing video continues during collection.
            if (mediaClassicPlayback && mediaClassicPlayback.runtime === api)
                mediaClassicPlayback.sequence = null;
            var viewRevision = library.revision();
            if (typeof w.__ottClassicPlayback.reconcile === "function")
                w.__ottClassicPlayback.reconcile();
            var generation = w.__ottClassicPlayback.snapshot().generation;
            var ticket: any = { cancel: null };
            collectionRequest = ticket;
            shuffleRequest = ticket;
            var received = false;
            var query = normalizedFilter(filterText);
            function valid() {
                return (
                    current() &&
                    admitted() &&
                    automaticGeneration === revision &&
                    library.revision() === viewRevision &&
                    w.__ottClassicPlayback.snapshot().generation === generation
                );
            }
            function foreground() {
                if (!valid()) return false;
                if (screenOwner && !screenOwner.foreground()) {
                    // A new editor/dialog owns the screen. Retire this intent,
                    // including a provider guard that rejects before delivery.
                    if (shuffleRequest === ticket) api.cancelAuto();
                    return false;
                }
                return true;
            }
            function accept(result: any) {
                if (received || collectionRequest !== ticket || !foreground())
                    return;
                received = true;
                collectionRequest = null;
                var items: MediaLibraryItem[] = [];
                if (result && !result.error && Array.isArray(result.items)) {
                    var seen: { [key: string]: boolean } = Object.create(null);
                    items = describe(result.items, frame!.route).filter(
                        function (item) {
                            if (
                                !playable(item) ||
                                (query &&
                                    normalizedFilter(
                                        classicMediaTitle(item.payload)
                                    ).indexOf(query) === -1) ||
                                seen[item.ref.itemId]
                            )
                                return false;
                            seen[item.ref.itemId] = true;
                            return true;
                        }
                    );
                }
                if (!items.length) {
                    finish();
                    if (typeof w.infoBox === "function")
                        w.infoBox(
                            w._(
                                result && !result.error
                                    ? "Nothing to play"
                                    : "Unable to load playlist"
                            )
                        );
                    return;
                }
                var ordered = items.slice();
                for (var index = items.length - 1; index > 0; index--) {
                    var selected = Math.floor(Math.random() * (index + 1));
                    var item = items[index];
                    items[index] = items[selected];
                    items[selected] = item;
                }
                function proceed() {
                    if (!foreground()) return;
                    resolve(
                        items[0],
                        {
                            index: 0,
                            items: items,
                            ordered: ordered,
                            repeat: repeat,
                            replace: true,
                        },
                        true,
                        foreground,
                        function () {
                            if (typeof w.closeList === "function")
                                w.closeList();
                        },
                        undefined,
                        finish
                    );
                }
                authorize(items[0], proceed, finish);
            }
            function finish() {
                if (shuffleRequest !== ticket) return;
                shuffleRequest = null;
                updateControls();
            }
            library.show();
            if (!valid()) return;
            var client = classicMediaClient();
            if (client && typeof client.collect === "function") {
                try {
                    var cancel = client.collect(
                        frame.route.target,
                        accept,
                        function () {
                            // A completed collection may have opened our PIN.
                            return received ? valid() : foreground();
                        }
                    );
                    if (typeof cancel === "function") {
                        if (
                            !received &&
                            collectionRequest === ticket &&
                            valid()
                        )
                            ticket.cancel = cancel;
                        else if (!received) cancel();
                    }
                } catch (_) {
                    accept({ error: true });
                }
            } else
                accept({
                    items: library.catalog().map(function (
                        item: MediaLibraryItem
                    ) {
                        return item.payload;
                    }),
                });
        },
        skip: function (direction: number) {
            if (direction === 1 || direction === -1) skipPlayback(direction);
        },
        snapshot: function () {
            var view = library.snapshot();
            view.filter = filterText;
            decorate(view);
            return view;
        },
        sourceId: source,
        toggleShuffle: function () {
            var playback = mediaClassicPlayback;
            var sequence =
                playback && playback.runtime === api && playback.sequence;
            if (sequence && sequence.explicit) return;
            if (!shuffleRequest && !(sequence && sequence.ordered)) {
                api.shufflePlay();
                return;
            }
            var admitted = library.capture();
            var completion = completionRequest;
            var reschedule =
                completion && automaticRequest && completion.valid();
            var revision = automaticGeneration + 1;
            api.cancelAuto();
            if (
                !current() ||
                !admitted() ||
                playback !== mediaClassicPlayback ||
                automaticGeneration !== revision
            )
                return;
            if (sequence && sequence.ordered) {
                sequence.items = sequence.ordered;
                delete sequence.ordered;
                sequence.items.forEach(function (
                    item: MediaLibraryItem,
                    index: number
                ) {
                    if (item.ref.itemId === playback.ref.itemId)
                        sequence.index = index;
                });
            }
            updateControls();
            if (
                reschedule &&
                current() &&
                admitted() &&
                automaticGeneration === revision &&
                mediaClassicPlayback === completion.playback &&
                w.__ottClassicPlayback.snapshot().generation ===
                    completion.generation
            ) {
                completion.playback.ended = false;
                api.ended(completion.generation);
            }
        },
    };
    mediaClassicInstance = api;
    try {
        var savedRepeat =
            typeof get === "function" ? get.call(w, repeatKey) : null;
        if (current() && /^(all|one|off)$/.test(savedRepeat || ""))
            repeat = savedRepeat;
    } catch (_) {
        // Missing storage or old settings retain the legacy repeat-all default.
    }
    collections();
    return api;
}

(window as any).__ottMedia = {
    back: function () {
        classicMediaRuntime().back();
    },
    // Queue admission is synchronous after metadata resolves. Keep the previous
    // runtime intact until the host confirms that its replacement was dispatched.
    beginSource: function (source: ClassicMediaSource) {
        var previous = {
            context: mediaClassicContext,
            instance: mediaClassicInstance,
            playback: mediaClassicPlayback,
            provider: mediaClassicProvider,
            source: mediaClassicSource,
        };
        var token = ++mediaClassicContextRevision;
        mediaClassicSourceHandoff = previous;
        mediaClassicContext = source;
        mediaClassicInstance = null;
        function owned() {
            return (
                token === mediaClassicContextRevision &&
                mediaClassicContext === source
            );
        }
        return {
            commit: function () {
                if (!owned()) return false;
                mediaClassicSourceHandoff = null;
                if (previous.instance) previous.instance.cancel();
                var departing = previous.playback;
                if (
                    departing &&
                    departing.context &&
                    departing.client !== source.client
                )
                    departing.client.stop(departing.payload.stream_url);
                return true;
            },
            rollback: function () {
                if (!owned()) return;
                var candidate = mediaClassicInstance;
                ++mediaClassicContextRevision;
                mediaClassicSourceHandoff = null;
                mediaClassicContext = previous.context;
                mediaClassicInstance = previous.instance;
                mediaClassicPlayback = previous.playback;
                mediaClassicProvider = previous.provider;
                mediaClassicSource = previous.source;
                if (candidate) candidate.cancel();
            },
        };
    },
    cancel: function () {
        var host = window as any;
        host._mediaLoadState = {};
        if (mediaClassicInstance) mediaClassicInstance.cancel();
        else if (classicMediaClient()) classicMediaClient().cancel();
    },
    cancelAuto: function () {
        if (mediaClassicInstance) mediaClassicInstance.cancelAuto();
    },
    cancelRequest: function () {
        var client = classicMediaClient();
        if (client) client.cancel();
    },
    capture: function () {
        return classicMediaRuntime().capture();
    },
    captureAuto: function () {
        return classicMediaRuntime().captureAuto();
    },
    captureFavorite: function () {
        var playing = mediaClassicPlayback;
        return playing && playing.runtime
            ? playing.runtime.captureFavorite()
            : null;
    },
    channelLaunch: function (payload: any) {
        return classicMediaRuntime().channelLaunch(payload);
    },
    checkpoint: function (ref: MediaRef, position: number, force = false) {
        var playback = mediaClassicPlayback;
        var runtime =
            playback &&
            playback.context &&
            ref &&
            playback.ref.sourceId === ref.sourceId &&
            playback.ref.itemId === ref.itemId
                ? playback.runtime
                : classicMediaRuntime();
        runtime.checkpoint(ref, position, force);
    },
    current: function () {
        return mediaClassicPlayback &&
            (mediaClassicPlayback.context ||
                mediaClassicPlayback.ref.sourceId === classicMediaSourceId())
            ? mediaClassicPlayback
            : null;
    },
    cycleRepeat: function () {
        classicMediaRuntime().cycleRepeat();
    },
    description: classicMediaDescription,
    ended: function (generation: number) {
        if ((window as any).__ottActiveProviderDriver?.id === "offline")
            classicMediaRuntime().ended(generation);
        else if (mediaClassicInstance) mediaClassicInstance.ended(generation);
    },
    favorite: function (item: any) {
        classicMediaRuntime().favorite(item);
    },
    filter: function () {
        classicMediaRuntime().filter();
    },
    highlight: function (index: number, revision: number) {
        classicMediaRuntime().highlight(index, revision);
    },
    keepKioskLoop: function () {
        var playing = mediaClassicPlayback;
        if (!playing || playing.ref.sourceId !== classicMediaSourceId()) return;
        if (playing.sequence) playing.sequence.repeat = "all";
        else
            playing.sequence = {
                index: 0,
                items: [
                    {
                        payload: playing.payload,
                        ref: playing.ref,
                        title: String(playing.payload.title || ""),
                    },
                ],
                repeat: "all",
            };
    },
    kioskSelection: function () {
        var w = window as any;
        var playing = mediaClassicPlayback;
        var source = classicMediaSourceId();
        var state = w.__ottClassicPlayback && w.__ottClassicPlayback.snapshot();
        if (
            !playing ||
            playing.ref.sourceId !== source ||
            !w.__ottActiveProviderDriver ||
            (w.__ottActiveProviderDriver.id !== "vportal" &&
                w.__ottActiveProviderDriver.id !== "plex") ||
            !state ||
            state.phase === "stopped" ||
            state.phase === "idle" ||
            !state.target ||
            state.target.kind !== "vod" ||
            state.target.sourceId !== source ||
            state.target.channelId !== playing.ref.itemId
        )
            return null;
        var sequence = playing.sequence;
        // Channel-backed playback is pinned by the channel kiosk policy.
        if (sequence && sequence.channel) return null;
        var items = sequence ? sequence.items : [playing];
        if (!items.length || items.length > 1000) return null;
        var index = -1;
        var records: any[] = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (!item.payload.request || item.ref.sourceId !== source)
                return null;
            if (
                item.ref.itemId === playing.ref.itemId &&
                (!sequence || i === sequence.index)
            )
                index = i;
            // Persist provider requests/identities, never resolved or expiring media URLs.
            records.push({
                __ottMediaCollection:
                    item.payload.__ottMediaCollection ||
                    item.payload.__ottMediaOrigin?.title,
                __ottMediaRef: item.ref,
                __ottMediaSequence: item.payload.__ottMediaSequence,
                __ottVPortalQueue: w.__ottActiveProviderDriver.id === "vportal",
                adult: item.payload.adult,
                plexSource: item.payload.plexSource,
                request: item.payload.request,
                title: String(item.payload.title || ""),
                vportalSource: item.payload.vportalSource,
            });
        }
        if (index < 0) return null;
        var value = {
            index: index,
            position:
                isFinite(state.position) && state.position >= 0
                    ? state.position
                    : 0,
            queueId: sequence ? sequence.queueId : undefined,
            records: records,
            source: source,
        };
        var json = JSON.stringify(value);
        return json.length <= 500000 ? JSON.parse(json) : null;
    },
    open: function (target: any, title?: string) {
        classicMediaRuntime().open(target, title);
    },
    playbackStop: function (target: any) {
        var playback = mediaClassicPlayback;
        if (
            !playback ||
            !target ||
            target.kind !== "vod" ||
            target.sourceId !== playback.ref.sourceId ||
            target.channelId !== playback.ref.itemId ||
            !target.payload ||
            target.payload.stream_url !== playback.payload.stream_url
        )
            return;
        var client = playback.client;
        if (client && typeof client.stop === "function")
            client.stop(playback.payload.stream_url);
    },
    playChannel: function (
        payload: any,
        id: any,
        guard?: () => boolean,
        background = false,
        positionMode = "prompt"
    ) {
        (window as any).__ottMedia.useSource(null);
        return classicMediaRuntime().playChannel(
            payload,
            id,
            guard,
            background,
            positionMode
        );
    },
    playFavorite: function (
        ref: MediaRef,
        guard: () => boolean,
        done: (ok: boolean) => void
    ) {
        return classicMediaRuntime().playFavorite(ref, guard, done);
    },
    playOrderedQueue: function (
        records: any[],
        index: number,
        queueId: string,
        resolved: any,
        guard: () => boolean,
        dispatched: () => void,
        failed: () => void
    ) {
        return classicMediaRuntime().playOrderedQueue(
            records,
            index,
            queueId,
            resolved,
            guard,
            dispatched,
            failed
        );
    },
    playQueue: function (
        records: any[],
        query: string,
        guard: () => boolean,
        dispatched: () => void
    ) {
        return classicMediaRuntime().playQueue(
            records,
            query,
            guard,
            dispatched
        );
    },
    prepare: function (item: any, url: string) {
        return classicMediaRuntime().prepare(item, url);
    },
    programme: classicMediaProgramme,
    randomPlay: function (fromList: boolean) {
        var runtime =
            !fromList && mediaClassicPlayback
                ? mediaClassicPlayback.runtime
                : classicMediaRuntime();
        runtime.randomPlay(fromList);
    },
    repeatMode: function () {
        return classicMediaRuntime().repeatMode();
    },
    restoreKiosk: function (selection: any, guard: () => boolean) {
        return classicMediaRuntime().restoreKiosk(selection, guard);
    },
    restoreLast: function (onUnavailable?: () => void) {
        return classicMediaRuntime().restoreLast(onUnavailable);
    },
    select: function (index: number) {
        classicMediaRuntime().select(index);
    },
    show: function () {
        classicMediaRuntime().show();
    },
    shufflePlay: function () {
        classicMediaRuntime().shufflePlay();
    },
    skip: function (direction: number) {
        classicMediaRuntime().skip(direction);
    },
    snapshot: function () {
        return classicMediaRuntime().snapshot();
    },
    sourceId: classicMediaSourceId,
    title: classicMediaTitle,
    toggleShuffle: function () {
        classicMediaRuntime().toggleShuffle();
    },
    useSource: function (source: ClassicMediaSource | null) {
        if (source === mediaClassicContext) return;
        var token = ++mediaClassicContextRevision;
        mediaClassicSourceHandoff = null;
        var host = window as any;
        var previous = mediaClassicInstance;
        // Capture a final confirmed position before the new storage owner is selected.
        var state =
            previous &&
            host.__ottClassicPlayback &&
            host.__ottClassicPlayback.snapshot();
        mediaClassicInstance = null;
        if (previous) {
            if (state && state.target && state.target.kind === "vod")
                previous.checkpoint(
                    {
                        itemId: state.target.channelId,
                        sourceId: state.target.sourceId,
                    },
                    state.position,
                    true
                );
            if (token !== mediaClassicContextRevision) return;
            previous.cancel();
        }
        if (token !== mediaClassicContextRevision) return;
        mediaClassicContext = source;
        host._mediaLoadState = {};
    },
    usesSource: function (source: ClassicMediaSource) {
        return mediaClassicContext === source;
    },
};

/** Navigation and request ownership have no dependency on DOM, globals or provider scripts. */
interface MediaRef {
    itemId: string;
    sourceId: string;
}
interface MediaLibraryItem {
    payload: any;
    ref: MediaRef;
    title: string;
}
interface MediaRoute {
    kind: "catalog" | "history" | "favorites" | "variants";
    label?: { key: string; value: string };
    target?: any;
    title: string;
}
interface MediaLibraryFrame {
    items: MediaLibraryItem[];
    route: MediaRoute;
    selected: number;
}
interface MediaOwnedFrame extends MediaLibraryFrame {
    catalog: MediaLibraryItem[];
    deferred?: boolean;
    pages?: { [key: string]: boolean };
}
interface MediaLibraryView {
    frame: MediaLibraryFrame | null;
    frames: MediaLibraryFrame[];
    loading: boolean;
    revision: number;
}
interface MediaLibraryPorts {
    describe(records: any[], route: MediaRoute): MediaLibraryItem[];
    filter?(items: MediaLibraryItem[], route: MediaRoute): MediaLibraryItem[];
    items(route: MediaRoute): MediaLibraryItem[];
    load(route: MediaRoute, done: any): (() => void) | void;
    page?(route: MediaRoute, done: any): (() => void) | void;
    render(view: MediaLibraryView): void;
}

function mediaLibraryCopy(value: any, seen?: any[]): any {
    if (!value || typeof value !== "object") return value;
    var parents = seen || [];
    if (parents.indexOf(value) !== -1) return undefined;
    parents = parents.concat([value]);
    var copy: any = Array.isArray(value) ? [] : {};
    Object.keys(value).forEach(function (key) {
        var next = mediaLibraryCopy(value[key], parents);
        if (key in copy)
            Object.defineProperty(copy, key, {
                configurable: true,
                enumerable: true,
                value: next,
                writable: true,
            });
        else copy[key] = next;
    });
    return copy;
}

function createMediaLibrary(ports: MediaLibraryPorts) {
    var frames: MediaOwnedFrame[] = [];
    var filterRevision = 0;
    var selectionRevision = 0;
    var revision = 0;
    var viewRevision = 0;
    var loading = false;
    var resolving = false;
    var cleanup: (() => void) | null = null;
    var paging: any = null;
    function cancelPage() {
        var previous = paging;
        paging = null;
        if (!previous) return;
        delete previous.item.payload.__ottMediaPageState;
        if (previous.abort) previous.abort();
    }
    function cancel() {
        var token = ++revision;
        viewRevision++;
        var previous = cleanup;
        cleanup = null;
        loading = false;
        resolving = false;
        cancelPage();
        if (previous) previous();
        return token;
    }
    // Public snapshots retain every page. Rendering needs only the current
    // page's payloads; navigation decisions need detached route metadata.
    function snapshot(
        items: "all" | "current" | "none" = "all"
    ): MediaLibraryView {
        var copy = frames.map(function (frame, index) {
            return mediaLibraryCopy({
                items:
                    items === "none" ||
                    (items === "current" && index !== frames.length - 1)
                        ? []
                        : frame.items,
                route: frame.route,
                selected: frame.selected,
            });
        });
        return {
            frame: copy.length ? copy[copy.length - 1] : null,
            frames: copy,
            loading: loading,
            revision: viewRevision,
        };
    }
    function applyFilter(
        frame: MediaOwnedFrame,
        selected: MediaLibraryItem = frame.items[frame.selected]
    ) {
        frame.items = ports.filter
            ? ports.filter(frame.catalog, frame.route)
            : frame.catalog;
        frame.selected = 0;
        if (selected && !selected.payload.__ottMediaFilter)
            frame.items.some(function (item, index) {
                if (item.ref.itemId !== selected.ref.itemId) return false;
                frame.selected = index;
                return true;
            });
    }
    function setItems(
        frame: MediaOwnedFrame,
        items: MediaLibraryItem[],
        selected?: MediaLibraryItem,
        cursorIndex?: number
    ) {
        var index = frame.selected,
            previous = frame.items[index],
            itemId = previous && previous.ref.itemId,
            sourceId = previous && previous.ref.sourceId;
        viewRevision++;
        frame.catalog = items;
        applyFilter(frame, selected);
        if (cursorIndex !== undefined)
            frame.selected = Math.max(
                0,
                Math.min(cursorIndex, frame.items.length - 1)
            );
        var current = frame.items[frame.selected];
        if (
            frames[frames.length - 1] === frame &&
            (index !== frame.selected ||
                itemId !== (current && current.ref.itemId) ||
                sourceId !== (current && current.ref.sourceId))
        )
            selectionRevision++;
    }
    function render() {
        ports.render(snapshot("current"));
    }
    function selectItem(index: number): MediaLibraryItem | null {
        var frame = frames[frames.length - 1];
        if (!frame || !frame.items[index]) return null;
        if (frame.selected !== index) selectionRevision++;
        frame.selected = index;
        return frame.items[index];
    }
    function nextPage(index: number, distance = 3): MediaLibraryItem | null {
        var frame = frames[frames.length - 1];
        if (!frame || frame.route.kind !== "catalog" || !ports.page)
            return null;
        for (
            var i = index;
            i <= index + distance && i < frame.items.length;
            i++
        )
            if (frame.items[i] && frame.items[i].payload.__ottMediaNext)
                return frame.items[i];
        return null;
    }
    function more(force = false) {
        var frame = frames[frames.length - 1];
        if (!frame || loading || resolving || paging) return;
        var candidate = nextPage(frame.selected, force ? 0 : 3);
        if (
            !candidate ||
            (!force && candidate.payload.__ottMediaPageState === "error")
        )
            return;
        var item: MediaLibraryItem = candidate;
        var token = revision;
        var request: any = { item: item };
        paging = request;
        item.payload.__ottMediaPageState = "loading";
        viewRevision++;
        render();
        var route: MediaRoute = {
            kind: "catalog",
            target: mediaLibraryCopy(item.payload.playlist_url),
            title: frame.route.title,
        };
        function active() {
            return (
                paging === request &&
                token === revision &&
                frames[frames.length - 1] === frame
            );
        }
        var done: any = function (records: any[], error?: string) {
            if (!active()) return;
            paging = null;
            var seen = frame.pages || (frame.pages = Object.create(null));
            if (
                error ||
                seen[item.ref.itemId] ||
                Object.keys(seen).length >= 1000 ||
                frame.catalog.length + records.length > 100000
            ) {
                item.payload.__ottMediaPageState = "error";
                viewRevision++;
                render();
                return;
            }
            seen[item.ref.itemId] = true;
            var selected = frame.items[frame.selected];
            var selectedIndex = frame.selected;
            var existing: { [key: string]: boolean } = Object.create(null);
            frame.catalog.forEach(function (row) {
                existing[row.ref.itemId] = true;
            });
            var incoming = ports
                .describe(records, route)
                .filter(function (row) {
                    var id = row.ref.itemId;
                    if (
                        existing[id] ||
                        (row.payload.__ottMediaNext && seen[id])
                    )
                        return false;
                    existing[id] = true;
                    return true;
                });
            var position = frame.catalog.indexOf(item);
            var merged = frame.catalog
                .slice(0, position)
                .concat(incoming, frame.catalog.slice(position + 1));
            // The loading row is replaced in place. Moving away during the
            // request keeps that newer selection, including filtered catalogs.
            setItems(
                frame,
                merged,
                selected,
                selected === item ? selectedIndex : undefined
            );
            render();
        };
        done.isCurrent = active;
        if (!active()) return;
        try {
            var abort = ports.page!(route, done);
            if (active()) request.abort = abort;
            else if (typeof abort === "function") abort();
        } catch (_) {
            done([], "page");
        }
    }
    function open(route: MediaRoute, reset = false, selected = 0) {
        var token = cancel();
        if (token !== revision) return;
        if (reset) frames = [];
        var frame: MediaOwnedFrame = {
            catalog: [],
            items: [],
            route: mediaLibraryCopy(route),
            selected: 0,
        };
        frames.push(frame);
        if (route.kind !== "catalog") {
            setItems(frame, mediaLibraryCopy(ports.items(route)));
            if (token === revision) render();
            return;
        }
        loading = true;
        var settled = false;
        var done: any = function (records: any[], title?: string) {
            if (!done.isCurrent()) return;
            settled = true;
            loading = false;
            cleanup = null;
            var items = ports.describe(records || [], frame.route);
            setItems(frame, items, items[selected]);
            if (typeof title === "string" && title) frame.route.title = title;
            if (token === revision) render();
        };
        done.isCurrent = function () {
            return (
                token === revision &&
                !settled &&
                frames[frames.length - 1] === frame
            );
        };
        done.active = function () {
            return token === revision && frames[frames.length - 1] === frame;
        };
        done.update = function (
            records: any[],
            title?: string,
            selected?: number
        ) {
            if (!done.active()) return;
            var items = ports.describe(records || [], frame.route);
            setItems(
                frame,
                items,
                typeof selected === "number" ? items[selected] : undefined
            );
            if (typeof title === "string") frame.route.title = title;
            render();
        };
        var abort = ports.load(frame.route, done);
        if (typeof abort === "function") {
            if (token !== revision && !settled) abort();
            else if (!settled) cleanup = abort;
        }
    }
    return {
        back: function () {
            var token = cancel();
            if (token !== revision) return false;
            if (frames.length <= 1) return false;
            frames.pop();
            var parent = frames[frames.length - 1];
            if (parent.deferred) {
                frames.pop();
                open(parent.route, false, parent.selected);
                return true;
            }
            render();
            return true;
        },
        cancel: cancel,
        cancelPage: cancelPage,
        capture: function (scope?: "frame") {
            var token = revision;
            var filtered = filterRevision;
            var selection = selectionRevision;
            var frame = frames[frames.length - 1];
            var selected = frame && frame.selected;
            var item = frame && frame.items[selected];
            return function () {
                var current = frame && frame.items[frame.selected];
                return (
                    token === revision &&
                    filtered === filterRevision &&
                    frame === frames[frames.length - 1] &&
                    (scope === "frame" ||
                        (selection === selectionRevision &&
                            (!frame || selected === frame.selected) &&
                            (item
                                ? current &&
                                  current.ref.itemId === item.ref.itemId &&
                                  current.ref.sourceId === item.ref.sourceId
                                : !current)))
                );
            };
        },
        catalog: function () {
            var frame = frames[frames.length - 1];
            return frame ? mediaLibraryCopy(frame.catalog) : [];
        },
        close: function () {
            var pending = loading;
            var token = cancel();
            if (pending && token === revision) frames.pop();
        },
        // Highlight changes owned selection without publishing item data.
        highlight: function (index: number) {
            selectItem(index);
        },
        highlightRef: function (ref: MediaRef) {
            var frame = frames[frames.length - 1];
            if (!frame || frame.route.kind !== "catalog") return;
            frame.items.some(function (item, index) {
                if (
                    item.ref.itemId !== ref.itemId ||
                    item.ref.sourceId !== ref.sourceId
                )
                    return false;
                selectItem(index);
                return true;
            });
        },
        more: more,
        nearEnd: function (index: number) {
            return !!nextPage(index);
        },
        open: open,
        refilter: function (commit?: () => void) {
            cancelPage();
            if (resolving && cancel() !== revision) return;
            if (commit) commit();
            filterRevision++;
            viewRevision++;
            frames.forEach(function (frame) {
                applyFilter(frame);
            });
            render();
        },
        replaceItems: function (items: MediaLibraryItem[]) {
            if (!frames.length) return;
            setItems(frames[frames.length - 1], mediaLibraryCopy(items));
            render();
        },
        resolve: function (
            execute: (done: any) => (() => void) | void,
            accept: (item: any) => void
        ) {
            var token = cancel();
            if (token !== revision) return;
            resolving = true;
            var settled = false;
            var done: any = function (item: any) {
                if (!done.isCurrent()) return;
                settled = true;
                resolving = false;
                cleanup = null;
                accept(item);
            };
            done.isCurrent = function () {
                return token === revision && !settled;
            };
            var abort = execute(done);
            if (typeof abort === "function") {
                if (token !== revision && !settled) abort();
                else if (!settled) cleanup = abort;
            }
        },
        // Startup restores only the current catalog. Ancestors are fetched on
        // Back, keeping checkpoints small and avoiding a request per breadcrumb.
        restore: function (
            trail: { route: MediaRoute; selected: number }[],
            items: MediaLibraryItem[],
            selected: MediaRef
        ) {
            var token = cancel();
            if (token !== revision || !trail.length) return false;
            frames = trail.map(function (saved) {
                return {
                    catalog: [],
                    deferred: true,
                    items: [],
                    route: mediaLibraryCopy(saved.route),
                    selected: saved.selected,
                };
            });
            var frame = frames[frames.length - 1];
            frame.deferred = false;
            var rows = mediaLibraryCopy(items);
            setItems(
                frame,
                rows,
                rows.filter(function (item: MediaLibraryItem) {
                    return item.ref.itemId === selected.itemId;
                })[0]
            );
            return true;
        },
        revision: function () {
            return viewRevision;
        },
        select: function (index: number): MediaLibraryItem | null {
            return mediaLibraryCopy(selectItem(index));
        },
        show: render,
        snapshot: snapshot,
    };
}

(window as any).__ottMediaLibrary = {
    copy: mediaLibraryCopy,
    create: createMediaLibrary,
};

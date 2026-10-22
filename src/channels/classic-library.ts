/** Numeric positions and localized labels exist only in this renderer adapter. */
var channelLibraryInstance: any = null;
var channelLibraryView: any[] = [];
var channelLibraryGeneration = 0;
var channelPreferenceKinds: any = {
    aAspects: "aspect",
    aAudios: "audio",
    aSubs: "subtitle",
    aZooms: "zoom",
};

function channelLibraryIndex(id: string): number {
    for (var i = 0; i < channelLibraryView.length; i++)
        if (channelLibraryView[i].id === id) return i;
    return -1;
}

function channelLibraryPublish(host: any): void {
    if (!channelLibraryInstance || !channelLibraryInstance.active()) return;
    var previousId = host.curList && host.curList[host.primaryIndex];
    var previousGroup = channelLibraryView[host.catIndex];
    var snapshot = channelLibraryInstance.snapshot();
    var all = { id: "system:all", label: host._("All"), members: snapshot.all };
    channelLibraryView = [all].concat(snapshot.groups);
    if (host.sFavorites)
        channelLibraryView.unshift({
            id: "system:favorites",
            label: host._("Favorites"),
            members: host.favoritesArray,
        });
    var categories: Record<string, number[]> = Object.create(null);
    var labels: string[] = [];
    channelLibraryView.forEach(function (group) {
        var label = group.label;
        // Provider names can coincide with translated virtual names. Keep both accessible.
        while (Object.prototype.hasOwnProperty.call(categories, label))
            label += " ";
        labels.push(label);
        categories[label] = group.members.slice();
    });
    host.catsArray = labels;
    host.cats = categories;
    host.parentalArray = snapshot.locks;
    var selected = snapshot.selected;
    var wantedGroup = selected
        ? selected.groupId
        : previousGroup && previousGroup.id;
    var category = channelLibraryIndex(wantedGroup);
    if (category < 0) category = host.sFavorites ? 1 : 0;
    var list = categories[labels[category]] || [];
    var index = -1;
    if (selected) {
        for (var i = 0; i < list.length; i++)
            if (channelLibraryInstance.itemId(list[i]) === selected.itemId) {
                index = i;
                break;
            }
    } else index = list.indexOf(previousId);
    host.catIndex = category;
    host.curList = list;
    host.primaryIndex = index < 0 ? 0 : index;
}

function mountChannelLibrary(host: any): void {
    var generation = ++channelLibraryGeneration;
    var source = host.__ottSourceIdentity.current(host);
    var get = host.providerGetItem;
    var getPersisted = host.providerGetPersistedItem;
    var set = host.providerSetItem;
    var rows: any[] = [];
    (host.cList || []).forEach(function (id: number) {
        var channel = host.channels[id];
        if (!channel) return;
        var category = channel.category || {};
        rows.push({
            groupId: String(
                channel.groupId || "provider:" + (category.name || "Other")
            ),
            groupLabel: String(category.name || "Other"),
            id: id,
            itemId: String(channel.itemId || "channel:" + id),
            label: String(channel.channel_name || ""),
            legacyId: channel.legacyChannelId,
            locked: !!(
                channel.adult ||
                (host.parental && host.parental.test(category.name || ""))
            ),
        });
    });
    channelLibraryInstance = host.__ottChannelLibrary.create(
        {
            current: function () {
                return (
                    generation === channelLibraryGeneration &&
                    source === host.__ottSourceIdentity.current(host) &&
                    get === host.providerGetItem &&
                    getPersisted === host.providerGetPersistedItem &&
                    set === host.providerSetItem
                );
            },
            get: function (key: string) {
                return get.call(host, key);
            },
            getPersisted: function (key: string) {
                return typeof getPersisted === "function"
                    ? getPersisted.call(host, key)
                    : null;
            },
            legacySelection: {
                category: host.catIndex,
                favorites: host.sFavorites ? host.favoritesArray : null,
                index: host.primaryIndex,
                virtualLabels: [host._("All"), host._("Favorites")],
            },
            set: function (key: string, value: string) {
                set.call(host, key, value);
            },
            sourceId: source,
        },
        rows
    );
    channelLibraryInstance.persist();
    channelLibraryView = [];
    channelLibraryPublish(host);
}

/** Retain the live list model so progressive data cannot replace its overlays. */
function captureChannelAppendView(host: any): (() => void) | null {
    var library = channelLibraryInstance;
    var port = host.__ottClassicScreenPort;
    var owner = port && port.listOwner();
    var group = channelLibraryView[host.listCatIndex];
    var rows = group && host.cats[host.catsArray[host.listCatIndex]];
    function current(): boolean {
        return !!(
            library === channelLibraryInstance &&
            library &&
            library.active() &&
            port === host.__ottClassicScreenPort &&
            owner &&
            owner.active() &&
            owner === port.listOwner() &&
            host.isListVisible &&
            rows &&
            host.listArray === rows &&
            host.listDataArray === rows &&
            owner.model.items === rows &&
            owner.model.rows === rows &&
            typeof host.channelsKeyHandler === "function" &&
            owner.model.handler === host.channelsKeyHandler &&
            host.listKeyHandler === host.channelsKeyHandler
        );
    }
    if (!current()) return null;
    var focused = rows[host.selIndex];
    return function () {
        if (!current()) return;
        var category = channelLibraryIndex(group.id);
        if (category < 0) return;
        var label = host.catsArray[category];
        var next = host.cats[label];
        var changed = rows.length !== next.length;
        for (var i = 0; i < next.length; i++) {
            if (rows[i] !== next[i]) changed = true;
            rows[i] = next[i];
        }
        rows.length = next.length;
        host.cats[label] = rows;
        if (host.curList === next) host.curList = rows;
        host.listCatIndex = category;
        host.selIndex = Math.max(0, rows.indexOf(focused));
        if (
            changed &&
            owner.foreground() &&
            typeof host.showPage === "function"
        )
            host.showPage();
    };
}

function appendChannelLibrary(host: any, ids: any[]): void {
    if (!channelLibraryInstance || !channelLibraryInstance.active()) return;
    var updateView = captureChannelAppendView(host);
    channelLibraryInstance.append(
        ids.map(function (id: any) {
            var channel = host.channels[id];
            var category = channel.category || {};
            return {
                groupId: String(
                    channel.groupId || "provider:" + (category.name || "Other")
                ),
                groupLabel: String(category.name || "Other"),
                id: id,
                itemId: String(channel.itemId || "channel:" + id),
                label: String(channel.channel_name || ""),
                locked: !!(
                    channel.adult ||
                    (host.parental && host.parental.test(category.name || ""))
                ),
            };
        })
    );
    channelLibraryPublish(host);
    if (updateView) updateView();
}

function channelLibraryChange(action: string, value?: any, extra?: any): any {
    var host = window as any;
    var library = channelLibraryInstance;
    if (!library || !library.active()) return false;
    var result: any = false;
    if (action === "create") result = library.createGroup(value, extra);
    if (action === "rename") result = library.renameGroup(value, extra);
    if (action === "remove") result = library.removeGroup(value);
    if (action === "move") result = library.moveGroup(value, extra);
    if (action === "member")
        result = library.changeMember(
            value.groupId,
            value.channelId,
            value.action,
            value.delta
        );
    if (action === "lock") result = library.lock(value, extra);
    if (action === "shuffle") result = library.shuffleGroup(value);
    if (action === "resetShuffle") result = library.resetShuffle(value);
    if (result) channelLibraryPublish(host);
    return result;
}

(window as any).__ottChannels = {
    append: function (ids: any[]): void {
        appendChannelLibrary(window, ids);
    },
    capture: function (category: number) {
        var host = window as any;
        var library = channelLibraryInstance;
        var catalog = host.channels;
        var group = channelLibraryView[category];
        function active(): boolean {
            return !!(
                library &&
                library === channelLibraryInstance &&
                library.active() &&
                catalog === host.channels
            );
        }
        function locate(): number {
            return active() && group ? channelLibraryIndex(group.id) : -1;
        }
        if (!group || !active()) return null;
        return {
            active: active,
            category: locate,
            members: function () {
                var category = locate();
                return category < 0
                    ? []
                    : (host.cats[host.catsArray[category]] || []).slice();
            },
            neighbours: function (id: string | number) {
                var category = locate();
                if (category < 0) return null;
                var members = host.cats[host.catsArray[category]] || [];
                var index = host.primaryIndex;
                if (String(members[index]) !== String(id)) {
                    index = -1;
                    for (var i = 0; i < members.length; i++)
                        if (String(members[i]) === String(id)) {
                            index = i;
                            break;
                        }
                }
                return index < 0
                    ? null
                    : {
                          id: members[index],
                          index: index,
                          length: members.length,
                          nextId: members[(index + 1) % members.length],
                      };
            },
            position: function (id: number) {
                var category = locate();
                var row = catalog[id];
                if (
                    category < 0 ||
                    !row ||
                    library.itemId(id) !== String(row.itemId || "channel:" + id)
                )
                    return null;
                var index = (host.cats[host.catsArray[category]] || []).indexOf(
                    id
                );
                return index < 0 ? null : [category, index];
            },
        };
    },
    capturePreference: function (name: string, channelId: number | null) {
        var host = window as any;
        var library = channelLibraryInstance;
        var catalog = host.channels;
        var kind = channelPreferenceKinds[name];
        function active(): boolean {
            return !!(
                kind &&
                library &&
                library === channelLibraryInstance &&
                library.active() &&
                catalog === host.channels &&
                (channelId === null || library.itemId(channelId))
            );
        }
        if (!active()) return null;
        return {
            active: active,
            get: function () {
                return active()
                    ? library.preference(kind, channelId)
                    : undefined;
            },
            saved: function () {
                return active()
                    ? library.savedPreference(kind, channelId)
                    : undefined;
            },
            set: function (value: number) {
                return (
                    active() &&
                    library.setPreference(kind, channelId, value, true)
                );
            },
        };
    },
    change: channelLibraryChange,
    document: function () {
        return channelLibraryInstance
            ? channelLibraryInstance.document()
            : null;
    },
    group: function (index: number) {
        return channelLibraryView[index] && channelLibraryView[index].id;
    },
    index: channelLibraryIndex,
    mount: mountChannelLibrary,
    preference: function (name: string, channelId: number | null) {
        var kind = channelPreferenceKinds[name];
        return channelLibraryInstance && channelLibraryInstance.active() && kind
            ? channelLibraryInstance.preference(kind, channelId)
            : undefined;
    },
    refresh: function () {
        channelLibraryPublish(window as any);
    },
    reset: function () {
        channelLibraryGeneration++;
        channelLibraryInstance = null;
        channelLibraryView = [];
    },
    select: function (category: number, id: number) {
        var group = channelLibraryView[category];
        return (
            !!group &&
            !!channelLibraryInstance &&
            channelLibraryInstance.select(group.id, id)
        );
    },
    setPreference: function (
        name: string,
        channelId: number | null,
        value: number | null | undefined
    ) {
        var kind = channelPreferenceKinds[name];
        return channelLibraryInstance && kind
            ? channelLibraryInstance.setPreference(kind, channelId, value)
            : false;
    },
};

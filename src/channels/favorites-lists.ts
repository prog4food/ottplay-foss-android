/**
 * Favorites multi-list leaf (Phase D2).
 *
 * List-model helpers extracted from channels/index.ts. Imported by that module;
 * listed on MODULES immediately before channels/index.js so concat+strip keeps
 * a single body per binding (not dual-listed with duplicate declarations).
 */

/** Multi-favorites lists blob — `{ v:1, lists, order, active }`. */
export interface FavoritesListsBlob {
    active: string;
    lists: Record<string, number[]>;
    order: string[];
    v: 1;
}

/**
 * Multi-favorites lists (Smart groups).
 * On first load, migrated from the prior single-array `favoritesArray` shape.
 * `favoritesArray` is kept in sync as the active list for existing readers.
 */
export let favoritesLists: FavoritesListsBlob = {
    active: "Favorites",
    lists: { Favorites: [] },
    order: ["Favorites"],
    v: 1,
};

/** Active-list alias for existing cats["Favorites"] / single-list readers. */
export let favoritesArray: number[] = favoritesLists.lists.Favorites;
// Display provenance is separate from stable list keys and user-authored names.
var favoritesDefaultList: string | undefined = "Favorites";

/** Optional view refresh (bound from channels/index — avoids circular import). */
var favoritesViewRefresh: (() => void) | null = null;

/** Register Favorites-category view refresh (curList / indices). */
export function bindFavoritesViewRefresh(fn: () => void): void {
    favoritesViewRefresh = fn;
}

function applyFavoritesCatAlias(): void {
    if (typeof window === "undefined") return;
    var w = window as any;
    w.favoritesArray = favoritesArray;
    if (
        w.cats &&
        typeof w._ === "function" &&
        (w.sFavorites || w.cats[w._("Favorites")])
    )
        w.cats[w._("Favorites")] = favoritesArray;
}

export function syncFavoritesArrayFromActive(): void {
    // Keep `favoritesArray` as an alias of the active list so existing readers
    // (cats["Favorites"], single-favorites flows) keep working unchanged.
    favoritesArray = activeFavoritesList();
    applyFavoritesCatAlias();
    if (favoritesViewRefresh) favoritesViewRefresh();
}

export function activeFavoritesList(): number[] {
    return (window as any).OttPlayCore.favoriteListCurrent(favoritesLists);
}

export function getActiveFavoritesListName(): string {
    return favoritesLists.active;
}

export function favoritesListLabel(name: string): string {
    return name === favoritesDefaultList
        ? (window as any)._("Favorites")
        : name;
}

/** Switch the active list. Updates `favoritesArray` alias and cats["Favorites"]. */
export function setActiveFavoritesList(name: string): boolean {
    return applyFavoriteListChange("activate", name);
}

export function listFavoritesLists(): string[] {
    return (window as any).OttPlayCore.favoriteListOrder(
        favoritesLists.lists,
        favoritesLists.order
    );
}

export function addFavoritesList(name: string): boolean {
    return applyFavoriteListChange("add", name);
}

export function renameFavoritesList(oldName: string, newName: string): boolean {
    // Explicitly naming the generated list "Favorites" makes it user text too.
    if (oldName === favoritesDefaultList && oldName === newName) {
        if (!favoritesWritable || !favoritesOwner || !favoritesOwner())
            return false;
        favoritesDefaultList = undefined;
        return true;
    }
    return applyFavoriteListChange("rename", oldName, newName);
}

export function deleteFavoritesList(name: string): boolean {
    return applyFavoriteListChange("delete", name);
}

/** Load `favoritesLists` from storage; migrate from prior single-array shape. */
var favoritesSource = "";
var favoritesWritable = false;
var favoritesGeneration = 0;
var favoritesOwner: (() => boolean) | null = null;
interface FavoriteReferenceList {
    bindings: Record<string, ChannelReference>;
    references: ChannelReference[];
    shuffleBefore?: ChannelReference[];
    view: number[];
}
var favoritesReferences: FavoriteReferenceList[] = [];

function favoritesReferenceIndex(): any {
    var w = window as any;
    return w.__ottChannelReferences.create(
        w.channels,
        w.__ottLegacyChannelAliases
    );
}
function favoriteReferenceKey(reference: ChannelReference): string {
    return JSON.stringify(reference);
}
function restoreFavoriteReference(
    value: any,
    origin: "raw" | "canonical" | "reference",
    index: any
): ChannelReference {
    if (origin !== "reference") return index.resolve(value, origin);
    if (value && typeof value.itemId === "string")
        return { itemId: value.itemId };
    if (
        value &&
        (typeof value.legacyId === "number" ||
            typeof value.legacyId === "string") &&
        (value.origin === "raw" || value.origin === "canonical")
    ) {
        if (!value.ambiguous)
            return index.resolve(value.legacyId, value.origin);
        var unresolved: ChannelReference = {
            legacyId: value.legacyId,
            origin: value.origin,
        };
        unresolved.ambiguous = true;
        return unresolved;
    }
    return { ambiguous: true, legacyId: String(value), origin: "raw" };
}
function favoriteReferenceRecord(
    view: number[],
    references: ChannelReference[],
    index: any,
    prior?: FavoriteReferenceList,
    merged?: boolean
): FavoriteReferenceList {
    var bindings: Record<string, ChannelReference> = Object.create(null);
    references.forEach(function (reference) {
        var id = index.project(reference);
        if (id !== null) bindings[String(id)] = reference;
    });
    if (prior)
        view.forEach(function (id) {
            var original = prior.bindings[String(id)];
            // mergeFavoriteReferences includes every selected prior binding.
            if (
                original &&
                (merged === true || references.indexOf(original) >= 0)
            )
                bindings[String(id)] = original;
        });
    return { bindings: bindings, references: references, view: view };
}
function appendFavoriteReferences(
    target: ChannelReference[],
    references: ChannelReference[]
): void {
    for (var i = 0; i < references.length; i++) target.push(references[i]);
}

/** Preserve invisible references at their next retained neighbour while visible rows can reorder. */
function mergeFavoriteReferences(
    view: number[],
    prior: FavoriteReferenceList | undefined,
    index: any
): ChannelReference[] {
    var selected = view.map(function (id) {
        return (
            (prior && prior.bindings[String(id)]) ||
            index.resolve(id, "canonical")
        );
    });
    var keys: Record<string, boolean> = Object.create(null);
    selected.forEach(function (reference) {
        keys[favoriteReferenceKey(reference)] = true;
    });
    var before: Record<string, ChannelReference[]> = Object.create(null);
    var pending: ChannelReference[] = [];
    if (prior)
        prior.references.forEach(function (reference) {
            var key = favoriteReferenceKey(reference);
            if (keys[key]) {
                if (pending.length) {
                    var bucket = before[key] || (before[key] = []);
                    appendFavoriteReferences(bucket, pending);
                    pending = [];
                }
            } else if (index.project(reference) === null)
                pending.push(reference);
        });
    var result: ChannelReference[] = [];
    selected.forEach(function (reference) {
        var key = favoriteReferenceKey(reference);
        if (before[key]) {
            appendFavoriteReferences(result, before[key]);
            delete before[key];
        }
        result.push(reference);
    });
    appendFavoriteReferences(result, pending);
    return result;
}

function isFavoriteReferenceBlob(value: any): boolean {
    if (
        !value ||
        !value.lists ||
        typeof value.lists !== "object" ||
        Array.isArray(value.lists)
    )
        return false;
    return Object.keys(value.lists).every(function (name) {
        var references = value.lists[name];
        return (
            Array.isArray(references) &&
            references.every(function (reference) {
                if (!reference || typeof reference !== "object") return false;
                if (
                    typeof reference.itemId === "string" &&
                    reference.itemId.length > 0
                )
                    return true;
                return (
                    (typeof reference.legacyId === "number" ||
                        typeof reference.legacyId === "string") &&
                    (reference.origin === "raw" ||
                        reference.origin === "canonical") &&
                    (reference.ambiguous === undefined ||
                        typeof reference.ambiguous === "boolean")
                );
            })
        );
    });
}

function currentFavoritesSource(): string {
    return (window as any).__ottSourceIdentity.current(window);
}

function favoriteLibrarySnapshot(
    index: any,
    replacement?: { name: string; record: FavoriteReferenceList }
): any {
    var lists: Record<string, ChannelReference[]> = Object.create(null);
    var records: FavoriteReferenceList[] = [];
    var shuffleBefore: Record<string, ChannelReference[]> = Object.create(null);
    Object.keys(favoritesLists.lists).forEach(function (name) {
        var view = favoritesLists.lists[name];
        var prior: FavoriteReferenceList | undefined;
        favoritesReferences.forEach(function (record) {
            if (record.view === view) prior = record;
        });
        var record =
            replacement && replacement.name === name
                ? replacement.record
                : favoriteReferenceRecord(
                      view,
                      mergeFavoriteReferences(view, prior, index),
                      index,
                      prior,
                      true
                  );
        if (!(replacement && replacement.name === name) && prior)
            record.shuffleBefore = prior.shuffleBefore;
        lists[name] = record.references;
        records.push(record);
        if (record.shuffleBefore) shuffleBefore[name] = record.shuffleBefore;
    });
    return {
        document: {
            defaultList: favoritesDefaultList,
            lists: {
                active: favoritesLists.active,
                lists: lists,
                order: favoritesLists.order.slice(),
                v: 1,
            },
            shuffleBefore: Object.keys(shuffleBefore).length
                ? shuffleBefore
                : undefined,
            sourceId: favoritesSource,
            version: 2,
        },
        records: records,
    };
}

function favoriteLibraryDocument(): any {
    if (!favoritesOwner) return null;
    if (!favoritesWritable || !favoritesOwner())
        throw new Error("Favorites library is unavailable for backup");
    var generation = favoritesGeneration;
    var snapshot = favoriteLibrarySnapshot(favoritesReferenceIndex());
    if (generation !== favoritesGeneration || !favoritesOwner())
        throw new Error("Favorites source replaced during backup");
    return JSON.parse(JSON.stringify(snapshot.document));
}

if (typeof window !== "undefined")
    (window as any).__ottFavoritesLibrary = {
        document: favoriteLibraryDocument,
        reset: function () {
            favoritesGeneration++;
            favoritesOwner = null;
            favoritesWritable = false;
            favoritesReferences = [];
        },
    };

export function saveFavoritesLists(): boolean {
    return persistFavoriteSnapshot();
}

function persistFavoriteSnapshot(replacement?: {
    name: string;
    record: FavoriteReferenceList;
}): boolean {
    var w = window as any;
    if (!favoritesWritable || !favoritesOwner || !favoritesOwner())
        return false;
    var source = favoritesSource,
        generation = favoritesGeneration;
    var get = w.providerGetItem,
        set = w.providerSetItem;
    function current(): boolean {
        return (
            generation === favoritesGeneration &&
            source === currentFavoritesSource() &&
            generation === favoritesGeneration &&
            get === w.providerGetItem &&
            set === w.providerSetItem &&
            !!favoritesOwner &&
            favoritesOwner()
        );
    }
    try {
        var index = favoritesReferenceIndex();
        if (!current()) return false;
        var snapshot = favoriteLibrarySnapshot(index, replacement);
        var text = JSON.stringify(snapshot.document);
        var key = "favoritesLibrary:" + source;
        var prior = get.call(w, key);
        if (!current()) return false;
        var claim = get.call(w, "favoritesLibrarySource");
        if (!current()) return false;
        if (!claim) {
            set.call(w, "favoritesLibrarySource", source);
            if (
                !current() ||
                get.call(w, "favoritesLibrarySource") !== source ||
                !current()
            )
                return false;
        }
        if (prior !== text) set.call(w, key, text);
        if (!current() || get.call(w, key) !== text || !current()) return false;
        favoritesReferences = snapshot.records;
        return true;
    } catch (_) {
        return false;
    }
}

export function loadFavoritesLists(): void {
    var w = window as any;
    if (typeof w.providerGetJson !== "function") return;
    var generation = ++favoritesGeneration;
    var source = currentFavoritesSource();
    var get = w.providerGetItem,
        set = w.providerSetItem;
    function current(): boolean {
        return (
            generation === favoritesGeneration &&
            source === currentFavoritesSource() &&
            generation === favoritesGeneration &&
            get === w.providerGetItem &&
            set === w.providerSetItem
        );
    }
    var writable = false;
    var raw: any = null;
    var prior: any[] = [];
    var scoped: any;
    var origin: "raw" | "canonical" | "reference" = "raw";
    var defaultList: string | undefined;
    var savedShuffle: any;
    try {
        scoped = get.call(w, "favoritesLibrary:" + source);
        if (scoped) {
            try {
                var envelope = JSON.parse(scoped);
                if (
                    envelope &&
                    (envelope.version === 1 || envelope.version === 2) &&
                    envelope.sourceId === source &&
                    envelope.lists &&
                    envelope.lists.v === 1 &&
                    (envelope.defaultList === undefined ||
                        (envelope.defaultList === "Favorites" &&
                            Object.prototype.hasOwnProperty.call(
                                envelope.lists.lists,
                                "Favorites"
                            ))) &&
                    (envelope.version !== 2 ||
                        isFavoriteReferenceBlob(envelope.lists))
                ) {
                    raw = envelope.lists;
                    defaultList = envelope.defaultList;
                    savedShuffle = envelope.shuffleBefore;
                    origin = envelope.version === 2 ? "reference" : "canonical";
                    writable = true;
                }
            } catch (_) {}
        } else {
            var claim = get.call(w, "favoritesLibrarySource");
            writable = true;
            if (!claim || claim === source) {
                raw = w.providerGetJson("favoritesLists", null);
                if (
                    !(
                        raw &&
                        raw.v === 1 &&
                        raw.lists &&
                        typeof raw.lists === "object"
                    )
                )
                    prior = w.providerGetJson("favoritesArray", []) || [];
            }
        }
    } catch (_) {
        writable = false;
    }
    if (!current()) return;
    var loaded = w.OttPlayCore.loadClassicFavoriteLists(raw, prior);
    if (!raw) defaultList = "Favorites";
    var index = favoritesReferenceIndex();
    var records: FavoriteReferenceList[] = [];
    Object.keys(loaded.lists).forEach(function (name) {
        var references = loaded.lists[name].map(function (value: any) {
            return restoreFavoriteReference(value, origin, index);
        });
        var view: number[] = [];
        references.forEach(function (reference: ChannelReference) {
            var id = index.project(reference);
            if (id !== null) view.push(id);
        });
        loaded.lists[name] = view;
        var record = favoriteReferenceRecord(view, references, index);
        if (
            savedShuffle &&
            Object.prototype.hasOwnProperty.call(savedShuffle, name) &&
            isFavoriteReferenceBlob({ lists: { baseline: savedShuffle[name] } })
        )
            record.shuffleBefore = savedShuffle[name].map(function (
                value: any
            ) {
                return restoreFavoriteReference(value, "reference", index);
            });
        records.push(record);
    });
    if (!current()) return;
    favoritesSource = source;
    favoritesWritable = writable;
    favoritesOwner = current;
    favoritesLists = loaded;
    favoritesDefaultList = defaultList;
    favoritesReferences = records;
    saveFavoritesLists();
    if (current()) syncFavoritesArrayFromActive();
}

/** Shuffle the active list, or restore its first saved order, without copying media. */
export function shuffleFavoritesList(reset = false): boolean {
    if (!favoritesWritable || !favoritesOwner || !favoritesOwner())
        return false;
    var generation = favoritesGeneration;
    var owner = favoritesOwner;
    var name = favoritesLists.active;
    var original = activeFavoritesList();
    var index = favoritesReferenceIndex();
    var prior: FavoriteReferenceList | undefined;
    favoritesReferences.forEach(function (record) {
        if (record.view === original) prior = record;
    });
    var references = mergeFavoriteReferences(original, prior, index);
    var baseline = prior && prior.shuffleBefore;
    var view = original.slice();
    if (reset) {
        if (!baseline) return false;
        var available: Record<string, ChannelReference> = Object.create(null);
        references.forEach(function (reference) {
            available[favoriteReferenceKey(reference)] = reference;
        });
        var ordered: ChannelReference[] = [];
        baseline.concat(references).forEach(function (reference) {
            var key = favoriteReferenceKey(reference);
            if (available[key]) {
                ordered.push(available[key]);
                delete available[key];
            }
        });
        references = ordered;
        view = [];
        references.forEach(function (reference) {
            var id = index.project(reference);
            if (id !== null) view.push(id);
        });
    } else {
        if (view.length < 2) return false;
        for (var i = view.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var value = view[i];
            view[i] = view[j];
            view[j] = value;
        }
        baseline = baseline || references.slice();
        references = mergeFavoriteReferences(view, prior, index);
    }
    var record = favoriteReferenceRecord(view, references, index, prior, true);
    if (!reset) record.shuffleBefore = baseline;
    if (!persistFavoriteSnapshot({ name: name, record: record })) return false;
    if (
        generation !== favoritesGeneration ||
        owner !== favoritesOwner ||
        !owner()
    )
        return false;
    favoritesLists.lists[name] = view;
    syncFavoritesArrayFromActive();
    return true;
}

function applyFavoriteListChange(
    operation: string,
    name: string,
    replacement?: string
): boolean {
    var result = (window as any).OttPlayCore.favoriteListChange(
        favoritesLists,
        "classic",
        operation,
        name,
        replacement
    );
    if (
        result.accepted &&
        name === favoritesDefaultList &&
        (operation === "rename" || operation === "delete")
    )
        favoritesDefaultList = undefined;
    if (result.synchronize) syncFavoritesArrayFromActive();
    return result.accepted;
}

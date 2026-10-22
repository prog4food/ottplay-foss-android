/** Portable library documents. Storage, source selection and confirmation belong to the host. */
function createLibraryBackupCodec() {
    type Check = (value: any) => boolean;
    type Fields = Record<string, Check | number | string>;
    function owns(value: any, key: string | number): boolean {
        return Object.prototype.hasOwnProperty.call(value, key);
    }
    function object(value: any): boolean {
        return !!value && typeof value === "object" && !Array.isArray(value);
    }
    /** Every own field must have a rule; all required fields must be present. */
    function record(
        required: Fields,
        optional: Record<string, Check> = {}
    ): Check {
        return function (value) {
            if (!object(value)) return false;
            var keys = Object.keys(value);
            return (
                Object.keys(required).every(function (key) {
                    return keys.indexOf(key) >= 0;
                }) &&
                keys.every(function (key) {
                    var rule = owns(required, key)
                        ? required[key]
                        : owns(optional, key)
                          ? optional[key]
                          : undefined;
                    return typeof rule === "function"
                        ? rule(value[key])
                        : rule !== undefined && value[key] === rule;
                }) &&
                Object.keys(optional).every(function (key) {
                    return (
                        owns(value, key) ||
                        value[key] === undefined ||
                        optional[key](value[key])
                    );
                })
            );
        };
    }
    function name(value: string): boolean {
        return (
            value !== "__proto__" &&
            value !== "prototype" &&
            value !== "constructor"
        );
    }
    function text(value: any, empty = false): boolean {
        return (
            typeof value === "string" &&
            value.length <= 4096 &&
            (empty || value.length > 0) &&
            !/[\u0000-\u001f]/.test(value)
        );
    }
    function finite(value: any): boolean {
        return typeof value === "number" && isFinite(value);
    }
    function scalar(value: any): boolean {
        return text(value) || finite(value);
    }
    function boolean(value: any): boolean {
        return typeof value === "boolean";
    }
    function array(value: any, check: Check, limit = 50000): boolean {
        if (
            !Array.isArray(value) ||
            value.length > limit ||
            Object.keys(value).length !== value.length
        )
            return false;
        for (var i = 0; i < value.length; i++)
            if (!owns(value, i) || !check(value[i])) return false;
        return true;
    }
    function strings(value: any): boolean {
        var seen: Record<string, boolean> = Object.create(null);
        return array(value, function (item) {
            if (!text(item) || seen[item]) return false;
            seen[item] = true;
            return true;
        });
    }
    function dictionary(check: Check, limit = 50000): Check {
        return function (value) {
            return (
                object(value) &&
                Object.keys(value).length <= limit &&
                Object.keys(value).every(function (key) {
                    return name(key) && text(key) && check(value[key]);
                })
            );
        };
    }
    var itemReference = record({ itemId: text });
    var legacyReference = record(
        {
            legacyId: scalar,
            origin: function (value) {
                return value === "raw" || value === "canonical";
            },
        },
        { ambiguous: boolean }
    );
    function reference(value: any): boolean {
        return itemReference(value) || legacyReference(value);
    }
    var group = record(
        {
            id: text,
            label: function (value) {
                return text(value, true);
            },
            members: strings,
        },
        { inheritsMembers: boolean, known: strings, shuffleBefore: strings }
    );
    var numbers = dictionary(finite);
    var selection = record({ groupId: text, itemId: text });
    var channelDocument = record({
        groups: function (value) {
            var ids: Record<string, boolean> = Object.create(null);
            return array(
                value,
                function (value) {
                    if (!group(value) || ids[value.id]) return false;
                    ids[value.id] = true;
                    return true;
                },
                1000
            );
        },
        hidden: strings,
        locks: strings,
        nextGroup: function (value) {
            return (
                finite(value) &&
                value > 0 &&
                Math.floor(value) === value &&
                value <= 9007199254740991
            );
        },
        preferences: record(
            {},
            {
                aspect: numbers,
                audio: numbers,
                subtitle: numbers,
                zoom: numbers,
            }
        ),
        selected: function (value) {
            return value === null || selection(value);
        },
        sourceId: text,
        unlocks: strings,
        version: 1,
    });
    function channels(value: any): boolean {
        return (
            value === null ||
            (channelDocument(value) &&
                value.locks.every(function (id: string) {
                    return value.unlocks.indexOf(id) < 0;
                }))
        );
    }
    var favoriteDocument = record(
        {
            lists: record({
                active: function (value) {
                    return text(value) && name(value);
                },
                lists: dictionary(function (value) {
                    return array(value, reference);
                }, 1000),
                order: strings,
                v: 1,
            }),
            sourceId: text,
            version: 2,
        },
        {
            defaultList: function (value) {
                return value === "Favorites";
            },
            shuffleBefore: dictionary(function (value) {
                return array(value, reference);
            }, 1000),
        }
    );
    function favorites(value: any): boolean {
        if (value === null) return true;
        if (!favoriteDocument(value)) return false;
        var lists = value.lists;
        return (
            owns(lists.lists, lists.active) &&
            (value.defaultList === undefined ||
                owns(lists.lists, value.defaultList)) &&
            (value.shuffleBefore === undefined ||
                Object.keys(value.shuffleBefore).every(function (key) {
                    return owns(lists.lists, key);
                })) &&
            lists.order.length <= 1000 &&
            lists.order.every(function (key: string) {
                return owns(lists.lists, key);
            })
        );
    }
    var portable = record({
        channels: channels,
        favorites: favorites,
        sourceId: text,
    });
    function validate(value: any, source: string): boolean {
        try {
            return (
                portable(value) &&
                [value, value.channels, value.favorites].every(
                    function (document) {
                        return (
                            document === null || document.sourceId === source
                        );
                    }
                )
            );
        } catch (_) {
            return false;
        }
    }
    function legacy(
        source: string,
        locked: any[],
        selected: any[],
        catalog: any,
        aliases: any,
        current: any,
        referenceFactory: (catalog: any, aliases: any) => any
    ): any {
        if (
            !validate(current, source) ||
            !array(locked, scalar) ||
            !array(selected, scalar)
        )
            throw new Error("Invalid legacy library backup");
        var result = JSON.parse(JSON.stringify(current));
        var codec = referenceFactory(catalog, aliases);
        var channel = result.channels || {
            groups: [],
            hidden: [],
            locks: [],
            nextGroup: 1,
            preferences: {},
            selected: null,
            sourceId: source,
            unlocks: [],
            version: 1,
        };
        var locks: string[] = [];
        locked.forEach(function (value) {
            var ref = codec.resolve(value, "raw");
            var id =
                ref.itemId ||
                (ref.ambiguous ? "ambiguous:" : "unresolved:") +
                    String(ref.legacyId);
            if (locks.indexOf(id) < 0) locks.push(id);
        });
        channel.locks = locks;
        channel.unlocks = [];
        Object.keys(catalog || {}).forEach(function (key) {
            var ref = codec.resolve(key, "canonical");
            if (
                ref.itemId &&
                locks.indexOf(ref.itemId) < 0 &&
                channel.unlocks.indexOf(ref.itemId) < 0
            )
                channel.unlocks.push(ref.itemId);
        });
        result.channels = channel;
        var favorite = result.favorites || {
            defaultList: "Favorites",
            lists: {
                active: "Favorites",
                lists: { Favorites: [] },
                order: ["Favorites"],
                v: 1,
            },
            sourceId: source,
            version: 2,
        };
        favorite.lists.lists[favorite.lists.active] = selected.map(
            function (value) {
                return codec.resolve(value, "raw");
            }
        );
        if (favorite.shuffleBefore) {
            delete favorite.shuffleBefore[favorite.lists.active];
            if (!Object.keys(favorite.shuffleBefore).length)
                delete favorite.shuffleBefore;
        }
        result.favorites = favorite;
        if (!validate(result, source))
            throw new Error("Invalid migrated library backup");
        return result;
    }
    return { legacy: legacy, validate: validate };
}
(window as any).__ottLibraryBackup = createLibraryBackupCodec();

/** Explicit codec for provider/native guide rows and the retained renderer ABI. */
declare function normalizeSearchText(value: string): string;
var classicGuideOwner: any = null;
var classicGuideBindings: Record<
    string,
    { row: any; reference: GuideReference }
> = Object.create(null);
var classicGuideConsumers: Record<string, () => void> = Object.create(null);
function guideHost(): any {
    return window as any;
}
function guideSource(): string {
    var host = guideHost();
    if (host.__ottSourceIdentity) return host.__ottSourceIdentity.current(host);
    var slot = host.p_pref === "m3u" && host.m3uArr ? host.m3uArr.active : null;
    return JSON.stringify([host.p_pref || host.providerId || "classic", slot]);
}
function guideChannelId(row: any, id: any): string {
    return String(row.itemId || "channel:" + id);
}
function guideRowReference(host: any, id: any): GuideReference | null {
    var row = (host.channels || {})[id];
    return row
        ? {
              channelId: guideChannelId(row, id),
              id: id,
              sourceId: guideSource(),
              token: row,
          }
        : null;
}
function guideReference(id: any): GuideReference | null {
    var host = guideHost();
    var candidates = (host.cList || host.curList || []).filter(function (
        key: any
    ) {
        return String(key) === String(id);
    });
    if (candidates.length === 1) id = candidates[0];
    return guideRowReference(host, id);
}
function guideReferences(ids: any[]): Array<GuideReference | null> {
    var host = guideHost(),
        canonical: Record<string, { id: any; unique: boolean }> =
            Object.create(null);
    (host.cList || host.curList || []).forEach(function (id: any) {
        var key = String(id),
            entry = canonical[key];
        if (entry) entry.unique = false;
        else canonical[key] = { id: id, unique: true };
    });
    return ids.map(function (id: any) {
        var entry = canonical[String(id)];
        return guideRowReference(host, entry && entry.unique ? entry.id : id);
    });
}
function guideCurrent(reference: GuideReference): boolean {
    return (
        !guideHost().__ottStandby?.blocked() &&
        reference.sourceId === guideSource() &&
        (guideHost().channels || {})[reference.id] === reference.token &&
        guideChannelId(reference.token, reference.id) === reference.channelId
    );
}
function decodeGuide(reference: GuideReference, raw: any): GuideProgramme[] {
    if (!Array.isArray(raw)) return [];
    var core = guideHost().OttPlayCore;
    return raw
        .filter(function (row) {
            return (
                row &&
                isFinite(Number(row.time)) &&
                isFinite(Number(row.time_to)) &&
                Number(row.time_to) > Number(row.time)
            );
        })
        .map(function (row) {
            return {
                description: String(row.descr || ""),
                end: Number(row.time_to),
                icon: row.icon,
                id: core.guideProgrammeId(
                    reference.sourceId,
                    reference.channelId,
                    row.providerId === undefined ? row.id : row.providerId,
                    Number(row.time)
                ),
                providerId:
                    row.providerId === undefined ? row.id : row.providerId,
                start: Number(row.time),
                title: String(row.name || ""),
            };
        });
}
function encodeGuide(row: GuideProgramme): any {
    return {
        descr: row.description,
        icon: row.icon,
        name: row.title,
        programmeId: row.id,
        providerId: row.providerId,
        time: row.start,
        time_to: row.end,
    };
}
function encodeGuides(rows: GuideProgramme[] | null): any[] | null {
    return rows && rows.map(encodeGuide);
}
function guideOwner(): any {
    if (!classicGuideOwner) {
        var host = guideHost();
        classicGuideOwner = host.__ottGuideService.create({
            capacity: function () {
                return Number(host.epgCacheCapacity) || 0;
            },
            clearTimer: function (id: any) {
                clearTimeout(id);
            },
            context: guideSource,
            current: guideCurrent,
            decode: decodeGuide,
            fetch: function (reference: GuideReference, complete: any) {
                if (host.__ottStandby?.blocked()) {
                    complete(null);
                    return function () {};
                }
                return host.fetchChannelGuide(
                    reference.id,
                    function (_id: any, rows: any) {
                        complete(rows);
                    }
                );
            },
            nextCount: function () {
                return Math.max(1, (Number(host.sNextCount) || 0) + 1);
            },
            now: function () {
                return Date.now() / 1000;
            },
            select: function (rows: any, now: number, count: number) {
                return host.OttPlayCore.guideScheduleSelection(
                    rows,
                    now,
                    count
                );
            },
            timer: function (callback: any, delay: number) {
                return setTimeout(callback, delay);
            },
        });
    }
    return classicGuideOwner;
}
function bindGuide(reference: GuideReference): void {
    var key = String(reference.id),
        bound = classicGuideBindings[key],
        host = guideHost();
    if (
        bound &&
        bound.row === reference.token &&
        bound.reference.sourceId === reference.sourceId
    )
        return;
    if (classicGuideConsumers[key]) {
        classicGuideConsumers[key]();
        delete classicGuideConsumers[key];
    }
    var row = reference.token;
    var seed =
        row.time_to > row.time
            ? [
                  {
                      descr: row.descr,
                      icon: row.icon,
                      name: row.name,
                      time: row.time,
                      time_to: row.time_to,
                  },
              ].concat(row.nextpr || [])
            : [];
    classicGuideBindings[key] = { reference: reference, row: row };
    var baseIcon = row.icon;
    function field(name: string): any {
        return guideOwner().field(reference, name);
    }
    var properties: any = {
        descr: function () {
            return field("description") || "";
        },
        icon: function () {
            var value = field("icon");
            return value !== undefined ? value : baseIcon;
        },
        name: function () {
            return field("title") || "";
        },
        nextpr: function () {
            var rows = field("following") || [];
            return rows.length ? encodeGuides(rows) : null;
        },
        outdated: function () {
            return field("missing") !== false;
        },
        time: function () {
            return field("start") || 0;
        },
        time_request: function () {
            return field("retryAt") || 0;
        },
        time_to: function () {
            return field("end") || 0;
        },
    };
    Object.keys(properties).forEach(function (name) {
        Object.defineProperty(row, name, {
            configurable: true,
            enumerable: true,
            get: properties[name],
            set: function () {},
        });
    });
    var cache = host.epgCache || host.epg;
    if (cache)
        Object.defineProperty(cache, key, {
            configurable: true,
            enumerable: true,
            get: function () {
                return encodeGuides(guideOwner().peek(reference));
            },
            set: function () {},
        });
    if (seed.length)
        guideOwner().publish(reference, decodeGuide(reference, seed));
}
function requestGuide(
    id: any,
    notify: (id: number, rows: any) => void
): () => void {
    var reference = guideReference(id);
    if (!reference) {
        notify(id, null);
        return function () {};
    }
    bindGuide(reference);
    return guideOwner().request(reference, function (rows: any) {
        notify(id, encodeGuides(rows));
    });
}
function currentGuide(id: any, callback: (id: any) => void): boolean {
    var reference = guideReference(id);
    if (!reference) return false;
    bindGuide(reference);
    var owner = guideOwner(),
        state = owner.snapshot(reference),
        now = Date.now() / 1000;
    if (!classicGuideConsumers[id]) {
        var captured = reference;
        var pending = function () {};
        classicGuideConsumers[id] = pending;
        var cancel = owner.subscribe(reference, function () {
            setTimeout(function () {
                if (
                    classicGuideConsumers[id] === cancel &&
                    guideCurrent(captured)
                )
                    callback(id);
            }, 0);
        });
        if (classicGuideConsumers[id] === pending)
            classicGuideConsumers[id] = cancel;
        else cancel();
    }
    return !!(
        state &&
        state.current &&
        state.current.start <= now &&
        state.current.end > now
    );
}
function clearGuideConsumers(): void {
    var old = classicGuideConsumers;
    classicGuideConsumers = Object.create(null);
    Object.keys(old).forEach(function (key) {
        old[key]();
    });
}
var classicGuideApi = {
    bind: bindGuide,
    cancelConsumers: clearGuideConsumers,
    current: currentGuide,
    decode: decodeGuide,
    encode: encodeGuide,
    encodeRows: encodeGuides,
    invalidate: function (warm: boolean) {
        if (!warm) clearGuideConsumers();
        guideOwner().invalidate(warm);
        if (!warm) {
            classicGuideBindings = Object.create(null);
            var cache = guideHost().epgCache || guideHost().epg;
            if (cache)
                Object.keys(cache).forEach(function (key) {
                    delete cache[key];
                });
            if (guideHost().__ottClassicGuideScreen)
                guideHost().__ottClassicGuideScreen.close();
            if (guideHost().__ottClassicReminders)
                guideHost().__ottClassicReminders.dispose();
        }
    },
    invalidateChannel: function (id: number) {
        var reference = guideReference(id);
        if (!reference) return;
        if (classicGuideConsumers[id]) {
            classicGuideConsumers[id]();
            delete classicGuideConsumers[id];
        }
        guideOwner().invalidateChannel(reference, true);
    },
    owner: guideOwner,
    peek: function (id: number) {
        var ref = guideReference(id);
        return ref ? encodeGuides(guideOwner().peek(ref)) : null;
    },
    publish: function (id: number, raw: any) {
        var ref = guideReference(id);
        if (ref) {
            bindGuide(ref);
            guideOwner().publish(ref, decodeGuide(ref, raw));
        }
    },
    reference: guideReference,
    references: guideReferences,
    request: requestGuide,
    search: function (text: string) {
        var query = normalizeSearchText(text),
            rows: any[] = [];
        guideOwner()
            .cached()
            .forEach(function (entry: any) {
                entry.rows.forEach(function (row: GuideProgramme) {
                    if (normalizeSearchText(row.title).indexOf(query) !== -1) {
                        var item = encodeGuide(row);
                        item.ch_id = entry.reference.id;
                        item.sourceId = entry.reference.sourceId;
                        item.channelId = entry.reference.channelId;
                        rows.push(item);
                    }
                });
            });
        return rows.sort(function (a, b) {
            return a.time - b.time;
        });
    },
    seed: function (id: any, rows: any) {
        var reference = guideReference(id);
        if (reference) {
            bindGuide(reference);
            guideOwner().seed(reference, rows);
        }
    },
    source: guideSource,
    suspend: function () {
        clearGuideConsumers();
        if (classicGuideOwner) classicGuideOwner.dispose();
        classicGuideOwner = null;
    },
    valid: guideCurrent,
};
(window as any).__ottClassicGuide = classicGuideApi;

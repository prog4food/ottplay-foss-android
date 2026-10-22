interface ProgrammeReminder {
    channelId: string;
    end: number;
    id: string;
    legacy?: boolean;
    programmeId: string;
    sourceId: string;
    start: number;
    title: string;
}
interface ReminderPorts {
    clearTimer(timer: any): void;
    current(): boolean;
    leadSeconds(): number;
    legacy(): any;
    legacyRecord(value: any): ProgrammeReminder | null;
    notify(record: ProgrammeReminder, minutes: number): void;
    now(): number;
    play(record: ProgrammeReminder): void;
    prompt(record: ProgrammeReminder, accept: () => void): (() => void) | void;
    read(key: string): string | null;
    resolve(record: ProgrammeReminder): boolean;
    sourceId: string;
    timer(callback: () => void, delay: number): any;
    write(key: string, value: string): void;
}

/** Durable identity never contains a list position, renderer row or timer handle. */
function createReminderService(ports: ReminderPorts) {
    var key = "guideReminders:" + ports.sourceId;
    var records: ProgrammeReminder[] = [];
    var writable = true;
    var disposed = false;
    var timer: any = null;
    var generation = 0;
    var operation = 0;
    var prompted: Record<string, boolean> = Object.create(null);
    var notified: Record<string, boolean> = Object.create(null);
    var promptRevision = 0;
    var promptId = "";
    var closePrompt: (() => void) | null = null;
    function clone<T>(value: T): T {
        return JSON.parse(JSON.stringify(value));
    }
    function active(): boolean {
        return !disposed && ports.current();
    }
    function valid(value: any): value is ProgrammeReminder {
        return (
            !!value &&
            value.sourceId === ports.sourceId &&
            typeof value.id === "string" &&
            value.id !== "" &&
            typeof value.channelId === "string" &&
            value.channelId !== "" &&
            typeof value.programmeId === "string" &&
            value.programmeId !== "" &&
            typeof value.title === "string" &&
            typeof value.start === "number" &&
            isFinite(value.start) &&
            typeof value.end === "number" &&
            isFinite(value.end) &&
            value.end > value.start
        );
    }
    function normalize(values: any[]): ProgrammeReminder[] {
        var seen: Record<string, boolean> = Object.create(null);
        return values
            .filter(function (value) {
                if (!valid(value) || seen[value.id]) return false;
                seen[value.id] = true;
                return true;
            })
            .map(clone);
    }
    function currentRecord(record: ProgrammeReminder): boolean {
        return (
            active() &&
            records.some(function (item) {
                return (
                    item.id === record.id &&
                    item.start === record.start &&
                    item.end === record.end
                );
            })
        );
    }
    function retirePrompt(): void {
        promptRevision++;
        promptId = "";
        var close = closePrompt;
        closePrompt = null;
        if (close) {
            try {
                close();
            } catch (_) {}
        }
    }
    function schedule(): void {
        ports.clearTimer(timer);
        timer = null;
        if (!active()) return;
        var now = ports.now(),
            next = Infinity;
        if (!isFinite(now)) return;
        var lead = Math.max(0, Number(ports.leadSeconds()) || 0);
        records.forEach(function (record) {
            if (record.end <= now || !ports.resolve(record)) return;
            if (!prompted[record.id]) next = Math.min(next, record.start);
            if (lead && !notified[record.id] && record.start > now)
                next = Math.min(next, Math.max(now, record.start - lead));
        });
        if (!isFinite(next)) return;
        var expected = generation;
        timer = ports.timer(
            function () {
                timer = null;
                if (!active() || generation !== expected) return;
                var now = ports.now();
                records.slice().forEach(function (record) {
                    if (
                        !currentRecord(record) ||
                        generation !== expected ||
                        record.end <= now ||
                        !ports.resolve(record)
                    )
                        return;
                    if (record.start > now) {
                        if (
                            lead &&
                            record.start - lead <= now &&
                            !notified[record.id]
                        ) {
                            notified[record.id] = true;
                            try {
                                ports.notify(
                                    clone(record),
                                    Math.max(
                                        0,
                                        Math.ceil((record.start - now) / 60)
                                    )
                                );
                            } catch (_) {}
                        }
                        return;
                    }
                    if (prompted[record.id]) return;
                    prompted[record.id] = true;
                    retirePrompt();
                    if (!currentRecord(record) || generation !== expected)
                        return;
                    var revision = promptRevision;
                    promptId = record.id;
                    var used = false;
                    var close: any = null;
                    try {
                        close = ports.prompt(clone(record), function () {
                            if (
                                used ||
                                revision !== promptRevision ||
                                !currentRecord(record) ||
                                generation !== expected ||
                                ports.now() >= record.end ||
                                !ports.resolve(record)
                            )
                                return;
                            used = true;
                            promptId = "";
                            closePrompt = null;
                            ports.play(clone(record));
                        });
                    } catch (_) {}
                    if (
                        !used &&
                        revision === promptRevision &&
                        currentRecord(record)
                    )
                        closePrompt = close || null;
                    else if (close) close();
                });
                schedule();
            },
            Math.max(0, Math.min(2147483647, (next - now) * 1000))
        );
    }
    function persist(next: ProgrammeReminder[]): boolean {
        if (!writable || !active()) return false;
        var expected = ++operation;
        var text = JSON.stringify({
            records: next,
            sourceId: ports.sourceId,
            version: 1,
        });
        try {
            var previous = ports.read(key);
            if (!active() || expected !== operation) return false;
            if (previous !== text) ports.write(key, text);
            if (
                !active() ||
                expected !== operation ||
                ports.read(key) !== text ||
                !active() ||
                expected !== operation
            )
                return false;
            var claim = ports.read("guideReminderSource");
            if (!active() || expected !== operation) return false;
            if (!claim) ports.write("guideReminderSource", ports.sourceId);
            if (!active() || expected !== operation) return false;
            var old = records;
            if (promptId) {
                delete prompted[promptId];
                retirePrompt();
                if (!active() || expected !== operation) return false;
            }
            var starts: Record<string, number> = Object.create(null);
            old.forEach(function (record) {
                starts[record.id] = record.start;
            });
            next.forEach(function (record) {
                if (starts[record.id] !== record.start) {
                    delete prompted[record.id];
                    delete notified[record.id];
                }
            });
            records = next;
            generation++;
            if (
                promptId &&
                !records.some(function (record) {
                    return record.id === promptId;
                })
            )
                retirePrompt();
            schedule();
            return true;
        } catch (_) {
            if (active() && expected === operation) schedule();
            return false;
        }
    }
    function load(): void {
        generation++;
        var expected = ++operation;
        ports.clearTimer(timer);
        timer = null;
        retirePrompt();
        prompted = Object.create(null);
        notified = Object.create(null);
        records = [];
        writable = true;
        if (!active() || expected !== operation) return;
        try {
            var text = ports.read(key);
            if (!active() || expected !== operation) return;
            if (text !== null) {
                var document = JSON.parse(text);
                if (
                    !document ||
                    document.version !== 1 ||
                    document.sourceId !== ports.sourceId ||
                    !Array.isArray(document.records) ||
                    !document.records.every(valid)
                ) {
                    writable = false;
                    return;
                }
                records = normalize(document.records);
            } else {
                var legacy = ports.legacy();
                if (!active() || expected !== operation) return;
                var claim = ports.read("guideReminderSource");
                if (!active() || expected !== operation) return;
                if (!claim || claim === ports.sourceId) {
                    if (Array.isArray(legacy) && legacy.length) {
                        var imported = normalize(
                            legacy
                                .map(ports.legacyRecord)
                                .filter(function (value) {
                                    return !!value;
                                })
                        );
                        if (!active() || expected !== operation) return;
                        if (imported.length && !claim) {
                            ports.write("guideReminderSource", ports.sourceId);
                            if (!active() || expected !== operation) return;
                            if (
                                ports.read("guideReminderSource") !==
                                ports.sourceId
                            ) {
                                writable = false;
                                return;
                            }
                            if (!active() || expected !== operation) return;
                        }
                        records = imported;
                    }
                }
            }
        } catch (_) {
            if (!active() || expected !== operation) return;
            writable = false;
            records = [];
        }
        records.forEach(function (record) {
            if (record.start <= ports.now()) {
                prompted[record.id] = true;
                notified[record.id] = true;
            }
        });
        schedule();
    }
    return {
        dispose: function () {
            if (!disposed) {
                disposed = true;
                generation++;
                operation++;
                ports.clearTimer(timer);
                timer = null;
                retirePrompt();
            }
        },
        guard: function (
            record: ProgrammeReminder,
            callback: () => void
        ): () => void {
            var expected = generation;
            return function () {
                if (expected === generation && currentRecord(record))
                    callback();
            };
        },
        has: function (id: string): boolean {
            return records.some(function (record) {
                return record.id === id;
            });
        },
        load: load,
        persist: function () {
            return persist(clone(records));
        },
        readonly: function () {
            return !writable;
        },
        remove: function (id: string): boolean {
            return persist(
                records.filter(function (record) {
                    return record.id !== id;
                })
            );
        },
        snapshot: function () {
            return clone(records);
        },
        upsert: function (record: ProgrammeReminder): boolean {
            if (!valid(record)) return false;
            var next = records.filter(function (entry) {
                return entry.id !== record.id;
            });
            next.push(clone(record));
            return persist(next);
        },
    };
}

(window as any).__ottReminderService = { create: createReminderService };

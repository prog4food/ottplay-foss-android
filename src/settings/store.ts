/** Settings domain. No browser, renderer or ambient storage dependencies. */
export interface SettingDefinition {
    decode?(value: string): any;
    defaultValue: any;
    effects: string[];
    encode?(value: any): string;
    id: string;
    invalidValue?: any;
    key: string;
    prepare?(value: any): any;
    protectOnLoad?: boolean;
    protectRollback?(value: string | null): string | null;
    scope: "application" | "provider";
    validate(value: any): boolean;
}
export interface SettingStorage {
    current?(): boolean;
    key?: string;
    read(): string | null;
    remove(): void;
    transaction?(
        writes: {
            key: string;
            before: string | null;
            after: string | null;
            rollback?: string | null;
        }[],
        current: () => boolean
    ): boolean;
    write(value: string): void;
}
export interface SettingsPorts {
    context(): string;
    effect(name: string): void;
    storage(definition: SettingDefinition): SettingStorage;
}
export interface SettingsWrite {
    after: string | null;
    before: string | null;
    rollback?: string | null;
    storage: SettingStorage;
}

/** Stable application-owned failure codes; engine exceptions remain diagnostics. */
function settingsFailure(code: string, message: string): Error {
    var error = new Error(message);
    (error as any).settingsCode = code;
    return error;
}

/** Persist captured bytes without publishing runtime state or adopting another owner. */
export function commitSettingsWrites(
    writes: SettingsWrite[],
    current: () => boolean,
    rollbackAllowed: () => boolean
): void {
    var transaction = writes.length && writes[0].storage.transaction;
    if (
        transaction &&
        writes.every(function (write) {
            return (
                typeof write.storage.key === "string" &&
                write.storage.transaction === transaction
            );
        }) &&
        transaction(
            writes.map(function (write) {
                return {
                    after: write.after,
                    before: write.before,
                    key: write.storage.key!,
                    rollback: Object.prototype.hasOwnProperty.call(
                        write,
                        "rollback"
                    )
                        ? write.rollback
                        : write.before,
                };
            }),
            current
        )
    ) {
        // A native/reentrant commit can finish after the source changes. Its
        // durable bytes are committed, but stale runtime values must not publish.
        if (!current())
            throw settingsFailure("source_changed", "Settings source changed");
        return;
    }
    var batch = writes.map(function (write) {
        return {
            after: write.after,
            before: write.before,
            rollback: Object.prototype.hasOwnProperty.call(write, "rollback")
                ? write.rollback
                : write.before,
            storage: write.storage,
        };
    });
    var attempted = 0;
    function requireCurrent(): void {
        if (!current())
            throw settingsFailure("source_changed", "Settings source changed");
    }
    function checkBefore(write: SettingsWrite): void {
        requireCurrent();
        var actual = write.storage.read();
        requireCurrent();
        if (actual !== write.before)
            throw settingsFailure("backup_changed", "Backup state changed");
    }
    try {
        requireCurrent();
        batch.forEach(checkBefore);
        for (var i = 0; i < batch.length; i++) {
            var write = batch[i];
            checkBefore(write);
            attempted = i + 1;
            if (write.after === null) write.storage.remove();
            else write.storage.write(write.after);
            requireCurrent();
            var actual = write.storage.read();
            requireCurrent();
            if (actual !== write.after)
                throw settingsFailure(
                    "write_rejected",
                    "Settings storage rejected write"
                );
        }
        requireCurrent();
    } catch (error) {
        // Roll back only attempted keys whose bytes still belong to this batch.
        for (var j = attempted - 1; j >= 0; j--) {
            try {
                if (!rollbackAllowed()) break;
                var write = batch[j];
                var actual = write.storage.read();
                if (!rollbackAllowed()) break;
                if (actual !== write.after) continue;
                if (write.rollback === null) write.storage.remove();
                else write.storage.write(write.rollback!);
            } catch (_rollback) {
                /* Preserve the original failure; a caller must not publish state. */
            }
        }
        throw error;
    }
}
export interface SettingsDraft {
    active(): boolean;
    cancel(): void;
    commit(writes?: SettingsWrite[], admitted?: () => boolean): boolean;
    error(): string;
    errorCode(): string;
    get(id: string): any;
    set(id: string, value: any): boolean;
}

/** A single owner, with detached snapshots and optimistic, source-bound drafts. */
export function createSettingsStore(
    schema: SettingDefinition[],
    ports: SettingsPorts
) {
    var definitions: Record<string, SettingDefinition> = Object.create(null);
    var values: Record<string, any> = Object.create(null);
    var revision = 0;
    var versions: Record<string, number> = Object.create(null);
    var context = ports.context();
    function copy(value: any): any {
        return Array.isArray(value) ? value.slice() : value;
    }
    function equal(a: any, b: any): boolean {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    schema.forEach(function (entry) {
        if (definitions[entry.id])
            throw new Error("Duplicate setting: " + entry.id);
        definitions[entry.id] = entry;
        values[entry.id] = copy(entry.defaultValue);
    });
    function get(id: string): any {
        return copy(values[id]);
    }
    function publish(id: string, value: any): void {
        if (!equal(values[id], value)) versions[id] = (versions[id] || 0) + 1;
        values[id] = copy(value);
    }
    function observe(id: string, value: any): boolean {
        var entry = definitions[id];
        if (!entry || !entry.validate(value)) return false;
        publish(id, value);
        return true;
    }
    function reload(scope?: "application" | "provider"): void {
        var generation = ++revision;
        var source: string;
        var protectedVersions: Record<string, number> = Object.create(null);
        // Revoke existing grants before any storage/crypto callback can run.
        // Failed or reentrant loads must not retain the prior usable credential.
        schema.forEach(function (entry) {
            if (!entry.protectOnLoad || (scope && entry.scope !== scope))
                return;
            publish(entry.id, copy(entry.invalidValue));
            protectedVersions[entry.id] = versions[entry.id] || 0;
        });
        try {
            source = ports.context();
        } catch (_contextError) {
            return;
        }
        if (generation !== revision) return;
        context = source;
        function current(): boolean {
            var currentSource: string;
            try {
                currentSource = ports.context();
            } catch (_contextError) {
                return false;
            }
            return (
                generation === revision &&
                source === currentSource &&
                Object.keys(protectedVersions).every(function (id) {
                    return (versions[id] || 0) === protectedVersions[id];
                })
            );
        }
        var loaded: Record<string, any> = {};
        var protectedReads: Record<string, () => boolean> = Object.create(null);
        schema.forEach(function (entry) {
            if (scope && entry.scope !== scope) return;
            var value = copy(entry.defaultValue);
            try {
                var storage = ports.storage(entry);
                var raw = storage.read();
                if (raw !== null) {
                    var parsed = entry.decode
                        ? entry.decode(raw)
                        : typeof entry.defaultValue === "number"
                          ? /^[-+]?\d+$/.test(raw)
                              ? Number(raw)
                              : NaN
                          : raw;
                    if (entry.validate(parsed)) value = parsed;
                    else if (
                        Object.prototype.hasOwnProperty.call(
                            entry,
                            "invalidValue"
                        )
                    )
                        value = copy(entry.invalidValue);
                }
                if (entry.protectOnLoad) {
                    var entryCurrent = function (): boolean {
                        var currentStorage =
                            !storage.current || storage.current();
                        return currentStorage && current();
                    };
                    if (!entry.prepare || !entry.validate(value))
                        throw new Error("Invalid protected setting");
                    value = entry.prepare(value);
                    var encoded = entry.encode
                        ? entry.encode(value)
                        : String(value);
                    if (encoded !== raw)
                        commitSettingsWrites(
                            [
                                {
                                    after: encoded,
                                    before: raw,
                                    rollback: encoded,
                                    storage,
                                },
                            ],
                            entryCurrent,
                            entryCurrent
                        );
                    else if (
                        !entryCurrent() ||
                        storage.read() !== encoded ||
                        !entryCurrent()
                    )
                        throw new Error(
                            "Protected setting changed while loading"
                        );
                    protectedReads[entry.id] = function () {
                        try {
                            return (
                                entryCurrent() &&
                                storage.read() === encoded &&
                                entryCurrent()
                            );
                        } catch (_readError) {
                            return false;
                        }
                    };
                }
            } catch (_error) {
                if (Object.prototype.hasOwnProperty.call(entry, "invalidValue"))
                    value = copy(entry.invalidValue);
                /* Security settings fail closed instead of restoring a default credential. */
            }
            loaded[entry.id] = copy(value);
        });
        Object.keys(protectedReads).forEach(function (id) {
            if (!protectedReads[id]())
                loaded[id] = copy(definitions[id].invalidValue);
        });
        if (!current()) return;
        Object.keys(loaded).forEach(function (id) {
            publish(id, loaded[id]);
        });
    }
    function begin(persistCurrent = false): SettingsDraft {
        // A failed catalog load must not prevent editing the new source's
        // preferences. Hydrate its scope before taking a fresh draft snapshot.
        if (ports.context() !== context) reload("provider");
        var generation = revision;
        var source = ports.context();
        var original: Record<string, any> = {};
        var pending: Record<string, any> = {};
        var open = true;
        var message = "";
        var code = "";
        schema.forEach(function (entry) {
            original[entry.id] = get(entry.id);
        });
        function active(): boolean {
            return (
                open &&
                generation === revision &&
                source === context &&
                source === ports.context()
            );
        }
        return {
            active: active,
            cancel: function () {
                open = false;
                pending = {};
            },
            commit: function (
                additional = [],
                admitted = function () {
                    return true;
                }
            ) {
                function current(): boolean {
                    return active() && admitted();
                }
                if (!current()) {
                    message = "Settings source changed";
                    code = "source_changed";
                    return false;
                }
                var changes = Object.keys(pending).filter(function (id) {
                    return persistCurrent || !equal(original[id], pending[id]);
                });
                if (
                    changes.some(function (id) {
                        return !equal(values[id], original[id]);
                    })
                ) {
                    message = "Settings changed while editing";
                    code = "concurrent_edit";
                    return false;
                }
                var writes: SettingsWrite[];
                try {
                    additional.forEach(function (write) {
                        if (write.storage.read() !== write.before)
                            throw settingsFailure(
                                "backup_changed",
                                "Backup state changed"
                            );
                    });
                    writes = additional.slice();
                    changes.forEach(function (id) {
                        var entry = definitions[id],
                            storage = ports.storage(entry);
                        var before = storage.read();
                        // Preserve the old value without re-persisting a legacy
                        // plaintext credential if a later write fails.
                        var rollback = entry.protectRollback
                            ? entry.protectRollback(before)
                            : before;
                        writes.push({
                            after: entry.encode
                                ? entry.encode(pending[id])
                                : String(pending[id]),
                            before: before,
                            rollback: rollback,
                            storage: storage,
                        });
                    });
                    commitSettingsWrites(writes, current, admitted);
                } catch (error) {
                    message = String(error);
                    code = String((error as any)?.settingsCode || "");
                    return false;
                }
                open = false;
                message = "";
                code = "";
                var effects: string[] = [];
                changes.forEach(function (id) {
                    publish(id, pending[id]);
                    definitions[id].effects.forEach(function (name) {
                        if (effects.indexOf(name) === -1) effects.push(name);
                    });
                });
                effects.forEach(function (name) {
                    if (
                        generation !== revision ||
                        source !== ports.context() ||
                        !admitted()
                    )
                        return;
                    try {
                        ports.effect(name);
                    } catch (error) {
                        message = String(error);
                        code = String((error as any)?.settingsCode || "");
                    }
                });
                return true;
            },
            error: function () {
                return message;
            },
            errorCode: function () {
                return code;
            },
            get: function (id) {
                return copy(
                    Object.prototype.hasOwnProperty.call(pending, id)
                        ? pending[id]
                        : original[id]
                );
            },
            set: function (id, value) {
                var entry = definitions[id];
                if (!active() || !entry || !entry.validate(value)) {
                    message = "Invalid setting: " + id;
                    code = "invalid_setting";
                    return false;
                }
                try {
                    if (entry.prepare) value = entry.prepare(value);
                } catch (_error) {
                    message = "Could not protect setting: " + id;
                    code = "invalid_setting";
                    return false;
                }
                pending[id] = copy(value);
                message = "";
                code = "";
                return true;
            },
        };
    }
    return {
        begin: begin,
        context: function () {
            return context;
        },
        get: get,
        observe: observe,
        reload: reload,
        schema: schema.slice(),
        version: function (ids: string[]): string {
            return ids
                .map(function (id) {
                    return versions[id] || 0;
                })
                .join(":");
        },
    };
}

/** Device-local authority is intentionally outside portable/cloud settings. */
export interface DiagnosticsPermissionBinding {
    address: string;
    revision: string;
    token: string;
}
export interface DiagnosticsPermissionStore {
    /** False only when the storage API is absent, not when access fails. */
    available?: () => boolean;
    read: (
        done: (
            error: boolean,
            value: DiagnosticsPermissionBinding | null
        ) => void
    ) => void;
    subscribe?: (changed: () => void) => () => void;
    write: (
        value: DiagnosticsPermissionBinding | null,
        done: (error: boolean) => void
    ) => void;
}

export function createDiagnosticsPermissionStore(
    w: any
): DiagnosticsPermissionStore {
    var database = "ottplay-diagnostics-permission-v1";
    var bucket = "permission";
    var active = false;
    var channel: any = null;
    var listeners: (() => void)[] = [];
    var queue: (() => void)[] = [];
    function available(): boolean {
        try {
            return !!w.indexedDB && typeof w.indexedDB.open === "function";
        } catch (_) {
            // Denied access does not prove that an older grant is absent.
            return true;
        }
    }
    function next(): void {
        active = false;
        var operation = queue.shift();
        if (operation) {
            active = true;
            operation();
        }
    }
    function enqueue(operation: () => void): void {
        queue.push(operation);
        if (!active) next();
    }
    function valid(value: any): DiagnosticsPermissionBinding | null {
        if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.keys(value).sort().join(",") !== "address,revision,token" ||
            typeof value.address !== "string" ||
            value.address.length > 2048 ||
            value.address.slice(0, 8) !== "https://" ||
            typeof value.revision !== "string" ||
            !/^[A-Za-z0-9_.:-]{1,80}$/.test(value.revision) ||
            typeof value.token !== "string" ||
            !/^[A-Za-z0-9_-]{32,256}$/.test(value.token)
        )
            return null;
        return {
            address: value.address,
            revision: value.revision,
            token: value.token,
        };
    }
    function publish(): void {
        try {
            if (channel) channel.postMessage("changed");
            else if (typeof w.BroadcastChannel === "function") {
                var temporary = new w.BroadcastChannel(database);
                temporary.postMessage("changed");
                temporary.close();
            }
        } catch (_) {}
    }
    function operate(
        write: boolean,
        value: DiagnosticsPermissionBinding | null,
        done: (
            error: boolean,
            result: DiagnosticsPermissionBinding | null
        ) => void
    ): void {
        enqueue(function () {
            var db: any = null;
            var transaction: any = null;
            var finished = false;
            var timeout: any = null;
            var result: DiagnosticsPermissionBinding | null = null;
            function finish(error: boolean): void {
                if (finished) return;
                finished = true;
                if (timeout !== null) w.clearTimeout(timeout);
                if (error && transaction) {
                    try {
                        transaction.abort();
                    } catch (_) {}
                }
                if (db) db.close();
                try {
                    done(error, error ? null : result);
                } finally {
                    next();
                }
            }
            try {
                if (!w.indexedDB || typeof w.indexedDB.open !== "function") {
                    finish(true);
                    return;
                }
                var request = w.indexedDB.open(database, 1);
                timeout = w.setTimeout(function () {
                    finish(true);
                }, 3000);
                request.onerror = request.onblocked = function () {
                    finish(true);
                };
                request.onupgradeneeded = function () {
                    if (finished) return;
                    try {
                        if (!request.result.objectStoreNames.contains(bucket))
                            request.result.createObjectStore(bucket);
                    } catch (_) {
                        finish(true);
                    }
                };
                request.onsuccess = function () {
                    db = request.result;
                    if (finished) {
                        db.close();
                        return;
                    }
                    db.onversionchange = function () {
                        finish(true);
                    };
                    try {
                        transaction = db.transaction(
                            bucket,
                            write ? "readwrite" : "readonly"
                        );
                        transaction.onerror = transaction.onabort =
                            function () {
                                finish(true);
                            };
                        transaction.oncomplete = function () {
                            finish(false);
                        };
                        var store = transaction.objectStore(bucket);
                        if (write) {
                            if (value === null) store.clear();
                            else
                                store.put(
                                    {
                                        address: value.address,
                                        revision: value.revision,
                                        token: value.token,
                                    },
                                    "trusted-controller"
                                );
                        } else {
                            var read = store.get("trusted-controller");
                            read.onsuccess = function () {
                                result = valid(read.result);
                            };
                        }
                    } catch (_) {
                        finish(true);
                    }
                };
            } catch (_) {
                finish(true);
            }
        });
    }
    function erase(done: (error: boolean) => void): void {
        // A failed clear must be resolved before a queued new permission write.
        queue.unshift(function () {
            var finished = false;
            var timer: any = null;
            function finish(error: boolean): void {
                if (finished) return;
                finished = true;
                if (timer !== null) w.clearTimeout(timer);
                try {
                    done(error);
                } finally {
                    next();
                }
            }
            try {
                var request = w.indexedDB.deleteDatabase(database);
                timer = w.setTimeout(function () {
                    finish(true);
                }, 3000);
                request.onsuccess = function () {
                    finish(false);
                };
                request.onerror = function () {
                    finish(true);
                };
            } catch (_) {
                finish(true);
            }
        });
        if (!active) next();
    }
    return {
        available: available,
        read: function (done) {
            operate(false, null, done);
        },
        subscribe: function (changed) {
            listeners.push(changed);
            if (!channel && typeof w.BroadcastChannel === "function") {
                try {
                    channel = new w.BroadcastChannel(database);
                    channel.onmessage = function () {
                        listeners.slice().forEach(function (listener) {
                            listener();
                        });
                    };
                } catch (_) {}
            }
            return function () {
                var index = listeners.indexOf(changed);
                if (index >= 0) listeners.splice(index, 1);
                if (!listeners.length && channel) {
                    channel.close();
                    channel = null;
                }
            };
        },
        write: function (value, done) {
            var binding = value === null ? null : valid(value);
            if (value !== null && !binding) {
                done(true);
                return;
            }
            operate(true, binding, function (error) {
                function complete(failed: boolean): void {
                    if (!failed) publish();
                    done(failed);
                }
                if (error && value === null) erase(complete);
                else complete(error);
            });
        },
    };
}

import {
    remoteDoctorCapabilities,
    remotePlayerInfo,
} from "../commands/remote-restart";
import { collectRemoteDoctor } from "./remote-doctor";

/** Bounded metadata only. A handler receipt never proves a visible outcome. */
export function installRemoteInspection(w: any): any {
    var records: { [id: string]: any } = Object.create(null);
    var order: string[] = [];
    var actions = [
        "command",
        "play",
        "provider",
        "profile",
        "profile_settings",
        "profile_save",
        "profile_import",
        "provider_settings",
        "kiosk",
        "restart",
        "lifecycle",
        "input",
        "playback",
        "aspect",
        "play_catalog",
        "play_archive_catalog",
        "playback_handoff_import",
        "vportal",
        "vportal_search",
        "vportal_random",
        "plex_queue",
        "plex_library",
        "favorites",
        "vportal_queue",
        "maintenance",
    ];
    function runtime(): string {
        return remotePlayerInfo(w).runtime;
    }
    function lane(name: "main" | "pip"): any {
        var backend =
            typeof w.__ottCoreBackendPeek === "function" &&
            w.__ottCoreBackendPeek();
        var handle = backend && backend.current(name);
        if (!handle) return null;
        var value = handle.snapshot();
        return {
            duration: value.duration,
            id: handle.id,
            phase: value.phase,
            position: value.position,
        };
    }
    function snapshot(): any {
        return collectRemoteDoctor(w, {
            readCapabilities: function () {
                return remoteDoctorCapabilities(w);
            },
            readIdentity: function () {
                return {
                    build: {
                        buildId: "__OTTP_BUILD_ID__",
                        sourceRevision:
                            String("__OTTP_SOURCE_REVISION__") || null,
                        version: "__OTTP_VERSION__",
                    },
                    runtime: runtime(),
                };
            },
            readLane: lane,
            readPlayback: function () {
                return w.__ottClassicPlayback.snapshot();
            },
            readUI: function () {
                var port = w.__ottClassicScreenPort;
                if (!port || !port.screens) throw new Error("unavailable");
                return {
                    owner: port.screens.current(),
                    revision: port.revision(),
                };
            },
        });
    }
    function evidence(kind?: string): any {
        return { generation: null, kind: kind || "none", position: null };
    }
    function operation(id: string): any {
        var record = records[id];
        if (!record)
            return {
                action: null,
                evidence: evidence(),
                operation_id: id,
                state: "unknown",
            };
        if (Date.now() - record.time > 600000 || Date.now() < record.time)
            return {
                action: record.action,
                evidence: evidence(),
                operation_id: id,
                state: "expired",
            };
        // Receipt stages are not effect verification. Progress can result from a
        // local seek or a later command, even with the same decoder identity.
        return {
            action: record.action,
            evidence: record.evidence,
            operation_id: id,
            state: record.state,
        };
    }
    function request(
        item: any,
        done: (result: any) => void
    ): void | (() => void) {
        var params = item.params || {};
        var version =
            params.section === "debug" &&
            (params.version === 2 || params.version === 3)
                ? params.version
                : 1;
        function finish(status: string, value: any): void {
            var result: any = {
                runtime: runtime(),
                section: params.section,
                version: version,
            };
            result[status === "ok" ? "data" : "error"] = value;
            done({ data: result, status: status });
        }
        if (params.runtime !== runtime()) {
            finish("rejected", "runtime_mismatch");
            return;
        }
        if (
            params.version !== version ||
            ["doctor", "snapshot", "operation", "debug"].indexOf(
                params.section
            ) < 0 ||
            Object.keys(params).sort().join(",") !==
                (params.section === "operation"
                    ? "operation_id,runtime,section,version"
                    : "runtime,section,version") ||
            (params.section === "operation" &&
                (typeof params.operation_id !== "string" ||
                    !/^[a-f0-9]{32}$/.test(params.operation_id)))
        ) {
            finish("rejected", "invalid_request");
            return;
        }
        if (params.section === "debug") {
            var collector = w.__ottRuntimeDebug;
            if (!collector || typeof collector.snapshot !== "function") {
                finish("unsupported", "unsupported");
                return;
            }
            var cancelled = false;
            try {
                collector.snapshot(version).then(
                    function (value: any) {
                        if (cancelled) return;
                        if (
                            w.__ottRuntimeDebug !== collector ||
                            params.runtime !== runtime()
                        )
                            finish("rejected", "unavailable");
                        else finish("ok", value);
                    },
                    function () {
                        if (!cancelled) finish("rejected", "unavailable");
                    }
                );
            } catch (_) {
                finish("rejected", "unavailable");
            }
            return function () {
                cancelled = true;
            };
        }
        try {
            finish(
                "ok",
                params.section === "operation"
                    ? operation(params.operation_id)
                    : snapshot()
            );
        } catch (_) {
            finish("rejected", "unavailable");
        }
    }
    function mutation(item: any): boolean {
        var params = item.params || {};
        return (
            /^[a-f0-9]{32}$/.test(item.id || "") &&
            actions.indexOf(item.action) >= 0 &&
            item.action !== "vportal_search" &&
            !(item.action === "plex_library" && params.op !== "play") &&
            !(item.action === "favorites" && params.op !== "play") &&
            !(item.action === "aspect" && params.operation !== "set") &&
            !(item.action === "kiosk" && params.mode === "status") &&
            !(
                item.action === "plex_queue" &&
                /^(status|preview)$/.test(params.op)
            ) &&
            !(
                item.action === "vportal_queue" && params.operation === "status"
            ) &&
            !(
                item.action === "maintenance" &&
                /^(health|logs)$/.test(params.operation)
            )
        );
    }
    var api = {
        accept: function (item: any): boolean {
            // Filtering avoids a second updated document consuming a request
            // meant for this one. Server-side validation fences legacy replies.
            return (
                (item.action !== "inspect" &&
                    item.action !== "aspect" &&
                    item.action !== "plex_library" &&
                    item.action !== "favorites") ||
                !!(item.params && item.params.runtime === runtime())
            );
        },
        execute: function (
            item: any,
            done: (result: any) => void,
            afterReply: ((effect: () => void) => void) | undefined,
            execute: (
                item: any,
                done: (value: any) => void,
                afterReply?: (effect: () => void) => void
            ) => any
        ): any {
            if (item.action === "inspect") {
                return request(item, done);
            }
            if (!mutation(item)) return execute(item, done, afterReply);
            var record = {
                action: item.action,
                evidence: evidence(),
                state: "invoked",
                time: Date.now(),
            };
            records[item.id] = record;
            var previous = order.indexOf(item.id);
            if (previous >= 0) order.splice(previous, 1);
            order.push(item.id);
            while (order.length > 128) delete records[order.shift()!];
            var deferred = false;
            var replied = false;
            var register =
                afterReply &&
                function (effect: () => void): void {
                    deferred = true;
                    afterReply!(function () {
                        record.state = "invoked";
                        try {
                            var completed = (effect as () => any)();
                            // Aspect reports a cancelled/failed setter locally;
                            // completion still does not prove a physical display.
                            if (
                                item.action === "aspect" &&
                                completed !== true
                            ) {
                                record.state = "rejected";
                                record.evidence = evidence();
                                return;
                            }
                            record.evidence = evidence("handler_completed");
                        } catch (error) {
                            record.state = "rejected";
                            throw error;
                        }
                    });
                };
            try {
                var cancel = execute(
                    item,
                    function (result) {
                        if (replied) return;
                        replied = true;
                        record.state =
                            result.status === "ok"
                                ? deferred
                                    ? "accepted"
                                    : "invoked"
                                : result.status === "unsupported"
                                  ? "unsupported"
                                  : "rejected";
                        record.evidence = evidence(
                            result.status === "ok" && !deferred
                                ? "handler_completed"
                                : "none"
                        );
                        done(result);
                    },
                    register
                );
                if (typeof cancel === "function")
                    return function () {
                        if (!replied) {
                            record.state = "expired";
                            replied = true;
                        }
                        cancel();
                    };
                return cancel;
            } catch (error) {
                record.state = "rejected";
                throw error;
            }
        },
        request: request,
        snapshot: snapshot,
    };
    w.__ottRemoteInspect = api;
    return api;
}

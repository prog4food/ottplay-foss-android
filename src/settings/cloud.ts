import { metadataText } from "../utils/helpers";
import { commitSettingsWrites, SettingsWrite } from "./store";

/** One transfer owns its requests, timers and about screen. */
var cloudSettingsTransfer = (function () {
    var cloudSettingsIntent = 0;
    var cancelCloudSettings: (() => void) | null = null;
    function startCloudSettings(receive: boolean): void {
        var w = window as any;
        if (w.__ottRemoteInputActive) return;
        var intent = ++cloudSettingsIntent;
        if (cancelCloudSettings) cancelCloudSettings();
        if (intent !== cloudSettingsIntent) return;
        var closed = false,
            requestId = 0,
            request: any = null,
            deadline: any,
            pollTimer: any,
            owner: any = null;
        var port = w.__ottClassicScreenPort;
        var host = w.host_ott,
            protocol = w.host_ott_proto;
        var source = w.__ottSourceIdentity.current(w),
            committing = false;
        var driver = w.__ottActiveProviderDriver;
        var providerRead = w.providerGetItem,
            providerWrite = w.providerSetItem;
        function selection(): string {
            return JSON.stringify([
                w.__ottSourceIdentity.legacy(w),
                w.m3uArr && w.m3uArr.M3Us && w.m3uArr.M3Us[w.m3uArr.active],
            ]);
        }
        var selected = selection();
        var read = w.stbGetItem,
            write = w.stbSetItem,
            remove = w.stbDelItem,
            dump = w.stbGetAllItems;
        var offlineExpected: {
            bytes: string | null;
            selection: string;
            source: string;
        } | null = null;
        function sameSource(): boolean {
            var currentSource = w.__ottSourceIdentity.current(w);
            var currentSelection = selection();
            var ownOfflineSelection =
                committing &&
                offlineExpected !== null &&
                currentSource === offlineExpected.source &&
                currentSelection === offlineExpected.selection &&
                read.call(w, "offlineProfiles") === offlineExpected.bytes;
            return (
                (committing || source === currentSource) &&
                driver === w.__ottActiveProviderDriver &&
                (selected === currentSelection || ownOfflineSelection) &&
                providerRead === w.providerGetItem &&
                providerWrite === w.providerSetItem &&
                read === w.stbGetItem &&
                write === w.stbSetItem &&
                remove === w.stbDelItem &&
                dump === w.stbGetAllItems
            );
        }
        function cancel(): void {
            if (closed) return;
            closed = true;
            requestId++;
            clearTimeout(deadline);
            clearTimeout(pollTimer);
            var pending = request;
            request = null;
            if (cancelCloudSettings === cancel) cancelCloudSettings = null;
            try {
                if (pending && pending.abort) pending.abort();
            } catch (_error) {}
            if (owner && port.owner("about") === owner) port.close("about");
            else if (w.aboutKeyHandler === keyHandler) {
                w.aboutKeyHandler = null;
                if (typeof jQuery !== "undefined") jQuery("#listAbout").hide();
            }
        }
        function active(): boolean {
            if (closed) return false;
            if (
                intent !== cloudSettingsIntent ||
                cancelCloudSettings !== cancel ||
                w.aboutKeyHandler !== keyHandler ||
                !sameSource() ||
                host !== w.host_ott ||
                protocol !== w.host_ott_proto ||
                (owner
                    ? !owner.active() || port.owner("about") !== owner
                    : w.aboutKeyHandler !== keyHandler)
            ) {
                cancel();
                return false;
            }
            return true;
        }
        function keyHandler(code: number): boolean {
            if (code === w.keys.RETURN || code === w.keys.EXIT) cancel();
            return true;
        }
        function text(value: any): string {
            return metadataText(value);
        }
        function label(value: string): string {
            return text(w._ ? w._(value) || value : value);
        }
        function show(html: string): void {
            if (active() && typeof jQuery !== "undefined")
                jQuery("#listAbout")
                    .html(
                        '<div style="text-align:center;font-size:larger;"><br/><br/>' +
                            html +
                            "</div>"
                    )
                    .show();
        }
        function fail(message: string, detail?: any): void {
            show(
                label("ERROR!") +
                    "<br/>" +
                    label(message) +
                    (detail ? "<br/>" + text(detail) : "")
            );
        }
        function send(
            command: string,
            data: string | undefined,
            success: (value: any) => void
        ): void {
            if (!active() || typeof jQuery === "undefined") return;
            var id = ++requestId,
                finished = false;
            function complete(value: any, error: boolean): void {
                if (finished || id !== requestId || !active()) return;
                finished = true;
                request = null;
                if (error)
                    fail("Cloud transfer failed", value && value.responseText);
                else {
                    try {
                        success(value);
                    } catch (_error) {
                        fail("Invalid cloud settings response");
                    }
                }
            }
            try {
                var pending = jQuery.ajax({
                    cache: false,
                    data:
                        data === undefined
                            ? { c: command }
                            : { c: command, d: data },
                    error: function (error: any) {
                        complete(error, true);
                    },
                    success: function (value: any) {
                        complete(value, false);
                    },
                    timeout: 10000,
                    type: "POST",
                    url: protocol + host + "/swop/a.php",
                });
                if (!finished && active() && id === requestId)
                    request = pending;
                else if (!finished && pending && pending.abort) pending.abort();
            } catch (_error) {
                complete(null, true);
            }
        }
        function codeScreen(data: any): string {
            if (
                !data ||
                (typeof data.code !== "string" &&
                    typeof data.code !== "number") ||
                !String(data.code)
            )
                throw new Error("Missing transfer code");
            var code = String(data.code);
            show(
                label(receive ? "Request sended!" : "Settings sended!") +
                    "<br/><br/>" +
                    label(
                        receive
                            ? "For upload settings file open"
                            : "For download settings file open"
                    ) +
                    '<br/><span style="font-size:larger;color:' +
                    text(w.curColor) +
                    '">' +
                    text(host) +
                    "/swop</span> " +
                    label("and enter code") +
                    ' <span style="font-size:larger;color:' +
                    text(w.curColor) +
                    '">' +
                    text(code) +
                    "</span><br/><br/>" +
                    label("or scan") +
                    ':<br/><br/><div><img src="https://chart.googleapis.com/chart?cht=qr&amp;chs=300x300&amp;chld=|1&amp;chl=' +
                    text(
                        encodeURIComponent(protocol + host + "/swop/?" + code)
                    ) +
                    '" style="height:30%;"/></div>'
            );
            return code;
        }
        function restore(xml: string): void {
            if (w.__ottKiosk && w.__ottKiosk.enabled()) return;
            var imported = w.__ottCloudSettingsCodec.read(xml);
            validateOfflineProfiles(imported);
            if (!active()) return;
            if (
                typeof read !== "function" ||
                typeof write !== "function" ||
                typeof remove !== "function" ||
                typeof dump !== "function"
            )
                throw new Error("Storage unavailable");
            var before = dump.call(w);
            if (!before || typeof before !== "object" || Array.isArray(before))
                throw new Error("Invalid storage");
            if (
                driver &&
                driver.id === "offline" &&
                source === w.__ottSourceIdentity.legacy(w)
            ) {
                var localBytes = Object.prototype.hasOwnProperty.call(
                    imported,
                    "offlineProfiles"
                )
                    ? imported.offlineProfiles
                    : null;
                var localActive = localBytes
                    ? JSON.parse(localBytes).active
                    : -1;
                var localSource =
                    localActive < 0 ? "offline" : "offline:" + localActive;
                offlineExpected = {
                    bytes: localBytes,
                    selection: JSON.stringify([
                        localSource,
                        JSON.parse(selected)[1],
                    ]),
                    source: localSource,
                };
            }
            if (
                !Object.prototype.hasOwnProperty.call(imported, "parentPIN") &&
                Object.prototype.hasOwnProperty.call(before, "parentPIN")
            )
                imported.parentPIN = w.__ottPinSecurity.prepare(
                    before.parentPIN
                );
            var keys = Object.keys(before);
            Object.keys(imported).forEach(function (key) {
                if (keys.indexOf(key) === -1) keys.push(key);
            });
            var writes: SettingsWrite[] = keys
                // Local source bindings never travel with a settings backup.
                .filter(function (key) {
                    return (
                        key !== "offlineProfileBindings" &&
                        key !== "__ottStandbyV1"
                    );
                })
                .map(function (key) {
                    var previous = Object.prototype.hasOwnProperty.call(
                        before,
                        key
                    )
                        ? before[key]
                        : null;
                    if (previous !== null && typeof previous !== "string")
                        throw new Error("Invalid storage");
                    return {
                        after: Object.prototype.hasOwnProperty.call(
                            imported,
                            key
                        )
                            ? imported[key]
                            : null,
                        before: previous,
                        rollback:
                            key === "parentPIN" && previous !== null
                                ? w.__ottPinSecurity.protectRollback(previous)
                                : previous,
                        storage: {
                            key: key,
                            read: function () {
                                return read.call(w, key);
                            },
                            remove: function () {
                                remove.call(w, key);
                            },
                            transaction:
                                w.ottpStorage &&
                                read === w.ottpStorage.get &&
                                write === w.ottpStorage.set &&
                                remove === w.ottpStorage.del
                                    ? w.ottpStorage.transaction
                                    : undefined,
                            write: function (value: string) {
                                write.call(w, key, value);
                            },
                        },
                    };
                })
                .filter(function (entry) {
                    return entry.before !== entry.after;
                });
            if (!active()) return;
            // Credentials may themselves be stored in the bytes being replaced.
            // During this synchronous batch, selection/driver/ports still own it.
            committing = true;
            try {
                commitSettingsWrites(writes, active, function () {
                    return intent === cloudSettingsIntent && sameSource();
                });
                source = w.__ottSourceIdentity.current(w);
                selected = selection();
            } catch (_error) {
                if (sameSource()) {
                    source = w.__ottSourceIdentity.current(w);
                    selected = selection();
                }
                committing = false;
                fail("Settings could not be saved");
                return;
            }
            committing = false;
            if (!active()) return;
            // Authority is local: never adopt remote credentials or listener consent.
            if (w.__ottCommandServer)
                w.__ottCommandServer.configure({
                    address: "",
                    enabled: false,
                    token: "",
                });
            if (!active()) return;
            if (w.__ottClassicPlayback)
                w.__ottClassicPlayback.suspendPersistence();
            if (!active()) return;
            if (w.__ottClassicGuide) w.__ottClassicGuide.invalidate(false);
            if (!active()) return;
            show(label("Settings received. Restarting player..."));
            if (active() && w.restart) w.restart();
        }
        function poll(code: string): void {
            send("get", code, function (data) {
                if (data && data.status === "forbidden")
                    pollTimer = setTimeout(function () {
                        poll(code);
                    }, 5000);
                else if (data && data.status === "success") restore(data.data);
                else fail("Invalid cloud settings response");
            });
        }
        function validateOfflineProfiles(items: any): void {
            if (!Object.prototype.hasOwnProperty.call(items, "offlineProfiles"))
                return;
            var offline = w.__ottOfflineProfiles;
            if (
                !offline ||
                typeof offline.validateStore !== "function" ||
                typeof items.offlineProfiles !== "string" ||
                !offline.validateStore(JSON.parse(items.offlineProfiles))
            )
                throw new Error("Invalid local video profiles");
        }
        cancelCloudSettings = cancel;
        w.aboutKeyHandler = keyHandler;
        if (w.aboutKeyHandler !== keyHandler) {
            cancel();
            return;
        }
        if (port) {
            owner = port.owner("about");
            if (owner) {
                owner.model.localOnlyInput = true;
                owner.own(cancel);
            }
        }
        if (!active()) return;
        deadline = setTimeout(cancel, 600000);
        if (!host || !protocol) {
            fail("Cloud save/load requires STB firmware (host_ott not set)");
            return;
        }
        show(label(receive ? "Load settings" : "Send settings") + "...");
        if (receive)
            send("get_code", undefined, function (data) {
                var code = codeScreen(data);
                if (active())
                    pollTimer = setTimeout(function () {
                        poll(code);
                    }, 10000);
            });
        else {
            try {
                var snapshot = dump.call(w);
                validateOfflineProfiles(snapshot);
                send(
                    "send",
                    w.__ottCloudSettingsCodec.write(snapshot),
                    codeScreen
                );
            } catch (_error) {
                fail("Settings could not be exported");
            }
        }
    }

    /** Retained device ABI; native shells export a local portable JSON document. */
    function cloudSendSettings(): void {
        var w = window as any;
        if (w.__ottRemoteInputActive) return;
        if (
            (w.Capacitor || w.__TAURI__) &&
            typeof w.exportSettingsUI === "function"
        ) {
            var intent = ++cloudSettingsIntent;
            if (cancelCloudSettings) cancelCloudSettings();
            if (intent === cloudSettingsIntent) w.exportSettingsUI();
        } else startCloudSettings(false);
    }
    function cloudLoadSettings(): void {
        startCloudSettings(true);
    }

    return { load: cloudLoadSettings, send: cloudSendSettings };
})();
export function cloudSendSettings(): void {
    cloudSettingsTransfer.send();
}
export function cloudLoadSettings(): void {
    cloudSettingsTransfer.load();
}

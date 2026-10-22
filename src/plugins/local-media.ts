import {
    installBrowserLocalMedia,
    installOfflineShell,
} from "../offline/browser-local-media";
import {
    formatLocalMediaProgress,
    localMediaProgressTimeout,
} from "../offline/local-media-progress";
import { installOfflineProfiles } from "../offline/profiles";
import { resolveNativePlugin, tauriInvoke } from "./native-bridge";

/** Stable item IDs belong to storage; playback URLs are resolved anew each launch. */
export function installLocalMedia(w: any): any {
    if (w.__ottLocalMedia) return w.__ottLocalMedia;
    var browser = installBrowserLocalMedia(w);
    installOfflineShell(w);
    var native = resolveNativePlugin<any>("LocalMedia", function () {
        return browser;
    });
    var opened = false;
    var revision = 0;
    var handler: any = null;
    var owner: any = null;
    var loading: any = null;
    var progressState: any = null;
    var catalogRevision = 0;
    var activeNativeCancel: (() => void) | null = null;
    function cancelNativeList(): void {
        if (activeNativeCancel) activeNativeCancel();
    }
    var resuming = false;
    var last: any = null;
    var endpoint = "";
    var importedSelection = "";
    var nextImportSelection = "";
    function isNative(): boolean {
        return !!(
            w.Capacitor &&
            w.Capacitor.isNativePlatform &&
            w.Capacitor.isNativePlatform()
        );
    }
    function isTauri(): boolean {
        return !!(w.__TAURI__ || w.__TAURI_INTERNALS__);
    }
    function remoteEndpoint(): string {
        try {
            return String(
                w.stbGetItem ? w.stbGetItem("localMediaEndpoint") || "" : ""
            );
        } catch (_) {
            return "";
        }
    }
    function getEndpoint(
        refresh = false,
        preferredId?: string
    ): Promise<string> {
        if (isTauri())
            return tauriInvoke<any>("offline_media_endpoint", {
                ...(refresh ? { refresh: true } : {}),
                ...(preferredId ? { preferredId } : {}),
            }).then(function (value) {
                endpoint = value.endpoint;
                return endpoint;
            });
        endpoint = remoteEndpoint().replace(/\/+$/, "");
        return Promise.resolve(endpoint);
    }
    function http(url: string, options?: any): Promise<any> {
        return w.fetch(url, options).then(function (response: any) {
            if (!response.ok)
                throw new Error(
                    "Local media request failed (" + response.status + ")"
                );
            return response.json().then(function (value: any) {
                if (value && Array.isArray(value.items))
                    value.items.forEach(function (item: any) {
                        if (item.url) item.url = new URL(item.url, url).href;
                    });
                if (value && value.uploadUrl)
                    value.uploadUrl = new URL(value.uploadUrl, url).href;
                return value;
            });
        });
    }
    function boundedCatalogRequest(url: string, timeout: number): Promise<any> {
        return new Promise(function (resolve, reject) {
            var controller = w.AbortController ? new w.AbortController() : null;
            var settled = false;
            var timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                if (controller) controller.abort();
                reject(new Error("Local media scan stopped responding"));
            }, timeout);
            function finish(error: any, value?: any): void {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) reject(error);
                else resolve(value);
            }
            // Include response.json() in the deadline: headers alone do not
            // establish progress when a local server stops sending its body.
            try {
                http(
                    url,
                    controller ? { signal: controller.signal } : undefined
                ).then(
                    function (value) {
                        finish(null, value);
                    },
                    function (error) {
                        finish(error);
                    }
                );
            } catch (error) {
                finish(error);
            }
        });
    }
    function remember(pending: Promise<any>): Promise<any> {
        var request = ++catalogRevision;
        return pending.then(function (value: any) {
            if (!value || !Array.isArray(value.items))
                throw new Error("Invalid local media catalog");
            if (request === catalogRevision) last = value;
            return value;
        });
    }
    function nativeList(
        progress: (value: any) => boolean,
        preferredId: string | undefined,
        request: number
    ): Promise<any> {
        cancelNativeList();
        var requestId = "local-" + request + "-" + Date.now();
        return new Promise(function (resolve, reject) {
            var listener: any = null;
            var settled = false;
            var started = false;
            function cleanup(): void {
                if (activeNativeCancel === cancel) activeNativeCancel = null;
                if (listener) {
                    var handle = listener;
                    listener = null;
                    try {
                        Promise.resolve(handle.remove()).catch(function () {});
                    } catch (_) {}
                }
            }
            function finish(error: any, value?: any): void {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error);
                else resolve(value);
            }
            function cancel(): void {
                if (settled) return;
                if (started && typeof native.cancelList === "function") {
                    try {
                        Promise.resolve(
                            native.cancelList({ requestId: requestId })
                        ).catch(function () {});
                    } catch (_) {}
                }
                finish(null, { cancelled: true, items: [] });
            }
            activeNativeCancel = cancel;
            function start(): void {
                if (settled) return;
                if (request !== catalogRevision) {
                    cancel();
                    return;
                }
                started = true;
                try {
                    Promise.resolve(
                        native.list({
                            preferredId: preferredId,
                            requestId: requestId,
                        })
                    ).then(
                        function (value: any) {
                            finish(null, value);
                        },
                        function (error: any) {
                            finish(error);
                        }
                    );
                } catch (error) {
                    finish(error);
                }
            }
            if (typeof native.addListener !== "function") {
                start();
                return;
            }
            Promise.resolve(
                native.addListener("localMediaProgress", function (event: any) {
                    if (settled || !event || event.requestId !== requestId)
                        return;
                    if (request !== catalogRevision || !progress(event.catalog))
                        cancel();
                })
            ).then(function (handle: any) {
                listener = handle;
                if (settled) {
                    cleanup();
                    return;
                }
                start();
            }, start);
        });
    }
    function list(
        onProgress?: (value: any) => boolean | void,
        preferredId?: string,
        prioritySources?: string[]
    ): Promise<any> {
        if (w.__ottStandby?.blocked())
            return Promise.reject(w.__ottStandby.error());
        var request = ++catalogRevision;
        last = null;
        function accept(value: any): boolean {
            if (request !== catalogRevision) return false;
            if (!value || !Array.isArray(value.items))
                throw new Error("Invalid local media catalog");
            last = value;
            updateLoading(value);
            return !onProgress || onProgress(value) !== false;
        }
        var pending = isNative()
            ? boundedLocalRead(function (progress) {
                  return nativeList(progress, preferredId, request);
              })
            : boundedLocalRead(function () {
                  return getEndpoint(false, preferredId);
              }).then(function (base) {
                  if (request !== catalogRevision)
                      return { cancelled: true, items: [] };
                  return base
                      ? pollCatalog(base, request, accept, !!onProgress)
                      : boundedLocalRead(function (progress) {
                            return browser.list(
                                progress,
                                preferredId,
                                prioritySources
                            );
                        });
              });
        // Native bridges and browser filesystem reads cannot always be aborted.
        // Native and browser progress extend the idle deadline while actual
        // discovery advances. Late events remain bound to this catalog owner.
        // Retire ownership on expiry so late results cannot populate a completed
        // snapshot or revive a closed loading dialog.
        function boundedLocalRead(
            start: (progress: (value: any) => boolean) => Promise<any>
        ): Promise<any> {
            return new Promise(function (resolve, reject) {
                var timer: any = null;
                var settled = false;
                var signature = "";
                function clear(): void {
                    if (timer !== null) clearTimeout(timer);
                    timer = null;
                }
                function heartbeat(timeout = 60000): void {
                    clear();
                    timer = setTimeout(function () {
                        if (settled) return;
                        settled = true;
                        timer = null;
                        if (request === catalogRevision) {
                            catalogRevision++;
                            last = null;
                        }
                        cancelNativeList();
                        reject(new Error("Local source did not respond"));
                    }, timeout);
                }
                function finish(error: any, value?: any): void {
                    if (settled) return;
                    settled = true;
                    clear();
                    if (error) {
                        cancelNativeList();
                        reject(error);
                    } else resolve(value);
                }
                heartbeat();
                try {
                    start(function (value) {
                        if (settled || request !== catalogRevision)
                            return false;
                        var admitted = accept(value);
                        var next = JSON.stringify([
                            value.scanned,
                            value.total,
                            value.items.length,
                            value.sources && value.sources.length,
                            value.phase,
                            value.scanning,
                        ]);
                        if (next !== signature) {
                            signature = next;
                            heartbeat(localMediaProgressTimeout(value));
                        }
                        return admitted;
                    }).then(
                        function (value) {
                            finish(null, value);
                        },
                        function (error) {
                            finish(error);
                        }
                    );
                } catch (error) {
                    finish(error);
                }
            });
        }
        return pending.then(function (value: any) {
            if (!value || !Array.isArray(value.items))
                throw new Error("Invalid local media catalog");
            if (request !== catalogRevision)
                return { ...value, cancelled: true };
            last = value;
            return value;
        });
    }
    // Poll snapshots of a native background scan. Reading the catalog never
    // starts a replacement scan, and unchanged snapshots are not progress.
    function pollCatalog(
        base: string,
        request: number,
        accept: (value: any) => boolean,
        progressive: boolean
    ): Promise<any> {
        var signature = "";
        var changedAt = Date.now();
        function read(): Promise<any> {
            return boundedCatalogRequest(
                base,
                Math.max(1, 60000 - (Date.now() - changedAt))
            ).then(function (value) {
                if (!value || !Array.isArray(value.items))
                    throw new Error("Invalid local media catalog");
                if (request !== catalogRevision)
                    return { ...value, cancelled: true };
                var next = JSON.stringify([
                    value.scanning,
                    value.scanned,
                    value.total,
                    value.items.length,
                    value.scanError,
                ]);
                if (next !== signature) {
                    signature = next;
                    changedAt = Date.now();
                    if (!accept(value)) return { ...value, cancelled: true };
                }
                if (value.scanError) throw new Error(value.scanError);
                if (!value.scanning) return value;
                if (Date.now() - changedAt >= 60000)
                    throw new Error("Local media scan stopped responding");
                // A one-shot server catalog remains compatible. Only Tauri's
                // explicit background-scan protocol needs repeated requests.
                if (!isTauri() && !progressive) return value;
                return new Promise(function (resolve) {
                    setTimeout(resolve, 250);
                }).then(function () {
                    if (request !== catalogRevision)
                        return { ...value, cancelled: true };
                    return read();
                });
            });
        }
        return read();
    }
    function importFiles(folder = false): Promise<any> {
        if (locked() || settingsLocked())
            return Promise.reject(
                new Error(
                    "Unlock settings and kiosk mode to change local sources"
                )
            );
        function scanImported(result: any): Promise<any> {
            if (request !== catalogRevision)
                return Promise.resolve({
                    cancelled: true,
                    pickerCancelled: true,
                });
            if (result && result.pickerCancelled)
                return Promise.resolve({ pickerCancelled: true });
            var pending = list(
                function (value) {
                    updateLoading(value);
                    return !value.items.some(function (item: any) {
                        return item.available !== false && !!item.url;
                    });
                },
                undefined,
                result && result.sourceIds
            );
            var scanRequest = catalogRevision;
            return pending.then(function (value) {
                if (
                    scanRequest === catalogRevision &&
                    last === value &&
                    result &&
                    result.sourceIds
                ) {
                    var item = value.items.filter(function (item: any) {
                        return (
                            result.sourceIds.indexOf(item.sourceId) >= 0 &&
                            item.available !== false &&
                            !!item.url
                        );
                    })[0];
                    importedSelection = item ? "local-" + item.id : "";
                }
                return value;
            });
        }
        if (isNative())
            return remember(
                folder ? native.importFolder() : native.importFiles()
            );
        // A picker may outlive its screen. Its saved handle is still valid, but
        // its completion must not replace a newer catalog or start playback.
        var request = ++catalogRevision;
        importedSelection = "";
        nextImportSelection = "";
        if (isTauri())
            return tauriInvoke<any>(
                folder
                    ? "offline_media_import_folder"
                    : "offline_media_import_files",
                {}
            ).then(scanImported);
        if (remoteEndpoint())
            return Promise.reject(
                new Error(
                    "Connect folders on the server itself, or select this device's library."
                )
            );
        progressState = {
            items: [],
            phase: folder ? "picker-folder" : "picker-files",
        };
        return (
            folder
                ? browser.importFolder({ deferScan: true })
                : browser.importFiles(undefined, { deferScan: true })
        ).then(scanImported);
    }
    function removeSource(id: string): Promise<any> {
        if (locked() || settingsLocked())
            return Promise.reject(
                new Error("Unlock settings to disconnect sources")
            );
        if (isNative()) return remember(native.removeSource({ id: id }));
        if (isTauri())
            return tauriInvoke<any>("offline_media_remove_source", {
                id: id,
            }).then(function () {
                return list();
            });
        if (remoteEndpoint())
            return Promise.reject(
                new Error("Manage sources on the server itself.")
            );
        return remember(browser.removeSource(id));
    }
    function requestAccess(
        onProgress?: (value: any) => boolean | void
    ): Promise<any> {
        if (locked() || settingsLocked())
            return Promise.reject(new Error("Unlock settings to grant access"));
        if (isNative()) return remember(native.requestAccess());
        if (isTauri()) {
            var missing =
                last &&
                (last.sources || []).filter(function (source: any) {
                    return !source.available;
                })[0];
            return importFiles(!!missing && missing.kind === "folder");
        }
        if (remoteEndpoint()) return list(onProgress);
        var request = ++catalogRevision;
        return browser
            .requestAccess(
                onProgress
                    ? function (value: any) {
                          if (request !== catalogRevision) return false;
                          last = value;
                          return onProgress(value);
                      }
                    : undefined
            )
            .then(function (value: any) {
                if (request === catalogRevision) last = value;
                return value;
            });
    }
    function remove(id: string): Promise<any> {
        if (locked())
            return Promise.reject(
                new Error("Unlock kiosk mode to change local files")
            );
        if (settingsLocked())
            return Promise.reject(
                new Error("Unlock settings to change local files")
            );
        if (isNative()) return remember(native.remove({ id: id }));
        return remember(
            getEndpoint().then(function (base) {
                return base
                    ? http(base + "/" + encodeURIComponent(id), {
                          method: "DELETE",
                      })
                    : browser.remove(id);
            })
        );
    }
    function title(): string {
        return w._ ? w._("Local videos") : "Local videos";
    }
    function locked(): boolean {
        return !!(w.__ottKiosk && w.__ottKiosk.locked());
    }
    function settingsLocked(): boolean {
        return !!(w.__ottParental && w.__ottParental.needs("settings"));
    }
    function text(value: any): string {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
    function current(): boolean {
        return (
            opened &&
            (!handler || w.listKeyHandler === handler) &&
            (!owner ||
                owner.foreground() ||
                (loading && loading.foreground() && owner.active()))
        );
    }
    function failureMessage(value: any): string {
        var name = value && value.readErrorName;
        if (
            !/^(NotFoundError|NotAllowedError|SecurityError|NotReadableError|AbortError|InvalidStateError|QuotaExceededError|TimeoutError|TypeError|UnknownError|Error)$/.test(
                name
            )
        )
            return "";
        var stage = (
            {
                enumerating: "Reading folder entries",
                files: "Reading local files",
                metadata: "Reading file information",
                permission: "Checking folder permission",
                sources: "Reading saved sources",
            } as any
        )[value.readErrorPhase];
        if (typeof stage !== "string") stage = "Local source unavailable";
        return (w._ ? w._(stage) : stage) + ": " + name;
    }
    function updateLoading(value: any): void {
        progressState = value;
        if (!loading || !current()) return;
        var node =
            w.document && w.document.getElementById("local-media-progress");
        if (node) node.textContent = formatLocalMediaProgress(value, w._);
    }
    function finishLoading(active = loading): void {
        if (!active) return;
        if (loading === active) loading = null;
        active.close();
    }
    function close(): void {
        importedSelection = "";
        nextImportSelection = "";
        cancelNativeList();
        browser.suspend();
        finishLoading();
        opened = false;
        revision++;
        catalogRevision++;
        if (
            !locked() &&
            !settingsLocked() &&
            typeof w.optionsList === "function"
        )
            w.optionsList(w.popLocalMedia);
        else if (typeof w.closeList === "function") w.closeList();
    }
    function playable(): boolean {
        return !!(
            last &&
            last.items.some(function (item: any) {
                return item.available !== false && !!item.url;
            })
        );
    }
    function activate(): void {
        if (locked()) return;
        if (!playable()) {
            open();
            return;
        }
        var selected = importedSelection;
        finishLoading();
        opened = false;
        revision++;
        if (typeof w.closeList === "function") w.closeList();
        w.stbSetItem("ottplayprov", "offline");
        nextImportSelection = selected;
        importedSelection = "";
        w.loadProv("offline");
    }
    function editServer(): void {
        if (locked() || settingsLocked()) return;
        finishLoading();
        revision++;
        w.editCaption = w._("Media Library URL");
        w.editvar = remoteEndpoint();
        w.setEdit = function () {
            if (!current() || locked() || settingsLocked()) return;
            var value = String(w.editvar || "")
                .trim()
                .replace(/\/+$/, "");
            if (value) {
                try {
                    var parsed = new URL(value);
                    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname)
                        throw new Error("Invalid server URL");
                } catch (_) {
                    render("Use a complete HTTP or HTTPS URL.");
                    return;
                }
            }
            w.stbSetItem("localMediaEndpoint", value);
            run(list);
        };
        w.showEditKey(null);
    }
    function restorePlayback(): void {
        run(function () {
            return requestAccess(function () {
                if (!resuming || !current()) return false;
                if (!playable()) return true;
                activate();
                return false;
            }).then(function (value) {
                if (resuming && current() && playable()) activate();
                return value;
            });
        });
    }
    function render(message?: string): void {
        if (!current()) return;
        if (locked() || settingsLocked()) {
            close();
            return;
        }
        var selected = w.selIndex || 0;
        var rows: any[] = [];
        function row(
            id: string,
            name: string,
            description: string,
            action: () => void
        ): void {
            rows.push({
                action: action,
                description: description,
                id: id,
                name: name,
            });
        }
        if (resuming)
            row(
                "resume",
                "Continue playback",
                last &&
                    (last.sources || []).some(function (source: any) {
                        return source.access === "permission-required";
                    })
                    ? "Chrome needs permission to read your saved folder again. Choose Allow on every visit in its prompt to resume automatically on later visits. No video files are copied."
                    : "Reconnect the original folder or drive, then continue playback. The saved source and video selection are preserved.",
                restorePlayback
            );
        row(
            "add-folder",
            "Add folder",
            !isNative() && !isTauri()
                ? "Chrome may ask to view and copy files. This grants read access; OTT plays the originals without storing another media copy."
                : "Play files directly from the selected folder without copying them.",
            function () {
                run(function () {
                    return importFiles(true);
                }, !isNative());
            }
        );
        row(
            "add-files",
            "Add files",
            "Play selected files directly without copying them.",
            function () {
                run(function () {
                    return importFiles();
                }, !isNative());
            }
        );
        if (
            last &&
            (last.sources || []).some(function (source: any) {
                return !source.available;
            })
        )
            row(
                "grant-access",
                "Grant access",
                "Allow access to previously connected sources.",
                function () {
                    if (resuming) restorePlayback();
                    else run(requestAccess);
                }
            );
        var profiles = w.__ottOfflineProfiles;
        if (profiles && profiles.current())
            row(
                "bind-profile",
                "Bind loaded profile to connected sources",
                "Explicitly match this profile's source names and saved video to folders connected on this device. Ambiguous or missing sources are rejected.",
                function () {
                    run(function () {
                        return profiles.bindCurrent();
                    });
                }
            );
        row("refresh", "Refresh", "Read connected folders again.", function () {
            run(function () {
                return isTauri()
                    ? getEndpoint(true).then(function () {
                          return list();
                      })
                    : list();
            });
        });
        row(
            "play",
            "Play local videos",
            playable()
                ? "Open the local video channel list."
                : "No playable local videos. Add a folder or grant access to a connected source.",
            function () {
                if (playable()) activate();
            }
        );
        ((last && last.sources) || []).forEach(function (source: any) {
            row(
                "disconnect-source",
                "Disconnect: " + source.name,
                (source.available
                    ? "Connected. "
                    : source.access === "permission-required"
                      ? "Read permission is needed again; the source is still saved. "
                      : "Source unavailable. ") +
                    "Disconnecting leaves the original files untouched.",
                function () {
                    run(function () {
                        return removeSource(source.id);
                    });
                }
            );
        });
        ((last && last.items) || []).forEach(function (item: any) {
            if (item.source === "linked") return;
            row(
                "remove-copy",
                "Remove copy: " + item.name,
                "Remove this previously imported copy from the library.",
                function () {
                    run(function () {
                        return remove(item.id);
                    });
                }
            );
        });
        if (!isNative() && !isTauri())
            row(
                "server-library",
                "Server library…",
                remoteEndpoint()
                    ? "A server library is selected. Clear its URL to use files on this device."
                    : "Optional: connect a library stored on your server. Network access is required.",
                editServer
            );
        row("close", "Close", "Return to player settings.", close);
        w.listArray = rows;
        w.listDataArray = rows;
        w.selIndex = Math.min(selected, rows.length - 1);
        w.getListItem = function (item: any) {
            return (
                '&nbsp;&nbsp;<span data-local-media-action="' +
                item.id +
                '">' +
                text(w._ ? w._(item.name) : item.name) +
                "</span>"
            );
        };
        w.detailListAction = function () {
            var item = rows[w.selIndex];
            w.listDetail.innerHTML = text(
                message || (item && item.description) || ""
            );
            w.listFooter.innerHTML =
                w.renderButtonHint(w.keys.RETURN, w.strRETURN, "Close") +
                w.renderButtonHint(w.keys.ENTER, w.strENTER, "Ok");
        };
        handler = function (key: number) {
            if (!current()) return false;
            if (key === w.keys.RETURN || key === w.keys.EXIT) {
                close();
                return true;
            }
            if (key !== w.keys.ENTER) return false;
            if (locked() || settingsLocked()) {
                close();
                return true;
            }
            var item = rows[w.selIndex];
            if (item) item.action();
            return true;
        };
        w.listKeyHandler = handler;
        w.listCaption.innerHTML = text(title());
        w.$("#listPopUp").hide();
        w.showPage();
        owner = w.__ottClassicScreenPort
            ? w.__ottClassicScreenPort.listOwner()
            : null;
        if (owner && owner.model) owner.model.localOnlyInput = true;
    }
    function run(action: () => Promise<any>, startPlayback = false): void {
        var request = ++revision;
        finishLoading();
        progressState = null;
        // Start the picker inside the user gesture, before rendering or awaiting.
        var pending: Promise<any>;
        try {
            pending = action();
        } catch (error: any) {
            render(error.message || String(error));
            return;
        }
        // Use the same owned loading dialog as provider/media loading. Its
        // parent list automatically disposes it when another screen replaces us.
        var active: any = null;
        if (current() && w.__ottClassicScreenPort) {
            active = w.__ottClassicScreenPort.setOwnedCallback(
                "dialog",
                function (key: number) {
                    if (key === w.keys.RETURN || key === w.keys.EXIT) close();
                }
            ).owner;
            loading = active;
            active.model = active.model || {};
            active.model.cancelOnPower = close;
            w.$("#dialogbox")
                .html(
                    '<center><div class="ott-spinner" aria-hidden="true"><span class="blob"></span><span class="blob"></span><span class="blob"></span><span class="blob"></span></div></center><br/>' +
                        text(w._("Loading. Please wait...")) +
                        '<div id="local-media-progress">' +
                        text(
                            formatLocalMediaProgress(
                                progressState || { items: [] },
                                w._
                            )
                        ) +
                        "</div><br/><br/>" +
                        w.renderButtonHint(w.keys.RETURN, w.strRETURN, "Cancel")
                )
                .show();
        }
        pending.then(
            function (value) {
                finishLoading(active);
                if (request === revision) {
                    if (
                        startPlayback &&
                        !(value && value.pickerCancelled) &&
                        current() &&
                        playable()
                    )
                        activate();
                    else render();
                }
            },
            function (error) {
                finishLoading(active);
                if (request === revision)
                    render(error.message || String(error));
            }
        );
    }
    function open(recovery = false, skipScan = false, message = ""): void {
        if (locked()) return;
        if (settingsLocked()) {
            if (typeof w.enterPinAndSetAccess === "function")
                w.enterPinAndSetAccess(open);
            return;
        }
        finishLoading();
        resuming = recovery;
        opened = true;
        handler = null;
        owner = null;
        w.selIndex = 0;
        if (skipScan) catalogRevision++;
        render(message || failureMessage(last));
        if (!skipScan) run(list);
    }
    var api = {
        activate: activate,
        available: function () {
            return isNative() || isTauri() || !!w.indexedDB;
        },
        cancelNativeList: cancelNativeList,
        cancelScan: function () {
            catalogRevision++;
            cancelNativeList();
            browser.suspend();
        },
        completedSources: function () {
            if (!last || last.cancelled || last.scanning) return null;
            return (last.sources || []).map(function (source: any) {
                return { id: source.id, kind: source.kind, name: source.name };
            });
        },
        didRestoreLibrary: function () {
            catalogRevision++;
            last = null;
        },
        failureMessage: failureMessage,
        importFiles: importFiles,
        isPlaybackUrl: function (url: string) {
            return !!(
                last &&
                last.items.some(function (item: any) {
                    return item.url === url;
                })
            );
        },
        libraryIdentity: function () {
            return isNative()
                ? "capacitor"
                : isTauri()
                  ? "tauri"
                  : "browser:" + remoteEndpoint();
        },
        libraryWrite: function (identity: string) {
            if (isNative() || isTauri() || identity.indexOf("browser:") !== 0)
                throw new Error(
                    "This local library belongs to another platform"
                );
            var value = identity.slice(8);
            if (value) {
                var parsed = new URL(value);
                if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname)
                    throw new Error("Invalid saved server library URL");
            }
            return { key: "localMediaEndpoint", value: value };
        },
        list: list,
        open: open,
        preferredState: function (id: string) {
            return last && last.preferred && last.preferred.id === id
                ? last.preferred.state
                : undefined;
        },
        progressText: function (value: any) {
            return formatLocalMediaProgress(value, w._);
        },
        progressTimeout: localMediaProgressTimeout,
        remove: remove,
        resume: function (skipScan = false, message = "") {
            // Backend exception text may contain private file paths. Keep only
            // our fixed timeout message or the sanitized filesystem error code.
            open(
                true,
                skipScan,
                message === "Local source did not respond"
                    ? message
                    : failureMessage(last)
            );
        },
        snapshot: function () {
            // Profile operations must never replace the provider's active scan.
            // Only a completed catalog describes every connected source.
            if (!last || last.cancelled || last.scanning)
                return Promise.reject(
                    new Error(
                        "Wait for the local media scan to finish before saving or binding a profile"
                    )
                );
            return Promise.resolve(JSON.parse(JSON.stringify(last)));
        },
        suspend: function () {
            cancelNativeList();
            catalogRevision++;
            revision++;
            close();
        },
        takeImportSelection: function () {
            var selected = nextImportSelection;
            nextImportSelection = "";
            return selected;
        },
        title: title,
    };
    w.__ottLocalMedia = api;
    installOfflineProfiles(w, api);
    w.popLocalMedia = open;
    return api;
}

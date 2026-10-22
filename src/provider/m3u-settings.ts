/** Explicit classic presentation/storage codec for the owned M3U instance. */
function mountM3uProviderSettings(
    host: any,
    driver: any,
    owner: DriverLifetime,
    _store: DriverStorage
): void {
    var editorRevision = 0;
    var mediaRevision = 0;
    var client: any = null;
    var mediaKey = "";
    var configurationKey = "";
    function active(): boolean {
        return owner.active();
    }
    function text(value: any): string {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
    function masked(value: any): string {
        return String(value || "").replace(
            /(portal::(?:\[|%5b)key:)[\s\S]*?(\]|%5d)/i,
            "$1***$2"
        );
    }
    function projectConfiguration(config: M3uConfiguration): void {
        var key = JSON.stringify(config);
        if (key !== configurationKey) {
            configurationKey = key;
            host.m3uArr = config;
        }
    }
    function mediaIdentity(config: M3uConfiguration): string {
        var slot = config.M3Us[config.active];
        return JSON.stringify([
            config.active,
            slot.medUrl || "",
            slot.medSourceId || "",
        ]);
    }
    function resetMediaView(): void {
        host.mediaUrls = null;
        host.mediaNames = [];
        host.mediaSelects = [0];
        host.mediaRecords = [];
        host.mediaRecordsPar = null;
        host.getMediaArray = null;
        if (typeof host._playMedia === "function")
            host.playMedia = host._playMedia;
    }
    function syncMedia(config: M3uConfiguration): void {
        if (!active()) return;
        var key = mediaIdentity(config);
        if (key === mediaKey && (!client || host.getMediaArray === client.load))
            return;
        var slot = config.M3Us[config.active];
        var source = slot.medUrl || "";
        var revision = ++mediaRevision;
        var previous = client;
        client = null;
        mediaKey = "";
        if (previous) previous.dispose();
        if (!active() || revision !== mediaRevision) return;
        if (host.providerMediaClient === previous)
            host.providerMediaClient = null;
        if (typeof host.cancelMediaLoad === "function") host.cancelMediaLoad();
        if (!active() || revision !== mediaRevision) return;
        resetMediaView();
        mediaKey = key;
        function current(): boolean {
            return (
                active() &&
                revision === mediaRevision &&
                mediaIdentity(driver.configuration()) === key &&
                !!client &&
                host.getMediaArray === client.load
            );
        }
        // Legacy portal links are inert; VPortal has its own provider profile.
        if (!source || /^portal:/i.test(source.trim())) return;
        if (host.browserName() === "dune") {
            var loadRevision = 0;
            var busyView: any = null;
            function cancel() {
                loadRevision++;
                var previous = busyView;
                busyView = null;
                driver.cancelMedia();
                if (previous) previous.close();
            }
            client = {
                cancel: cancel,
                dispose: cancel,
                load: function (target: any, callback: any) {
                    if (!current()) return;
                    var token = ++loadRevision;
                    var previousBusy = busyView;
                    busyView = null;
                    driver.cancelMedia();
                    if (previousBusy) previousBusy.close();
                    var url = String(target || source);
                    function admitted() {
                        return (
                            current() &&
                            token === loadRevision &&
                            (!callback.isCurrent || callback.isCurrent())
                        );
                    }
                    if (!admitted()) return;
                    if (host.mediaUrls && host.mediaUrls.length)
                        host.mediaUrls[host.mediaUrls.length - 1] = url;
                    if (!url) {
                        if (admitted()) callback();
                        return;
                    }
                    var previousHandler = host.dialogBoxKeyHandler;
                    var handler = function (key: number) {
                        if (!admitted() || host.dialogBoxKeyHandler !== handler)
                            return false;
                        if (key !== host.keys.RETURN && key !== host.keys.STOP)
                            return false;
                        cancel();
                        return true;
                    };
                    var busy = {
                        close: function () {
                            if (host.dialogBoxKeyHandler === handler) {
                                host.dialogBoxKeyHandler = previousHandler;
                                host.$("#dialogbox").hide();
                            }
                        },
                    };
                    busyView = busy;
                    host.dialogBoxKeyHandler = handler;
                    host.$("#dialogbox")
                        .html(host._("Download! Wait ..."))
                        .show();
                    driver.loadMedia(
                        url,
                        host.mediaName || slot.name || "?",
                        function (result: any) {
                            if (!admitted()) return;
                            if (result.records)
                                host.mediaRecords = result.records;
                            if (result.name) host.mediaName = result.name;
                            if (result.error)
                                host.alert(
                                    host._("Unable to load playlist") +
                                        (result.error === "network" &&
                                        result.status
                                            ? " (" + result.status + ")"
                                            : "")
                                );
                            if (busyView === busy) busyView = null;
                            busy.close();
                            if (admitted()) callback();
                        }
                    );
                },
            };
            host.providerMediaClient = client;
            host.getMediaArray = client.load;
        }
    }
    function projectPatch(event: any): void {
        function currentPatch() {
            return active() && (!event.isCurrent || event.isCurrent());
        }
        if (!currentPatch()) return;
        projectConfiguration(event.configuration);
        if (event.type === "configuration") {
            syncMedia(event.configuration);
            return;
        }
        var fields = event.type === "guide" ? ["epg_src", "epg_url"] : ["logo"];
        var channels = host.channels || {};
        event.catalog.ids.forEach(function (id: any) {
            if (!currentPatch()) return;
            var row = channels[id],
                source = event.catalog.channels[id];
            if (row && source)
                fields.forEach(function (field) {
                    if (source[field] !== undefined) row[field] = source[field];
                });
        });
        var selected = (host.curList || [])[host.primaryIndex];
        if (event.type === "guide") {
            var now = Date.now() / 1000;
            event.catalog.ids.forEach(function (id: any) {
                if (!currentPatch()) return;
                var row = channels[id];
                if (
                    row &&
                    row.time_request > now &&
                    driver.currentGuideUrl(id)
                ) {
                    if (host.__ottClassicGuide)
                        host.__ottClassicGuide.invalidateChannel(Number(id));
                    if (
                        id !== selected &&
                        typeof host.observeCurrentProgramme === "function" &&
                        typeof host.updateChannelListRow === "function"
                    )
                        host.observeCurrentProgramme(
                            id,
                            host.updateChannelListRow
                        );
                }
            });
        }
        if (currentPatch() && selected !== undefined && channels[selected]) {
            if (event.type === "guide" && driver.currentGuideUrl(selected))
                if (host.__ottClassicGuide)
                    host.__ottClassicGuide.invalidateChannel(Number(selected));
            if (typeof host.updateChannelInfo === "function")
                host.updateChannelInfo(selected);
        }
    }
    owner.own(driver.subscribe(projectPatch));
    owner.own(function () {
        editorRevision++;
        mediaRevision++;
        var previous = client;
        client = null;
        if (previous) previous.dispose();
        if (host.providerMediaClient === previous)
            host.providerMediaClient = null;
    });
    function menuTitle(): string {
        var config = driver.configuration(),
            slot = config.M3Us[config.active];
        return (
            host._("Select playlist") +
            ": " +
            (config.active + 1) +
            " - " +
            text(slot.name || masked(slot.www))
        );
    }
    function label(): void {
        if (!active()) return;
        var index = host.popupActions.indexOf(
            driver.fixedSlot() >= 0 ? showDetails : showSlots
        );
        if (index !== -1) host.popupArray[index] = menuTitle();
    }
    function loadPlaylist(): void {
        if (!active()) return;
        editorRevision++;
        var config = driver.configuration();
        projectConfiguration(config);
        label();
        syncMedia(config);
        if (active()) host.loadChannels();
    }
    function selectSlot(index: number): void {
        if (
            !active() ||
            index < 0 ||
            index >= 15 ||
            Math.floor(index) !== index
        )
            return;
        var config = driver.configuration();
        config.active = index;
        if (driver.saveConfiguration(config) && active()) loadPlaylist();
    }
    function footer(): string {
        return host.renderButtonHint(host.keys.RETURN, host.strRETURN, "Close");
    }
    function openList(title: string): void {
        host.listDetail.innerHTML = "";
        host.listCaption.innerHTML = host._(title);
        host.listFooter.innerHTML = footer();
        host.$("#listPopUp").hide();
        host.showPage();
    }
    function showSlots(index?: number): void {
        if (!active()) return;
        var revision = ++editorRevision,
            config = driver.configuration();
        host.selIndex = index === undefined ? config.active : index;
        host.listArray = config.M3Us;
        host.listDataArray = host.listArray;
        function current() {
            return active() && revision === editorRevision;
        }
        host.getListItem = function (slot: any, item: number) {
            return (
                "&nbsp;&nbsp;" +
                (host.sNoNumbersKeys || item >= 6
                    ? item + 1 + ":&nbsp;"
                    : '<div class="btn">' + (item + 1) + "</div>&nbsp;") +
                text(slot.name || masked(slot.www) || "—")
            );
        };
        host.detailListAction = function () {
            if (!current()) return;
            var slot = config.M3Us[host.selIndex];
            if (!slot) return;
            host.listDetail.innerHTML =
                host._("Playlist Name") +
                ": " +
                text(slot.name) +
                "<br/>" +
                host._("Playlist URL") +
                ":<br/>" +
                text(masked(slot.www)) +
                "<br/>" +
                host._("Archive hours") +
                ": " +
                text(slot.rechours || 0);
            host.listFooter.innerHTML =
                footer() +
                host.renderButtonHint(
                    host.keys.ENTER,
                    host.strENTER,
                    config.active === host.selIndex || !slot.www
                        ? "Edit"
                        : "Load"
                );
        };
        host.listKeyHandler = function (key: number) {
            if (!current()) return false;
            if (key === host.keys.RETURN) {
                editorRevision++;
                label();
                host.popupList(
                    host.popupActions.indexOf(
                        host.toggleProviderSettingsVisibility
                    ) + 1
                );
                return true;
            }
            if (key >= 49 && key <= 54) host.selIndex = key - 49;
            else if (key !== host.keys.ENTER) return false;
            var selected = host.selIndex;
            if (!config.M3Us[selected]) return true;
            if (config.active === selected || !config.M3Us[selected].www)
                showDetails(selected);
            else selectSlot(selected);
            return true;
        };
        openList("Select playlist");
    }
    function showDetails(index?: number): void {
        if (!active()) return;
        var config = driver.configuration();
        var slotIndex =
            typeof index === "number" && index >= 0 && index < 15
                ? index
                : config.active;
        var revision = ++editorRevision,
            fieldRevision = 0;
        var fields = ["name", "www"].concat(
            typeof host.readFile === "function" ? ["file"] : [],
            ["rechours", "", "load"]
        );
        function current() {
            return active() && revision === editorRevision;
        }
        function render() {
            if (!current()) return;
            var slot = driver.configuration().M3Us[slotIndex];
            host.listArray = fields.map(function (field) {
                if (field === "name")
                    return host._("Playlist Name") + ": " + text(slot.name);
                if (field === "www")
                    return (
                        host._("Playlist URL") + ": " + text(masked(slot.www))
                    );
                if (field === "file")
                    return (
                        host._("Playlist file") +
                        ": " +
                        text(
                            slot.www.charAt(0) === "/"
                                ? slot.www.split("/").pop()
                                : ""
                        ) +
                        (host.strNew || "")
                    );
                if (field === "rechours")
                    return (
                        host._("Archive hours") +
                        ": " +
                        text(slot.rechours || 0)
                    );
                return field === "load" ? host._("Load playlist") : "";
            });
            host.listDataArray = host.listArray;
        }
        function edit(field: string) {
            var fieldToken = ++fieldRevision;
            var key = field === "file" ? "www" : field;
            var keys = key === "rechours" ? [0] : null;
            var captions: any = {
                name: "Enter playlist Name",
                rechours: "Enter playlist archive hours",
                www: "Enter playlist URL",
            };
            host.editCaption = host._(captions[key]);
            host.editvar = String(
                (driver.configuration().M3Us[slotIndex] as any)[key] || ""
            );
            function reopen() {
                var release = function () {};
                var timer = host.setTimeout(function () {
                    release();
                    if (current() && fieldToken === fieldRevision)
                        host.showEditKey(keys);
                }, 0);
                release = owner.own(function () {
                    host.clearTimeout(timer);
                });
            }
            host.setEdit = function () {
                if (!current() || fieldToken !== fieldRevision) return;
                var config = driver.configuration(),
                    slot: any = config.M3Us[slotIndex];
                var value = String(host.editvar);
                if (String(slot[key] || "") === value.trim()) return;
                if (key === "www" && /^portal:/i.test(value.trim())) {
                    host.alert(host._("Enter playlist URL"));
                    reopen();
                    return;
                }
                if (!current()) return;
                if (key === "www" && slotIndex === config.active) {
                    if (host.__ottClassicPlayback)
                        host.__ottClassicPlayback.suspendPersistence();
                    driver.clearSlot(slotIndex);
                }
                if (!current()) return;
                slot[key] =
                    key === "rechours" ? parseInt(value, 10) || 0 : value;
                if (!driver.saveConfiguration(config) || !current()) return;
                fieldRevision++;
                render();
                label();
                host.showPage();
            };
            if (field === "file") {
                if (typeof host.showFileDialog === "function")
                    host.showFileDialog(host.editvar, "m3u,m3u8");
                else
                    host.alert(
                        host._("File selection is not supported on this device")
                    );
            } else host.showEditKey(keys);
        }
        host.selIndex = 0;
        render();
        host.getListItem = function (value: string) {
            return "&nbsp;&nbsp;" + value;
        };
        host.detailListAction = function () {
            if (!current()) return;
            var field = fields[host.selIndex];
            var details: any = {
                file: "Select playlist file",
                load: "Load playlist",
                name: "Enter playlist Name",
                rechours: "Enter playlist archive hours",
                www: "Enter playlist URL",
            };
            host.listDetail.innerHTML =
                (details[field] ? host._(details[field]) : "") +
                (["www", "file", "rechours"].indexOf(field) !== -1
                    ? host._(" (after changing, load playlist)")
                    : "");
        };
        host.listKeyHandler = function (key: number) {
            if (!current()) return false;
            if (key === host.keys.RETURN) {
                editorRevision++;
                if (driver.fixedSlot() >= 0) {
                    label();
                    host.popupList(
                        host.popupActions.indexOf(
                            host.toggleProviderSettingsVisibility
                        ) + 1
                    );
                } else showSlots(slotIndex);
                return true;
            }
            if (key !== host.keys.ENTER) return false;
            var field = fields[host.selIndex];
            if (field === "load") {
                if (driver.fixedSlot() >= 0) loadPlaylist();
                else selectSlot(slotIndex);
            } else if (field) edit(field);
            return true;
        };
        openList("Edit playlist data");
    }
    host.getProviderParams = function () {
        if (!active()) return "";
        var config = driver.configuration();
        projectConfiguration(config);
        config.M3Us.forEach(function (slot, index) {
            host.$("#www" + index).val(slot.www);
            host.$("#rechours" + index).val(slot.rechours);
        });
        host.$("input:radio[name=odin]")
            .filter("[value=" + config.active + "]")
            .prop("checked", true);
        return config.M3Us[config.active].www;
    };
    host.setProviderParams = function () {
        if (!active()) return false;
        var config = driver.configuration(),
            before = JSON.stringify(config);
        config.M3Us.forEach(function (slot, index) {
            var value = String(host.$("#www" + index).val() || "").trim();
            try {
                value = decodeURIComponent(value);
            } catch (_) {}
            slot.www = value;
            slot.rechours = String(
                host.$("#rechours" + index).val() || ""
            ).trim();
        });
        config.active = Number(host.$("input[name=odin]:checked").val());
        if (!driver.saveConfiguration(config) || !active()) return false;
        var next = driver.configuration();
        if (next.M3Us[next.active].www.length < 8)
            host.alert(host._("Enter playlist URL"));
        return before !== JSON.stringify(next);
    };
    showSlots.menuTitle = showDetails.menuTitle = menuTitle;
    showSlots.menuDetail = showDetails.menuDetail = function () {
        return host._("Select playlist");
    };
    host.duneAddSettings = function (index: number) {
        if (!active()) return;
        var action = driver.fixedSlot() >= 0 ? showDetails : showSlots;
        host.popupArray.splice(index, 1, "");
        host.popupDetail.splice(index, 1, host._("Select playlist"));
        host.popupActions.splice(index, 1, action);
        projectConfiguration(driver.configuration());
        label();
        syncMedia(driver.configuration());
    };
    host.loadPlaylist = loadPlaylist;
    host.selectAndRestart = selectSlot;
    host.doEditM3Ua = showSlots;
    host.doEditListData = showDetails;
    host.m3uUpdateMedia = function () {
        if (active()) syncMedia(driver.configuration());
    };
    driver.openSettings = showDetails;
    projectConfiguration(driver.configuration());
    syncMedia(driver.configuration());
}

function reportM3uProviderLoad(host: any, driver: any, error: string): boolean {
    if (error === "m3u-empty") {
        host.$(host.launch_id).hide();
        if (typeof host.clearBootHide === "function") host.clearBootHide();
        driver.openSettings(driver.configuration().active);
        return false;
    }
    if (error)
        host.alert(
            host._(
                error === "m3u-portal"
                    ? "Enter playlist URL"
                    : "Failed to load channel list!"
            )
        );
    return true;
}

(window as any).__ottM3uSettings = {
    mount: mountM3uProviderSettings,
    reportLoad: reportM3uProviderLoad,
};

interface ScreenMenuRecord {
    action: () => void;
    color?: string;
    detail: string;
    hint?: string;
    id: string;
    legacyId: string;
    number?: string;
    sourceIndex: number;
    title: string;
}
/** Stable command identities are independent of translated labels and function names. */
var screenMenuDefinitions: Array<
    [string, string, string, string?, string?, string?, string?]
> = [
    [
        "video.aspect",
        "toggleAspectRatio",
        "Toggle Aspect Ratio",
        "",
        "",
        "",
        "strAspect",
    ],
    ["video.zoom", "toggleZoom", "Toggle Zoom Mode", "", "", "", "strZoom"],
    [
        "audio.track",
        "toggleAudioTrack",
        "Switch sound track",
        "",
        "1",
        "",
        "strAudio",
    ],
    [
        "subtitle.track",
        "toggleSubtitle",
        "Switch subtitle",
        "",
        "",
        "",
        "strSubt",
    ],
    [
        "channel.previous",
        "popPrevProg",
        "Return to previous channel",
        "",
        "3",
        "",
        "strPRECH",
    ],
    ["playback.toggle", "popPause", "Pause/Play", "", "", "", "strPlayPause"],
    [
        "playback.live",
        "popStop",
        "Restart stream / Live",
        "",
        "7",
        "",
        "strSTOP",
    ],
    ["archive.seek", "popShift", "Rewind", "Show rewind window", "4"],
    [
        "pip.toggle",
        "popTogglePip",
        "Call PiP / PiP exchange",
        "",
        "5",
        "",
        "strPip",
    ],
    ["pip.close", "popStopPip", "Close PiP", "", "6"],
    ["channels.categories", "popBuckets", "Category selection", "", "", "blue"],
    ["guide.open", "popEpg", "Show EPG and archive for channel", "", "", "red"],
    [
        "archive.records",
        "popRecords",
        "Show list of channel archive records",
        "Show list of channel archive records without duplication",
        "",
        "green",
    ],
    ["media.open", "popMedia", "Show Media Library", "", "", "yellow"],
    ["provider.unlock", "toggleProviderSettingsVisibility", ""],
    ["provider.settings", "noop", ""],
    ["settings.open", "optionsList", "Settings", "", "9", "", "strTools"],
    ["app.restart", "restart", "Restart player", "", "8"],
    ["app.exit", "exitPortal", "Exit player", "", "0"],
    ["information.open", "infoList", "Information", "", "2", "", "strInfo"],
    ["favorites.open", "popFavLists", "Favorite lists"],
];
function createScreenMenuRegistry() {
    var bindings: Array<[string, string]> = [
        ["ZOOM", "video.zoom"],
        ["ASPECT", "video.aspect"],
        ["N0", "app.exit"],
        ["N1", "audio.track"],
        ["AUDIO", "audio.track"],
        ["N2", "information.open"],
        ["N3", "channel.previous"],
        ["N4", "archive.seek"],
        ["N5", "pip.toggle"],
        ["N6", "pip.close"],
        ["N7", "playback.live"],
        ["N8", "app.restart"],
        ["N9", "settings.open"],
        ["TOOLS", "settings.open"],
        ["SUBTITLE", "subtitle.track"],
        ["EPG", "guide.open"],
        ["RED", "guide.open"],
        ["GREEN", "archive.records"],
        ["YELLOW", "media.open"],
        ["BLUE", "channels.categories"],
        ["PREV", "channels.categories"],
    ];
    function defaults(host: any) {
        return {
            actions: screenMenuDefinitions.map(function (record) {
                return host[record[1]];
            }),
            details: screenMenuDefinitions.map(function (record) {
                return record[3] || null;
            }),
            labels: screenMenuDefinitions.map(function (record) {
                return record[2];
            }),
        };
    }
    var legacyNames: any = {
        "provider.settings": "nofun",
        "provider.unlock": "noProvParam",
    };
    function importClassic(host: any): ScreenMenuRecord[] {
        // Existing provider codecs are an explicit input codec, never menu policy.
        var records: ScreenMenuRecord[] = [];
        (host.popupActions || []).forEach(function (
            action: any,
            index: number
        ) {
            if (typeof action !== "function") return;
            var definition: any = null;
            screenMenuDefinitions.some(function (candidate) {
                if (host[candidate[1]] !== action) return false;
                definition = candidate;
                return true;
            });
            // Provider captions may include mutable account/playlist metadata.
            // Resolve their translated pieces when opening the menu, just like
            // the static command keys, without translating user-supplied names.
            var title = String(
                typeof action.menuTitle === "function"
                    ? action.menuTitle()
                    : (host.popupArray || [])[index] || ""
            );
            var detail = String(
                typeof action.menuDetail === "function"
                    ? action.menuDetail()
                    : (host.popupDetail || [])[index] || title
            );

            var legacyId = host.popupActionId
                ? host.popupActionId(action)
                : definition
                  ? legacyNames[definition[0]] || definition[1]
                  : action.name || "";
            records.push({
                action: action,
                color: definition && definition[5],
                detail: detail,
                hint: definition && host[definition[6]],
                id: definition
                    ? definition[0]
                    : "provider:" + String(host.p_pref || "") + ":" + index,
                legacyId: legacyId,
                number: definition && definition[4],
                sourceIndex: index,
                title: title,
            });
        });
        var nas = host.__ottNasLibrary;
        if (nas && nas.available() && typeof host.popNasMedia === "function")
            records.push({
                action: host.popNasMedia,
                detail: nas.title(),
                id: "media.nas",
                legacyId: "popNasMedia",
                sourceIndex: -1,
                title: nas.title(),
            });
        if (host.__ottLocalMedia && host.__ottLocalMedia.available())
            records.push({
                action: host.popLocalMedia,
                detail: host.__ottLocalMedia.title(),
                id: "media.local",
                legacyId: "popLocalMedia",
                sourceIndex: -1,
                title: host.__ottLocalMedia.title(),
            });
        return records;
    }
    function available(record: ScreenMenuRecord, host: any): boolean {
        var channelId = (host.curList || [])[host.primaryIndex];
        var channel = (host.channels || {})[channelId];
        switch (record.id) {
            case "archive.records":
            case "archive.seek":
            case "playback.toggle":
                return (
                    host.playType < 0 || !channelId || !channel || !!channel.rec
                );
            case "audio.track":
                return !!(
                    channelId &&
                    host.stbAudioTracksExists &&
                    host.stbAudioTracksExists()
                );
            case "subtitle.track":
                return !!(
                    channelId &&
                    host.stbSubtitleExists &&
                    host.stbSubtitleExists()
                );
            case "media.open":
                return typeof host.getMediaArray === "function";
            case "pip.close":
                return host.pipIndex != null;
            default:
                return true;
        }
    }
    function open(host: any, selected: any) {
        // Resolve labels when opening, after the active language has loaded.
        // Keep the imported titles intact so later language changes can reuse them.
        function translate(text: string): string {
            return typeof host._ === "function" ? host._(text) : text;
        }
        var records = importClassic(host);
        var hidden = host.sHideMenus || [];
        var focus = 0;
        var rows = records
            .filter(function (record) {
                return (
                    hidden.indexOf(record.id) < 0 &&
                    hidden.indexOf(record.legacyId) < 0 &&
                    available(record, host)
                );
            })
            .map(function (record, index) {
                if (
                    selected === record.id ||
                    selected === record.action ||
                    selected == record.sourceIndex
                )
                    focus = index;
                var name = record.title;
                var toggled =
                    record.id === "pip.toggle"
                        ? host.pipIndex != null
                        : record.id === "playback.live"
                          ? !!host.playType
                          : record.id === "playback.toggle"
                            ? !!(host.stbIsPlaying && host.stbIsPlaying())
                            : undefined;
                if (toggled !== undefined && name.indexOf("/") >= 0)
                    name = name.split("/")[toggled ? 1 : 0].trim();
                name = translate(name);
                if (!host.sNoNumbersKeys && record.number)
                    name =
                        '<div class="btn">' + record.number + "</div> " + name;
                if (!host.sNoColorKeys && record.color)
                    name =
                        '<div class="btn ' +
                        record.color +
                        '">&nbsp;</div> ' +
                        name;
                if (record.hint)
                    name = '<div class="btn">' + record.hint + "</div> " + name;
                return {
                    action: record.action,
                    desc: translate(record.detail),
                    id: record.id,
                    name: name,
                };
            });
        return {
            command: function (code: number) {
                var keys = host.keys;

                for (var i = 0; i < bindings.length; i++)
                    if (keys[bindings[i][0]] && code === keys[bindings[i][0]])
                        return bindings[i][1];
                return "";
            },
            focus: focus,
            invoke: function (id: string) {
                for (var i = 0; i < records.length; i++)
                    if (records[i].id === id) {
                        records[i].action();
                        return;
                    }
            },
            records: records,
            rows: rows,
        };
    }
    return { defaults: defaults, importClassic: importClassic, open: open };
}
(window as any).__ottMenuRegistry = createScreenMenuRegistry();

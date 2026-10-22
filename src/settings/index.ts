import {
    readLegacySettingsFields,
    writeLegacySettingsFields,
} from "../compatibility/legacy-names";
import { languageNames } from "../localization/assets";
/**
 * Player preferences and their persistent compatibility keys.
 *
 * Loaded from persistent storage on startup (see `loadSettings`) and
 * persisted on change (see `saveSettings`). The `PlayerSettings` interface
 * defines every tunable parameter exposed to the user via the settings UI.
 */
import { storage } from "../storage/index";
import {
    createSettingsStore,
    type SettingDefinition,
    type SettingsDraft,
} from "./store";

// The polyfill preserves this getter so "system" also restores native DST rules.
const systemTimezoneOffset =
    (Date as any).nativeGetTimezoneOffset || Date.prototype.getTimezoneOffset;

/** Apply the legacy timezone menu index; zero restores the system timezone. */
export function applyTimezoneSetting(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index > 25) index = 0;
    var hours = index <= 13 ? index - 1 : 13 - index;
    var offset =
        index === 0 ? systemTimezoneOffset.call(new Date()) : -60 * hours;
    if (typeof (Date as any).setTimezoneOffset === "function") {
        (Date as any).setTimezoneOffset(offset);
    }
    return index;
}

/**
 * All player configuration parameters.
 *
 * Each property corresponds to a stored key (prefixed with `s` or stored
 * verbatim) that is read from / written to the `storage` adapter.
 *
 * @property noSmall           - Disable small screen optimisation (0/1).
 * @property stopPlay          - Stop playback on certain events (0/1).
 * @property pipSize           - Picture-in-picture size mode.
 * @property pipPosition       - Picture-in-picture screen position.
 * @property pageSize          - Number of items per page in channel list.
 * @property fontShift         - Font size adjustment shift.
 * @property fontSize          - Base font size index.
 * @property arrowFun          - Remote arrow key function mapping.
 * @property rewFun            - Rewind button function mapping.
 * @property pnFun             - P+/P- button function mapping.
 * @property rFun              - Red (R) colour key function mapping.
 * @property gFun              - Green (G) colour key function mapping.
 * @property yFun              - Yellow (Y) colour key function mapping.
 * @property bFun              - Blue (B) colour key function mapping.
 * @property alFun             - Left arrow function mapping.
 * @property arFun             - Right arrow function mapping.
 * @property auFun             - Up arrow function mapping.
 * @property adFun             - Down arrow function mapping.
 * @property rwFun             - Rewind key function mapping.
 * @property ffFun             - Fast-forward key function mapping.
 * @property prevFun           - Previous channel / track function mapping.
 * @property nextFun           - Next channel / track function mapping.
 * @property eFun              - Exit / back function mapping.
 * @property okFun             - OK / select function mapping.
 * @property seek13Duration    - Short skip duration (seconds).
 * @property seek46Duration    - Medium skip duration (seconds).
 * @property seek79Duration    - Long skip duration (seconds).
 * @property noColorKeys       - Disable colour-key shortcuts (0/1).
 * @property noNumbersKeys     - Disable numeric key shortcuts (0/1).
 * @property timezone          - UTC offset override (applied via polyfill).
 * @property sleepTimeout      - Inactivity sleep timer menu index (off, 30m, 1h, 2h, 3h).
 * @property epgRemindMinutes  - Minutes before an EPG timer to show a reminder OSD (0 = off).
 * @property volumeStep        - Volume increment per key press (%).
 * @property infoTimeout       - Info OSD auto-hide timeout (seconds).
 * @property infoSlide         - Info OSD slide animation enabled (0/1).
 * @property infoSwitch        - Info OSD channel-switch enabled (0/1).
 * @property infoChange        - Info OSD on programme change (0/1).
 * @property infoRew           - Info OSD during rewind/ff (0/1).
 * @property thumbnail         - Show channel thumbnail/preview (0/1).
 * @property osdOpacity        - OSD background opacity level.
 * @property listPosition      - List location: right (0) or left (1).
 * @property editor            - Enable channel editor (0/1).
 * @property showNumber        - Show channel number in list (0/1).
 * @property channelLogoMode   - Channel logo layout: hidden, square, or portrait (0/1/2).
 * @property showName          - Show channel name (0/1).
 * @property showProgress      - Show progress bar (0/1).
 * @property showArchive       - Show archive indicator (0/1).
 * @property showScroll        - Show scrollbar (0/1).
 * @property showDescription   - Show programme description (0/1).
 * @property showProgram       - Show programme title (0/1).
 * @property preview           - Preview window mode (0/1/2).
 * @property nextCount         - Number of next programmes to show.
 * @property nextCountList     - Number of next programmes in list view.
 * @property favorites         - Enable favourites filtering (0/1).
 * @property permanentTime     - Always show time in OSD (0/1).
 * @property resumeWithTenSecondRewind - Rewind ten seconds when resuming (0/1).
 * @property prevCount         - Number of previous programmes shown.
 * @property medCount          - Media item count threshold.
 * @property psChannels        - Provider-switch channel mapping (0/1).
 * @property psOptions         - Provider-switch options (0/1).
 * @property requirePinForProviderSelection - Require a PIN to select a provider (0/1).
 * @property hdmiSupport       - Enable HDMI-CEC support (0/1).
 * @property autorun           - Auto-start on boot (0/1).
 * @property players           - Player type selection.
 * @property bufSize           - Buffer size in KB.
 * @property useGraphicalIndicators - Use graphical icons for yes/no/off (0/1).
 * @property parentPin         - Parental control PIN code.
 * @property hideMenus         - List of menu IDs to hide.
 * @property interfaceTheme    - Interface preset: Classic (0), PLi-HD (1), Studio 2026 (2).
 * @property highlightColorSel - Classic selection colour (HSV H,S; V=50).
 * @property highlightColor    - Classic accent colour (HSV H,S; V=100).
 * @property highlightColorB   - Classic background colour (HSV H,V; S=100).
 */
export interface PlayerSettings {
    adFun: number;
    alFun: number;
    arFun: number;
    arrowFun: number;
    auFun: number;
    autorun: number;
    bFun: number;
    bufSize: number;
    channelLogoMode: number;
    commandServerAddress: string;
    commandServerEnabled: number;
    commandServerToken: string;
    deviceUuid: string;
    editor: number;
    eFun: number;
    epgRemindMinutes: number;
    favorites: number;
    ffFun: number;
    fontShift: number;
    fontSize: number;
    gFun: number;
    hdmiSupport: number;
    hideMenus: string[];
    highlightColor: string;
    highlightColorB: string;
    highlightColorSel: string;
    infoChange: number;
    infoRew: number;
    infoSlide: number;
    infoSwitch: number;
    infoTimeout: number;
    interfaceTheme: number;
    listPosition: number;
    localCmdUrl: string;
    localHttpDeviceCode: string;
    localHttpEnabled: number;
    medCount: number;
    nextCount: number;
    nextCountList: number;
    nextFun: number;
    noColorKeys: number;
    noNumbersKeys: number;
    noSmall: number;
    okFun: number;
    osdOpacity: number;
    pageSize: number;
    parentPin: string;
    permanentTime: number;
    pipPosition: number;
    pipSize: number;
    players: number;
    pnFun: number;
    preferredAudioLanguage: string;
    preferredSubtitleLanguage: string;
    prevCount: number;
    prevFun: number;
    preview: number;
    psChannels: number;
    psOptions: number;
    requirePinForProviderSelection: number;
    resumeWithTenSecondRewind: number;
    rewFun: number;
    rFun: number;
    rwFun: number;
    seek13Duration: number;
    seek46Duration: number;
    seek79Duration: number;
    showArchive: number;
    showDescription: number;
    showName: number;
    showNumber: number;
    showProgram: number;
    showProgress: number;
    showScroll: number;
    sleepTimeout: number;
    stopPlay: number;
    streamMaxBitrate: number;
    streamMaxHeight: number;
    swopBaseUrl: string;
    thumbnail: number;
    timezone: number;
    useGraphicalIndicators: number;
    volumeStep: number;
    yFun: number;
}

/**
 * Return the factory-default `PlayerSettings` object for the selected device.
 *
 * @returns A `PlayerSettings` instance with all default values.
 *
 * @remarks
 * Device shortcuts are selected before stored user overrides are loaded.
 */
export function defaultSettings(): PlayerSettings {
    const device =
        typeof window !== "undefined" ? (window as any).ott_device : "";
    const webos = device === "lg/webos";
    return {
        adFun: 16,
        alFun: webos || device === "lg/netcast" ? 1 : 14,
        arFun: webos || device === "lg/netcast" ? 4 : 13,
        arrowFun: 0,
        auFun: 15,
        autorun: 0,
        bFun: 9,
        bufSize: 0,
        channelLogoMode: 1,
        commandServerAddress: "",
        commandServerEnabled: 0,
        commandServerToken: "",
        deviceUuid: "",
        editor: 0,
        eFun: webos ? 1 : 0,
        epgRemindMinutes: 5,
        favorites: 0,
        ffFun: 19,
        fontShift: 4,
        fontSize: 4,
        gFun: 0,
        hdmiSupport: 0,
        hideMenus: [],
        highlightColor: "50,85",
        highlightColorB: "255,0",
        highlightColorSel: "240,25",
        infoChange: 1,
        infoRew: 1,
        infoSlide: 1,
        infoSwitch: 1,
        infoTimeout: 5,
        interfaceTheme: 2,
        listPosition: 0,
        localCmdUrl: "",
        localHttpDeviceCode: "",
        localHttpEnabled: 0,
        medCount: 2,
        nextCount: 0,
        nextCountList: 1,
        nextFun: 21,
        noColorKeys: 0,
        noNumbersKeys: 0,
        noSmall: 0,
        okFun: 0,
        osdOpacity: 7,
        pageSize: 25,
        parentPin: "1234",
        permanentTime: 0,
        pipPosition: 0,
        pipSize: 0,
        players: 0,
        pnFun: 0,
        preferredAudioLanguage: "",
        preferredSubtitleLanguage: "",
        prevCount: 2,
        prevFun: 20,
        preview: 0,
        psChannels: 1,
        psOptions: 0,
        requirePinForProviderSelection: 0,
        resumeWithTenSecondRewind: 1,
        rewFun: 0,
        rFun: 10,
        rwFun: 18,
        seek13Duration: 15,
        seek46Duration: 180,
        seek79Duration: 600,
        showArchive: 1,
        showDescription: 1,
        showName: 1,
        showNumber: 1,
        showProgram: 1,
        showProgress: 1,
        showScroll: 1,
        sleepTimeout: 0,
        stopPlay: 0,
        streamMaxBitrate: 0,
        streamMaxHeight: 0,
        swopBaseUrl: "",
        thumbnail: 1,
        timezone: 0,
        useGraphicalIndicators: 0,
        volumeStep: 5,
        yFun: 1,
    };
}

/** Restore only supported seek durations from old backups. */
export function normalizeSeekDuration(value: number, fallback: number): number {
    return [
        5, 10, 15, 20, 30, 60, 120, 180, 240, 300, 600, 900, 1200, 1800, 3600,
    ].indexOf(value) >= 0
        ? value
        : fallback;
}
const settingDefaults = defaultSettings();
function defineSetting(
    id: string,
    key: string,
    rules: any = { range: [0, 1] },
    effects: string[] = [],
    scope: "application" | "provider" = "application"
): SettingDefinition {
    var fallback = (settingDefaults as any)[id];
    return {
        decode: rules.list
            ? function (raw) {
                  return raw.split(",").filter(function (x) {
                      return x !== "";
                  });
              }
            : rules.nextCount
              ? function (raw) {
                    return Number(raw) + 1;
                }
              : undefined,
        defaultValue: fallback,
        ...(rules.pin
            ? {
                  invalidValue: "!locked-invalid-pin",
                  prepare: function (value: string) {
                      return (window as any).__ottPinSecurity.prepare(value);
                  },
                  protectOnLoad: true,
                  protectRollback: function (value: string | null) {
                      return (window as any).__ottPinSecurity.protectRollback(
                          value
                      );
                  },
              }
            : {}),
        effects: effects,
        encode: rules.list
            ? function (value) {
                  return value.join(",");
              }
            : rules.nextCount
              ? function (value) {
                    return String(value - 1);
                }
              : rules.encode,
        id: id,
        key: key,
        scope: scope,
        validate: function (value): boolean {
            if (rules.language)
                return (
                    typeof value === "string" &&
                    (value === "" ||
                        (rules.language === "subtitle" && value === "off") ||
                        Object.prototype.hasOwnProperty.call(
                            languageNames,
                            value
                        ))
                );
            if (rules.list)
                return (
                    Array.isArray(value) &&
                    value.every(function (item) {
                        return typeof item === "string";
                    })
                );
            if (rules.pin)
                return (
                    typeof value === "string" &&
                    (window as any).__ottPinSecurity.valid(value)
                );
            if (rules.color) {
                if (
                    typeof value !== "string" ||
                    !/^\d{1,3},\d{1,3}$/.test(value)
                )
                    return false;
                var pair = value.split(",").map(Number);
                return pair[0] <= 360 && pair[1] <= 100;
            }
            if (typeof fallback === "string") return typeof value === "string";
            if (
                typeof value !== "number" ||
                !isFinite(value) ||
                Math.floor(value) !== value
            )
                return false;
            if (rules.values) return rules.values.indexOf(value) >= 0;
            if (rules.durations)
                return normalizeSeekDuration(value, NaN) === value;
            return rules.range
                ? value >= rules.range[0] && value <= rules.range[1]
                : value >= 0;
        },
    };
}
export const settingsSchema: SettingDefinition[] = [
    defineSetting("streamMaxHeight", "sStreamMaxHeight", {
        values: [0, 360, 480, 720, 1080, 2160],
    }),
    defineSetting("streamMaxBitrate", "sStreamMaxBitrate", {
        values: [0, 1000000, 2000000, 4000000, 8000000, 16000000],
    }),
    defineSetting("preferredAudioLanguage", "sPreferredAudioLanguage", {
        language: "audio",
    }),
    defineSetting("preferredSubtitleLanguage", "sPreferredSubtitleLanguage", {
        language: "subtitle",
    }),
    defineSetting(
        "noSmall",
        "sNoSmall",
        {
            range: [0, 1],
        },
        ["setListPos"]
    ),
    defineSetting("stopPlay", "sStopPlay"),
    defineSetting(
        "pipSize",
        "sPipSize",
        {
            range: [0, 2],
        },
        ["setPipPosBuf"]
    ),
    defineSetting(
        "pipPosition",
        "sPipPos",
        {
            range: [0, 3],
        },
        ["setPipPosBuf"]
    ),
    defineSetting("pageSize", "sPageSize", { range: [10, 30] }, [
        "setFontSize",
        "setListPos",
    ]),
    defineSetting("fontShift", "sFontShift", { range: [0, 30] }, [
        "setFontSize",
        "setListPos",
    ]),
    defineSetting(
        "fontSize",
        "sFont",
        {
            range: [0, 6],
        },
        ["setFontSize", "setListPos"]
    ),
    defineSetting("arrowFun", "sArrowFun", {
        range: [0, 3],
    }),
    defineSetting("rewFun", "sRewFun", { range: [0, 3] }),
    defineSetting("pnFun", "sPNFun", { range: [0, 3] }),
    defineSetting("rFun", "sRfun", { range: [0, 64] }),
    defineSetting("gFun", "sGfun", { range: [0, 64] }),
    defineSetting("yFun", "sYfun", { range: [0, 64] }),
    defineSetting("bFun", "sBfun", { range: [0, 64] }),
    defineSetting("alFun", "sALfun", { range: [0, 64] }),
    defineSetting("arFun", "sARfun", {
        // A signed integer keeps an explicit LG volume choice distinguishable
        // from the old default in the same atomic, legacy-readable value.
        encode: function (value) {
            return value === 13 && defaultSettings().arFun === 4
                ? "+13"
                : String(value);
        },
        range: [0, 64],
    }),
    defineSetting("auFun", "sAUfun", { range: [0, 64] }),
    defineSetting("adFun", "sADfun", { range: [0, 64] }),
    defineSetting("rwFun", "sRWfun", { range: [0, 64] }),
    defineSetting("ffFun", "sFFfun", { range: [0, 64] }),
    defineSetting("prevFun", "sPREVfun", { range: [0, 64] }),
    defineSetting("nextFun", "sNEXTfun", { range: [0, 64] }),
    defineSetting("eFun", "sEfun", { range: [0, 4] }),
    defineSetting("okFun", "sOkfun"),
    defineSetting("seek13Duration", "s13dur", {
        durations: true,
    }),
    defineSetting("seek46Duration", "s46dur", {
        durations: true,
    }),
    defineSetting("seek79Duration", "s79dur", {
        durations: true,
    }),
    defineSetting("noColorKeys", "sNoColorKeys"),
    defineSetting("noNumbersKeys", "sNoNumbersKeys"),
    defineSetting(
        "timezone",
        "sTimezone",
        {
            range: [0, 25],
        },
        ["setTimezone"]
    ),
    defineSetting("sleepTimeout", "sSleepTimeout", { range: [0, 4] }, [
        "setSleepTimeout",
    ]),
    defineSetting("epgRemindMinutes", "sEpgRemindMinutes", {
        range: [0, 120],
    }),
    defineSetting("volumeStep", "sVolumeStep", {
        range: [3, 10],
    }),
    defineSetting("infoTimeout", "sInfoTimeout", {
        range: [3, 20],
    }),
    defineSetting("infoSlide", "sInfoSlide"),
    defineSetting("infoSwitch", "sInfoSwitch"),
    defineSetting("infoChange", "sInfoChange"),
    defineSetting("infoRew", "sInfoRew"),
    defineSetting("thumbnail", "sThumbnail"),
    defineSetting(
        "osdOpacity",
        "sOsdOpacity",
        {
            range: [0, 10],
        },
        ["setColor"]
    ),
    defineSetting(
        "interfaceTheme",
        "sInterfaceTheme",
        {
            range: [0, 2],
        },
        ["setFontSize", "setColor"]
    ),
    defineSetting(
        "listPosition",
        "sListPos",
        {
            range: [0, 1],
        },
        ["setListPos"]
    ),
    defineSetting(
        "editor",
        "sEditor",
        {
            range: [0, 1],
        },
        ["setEditor"]
    ),
    defineSetting("showNumber", "sShowNum", { range: [0, 1] }, [], "provider"),
    defineSetting(
        "channelLogoMode",
        "sShowPikon",
        {
            range: [0, 2],
        },
        [],
        "provider"
    ),
    defineSetting("showName", "sShowName", { range: [0, 1] }, [], "provider"),
    defineSetting(
        "showProgress",
        "sShowProgress",
        {
            range: [0, 1],
        },
        [],
        "provider"
    ),
    defineSetting(
        "showArchive",
        "sShowArchive",
        {
            range: [0, 1],
        },
        [],
        "provider"
    ),
    defineSetting("showScroll", "sShowScroll"),
    defineSetting(
        "showDescription",
        "sShowDescr",
        {
            range: [0, 1],
        },
        [],
        "provider"
    ),
    defineSetting(
        "showProgram",
        "sShowProgram",
        {
            range: [0, 1],
        },
        [],
        "provider"
    ),
    defineSetting("preview", "sPreview", { range: [0, 2] }, [], "provider"),
    defineSetting(
        "nextCountList",
        "sNextCount",
        {
            nextCount: true,
            range: [0, 20],
        },
        [],
        "provider"
    ),
    defineSetting("favorites", "sFavorites", {
        range: [-1, 1],
    }),
    defineSetting("permanentTime", "sPermanentTime", { range: [0, 2] }, [
        "setFontSize",
    ]),
    defineSetting("resumeWithTenSecondRewind", "s10resum"),
    defineSetting("prevCount", "sPrevCount", {
        range: [0, 4],
    }),
    defineSetting("medCount", "sMedCount", {
        range: [0, 5],
    }),
    defineSetting("psChannels", "sPSchannels"),
    defineSetting("psOptions", "sPSoptions"),
    defineSetting("requirePinForProviderSelection", "sPSprovs"),
    defineSetting("hdmiSupport", "sHDMIsupport"),
    defineSetting(
        "autorun",
        "sAutorun",
        {
            range: [0, 1],
        },
        ["setAutorun"]
    ),
    defineSetting(
        "players",
        "sPlayers",
        {
            range: [0, 3],
        },
        ["setPlayerMode", "setPlayer"],
        "provider"
    ),
    defineSetting(
        "bufSize",
        "sBufSize",
        {
            range: [0, 3600],
        },
        ["stbSetBuffer"]
    ),
    defineSetting(
        "useGraphicalIndicators",
        "sGrapI",
        {
            range: [0, 1],
        },
        ["setColor"]
    ),
    defineSetting("parentPin", "parentPIN", { pin: true }),
    defineSetting("hideMenus", "sHideMenus", { list: true }),
    defineSetting(
        "highlightColorSel",
        "sSHLcolSel",
        {
            color: true,
        },
        ["setColor"]
    ),
    defineSetting(
        "highlightColor",
        "sSHLcolor",
        {
            color: true,
        },
        ["setColor"]
    ),
    defineSetting(
        "highlightColorB",
        "sSHLcolorB",
        {
            color: true,
        },
        ["setColor"]
    ),
    defineSetting("commandServerAddress", "commandServerAddress", {}),
    defineSetting("commandServerToken", "commandServerToken", {}),
    defineSetting("localCmdUrl", "sLocalCmdUrl", {}),
    defineSetting("localHttpDeviceCode", "sLocalHttpDeviceCode", {}),
    defineSetting("swopBaseUrl", "sSwopBaseUrl", {}),
    defineSetting("deviceUuid", "sDeviceUuid", {}),
    defineSetting("localHttpEnabled", "sLocalHttpEnabled"),
    defineSetting("commandServerEnabled", "commandServerEnabled"),
];
function settingsSource(): string {
    var w = typeof window === "undefined" ? {} : (window as any);
    var driver = w.__ottActiveProviderDriver;
    return driver && typeof driver.storageKey === "function"
        ? driver.id + ":" + driver.storageKey("sPlayers")
        : String(w.p_pref || w.providerId || "classic");
}
export const settingsStore = createSettingsStore(settingsSchema, {
    context: settingsSource,
    effect: function (name) {
        var w = window as any;
        if (typeof w[name] === "function") {
            if (name === "setPlayerMode") w[name](settings.players);
            else w[name]();
        }
    },
    storage: function (entry) {
        var w = window as any;
        var driver = w.__ottActiveProviderDriver;
        var key = entry.key;
        if (
            entry.scope === "provider" &&
            driver &&
            typeof driver.storageKey === "function"
        ) {
            key = driver.storageKey(key);
        } else if (
            entry.scope === "provider" &&
            typeof w.providerGetItem === "function"
        ) {
            var read = w.providerGetItem,
                write = w.providerSetItem,
                remove = w.providerDelItem;
            return {
                read: function () {
                    return read(entry.key);
                },
                remove: function () {
                    if (remove) remove(entry.key);
                    else write(entry.key, "");
                },
                write: function (v) {
                    write(entry.key, v);
                },
            };
        }
        if (entry.protectOnLoad) {
            var readProtected = storage.get,
                writeProtected = storage.set,
                removeProtected = storage.del;
            return {
                current: function () {
                    return (
                        storage.get === readProtected &&
                        storage.set === writeProtected &&
                        storage.del === removeProtected
                    );
                },
                read: function () {
                    return readProtected.call(storage, key);
                },
                remove: function () {
                    removeProtected.call(storage, key);
                },
                write: function (v) {
                    writeProtected.call(storage, key, v);
                },
            };
        }
        return {
            key: key,
            read: function () {
                return storage.get(key);
            },
            remove: function () {
                storage.del(key);
            },
            transaction: storage.transaction,
            write: function (v) {
                storage.set(key, v);
            },
        };
    },
});
/** Typed and legacy views both forward to the same authoritative store. */
export const settings = {} as PlayerSettings;
function bindSettingsFacade(
    target: Record<string, any>,
    legacy: boolean
): void {
    settingsSchema.forEach(function (entry) {
        var key = legacy
            ? entry.id === "nextCountList"
                ? "sNextCountL"
                : entry.key
            : entry.id;
        Object.defineProperty(target, key, {
            configurable: legacy,
            enumerable: true,
            get: function () {
                return settingsStore.get(entry.id);
            },
            set: function (value) {
                settingsStore.observe(entry.id, value);
            },
        });
    });
    Object.defineProperty(target, legacy ? "sNextCount" : "nextCount", {
        configurable: legacy,
        enumerable: true,
        get: function () {
            return Math.max(0, settings.nextCountList - 1);
        },
        set: function (value) {
            settings.nextCountList = Number(value) + 1;
        },
    });
}
bindSettingsFacade(settings, false);
export function installSettingsFacade(target: Record<string, any>): void {
    bindSettingsFacade(target, true);
    target.settings = settings;
}
export function loadSettings(): PlayerSettings {
    // Device detection can finish after the settings schema was constructed.
    var defaults = defaultSettings();
    settingsSchema.forEach(function (entry) {
        entry.defaultValue = (defaults as any)[entry.id];
    });
    settingsStore.reload();
    // Older LG profiles inherited PC's Right = volume-up default. Explicit
    // choices now carry their provenance in the same stored integer.
    if (
        defaults.arFun === 4 &&
        settings.arFun === 13 &&
        storage.get("sARfun") !== "+13"
    ) {
        settings.arFun = 4;
        try {
            storage.setI("sARfun", 4);
        } catch (_error) {}
    }
    var w = window as any;
    var nativeEditor =
        !!w.__TAURI__ ||
        !!w.Capacitor ||
        /^(pc|pc2|tauri|desktop|nodejs)$/.test(String(w.ott_device || ""));
    if (nativeEditor && !storage.get("sEditorPcNativeMigrated")) {
        settings.editor = 1;
        try {
            storage.setI("sEditor", 1);
            storage.set("sEditorPcNativeMigrated", "1");
        } catch (_error) {}
    }
    installSettingsFacade(w);
    return settings;
}
/** Refresh only this provider's settings; application preferences stay intact. */
export function loadProviderSettings(playerDefault: number): void {
    settingsStore.reload("provider");
    var w = window as any;
    if (
        typeof w.providerGetItem === "function" &&
        w.providerGetItem("sPlayers") === null
    )
        settings.players = playerDefault;
}
export function saveSettings(input: Partial<PlayerSettings>): boolean {
    var draft = settingsStore.begin(true);
    var valid = true;
    settingsSchema.forEach(function (entry) {
        if (
            Object.prototype.hasOwnProperty.call(input, entry.id) &&
            !draft.set(entry.id, (input as any)[entry.id])
        )
            valid = false;
    });
    if (!valid) {
        draft.cancel();
        return false;
    }
    return draft.commit();
}
export function beginSettingsDraft(): SettingsDraft {
    return settingsStore.begin();
}
if (typeof window !== "undefined") installSettingsFacade(window as any);

/** Capture the account and storage ports across confirmation and every write. */
function settingsBackupContext(): any {
    var w = window as any;
    var source = w.__ottSourceIdentity.current(w);
    var get = w.providerGetItem,
        set = w.providerSetItem,
        del = w.providerDelItem,
        driver = w.__ottActiveProviderDriver,
        prefix = w.p_pref;
    function current(expectedSource?: string): boolean {
        var actualSource = w.__ottSourceIdentity.current(w);
        return (
            (expectedSource === undefined ? source : expectedSource) ===
                actualSource &&
            driver === w.__ottActiveProviderDriver &&
            prefix === w.p_pref &&
            get === w.providerGetItem &&
            set === w.providerSetItem &&
            del === w.providerDelItem
        );
    }
    function port(key: string): any {
        var driver = w.__ottActiveProviderDriver;
        var durable =
            !get ||
            (driver &&
                w.stbGetItem === storage.get &&
                w.stbSetItem === storage.set);
        return {
            key: durable
                ? get
                    ? driver.storageKey
                        ? driver.storageKey(key)
                        : String(w.p_pref || "") + key
                    : key
                : undefined,
            read: function () {
                return get ? get.call(w, key) : storage.get(key);
            },
            remove: function () {
                if (!get) storage.del(key);
                else if (del) del.call(w, key);
                else set.call(w, key, "");
            },
            transaction: durable ? storage.transaction : undefined,
            write: function (value: string) {
                if (set) set.call(w, key, value);
                else storage.set(key, value);
            },
        };
    }
    function document(): any {
        function read(owner: any, key: string): any {
            var value = owner && owner.document ? owner.document() : null;
            return value === null
                ? JSON.parse(port(key + source).read() || "null")
                : value;
        }
        var tv = {
            channels: read(w.__ottChannels, "channelLibrary:"),
            favorites: read(w.__ottFavoritesLibrary, "favoritesLibrary:"),
            sourceId: source,
        };
        if (!current() || !w.__ottLibraryBackup.validate(tv, source))
            throw new Error("Library unavailable");
        return tv;
    }
    return { current: current, document: document, port: port, source: source };
}

/** V2 carries stable references, including items absent from today's catalog. */
export function exportSettings(): string {
    var w = window as any,
        context = settingsBackupContext();
    var tv = context.document();
    if (!tv.channels && !tv.favorites) {
        var locked = context.port("parentalArray").read();
        var favorites = context.port("favoritesArray").read();
        if (locked || favorites)
            tv = w.__ottLibraryBackup.legacy(
                context.source,
                JSON.parse(locked || "[]"),
                JSON.parse(favorites || "[]"),
                w.channels || {},
                w.__ottLegacyChannelAliases,
                tv,
                w.__ottChannelReferences.create
            );
    }
    if (!context.current()) throw new Error("Settings source changed");
    return JSON.stringify(
        {
            offline_profiles: w.__ottOfflineProfiles
                ? w.__ottOfflineProfiles.read()
                : undefined,
            settings: writeLegacySettingsFields(
                w.__ottPinSecurity.protectSnapshot(
                    w.OttPlayCore.classicPortableSnapshot(settings, false),
                    "parentPin"
                )
            ),
            timestamp: Date.now(),
            tv: tv,
            version: 2,
        },
        null,
        2
    );
}

/** Validate before confirmation; commit settings and library bytes together. */
export function importSettings(
    jsonStr: string,
    onConfirm?: (ok: boolean) => void
): void {
    var w = window as any,
        request = settingsStore.begin(true),
        context: any,
        writes: any[] = [];
    var settled = false,
        applying = false;
    function complete(accept: boolean): void {
        if (settled) return;
        settled = true;
        var applied = false;
        try {
            if (accept && request.active() && context.current()) {
                applying = true;
                applied = applyImport(request, writes, context.current);
            }
        } catch (_error) {
            /* A rejected import must never report success. */
        } finally {
            applying = false;
        }
        request.cancel();
        if (onConfirm) onConfirm(applied);
    }
    try {
        var env = JSON.parse(jsonStr, function (key, value) {
            if (
                key === "__proto__" ||
                key === "constructor" ||
                key === "prototype"
            )
                throw new Error("Unsafe backup key");
            return value;
        });
        if (
            !env ||
            (env.version !== 1 && env.version !== 2) ||
            !env.settings ||
            typeof env.settings !== "object" ||
            Array.isArray(env.settings)
        )
            throw new Error("Invalid backup");
        if (
            env.version === 2 &&
            (typeof env.timestamp !== "number" || !isFinite(env.timestamp))
        )
            throw new Error("Invalid timestamp");
        context = settingsBackupContext();
        var current = context.document();
        var targetSource = context.source;
        if (env.offline_profiles !== undefined) {
            if (
                !w.__ottOfflineProfiles ||
                !w.__ottOfflineProfiles.validateStore(env.offline_profiles)
            )
                throw new Error("Invalid local video profiles");
            if (
                w.__ottActiveProviderDriver &&
                w.__ottActiveProviderDriver.id === "offline" &&
                context.source === w.__ottSourceIdentity.legacy(w)
            )
                targetSource =
                    env.offline_profiles.active < 0
                        ? "offline"
                        : "offline:" + env.offline_profiles.active;
        }
        var tv =
            env.version === 1
                ? w.__ottLibraryBackup.legacy(
                      context.source,
                      env.parentalArray === undefined ? [] : env.parentalArray,
                      env.favoritesArray === undefined
                          ? []
                          : env.favoritesArray,
                      w.channels || {},
                      w.__ottLegacyChannelAliases,
                      current,
                      w.__ottChannelReferences.create
                  )
                : env.tv;
        if (!w.__ottLibraryBackup.validate(tv, targetSource))
            throw new Error("Invalid library");
        var input = readLegacySettingsFields(env.settings);
        var installation = w.OttPlayCore.classicInstallationState(
            settings,
            false
        );
        Object.keys(installation).forEach(function (id) {
            input[id] = installation[id];
        });
        settingsSchema.forEach(function (entry) {
            if (
                Object.prototype.hasOwnProperty.call(input, entry.id) &&
                !request.set(entry.id, input[entry.id])
            )
                throw new Error("Invalid setting");
        });
        if (env.offline_profiles !== undefined) {
            var profileRead = w.stbGetItem,
                profileWrite = w.stbSetItem,
                profileRemove = w.stbDelItem;
            if (!profileRead || !profileWrite || !profileRemove)
                throw new Error("Local profile storage unavailable");
            var profileContext = context.current,
                profileBefore = profileRead("offlineProfiles"),
                profileAfter = JSON.stringify(env.offline_profiles),
                profilePublished = false;
            context.current = function () {
                var bytes = profileRead("offlineProfiles");
                // Once our write is visible, restoring even the exact old bytes
                // belongs to another writer. Do not publish settings or effects.
                if (applying && bytes === profileAfter) profilePublished = true;
                return (
                    ((!profilePublished && bytes === profileBefore) ||
                        (applying && bytes === profileAfter)) &&
                    profileContext(
                        applying && bytes === profileAfter
                            ? targetSource
                            : undefined
                    ) &&
                    profileRead === w.stbGetItem &&
                    profileWrite === w.stbSetItem &&
                    profileRemove === w.stbDelItem
                );
            };
            writes.push({
                after: profileAfter,
                before: profileBefore,
                storage: {
                    key: "offlineProfiles",
                    read: function () {
                        return profileRead("offlineProfiles");
                    },
                    remove: function () {
                        profileRemove("offlineProfiles");
                    },
                    transaction:
                        profileRead === storage.get &&
                        profileWrite === storage.set
                            ? storage.transaction
                            : undefined,
                    write: function (value: string) {
                        profileWrite("offlineProfiles", value);
                    },
                },
            });
        }
        ["channels", "favorites"].forEach(function (name) {
            if (tv[name] === null) return;
            var port = context.port(
                (name === "channels"
                    ? "channelLibrary:"
                    : "favoritesLibrary:") + targetSource
            );
            writes.push({
                after: JSON.stringify(tv[name]),
                before: port.read(),
                storage: port,
            });
        });
    } catch (_error) {
        complete(false);
        return;
    }
    if (typeof w.confirmBox === "function")
        w.confirmBox(
            "Overwrite current settings?",
            function () {
                complete(true);
            },
            function () {
                complete(false);
            }
        );
    else complete(true);
}

function applyImport(
    request: SettingsDraft,
    writes: any[],
    admitted: () => boolean
): boolean {
    var w = window as any;
    if (!request.commit(writes, admitted)) {
        if (w.showShift) w.showShift(w._("Settings could not be saved"));
        return false;
    }
    if (!admitted()) return false;
    if (w.__ottChannels) w.__ottChannels.reset();
    if (!admitted()) return false;
    if (w.__ottFavoritesLibrary) w.__ottFavoritesLibrary.reset();
    if (!admitted()) return false;
    if (w.__ottCommandServer)
        w.__ottCommandServer.configure({
            address: settings.commandServerAddress,
            enabled: false,
            token: settings.commandServerToken,
        });
    if (!admitted()) return false;
    loadSettings();
    if (!admitted()) return false;
    if (w.showShift) w.showShift(w._("Settings imported"));
    if (!admitted()) return false;
    if (w.restart) w.restart();
    return true;
}

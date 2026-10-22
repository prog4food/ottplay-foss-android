/** Source names map to stable classic-script, provider and settings contracts. */
export const legacyPlayerBindings: Array<[string, string]> = [
    ["renderEpgFooter", "epgPodval"],
    ["listFooterElement", "listPodvalElement"],
    ["listFooter", "listPodval"],
    ["showProviderSelection", "selectProvaider"],
    ["providerIds", "arrayProvaiders"],
    ["providerLabels", "provArray"],
    ["showChannelInfo", "showChanelInfo"],
    ["updateChannelInfo", "updateChanelInfo"],
    ["updateChannelListRow", "updateChanelList"],
    ["onChannelsLoaded", "onChanelsLoaded"],
    ["getChannelsArray", "getChanelsArray"],
    ["pauseLivePlayback", "liveStop"],
    ["replayFromLiveOffset", "timeShift"],
    ["showPlaybackSeekDialog", "shiftArchiveSelect"],
    ["observeCurrentProgramme", "getCurProgData"],
    ["publishChannelProgrammeRows", "setCurProg"],
    ["moveSelectedChannelOrCategory", "moveChannel"],
    ["removeSelectedChannelFromCategory", "deleteChannel"],
    ["importGuideReminder", "startEpgTimer"],
    ["openSelectedChannelRecordings", "catRecordsList"],
    ["getChannelEpg", "getEPGchanel"],
    ["getCurrentChannelEpg", "getEPGchanelCur"],
    ["getChannelEpgCached", "getEPGchanelCached"],
    ["getCachedChannelEpg", "getEPGchanelCurCached"],
    ["getEpgFromCache", "getEpgFromCash"],
    ["epgCacheCapacity", "epgCash"],
    ["showProgramInfo", "infoProgramm"],
    ["providerEpgBaseUrl", "_epgDomen"],
    ["showFallbackCategoryList", "showChanelsList"],
    ["saveListPanelState", "saveCPD"],
    ["restoreListPanelState", "restoreCPD"],
    ["renderButtonHint", "btnDiv"],
    ["noop", "nofun"],
    ["toggleProviderSelectionVisibility", "noSelProv"],
    ["toggleProviderSettingsVisibility", "noProvParam"],
    ["providerSelectionUnlockCount", "nselprov"],
    ["providerSettingsUnlockCount", "nprovparams"],
    ["providerScopedStorageKeys", "pdsa"],
    ["channelListItemWidth", "itemWith"],
    ["epgListMode", "epglisted"],
    ["loadEpgListData", "epgShow_miniproc"],
    ["getChannelPreference", "getCHarr"],
    ["applyChannelPreference", "execCHarr"],
    ["saveChannelPreference", "saveCHarr"],
    ["formatClockTime", "pos2text"],
    ["formatSeekOffset", "step2text"],
    ["formatProgramDateTime", "time2str"],
    ["getViewportWidthScale", "getWidthK"],
    ["getViewportHeightScale", "getHeightK"],
    ["stringToUtf8Bytes", "str2arr_u8_utf"],
    ["stringToLatin1Bytes", "str2arr_u8_latin1"],
    ["stripHttpScheme", "StripHttp"],
    ["logPlayerError", "ErrPOST"],
    ["hashString32", "TSH"],
    ["channels", "chanels"],
    ["channelNumberElement", "numprogElement"],
    ["sendClientFeedback", "client_feedb"],
    ["queueFeedbackPost", "PostFeedback"],
    ["sendFeedback", "FeedbPOST"],
    ["hideInfoBarWhenReady", "infoBarHideT"],
    ["scheduleListDetailUpdate", "detailListActionWithTimeOut"],
    ["findOptionIndex", "optIndexOf"],
    ["removeOption", "delOption"],
    ["prependMenuButtonHint", "addBtn2menu"],
];

export const legacySettingsFields: Array<[string, string]> = [
    ["channelLogoMode", "showPicon"],
    ["useGraphicalIndicators", "grapI"],
    ["resumeWithTenSecondRewind", "res10Resume"],
    ["requirePinForProviderSelection", "psProvs"],
];
export const legacyPopupActionIds: Array<[string, string]> = [
    ["toggleAspectRatio", "toggleAspectRatio"],
    ["toggleZoom", "toggleZoom"],
    ["toggleAudioTrack", "toggleAudioTrack"],
    ["toggleSubtitle", "toggleSubtitle"],
    ["popPrevProg", "popPrevProg"],
    ["popPause", "popPause"],
    ["popStop", "popStop"],
    ["popShift", "popShift"],
    ["popTogglePip", "popTogglePip"],
    ["popStopPip", "popStopPip"],
    ["popBuckets", "popBuckets"],
    ["popEpg", "popEpg"],
    ["popRecords", "popRecords"],
    ["popMedia", "popMedia"],
    ["toggleProviderSettingsVisibility", "noProvParam"],
    ["noop", "nofun"],
    ["optionsList", "optionsList"],
    ["restart", "restart"],
    ["exitPortal", "exitPortal"],
    ["infoList", "infoList"],
];

/** Link public English properties to the replaceable classic/provider bindings. */
export function installEnglishPlayerAliases(target: Record<string, any>): void {
    function link(canonical: string, legacy: string): void {
        Object.defineProperty(target, canonical, {
            configurable: true,
            enumerable: true,
            get: function (): any {
                return target[legacy];
            },
            set: function (value: any): void {
                target[legacy] = value;
            },
        });
    }
    for (var i = 0; i < legacyPlayerBindings.length; i++) {
        link(legacyPlayerBindings[i][0], legacyPlayerBindings[i][1]);
    }
}

/** Persist the established action ID, independently of the implementation name. */
export function popupActionId(action: any): string {
    if (typeof action !== "function") return "";
    var target = typeof window === "undefined" ? null : (window as any);
    for (var i = 0; i < legacyPopupActionIds.length; i++) {
        var binding = legacyPopupActionIds[i];
        if (
            target &&
            (target[binding[0]] === action || target[binding[1]] === action)
        )
            return binding[1];
    }
    var name = action.name || "";
    // Source-module callers need the same IDs before publishing window APIs.
    for (var i = 0; i < legacyPopupActionIds.length; i++) {
        if (legacyPopupActionIds[i][0] === name)
            return legacyPopupActionIds[i][1];
    }
    // Provider-defined actions retain their existing, provider-owned IDs.
    return name;
}

function copySettingsFields(input: Record<string, any>): Record<string, any> {
    var result: Record<string, any> = {};
    for (var key in input) {
        if (Object.prototype.hasOwnProperty.call(input, key)) {
            Object.defineProperty(result, key, {
                configurable: true,
                enumerable: true,
                value: input[key],
                writable: true,
            });
        }
    }
    return result;
}

/** Read old version-1 backup fields while accepting the canonical source names. */
export function readLegacySettingsFields(
    input: Record<string, any>
): Record<string, any> {
    var result = copySettingsFields(input);
    for (var i = 0; i < legacySettingsFields.length; i++) {
        var pair = legacySettingsFields[i];
        if (
            !Object.prototype.hasOwnProperty.call(result, pair[0]) &&
            Object.prototype.hasOwnProperty.call(result, pair[1])
        ) {
            result[pair[0]] = result[pair[1]];
        }
        delete result[pair[1]];
    }
    return result;
}

/** Keep version-1 backups readable by older installations without changing keys. */
export function writeLegacySettingsFields(
    input: Record<string, any>
): Record<string, any> {
    var result = copySettingsFields(input);
    for (var i = 0; i < legacySettingsFields.length; i++) {
        var pair = legacySettingsFields[i];
        if (Object.prototype.hasOwnProperty.call(result, pair[0]))
            result[pair[1]] = result[pair[0]];
        delete result[pair[0]];
    }
    return result;
}

if (typeof window !== "undefined") installEnglishPlayerAliases(window as any);

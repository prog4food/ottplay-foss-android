import { popupActionId } from "../compatibility/legacy-names";
import {
    hasTmdbService,
    metadataCssUrl,
    metadataHtml,
    metadataText,
} from "../utils/helpers";
/**
 * UI management — info bar, dialogs, lists, volume, color, time display.
 */

import {
    cancelMediaLoad,
    ifParentalAccessChId,
    type MediaHistoryEntry,
    type MediaTarget,
    observeCurrentProgramme,
    rememberMediaView,
    requestMediaList,
} from "../channels";
import { updateCoreVideoInfo } from "../core";
import { dispatchKey, keys, list_OnClick } from "../key-handler";
import {
    translate as _,
    formatLocaleDateTime,
    interfaceDirection,
} from "../localization";
import { textBoundary } from "../localization/unicode";
import { settings } from "../settings";
import { swopLoadValue } from "../swop";
import {
    formatTwoDigits,
    getThumbnail,
    getViewportHeightScale,
    getViewportWidthScale,
    listRowHeight,
    packListRowBoxes,
    time2time,
} from "../utils/helpers";

declare var $: any;
declare var jQuery: any;

// Globals from other modules
declare var selIndex: number;
declare var isListVisible: boolean;
declare var listPopUpElement: HTMLElement | null;
declare var prependMenuButtonHint: (
    arr: any[],
    action: any,
    label: string
) => void;
declare var dialogBoxKeyHandler: ((key: number) => void) | null;
declare var listArray: any[];
declare var curList: any[];
declare var primaryIndex: number;
declare var sHideMenus: string[];
declare var sNoNumbersKeys: number;
declare var sNoColorKeys: number;
declare var providerSettingsUnlockCount: number;

// DOM element references
var $infoBar: any;
var infoTimeout: any = null;
var listElement: HTMLElement | null = null;
var listInElement: HTMLElement | null = null;
var listCaptionElement: HTMLElement | null = null;
var listFooterElement: HTMLElement | null = null;
var listDetailElement: HTMLElement | null = null;
var channelNumberElement: HTMLElement | null = null;

// List models and callbacks are owned by the screen port. The declarations
// retain the classic renderer ABI without allocating another copy of state.
(window as any).listKeyHandler = null;
declare var listDataArray: any[];
declare var getListItemFn: ((item: any, idx: number) => string) | null;
declare var detailListActionFn: (() => void) | null;
declare var listKeyHandlerFn: ((key: any) => boolean) | null;
var itemWidth = 735;
declare var curColor: string;
declare var curColorB: string;

// Edit mode state — use window.editvar so provider scripts can set it directly
if (typeof (window as any).editvar === "undefined")
    (window as any).editvar = "";
if (typeof (window as any).editCaption === "undefined")
    (window as any).editCaption = "";
declare var editPos: number;
var cursorInterval: any = null;
var _keyCur = 0;
var _keyP = false;

// Keyboard layout (from original stbPlayer)
var _keys1 = "1234567890";
var _keysA = "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09";
var _keysL = "abcdefghijklmnopqrstuvwxyz";
var _keysP = ".:/@,!?<>#$%^&*()-=_+;'\"[]{}`~";
var _keys = "";
var _keyPage = 0;
var _keyPages = 1;
var _keysSymbol: any[] = [
    {
        a: function () {
            _setCase(!_keyUp);
            showEdit();
        },
        s: "",
    },
    {
        a: function () {
            if (!_keysSymbol[1].s) return;
            _keyP = false;
            _setLang(!_keyE);
            showEdit();
        },
        s: "",
    },
    {
        a: function () {
            _setPunct(!_keyP);
            showEdit();
        },
        s: "",
    },
    {
        a: function () {
            swopLoadValue();
        },
        s: "&hearts;&trade;",
    },
    {
        a: function () {
            if (editPos) {
                editPos = textBoundary((window as any).editvar, editPos, -1);
                _changeEdit();
            }
        },
        s: "&larr;",
    },
    {
        a: function () {
            if (editPos < (window as any).editvar.length) {
                editPos = textBoundary((window as any).editvar, editPos, 1);
                _changeEdit();
            }
        },
        s: "&rarr;",
    },
    {
        a: function () {
            editPos = textBoundary((window as any).editvar, editPos, 0);
            (window as any).editvar =
                (window as any).editvar.substr(0, editPos) +
                " " +
                (window as any).editvar.substr(editPos);
            editPos++;
            _changeEdit();
        },
        s: "_",
    },
    {
        a: function () {
            editPos = textBoundary((window as any).editvar, editPos, 0);
            if (editPos) {
                var previous = textBoundary(
                    (window as any).editvar,
                    editPos,
                    -1
                );
                (window as any).editvar =
                    (window as any).editvar.substr(0, previous) +
                    (window as any).editvar.substr(editPos);
                editPos = previous;
                _changeEdit();
            }
        },
        s: "",
    },
    {
        a: function () {
            if (_keyPages < 2) return;
            _keyPage = (_keyPage + 1) % _keyPages;
            _buildKeyboard();
            _keyCur = _keys.length - 2;
            showEdit();
        },
        s: "",
    },
    {
        a: function () {
            (window as any).__ottClassicScreenPort.finishEditor(
                true,
                function () {
                    clearInterval(cursorInterval);
                    $("#listEdit").hide();
                    (window as any).restoreListPanelState();
                }
            );
        },
        s: "Ok",
    },
];
var _keyUp = false;
var _keyE = true;

// Select/value state
var _curVal = 0;
declare var aboutKeyHandler: ((key: number) => boolean) | null;

// Volume
var volumeTimeout: any = null;

// UI state for save/restore

// String constants for button hints
export var strUP = '<span class="fontello">&#xe80b;</span>';
export var strDOWN = '<span class="fontello">&#xe80a;</span>';
export var strLEFT = '<span class="fontello">&#xe80c;</span>';
export var strRIGHT = '<span class="fontello">&#xe80d;</span>';
export var strSTOP = '<span class="fontello">&#xe812;</span>';
export var strPLAY = '<span class="fontello">&#xe811;</span>';
export var strPAUSE = '<span class="fontello">&#xe813;</span>';
export var strPlayPause = '<span class="fontello">&#xe811;&#xe813;</span>';
export var strRW = '<span class="fontello">&#xe803;</span>';
export var strFF = '<span class="fontello">&#xe802;</span>';
export var strPREV = '<span class="fontello">&#xe806;</span>';
export var strNEXT = '<span class="fontello">&#xe805;</span>';
export var strInfo = "INFO";
export var strEPG = "EPG";
export var strSubt = "";
export var strNew = ' <span style="color:red;font-size:60%;">NEW</span>';
export var strRETURN = '<span class="fontello">&#xe804;</span>';
export var strSETUP = "§";
export var strLANG = "SHIFT";
export var strENTER = "ENTER";
export var strTools = '<span class="fontello">&#xe808;</span>';
export var strPip = "W";
export var strAspect = "A";
export var strZoom = "E";
export var strAudio = "S";
export var strPRECH = "?";

/** LG Magic Remote pointer selection activates the row like its OK button. */
function usesLgPointerInput(): boolean {
    var device = (window as any).ott_device;
    return device === "lg/webos" || device === "lg/netcast";
}

/**
 * Initialize UI module — cache DOM element references, load CSS, patch jQuery show/hide,
 * bind click/wheel/progress-bar event handlers.
 *
 * @returns void
 * @sideeffect Hides the info bar and numprog element on init. Appends a `<link>` stylesheet to `<head>`.
 *             Patches `$.fn.show` and `$.fn.hide` to trigger custom events. Binds mousewheel on list
 *             and click/mousemove on the progress bar.
 * @analysis The jQuery show/hide patch allows other handlers to react to visibility changes via `on('show')`/`on('hide')`.
 *             Progress bar click supports seeking for both timeshift (playType < 0) and archive (playType > 0) playback.
 */
export function uiInit(): void {
    $infoBar = $("#info1");
    $infoBar.hide();
    listElement = document.getElementById("list");
    if (listElement) listElement.onclick = list_OnClick;
    listInElement = document.getElementById("listIn");
    listCaptionElement = document.getElementById("listCaption");
    listFooterElement = document.getElementById("listPodval");
    listDetailElement = document.getElementById("listDetail");
    listPopUpElement = document.getElementById("listPopUp");
    channelNumberElement = document.getElementById("numprog");
    if (channelNumberElement) channelNumberElement.style.display = "none";

    var host = (window as any).__host || "";
    var version = (window as any).__av || "local";

    if (!document.querySelector('link[href*="styles/player.css"]')) {
        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = host + "/styles/player.css?" + version;
        document.head.appendChild(link);
    }

    // A standby wake reuses the page and its jQuery prototype.
    (function ($) {
        if ($.fn.__ottVisibilityEvents) return;
        $.fn.__ottVisibilityEvents = true;
        $.each(["show", "hide"], function (_i, ev) {
            var orig = $.fn[ev];
            $.fn[ev] = function () {
                this.triggerHandler(ev);
                return orig.apply(this, arguments);
            };
        });
    })(jQuery);

    // Replace only our listeners; newly created elements also need binding.
    $("#listAbout, #listEdit, #dialogbox, #info1, #progress_div").off(".ottUi");
    $("#listAbout").on("show.ottUi", function () {
        $("#listIn").hide();
    });
    $("#listAbout").on("hide.ottUi", function () {
        $("#listIn").show();
    });
    $("#listEdit").on("show.ottUi", function () {
        $("#listIn").hide();
    });
    $("#listEdit").on("hide.ottUi", function () {
        $("#listIn").show();
        $("#listEdit").text("");
    });
    $("#dialogbox").on("show.ottUi", function () {
        $(this)
            .css({ height: "auto", left: 0, top: 0, width: "auto" })
            .css({
                left: (1260 * getViewportWidthScale() - $(this).width()) / 2,
                top: (720 * getViewportHeightScale() - $(this).height()) / 2,
            });
    });
    ["dialogbox", "listPopUp", "listDetail", "listEdit", "listAbout"].forEach(
        function (id) {
            var root = document.getElementById(id);
            if (!root || (root as any).__ottButtonsBound) return;
            (root as any).__ottButtonsBound = true;
            var overlay =
                id === "dialogbox"
                    ? "dialog"
                    : id === "listEdit"
                      ? "editor"
                      : id === "listAbout"
                        ? "about"
                        : "";
            var listButtons = !overlay;
            var dispatchButton = function (event: Event): void {
                var target = event.target as Node | null;
                if (target && target.nodeType !== 1) target = target.parentNode;
                var button = target && $(target).closest("[data-ott-key]")[0];
                if (
                    !button ||
                    !root!.contains(button) ||
                    (id === "listDetail" &&
                        (button.parentNode !== root!.firstChild ||
                            (button.parentNode as HTMLElement).id !==
                                "mediaPlaybackControls"))
                )
                    return;
                // Consume before ownership checks so obsolete controls cannot
                // activate inline fallbacks or the video surface underneath.
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                var w = window as any;
                var port = w.__ottClassicScreenPort;
                var owner = listButtons
                    ? port.listOwner()
                    : port.owner(overlay);
                var key = Number(button.getAttribute("data-ott-key"));
                if (
                    owner &&
                    owner.foreground() &&
                    (id === "dialogbox" || $(root!).is(":visible")) &&
                    key &&
                    isFinite(key)
                ) {
                    if (
                        id === "listEdit" &&
                        owner.model &&
                        owner.model.nativeInputIme &&
                        key === w.keys.ENTER
                    ) {
                        // Synthetic/assistive clicks need not focus a role=button
                        // span. Make this explicit action visible to the key router.
                        button.focus();
                        if (!owner.foreground()) return;
                    }
                    w._doKey(key, event);
                }
            };
            root.addEventListener("click", dispatchButton, true);
            root.addEventListener(
                "keydown",
                function (event: KeyboardEvent): void {
                    if (event.keyCode === 13 || event.keyCode === 32)
                        dispatchButton(event);
                },
                true
            );
        }
    );

    if ((window as any).__ottAccessibility)
        (window as any).__ottAccessibility.install();

    // Click on info bar toggles channel info display
    $infoBar.on("click.ottUi", function (e: any) {
        if (!e) e = event;
        e.stopPropagation();
        if (typeof (window as any).showChannelInfo === "function")
            (window as any).showChannelInfo();
    });

    // Mousewheel on list
    var listInEl = listInElement;
    if (listInEl) {
        var onWheel = function (e: any): void {
            if (!e) e = event;
            var t = e.deltaY || e.detail || -e.wheelDelta;
            if (e.preventDefault) e.preventDefault();
            else e.returnValue = false;
            if (
                t < 0 &&
                (window as any).selIndex > 0 &&
                typeof (window as any).changeSelect === "function"
            )
                (window as any).changeSelect(-1);
            if (
                t > 0 &&
                (window as any).selIndex <
                    ((window as any).listArray || []).length - 1 &&
                typeof (window as any).changeSelect === "function"
            )
                (window as any).changeSelect(1);
        };
        if ("onwheel" in document) {
            (listInEl as any).onwheel = onWheel;
        } else if ("onmousewheel" in document) {
            (listInEl as any).onmousewheel = onWheel;
        }
        // Capture-phase row hit-test: map click to the .item under the
        // pointer (closest + Y fallback). Avoids float/paint desync where
        // visual row N fired #it0 / void. stopImmediatePropagation keeps
        // other row listeners from double-firing setSelect→ENTER.
        if (!(listInEl as any).__ottListClickBound) {
            (listInEl as any).__ottListClickBound = true;
            var listInClickRoot: HTMLElement = listInEl;
            listInClickRoot.addEventListener(
                "mousemove",
                function (ev: MouseEvent): void {
                    if (!usesLgPointerInput() || ev.buttons) return;
                    var target = ev.target;
                    if (!target || (target as Node).nodeType !== 1) return;
                    var item = $(target).closest(".item")[0] as
                        | HTMLElement
                        | undefined;
                    if (!item || !listInClickRoot.contains(item)) return;
                    var raw =
                        item.getAttribute("data-idx") ||
                        (item.id && item.id.indexOf("it") === 0
                            ? item.id.slice(2)
                            : "");
                    var index = parseInt(raw as string, 10);
                    // Movement only focuses; repeated movement never activates.
                    if (!isNaN(index) && index !== selIndex) setSelect(index);
                },
                false
            );
            listInClickRoot.addEventListener(
                "click",
                function (ev: MouseEvent): void {
                    if ((window as any).__ottTauriSuppressClick) return;
                    var t = ev.target;
                    if (!t || (t as Node).nodeType !== 1) return;
                    if ($(t).closest(".list-scroll").length) return;
                    var item = $(t).closest(".item")[0] as
                        | HTMLElement
                        | undefined;
                    if (!item) {
                        var y = ev.clientY;
                        var nodes = listInClickRoot.querySelectorAll(".item");
                        for (var ii = 0; ii < nodes.length; ii++) {
                            var el = nodes[ii] as HTMLElement;
                            var rr = el.getBoundingClientRect();
                            if (y >= rr.top && y <= rr.bottom) {
                                item = el;
                                break;
                            }
                        }
                    }
                    if (!item) return;
                    var raw =
                        item.getAttribute("data-idx") ||
                        (item.id && item.id.indexOf("it") === 0
                            ? item.id.slice(2)
                            : "");
                    var idx = parseInt(raw as string, 10);
                    if (isNaN(idx)) return;
                    ev.preventDefault();
                    ev.stopPropagation();
                    ev.stopImmediatePropagation();
                    if (
                        usesLgPointerInput() ||
                        (ev as any).ottNativeListTap === true
                    ) {
                        // Touch taps and LG pointer clicks focus and activate
                        // in one action, including an already selected row.
                        if (idx !== selIndex) setSelect(idx);
                        dispatchKey(keys.ENTER);
                    } else if (
                        typeof (window as any).setSelect === "function"
                    ) {
                        (window as any).setSelect(idx);
                    } else {
                        setSelect(idx);
                    }
                },
                true
            );
            listInClickRoot.addEventListener(
                "keydown",
                function (event: KeyboardEvent): void {
                    if (event.keyCode !== 13 && event.keyCode !== 32) return;
                    var target = event.target as Node | null;
                    if (!target || target.nodeType !== 1) return;
                    var item = $(target).closest(".item")[0] as
                        | HTMLElement
                        | undefined;
                    if (!item || !listInClickRoot.contains(item)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    item.click();
                },
                true
            );
        }
    }

    // Capture footer button clicks before Tauri drag suppression or video
    // compositing cannot swallow EPG/Category/Actions/Description/PiP clicks.
    var footerElement =
        listFooterElement || document.getElementById("listPodval");
    if (footerElement && !(footerElement as any).__ottFooterClickBound) {
        (footerElement as any).__ottFooterClickBound = true;
        var footerRoot: HTMLElement = footerElement as HTMLElement;
        var dispatchFooterAction = function (ev: Event): void {
            try {
                (window as any).__ottTauriSuppressClick = false;
            } catch (_s) {}
            var t = ev.target;
            if (!t || (t as Node).nodeType !== 1) return;
            var span = $(t).closest("span[data-ott-key]")[0] as
                | HTMLElement
                | undefined;
            if (!span || !footerRoot.contains(span)) return;
            var keyNum = Number(span.getAttribute("data-ott-key"));
            if (!keyNum || !isFinite(keyNum)) return;
            try {
                ev.preventDefault();
                ev.stopPropagation();
                if (typeof (ev as any).stopImmediatePropagation === "function")
                    (ev as any).stopImmediatePropagation();
            } catch (_sp) {}
            if (typeof (window as any)._doKey === "function") {
                (window as any)._doKey(keyNum, ev);
            }
        };
        footerRoot.addEventListener("click", dispatchFooterAction, true);
        footerRoot.addEventListener(
            "keydown",
            function (event: KeyboardEvent): void {
                if (event.keyCode === 13 || event.keyCode === 32)
                    dispatchFooterAction(event);
            },
            true
        );
        // mousedown arm: clear suppress before click; do not _doKey here
        // (would double-fire with click).
        footerRoot.addEventListener(
            "mousedown",
            function (ev: Event): void {
                try {
                    (window as any).__ottTauriSuppressClick = false;
                } catch (_s) {}
                try {
                    ev.stopPropagation();
                } catch (_sp) {}
            },
            true
        );
    }

    // Progress bar drag-to-seek — press on progress bar and drag to seek, release to seek
    var $progressDiv = $("#progress_div");
    var seekInProgress = false;

    $progressDiv.on("mousedown.ottUi", function (e: any) {
        if (!e) e = event;
        if (e.clientX === undefined) {
            console.error("$progress_div[mousedown] evt.clientX not exist");
            return;
        }
        seekInProgress = true;
    });

    function seekProgress(e: any, eventName: string): void {
        if (!e) e = event;
        if (e.clientX === undefined) {
            console.error(
                "$progress_div[" + eventName + "] evt.clientX not exist"
            );
            return;
        }
        e.stopPropagation();
        var w = window as any;
        if (
            !(
                w.playType ||
                (w.channels &&
                    w.curList &&
                    w.channels[w.curList[w.primaryIndex]] &&
                    w.channels[w.curList[w.primaryIndex]].rec)
            )
        )
            return;
        var t =
            (e.clientX - $progressDiv.position().left) / $progressDiv.width();
        if (w.playType < 0) {
            var r = Math.max(Math.round(t * w.stbGetLen()), 0);
            var hr = Math.floor(r / 3600);
            var mn = Math.floor((r % 3600) / 60);
            var sc = r % 60;
            if (typeof w.showShift === "function")
                w.showShift(
                    ">> " +
                        (hr ? hr + ":" : "") +
                        _t2(mn) +
                        ":" +
                        _t2(sc) +
                        " <<"
                );
            if (typeof w.stbSetPosTime === "function") w.stbSetPosTime(r);
            return;
        }
        if (
            w._prog100 &&
            w._prog100.time_to != null &&
            w._prog100.time != null
        ) {
            var r2 = Math.round(
                t * (w._prog100.time_to - w._prog100.time) + w._prog100.time
            );
        } else {
            // No EPG — map click onto virtual 1h/80% timeshift window (live)
            // or hourless elapsed window (archive).
            var virt = virtualTimeshiftProg();
            w._prog100 = virt;
            var r2 = Math.round(t * (virt.time_to - virt.time) + virt.time);
        }
        if (r2 < Date.now() / 1e3) {
            if (!w.playType) {
                if (typeof w.replayFromLiveOffset === "function")
                    w.replayFromLiveOffset(Math.round(Date.now() / 1e3 - r2));
                return;
            }
            if (typeof w.showShift === "function")
                w.showShift(">> " + formatClockTime(r2) + " <<");
            if (typeof w.playArchive === "function") w.playArchive(r2);
        } else {
            if (typeof w.showShift === "function")
                w.showShift(w._(w.playType ? "Live" : "Restart stream"));
            if (typeof w.playChannel === "function")
                w.playChannel(w.catIndex, w.primaryIndex);
        }
    }
    $progressDiv.on("mouseup.ottUi", function (e: any) {
        if (!seekInProgress) return;
        seekInProgress = false;
        seekProgress(e, "mouseup");
    });
    $progressDiv.on("click.ottUi", function (e: any) {
        seekProgress(e, "click");
    });

    // Progress bar mousemove — show tooltip
    var tooltipEl = document.getElementById("progress_span");
    $progressDiv.on("mousemove.ottUi", function (e: any) {
        if (!e) e = event;
        if (e.clientX === undefined) {
            console.error("$progress_div[mousemove] evt.clientX not exist");
            return;
        }
        var w = window as any;
        if (
            !(
                w.playType ||
                (w.channels &&
                    w.curList &&
                    w.channels[w.curList[w.primaryIndex]] &&
                    w.channels[w.curList[w.primaryIndex]].rec)
            )
        )
            return;
        var clientX = e.clientX;
        if (tooltipEl) {
            tooltipEl.style.display = "block";
            tooltipEl.style.top =
                $progressDiv.offset().top - $progressDiv.height() + "px";
            tooltipEl.style.left = clientX - tooltipEl.offsetWidth / 2 + "px";
        }
        var $tooltipSpan = $("span", tooltipEl);
        var frac =
            (clientX - $progressDiv.position().left) / $progressDiv.width();
        if (w.playType < 0) {
            var r = Math.max(Math.round(frac * w.stbGetLen()), 0);
            var hr = Math.floor(r / 3600);
            var mn = Math.floor((r % 3600) / 60);
            var sc = r % 60;
            $tooltipSpan.text((hr ? hr + ":" : "") + _t2(mn) + ":" + _t2(sc));
        } else if (
            w._prog100 &&
            w._prog100.time_to != null &&
            w._prog100.time != null
        ) {
            var r2 = Math.round(
                frac * (w._prog100.time_to - w._prog100.time) + w._prog100.time
            );
            $tooltipSpan.text(formatClockTime(r2));
        } else {
            // No EPG data — show playback position based on playTime (seconds elapsed)
            var elapsed = w.playType > 0 ? (w.playTime ?? 0) : 0;
            var r3 = Math.round(elapsed);
            $tooltipSpan.text(formatClockTime(r3));
        }
    });
}

/**
 * Hide the info bar after a conditional delay. If the player is buffering, not playing, or in step mode,
 * re-checks after 5 seconds. Otherwise hides immediately.
 *
 * @returns void
 * @sideeffect Calls `infoBarHide()` immediately or schedules itself again via `setTimeout`.
 * @analysis This is a polling-style hide: it keeps retrying every 5s until conditions are right for immediate hide.
 */
export function hideInfoBarWhenReady(): void {
    if (typeof (window as any).stbIsPlaying === "function") {
        if (
            $("#buffering").is(":visible") ||
            !(window as any).stbIsPlaying() ||
            $("#step").is(":visible")
        ) {
            infoTimeout = setTimeout(hideInfoBarWhenReady, 5000);
        } else {
            infoBarHide();
        }
    }
}

/**
 * Immediately hide the info bar and clear the progress tooltip.
 *
 * @returns void
 * @sideeffect Clears `infoTimeout`. Hides `$infoBar`. Sets progress_span tooltip display to '' (shows it by clearing).
 * @analysis Hides the info bar unconditionally, even if it is already hidden.
 */
export function infoBarHide(): void {
    try {
        var tooltip = document.getElementById("progress_span");
        if (tooltip) tooltip.style.display = "";
    } catch (e) {
        console.error(e);
    }
    clearTimeout(infoTimeout);
    if ((window as any).sInfoSlide) {
        $infoBar.slideUp();
    } else {
        $infoBar.hide();
    }
    $("#descr").hide();
}

/**
 * Show the channel info bar and schedule its auto-hide after `timeoutSec` seconds.
 *
 * @param timeoutSec - Number of seconds before the info bar is hidden (multiplied by 1000 for setTimeout).
 * @returns void
 * @sideeffect Shows `$infoBar`, clears any existing `infoTimeout`, and sets a new timeout to call `infoBarHide`.
 */
export function showChannelInfo(timeoutSec: number): void {
    var w = window as any;
    clearTimeout(detailTimer);
    clearTimeout(detailScrollTimer);
    clearTimeout(infoTimeout);
    if (w.__ottKiosk && w.__ottKiosk.strict && w.__ottKiosk.strict()) {
        // Strict input owns the limited media seek gesture; other footer controls
        // and expandable details remain blocked, with a bounded display lifetime.
        $("#descr, #progress_span").hide();
        $infoBar.stop(true, true).show();
        infoTimeout = setTimeout(infoBarHide, 5000);
        return;
    }
    if (timeoutSec === undefined) timeoutSec = 0;
    // If called with timeoutSec=1 and bar is already visible with descr hidden, just reset timeout
    if (
        timeoutSec === 1 &&
        $infoBar.is(":visible") &&
        !$("#descr").is(":visible")
    ) {
        infoTimeout = setTimeout(
            hideInfoBarWhenReady,
            (w.sInfoTimeout || 5) * 1000
        );
        return;
    }
    // Hide first for animated re-show (when timeoutSec is 1 or 2)
    if (timeoutSec) $infoBar.hide();
    $("#programm_descr").stop(true).css("margin-top", 0);
    if (!$infoBar.is(":visible")) {
        if (timeoutSec !== 2) $("#descr").hide();
        else $("#descr").show();
        if (w.sInfoSlide) {
            $infoBar.slideDown(400, function () {
                if (typeof w.scrollUpDescr === "function") w.scrollUpDescr();
            });
        } else {
            $infoBar.show(0, function () {
                if (typeof w.scrollUpDescr === "function") w.scrollUpDescr();
            });
        }
        if (timeoutSec !== 2) {
            infoTimeout = setTimeout(
                hideInfoBarWhenReady,
                (timeoutSec > 0 ? timeoutSec : w.sInfoTimeout || 5) * 1000
            );
        }
    } else if (!$("#descr").is(":visible")) {
        // Keep the footer timed when no programme or media details are available.
        if (
            !$("#programm_name2, #programm_descr").text().trim() &&
            !$("#programm_descr").find("img,.img").length
        ) {
            showChannelInfo(1);
            return;
        }
        if (w.sInfoSlide) {
            $("#descr").slideDown(400, function () {
                if (typeof w.scrollUpDescr === "function") w.scrollUpDescr();
            });
        } else {
            $("#descr").show(0, function () {
                if (typeof w.scrollUpDescr === "function") w.scrollUpDescr();
            });
        }
    } else {
        infoBarHide();
    }
    refreshAudioBadge();
}

/**
 * Render the current page of items in the list overlay.
 * Calculates page boundaries from `selIndex` and `settings.pageSize`, builds HTML for visible items,
 * and renders a scrollbar thumbnail when content exceeds one page.
 *
 * @returns void
 * @sideeffect Hides info bar and permanentTime. Shows `list_osd` or `list_window`. Sets `listInElement.innerHTML`.
 *             Calls `scheduleListDetailUpdate()` after rendering.
 * @analysis Falls back to `window.listDataArray` if the module-level `listDataArray` is empty.
 *             Each item is rendered as a `<div id="it{i}">` with the result of `getListItemFn(item, i)`.
 *             The scrollbar shows the current page position as a colored bar.
 */
export function showPage(): void {
    var screenOwner = (window as any).__ottClassicScreenPort.commitList();
    if (!screenOwner.active()) return;
    function scheduleLayoutRetry(key: string): void {
        var host = window as any;
        var pending = host[key];
        if (pending && pending.owner === screenOwner) return;
        var retry = { owner: screenOwner };
        host[key] = retry;
        requestAnimationFrame(function () {
            if (host[key] !== retry) return;
            host[key] = false;
            if (screenOwner.active()) showPage();
        });
    }
    isListVisible = true;
    try {
        (window as any).isListVisible = true;
    } catch (_vis) {}
    $infoBar.hide();
    $("#permanentTime").hide();
    // Retire the previous visible-row subscriptions before mounting this page.
    try {
        (window as any).__ottClassicGuide.cancelConsumers();
    } catch (_q) {}

    if (listInElement) listInElement.innerHTML = "";
    try {
        if (settings.noSmall) {
            if (
                $("#list_window").is(":visible") &&
                typeof (window as any).stbToFullScreen === "function"
            )
                (window as any).stbToFullScreen();
            $("#list_window").hide();
            $("#list_osd").show();
        } else {
            $("#list_osd").hide();
            $("#list_window").show();
            if (typeof (window as any).stbSetWindow === "function")
                (window as any).stbSetWindow();
        }
    } catch (e) {
        console.error(e);
    }
    if (listElement) listElement.style.display = "";
    // Remeasure once on next frame if #listIn was not laid out yet
    // (common on first open in Tauri after show()).
    try {
        var _boxEarly = document.getElementById("listIn");
        if (_boxEarly && _boxEarly.clientHeight <= 40)
            scheduleLayoutRetry("__ottListFitRetry");
    } catch (_early) {}
    // Both classic spellings project the same ScreenPort arrays.
    var dataArr =
        listDataArray && listDataArray.length
            ? listDataArray
            : listArray && listArray.length
              ? listArray
              : [];
    // Always honor List settings pageSize (OTT). Cursor stays on-screen via
    // paging in changeSelect — never by shrinking pageSize.
    var pageSz = Math.max(1, settings.pageSize | 0 || 25);
    (window as any).listPageSize = pageSz;
    var pageStart = Math.floor(selIndex / pageSz) * pageSz;
    var pageEnd = Math.min(pageStart + pageSz, dataArr.length);
    var itemHeight = Math.max(1, Math.floor(listRowHeight(pageSz)));
    (window as any).__ottListRowH = itemHeight;
    var html = "";
    // OTT showPage: scrollbar only when sShowScroll (Lists settings) is on.
    var showScroll = settings.showScroll;
    var scrollWidth = 0;
    var totalPages = 1;
    var currentPage = 0;
    if (showScroll && dataArr.length > pageSz) {
        itemWidth = getViewportWidthScale() * 720;
        (window as any).channelListItemWidth = itemWidth;
        scrollWidth = 10 * getViewportWidthScale();
        totalPages =
            Math.floor(dataArr.length / pageSz) +
            (dataArr.length % pageSz ? 1 : 0);
        currentPage = Math.floor(selIndex / pageSz);
        // Absolute scrollbar (NOT float:right): float-first layout made
        // visual rows miss their #itN hit targets in WKWebView/Tauri.
        html += '<div class="list-scroll">';
        html += '<div class="list-scroll-before"></div>';
        html += '<div class="list-scroll-thumb"></div></div>';
    } else {
        itemWidth = getViewportWidthScale() * 735;
        (window as any).channelListItemWidth = itemWidth;
    }
    // Never let row width exceed the live #listIn box (window-state restore /
    // non-1280 sizes used to overflow → wrap / clipped values in WKWebView).
    try {
        var listInBox = listInElement || document.getElementById("listIn");
        if (listInBox && (listInBox as HTMLElement).clientWidth > 40) {
            var avail =
                (listInBox as HTMLElement).clientWidth -
                (showScroll && dataArr.length > pageSz
                    ? 12 * getViewportWidthScale()
                    : 0);
            if (avail > 40) itemWidth = Math.min(itemWidth, Math.floor(avail));
            (window as any).channelListItemWidth = itemWidth;
        }
    } catch (_wCap) {}
    var restoreRowFocus =
        !!listInElement && listInElement.contains(document.activeElement);
    for (var i = pageStart; i < pageEnd; i++) {
        html +=
            '<div id="it' +
            i +
            '" data-idx="' +
            i +
            '" role="option" tabindex="-1" aria-posinset="' +
            (i + 1) +
            '" aria-setsize="' +
            dataArr.length +
            '" class="item"';
        html += ">";
        try {
            html += getListItemFn ? getListItemFn(dataArr[i], i) : "";
        } catch (e) {
            html += "ERROR:" + metadataText((e as any).message);
        }
        html += "</div>";
    }
    if (listInElement) {
        listInElement.scrollTop = 0;
        listInElement.innerHTML = html;
        // Assign only app-owned geometry/theme properties. Tauri's style nonce
        // blocks attributes parsed from HTML but allows these DOM properties.
        for (var ri = pageStart; ri < pageEnd; ri++) {
            var row = document.getElementById("it" + ri);
            if (!row) continue;
            row.style.height = itemHeight + "px";
            row.style.maxHeight = itemHeight + "px";
            row.style.minHeight = itemHeight + "px";
            row.style.lineHeight = itemHeight + "px";
            row.style.width = itemWidth + "px";
            if (ri === selIndex) {
                $(row).addClass("ott-selected");
                row.style.color = curColor || "gold";
                row.style.backgroundColor = curColorB || "#668";
            }
        }
        var scrollbar = listInElement.querySelector(
            ".list-scroll"
        ) as HTMLElement | null;
        if (scrollbar) {
            scrollbar.style.width = scrollWidth + "px";
            var scrollBefore = scrollbar.querySelector(
                ".list-scroll-before"
            ) as HTMLElement;
            var scrollThumb = scrollbar.querySelector(
                ".list-scroll-thumb"
            ) as HTMLElement;
            scrollBefore.style.height = (currentPage / totalPages) * 100 + "%";
            scrollThumb.style.height = 100 / totalPages + "%";
            scrollbar.onclick = function (event): void {
                event.stopPropagation();
                changeSelect(pageSz);
            };
            scrollBefore.onclick = function (event): void {
                event.stopPropagation();
                changeSelect(-pageSz);
            };
        }
        var applyChannelStyles = (window as any).applyChannelListStyles;
        if (typeof applyChannelStyles === "function")
            applyChannelStyles(listInElement);
    }
    // The formatter and channel style pass already paint warm programme rows.
    // Cold rows update through their guide callbacks; detail rendering is debounced below.
    // Force exact integer row boxes after layout (WKWebView may expand flex
    // rows 1px+ each → pageSize 25 collapses to ~21 visible).
    try {
        packListRowBoxes(pageStart, pageEnd, pageSz);
        requestAnimationFrame(function () {
            if (!screenOwner.active()) return;
            try {
                var h2 = packListRowBoxes(pageStart, pageEnd, pageSz);
                if (h2 > 0) (window as any).__ottListRowH = h2;
                // If the last row on this page is still clipped, one more shrink.
                var box = document.getElementById("listIn");
                var last = document.getElementById("it" + (pageEnd - 1));
                if (box && last && pageEnd > pageStart) {
                    var lr = box.getBoundingClientRect();
                    var er = last.getBoundingClientRect();
                    if (er.bottom > lr.bottom + 0.5) {
                        var avail2 =
                            typeof (window as any).listInContentHeight ===
                            "function"
                                ? (window as any).listInContentHeight()
                                : box.clientHeight;
                        var h3 = Math.max(1, Math.floor(avail2 / pageSz) - 1);
                        for (var j = pageStart; j < pageEnd; j++) {
                            var n = document.getElementById(
                                "it" + j
                            ) as HTMLElement | null;
                            if (!n) continue;
                            n.style.height = h3 + "px";
                            n.style.maxHeight = h3 + "px";
                            n.style.minHeight = h3 + "px";
                            n.style.lineHeight = h3 + "px";
                        }
                        (window as any).__ottListRowH = h3;
                    }
                }
            } catch (_pack2) {}
        });
    } catch (_pack) {}
    // Pin selection styles after remount (page-boundary ↓/L/R and first open
    // used to leave #itN without a visible cursor when only page HTML flipped).
    try {
        var pin = document.getElementById("it" + selIndex);
        var cursorRetry = (window as any).__ottListCursorRetry;
        var retryCursor = !cursorRetry || cursorRetry.owner !== screenOwner;
        if (pin) {
            $(pin).addClass("ott-selected");
            pin.style.backgroundColor = curColorB || "#668";
            pin.style.color = curColor || "gold";
            // First open / page flip: if the pin is still clipped, remeasure once
            // after layout (Tauri WKWebView often reports stale #listIn height).
            try {
                var boxPin = listInElement || document.getElementById("listIn");
                if (boxPin && retryCursor && dataArr.length) {
                    var lr2 = (boxPin as HTMLElement).getBoundingClientRect();
                    var er2 = pin.getBoundingClientRect();
                    if (
                        !(
                            er2.top >= lr2.top - 1 &&
                            er2.bottom <= lr2.bottom + 1
                        )
                    )
                        scheduleLayoutRetry("__ottListCursorRetry");
                }
            } catch (_clip) {}
        } else if (
            dataArr.length &&
            selIndex >= 0 &&
            selIndex < dataArr.length &&
            retryCursor
        ) {
            scheduleLayoutRetry("__ottListCursorRetry");
        }
    } catch (_pin) {}
    (window as any).selIndex = selIndex;
    if ((window as any).__ottAccessibility)
        (window as any).__ottAccessibility.select(
            listInElement,
            selIndex,
            restoreRowFocus
        );
    scheduleListDetailUpdate();
}

/**
 * Change the list selection by a delta offset. Wraps around at boundaries.
 * Visually updates the highlight on the old and new items. If the new item is not in the current page,
 * calls `showPage()` to re-render.
 *
 * @param delta - Number of positions to move (positive = down, negative = up). Large values (pageSize) skip pages.
 * @returns void — early return if the data array is empty.
 * @sideeffect Modifies `selIndex`. Updates DOM element styles for old/new selection. Calls `scheduleListDetailUpdate()`.
 * @analysis Wrapping behavior differs for delta ±1 (wrap to opposite end) vs larger jumps (clamp at boundary).
 *             `showPage()` is called if the new index is not yet rendered on the current page.
 */
export function changeSelect(delta: number): void {
    var owner = (window as any).__ottClassicScreenPort.listOwner();
    if (owner && !owner.foreground()) return;
    var dataArr =
        (listDataArray && listDataArray.length ? listDataArray : null) ||
        ((window as any).listDataArray && (window as any).listDataArray.length
            ? (window as any).listDataArray
            : null) ||
        (listArray && listArray.length ? listArray : null) ||
        ((window as any).listArray && (window as any).listArray.length
            ? (window as any).listArray
            : null) ||
        [];
    if (!dataArr.length) return;
    var oldIndex = selIndex;
    selIndex += delta;
    if (selIndex < 0) selIndex = delta === -1 ? dataArr.length - 1 : 0;
    else if (selIndex >= dataArr.length)
        selIndex = delta === 1 ? 0 : dataArr.length - 1;
    // Keep window.selIndex in sync (channelsKeyHandler / provider read it).
    (window as any).selIndex = selIndex;
    var pageSz = (window as any).listPageSize || settings.pageSize || 25;
    pageSz = Math.max(1, pageSz | 0);
    var pageChanged =
        Math.floor(oldIndex / pageSz) !== Math.floor(selIndex / pageSz);
    var newItem = document.getElementById("it" + selIndex);
    // #itN in DOM is not enough: overflow:hidden can leave the node clipped
    // inside #listIn (cursor on 21–25 while rows 1–20 show). Re-render the
    // page so the highlight always lands on a fully visible row. Also
    // re-showPage on every page boundary (↓ onto 20, L/R ±pageSize) so the
    // highlight class is never left on a stale off-page node.
    var fullyVisible = false;
    if (newItem && !pageChanged) {
        try {
            var listInBox = listInElement || document.getElementById("listIn");
            if (listInBox) {
                var lr = (listInBox as HTMLElement).getBoundingClientRect();
                var er = newItem.getBoundingClientRect();
                fullyVisible =
                    er.top >= lr.top - 1 && er.bottom <= lr.bottom + 1;
            } else {
                fullyVisible = true;
            }
        } catch (_vis) {
            fullyVisible = true;
        }
    }
    if (newItem && fullyVisible && !pageChanged) {
        var oldItem = document.getElementById("it" + oldIndex);
        if (oldItem) {
            $(oldItem).removeClass("ott-selected");
            oldItem.style.backgroundColor = "";
            oldItem.style.color = "";
        }
        $(newItem).addClass("ott-selected");
        newItem.style.backgroundColor = curColorB || "#668";
        newItem.style.color = curColor || "gold";
        if ((window as any).__ottAccessibility)
            (window as any).__ottAccessibility.select(
                listInElement,
                selIndex,
                !!listInElement &&
                    listInElement.contains(document.activeElement)
            );
        scheduleListDetailUpdate();
    } else {
        showPage();
    }
}

/**
 * Set list selection to a specific index (from click or programmatic call).
 * If the clicked item is already selected, dispatches ENTER (confirm). Otherwise moves selection
 * and updates highlighting.
 *
 * @param index - The target item index to select.
 * @returns void
 * @sideeffect Dispatches ENTER key if already on the target. Updates DOM styles for old/new selection.
 *             Calls `scheduleListDetailUpdate()`.
 */
export function setSelect(index: number): void {
    var owner = (window as any).__ottClassicScreenPort.listOwner();
    if (owner && !owner.foreground()) return;
    if (selIndex === index) {
        dispatchKey(keys.ENTER);
    } else {
        var oldItem = document.getElementById("it" + selIndex);
        selIndex = index;
        (window as any).selIndex = selIndex;
        var newItem = document.getElementById("it" + selIndex);
        if (oldItem) {
            $(oldItem).removeClass("ott-selected");
            oldItem.style.backgroundColor = "";
            oldItem.style.color = "";
        }
        if (newItem) {
            $(newItem).addClass("ott-selected");
            newItem.style.backgroundColor = curColorB || "#668";
            newItem.style.color = curColor || "gold";
        }
        if ((window as any).__ottAccessibility)
            (window as any).__ottAccessibility.select(
                listInElement,
                selIndex,
                !!listInElement &&
                    listInElement.contains(document.activeElement)
            );
        scheduleListDetailUpdate();
    }
}

/**
 * Close the list overlay (OSD or window) and return to full-screen video.
 *
 * @returns void
 * @sideeffect Sets `isListVisible = false`. Hides list element, `list_osd`, `list_window`.
 *             Shows `permanentTime` if `settings.permanentTime !== 0`. Calls `window.stbToFullScreen()`.
 * @analysis Errors during DOM manipulation are silently caught and logged.
 */
export function closeList(restorePip = true): void {
    var wasListVisible = isListVisible;
    if (wasListVisible && (window as any).__ottClassicGuide)
        (window as any).__ottClassicGuide.cancelConsumers();
    (window as any).__ottClassicScreenPort.closeList();
    if ((window as any).__ottClassicGuideScreen)
        (window as any).__ottClassicGuideScreen.close();
    cancelMediaLoad();
    isListVisible = false;
    try {
        (window as any).isListVisible = false;
    } catch (_vis) {}
    try {
        if (listElement) listElement.style.display = "none";
        $("#list_osd").hide();
        $("#list_window").hide();
        $("#listPopUp").hide();
        $("#permanentTime").toggle(settings.permanentTime !== 0);
        if (typeof (window as any).stbToFullScreen === "function")
            (window as any).stbToFullScreen();
        if (
            restorePip &&
            !(window as any).sNoSmall &&
            (window as any).pipIndex != null
        )
            playPipChannel(
                (window as any).pipCatIndex,
                (window as any).pipIndex
            );
        if ((window as any).sPreview && (window as any).previewChan) {
            if (
                (window as any).previewChan.ch_id !==
                (window as any).curList[(window as any).primaryIndex]
            ) {
                if ((window as any).sStopPlay) (window as any).stbStop();
                if ((window as any).playType > 0)
                    (window as any).playArchive(
                        (window as any).playType +
                            (window as any).playTime -
                            ((window as any).s10resum ? 10 : 0)
                    );
                else
                    (window as any).playChannel(
                        (window as any).catIndex,
                        (window as any).primaryIndex
                    );
            }
            (window as any).previewChan = null;
        }
    } catch (e) {
        console.error(e);
    }
    // Visible rows owned the guide callbacks; fullscreen returns ownership
    // to the playing channel, which can differ from the selected list row.
    if (wasListVisible && !(window as any).playType)
        updateChannelInfo(
            ((window as any).curList || [])[(window as any).primaryIndex]
        );
}

/** Isolate Latin identifiers/URLs inside RTL display text, after HTML sanitizing. */
export function localizedTextHtml(message: string, centered?: boolean): string {
    var direction = interfaceDirection();
    var content = document.createElement("div");
    content.innerHTML = metadataHtml(message);
    if (direction === "rtl") {
        var isolate = function (parent: Node): void {
            for (var child = parent.firstChild; child; ) {
                var next = child.nextSibling;
                if (child.nodeType === 3) {
                    var text = child.nodeValue || "",
                        pattern =
                            /[#@]?[A-Za-z0-9](?:[A-Za-z0-9._:/?&=%@+#~\-]*[A-Za-z0-9_/#=%~\-])?/g;
                    var match: RegExpExecArray | null,
                        previous = 0;
                    var fragment = document.createDocumentFragment();
                    while ((match = pattern.exec(text))) {
                        fragment.appendChild(
                            document.createTextNode(
                                text.substring(previous, match.index)
                            )
                        );
                        var token = document.createElement("bdi");
                        token.setAttribute("dir", "ltr");
                        token.className = "localized-token";
                        token.textContent = match[0];
                        fragment.appendChild(token);
                        previous = match.index + match[0].length;
                    }
                    if (previous) {
                        fragment.appendChild(
                            document.createTextNode(text.substring(previous))
                        );
                        parent.replaceChild(fragment, child);
                    }
                } else if (child.nodeType === 1) isolate(child);
                child = next;
            }
        };
        isolate(content);
    }
    return (
        '<div class="localized-text' +
        (centered ? " localized-centered" : "") +
        '" dir="' +
        direction +
        '">' +
        content.innerHTML +
        "</div>"
    );
}

/**
 * Show a temporary notification/message at the bottom of the screen (the `#info` element).
 * Auto-hides after 3 seconds.
 *
 * @param message - HTML string to display.
 * @returns void
 * @sideeffect Replaces the per-element timer and hides `#info` after 3000ms.
 */
export function showShift(message: string): void {
    var info: any = document.getElementById("info");
    if (!info) return;
    clearTimeout(info.__ottShiftTimer);
    info.innerHTML = localizedTextHtml(message);
    info.style.display = "block";
    info.__ottShiftTimer = setTimeout(function () {
        info.style.display = "none";
    }, 3000);
}

/**
 * Show a modal info dialog box with a single OK button.
 * Any key press dismisses it.
 *
 * @param message - HTML string for the dialog body.
 * @returns void
 * @sideeffect Shows `#dialogbox` with the message and an ENTER button. Registers a one-shot `dialogBoxKeyHandler`.
 */
export function infoBox(message: string): void {
    $("#dialogbox")
        .html(
            '<div id="dialogMessage">' +
                localizedTextHtml(message) +
                "</div><br/><br/>" +
                renderButtonHint(keys.ENTER, strENTER, "Ok")
        )
        .show();
    (window as any).__ottClassicScreenPort.setOwnedCallback(
        "dialog",
        function (_e: number): void {
            $("#dialogbox").hide();
            (window as any).dialogBoxKeyHandler = null;
        }
    );
}

/**
 * Show a confirmation dialog with Yes (ENTER) and No (RETURN) buttons.
 * Calls the appropriate callback based on the user's key press.
 *
 * @param message - Text with newlines or attribute-free `<br>` tags for line breaks.
 * @param onYes - Callback invoked when ENTER is pressed.
 * @param onNo - Optional callback invoked for any non-ENTER key, including No/RETURN.
 * @param acceptAfterMs - Optional delay before accepting an unanswered dialog.
 * @returns void
 * @sideeffect Shows `#dialogbox`. Registers a one-shot `dialogBoxKeyHandler` that hides the box and calls the callback.
 */
export function confirmBox(
    message: string,
    onYes: () => void,
    onNo?: () => void,
    acceptAfterMs?: number
): void {
    var w = window as any;
    var wasPlaying =
        typeof w.stbIsPlaying === "function" ? !!w.stbIsPlaying() : false;
    // Preserve legacy cancellation on any non-ENTER key; expose No for touch users.
    $("#dialogbox")
        .html(
            '<center><div id="dialogMessage">' +
                // Preserve line breaks without interpreting other message HTML.
                localizedTextHtml(
                    metadataText(_(message)).replace(
                        /&lt;br\s*\/?&gt;|\r\n?|\n/gi,
                        "<br/>"
                    ),
                    true
                ) +
                "</div><br/><br/>" +
                renderButtonHint(keys.ENTER, strENTER, "Yes") +
                renderButtonHint(keys.RETURN, strRETURN, "No") +
                "</center>"
        )
        .show();
    var handler = w.__ottClassicScreenPort.setOwnedCallback(
        "dialog",
        function (e: number): void {
            $("#dialogbox").hide();
            w.dialogBoxKeyHandler = null;
            if (e === keys.ENTER) {
                if (onYes) onYes();
            } else {
                // Esc/RETURN must not leave video frozen (stbPause / overlay).
                if (
                    wasPlaying &&
                    typeof w.stbContinue === "function" &&
                    typeof w.stbIsPlaying === "function" &&
                    !w.stbIsPlaying()
                )
                    w.stbContinue();
                if (typeof onNo === "function") onNo();
            }
        }
    );
    if (acceptAfterMs && acceptAfterMs > 0 && isFinite(acceptAfterMs)) {
        var timer = setTimeout(function () {
            handler(keys.ENTER);
        }, acceptAfterMs);
        handler.owner.own(function () {
            clearTimeout(timer);
        });
    }
}

export function showSelectBox(
    selected: number,
    labels: string[],
    choose: (value: number) => void,
    timeout?: number,
    preserveParent = false
): void {
    var w = window as any;
    clearTimeout(w.numTimeout);
    if (!labels.length) return;
    if (labels.length === 1) {
        showShift(labels[0]);
        return;
    }
    var delay = timeout === undefined ? 3000 : timeout;
    var immediate = !!delay && delay !== -1;
    var commitOnTimeout = delay === 0;
    var focus = selected;
    var owner: ScreenOwner;
    var timer: any = null;
    if (preserveParent) {
        $("#list_osd").hide();
        $("#list_window").hide();
        if (listElement) listElement.style.display = "none";
    } else closeList();
    var port = w.__ottClassicScreenPort;
    function finish(commit: boolean) {
        if (!owner || !owner.foreground()) return;
        port.close("picker");
        if (channelNumberElement) channelNumberElement.style.display = "none";
        if (preserveParent && port.listOwner() && port.listOwner().active())
            showPage();
        if (commit) choose(focus);
    }
    function render(value: number) {
        if (!owner.active()) return;
        focus = (value + labels.length) % labels.length;
        owner.model.focus = focus;
        if (immediate) choose(focus);
        if (!owner.active()) return;
        if (channelNumberElement) {
            channelNumberElement.innerHTML = "";
            labels.forEach(function (label, index) {
                var row = document.createElement("div");
                row.setAttribute("role", "button");
                row.setAttribute("aria-pressed", String(index === focus));
                row.tabIndex = index === focus ? 0 : -1;
                row.innerHTML =
                    "&nbsp;&nbsp;" + metadataHtml(label) + "&nbsp;&nbsp;";
                if (index === focus) {
                    row.style.color = w.curColor;
                    row.style.backgroundColor = w.curColorB;
                }
                // Native CSP rejects inline handlers/styles; consume the click
                // before the video surface can open its menu underneath us.
                row.onclick = function (event) {
                    event.stopPropagation();
                    if (owner.foreground()) w._doKey(-100 + index, event);
                };
                row.onkeydown = function (event) {
                    if (
                        owner.foreground() &&
                        (event.keyCode === 13 || event.keyCode === 32)
                    ) {
                        event.preventDefault();
                        row.onclick!(event as any);
                    }
                };
                channelNumberElement!.appendChild(row);
            });
            channelNumberElement.style.display = "";
        }
        clearTimeout(timer);
        if (delay > 0 || commitOnTimeout)
            timer = setTimeout(
                owner.guard(function () {
                    finish(commitOnTimeout);
                }),
                delay > 0 ? delay : 2000
            );
        w.numTimeout = timer;
    }
    var pickerInput = port.setOwnedCallback(
        "picker",
        function (code: number): boolean {
            clearTimeout(timer);
            if (code === keys.ENTER) finish(!immediate);
            else if (code === keys.RETURN || code === keys.EXIT) finish(false);
            else if (code === keys.UP) render(focus - 1);
            else if (code === keys.DOWN) render(focus + 1);
            else if (code === keys.LEFT) render(0);
            else if (code === keys.RIGHT) render(labels.length - 1);
            else if (code + 100 >= 0 && code + 100 < labels.length) {
                if (code + 100 === focus) finish(!immediate);
                else render(code + 100);
            }
            return true;
        }
    );
    owner = pickerInput.owner;
    if (!owner || !owner.active()) return;
    owner.own(function () {
        clearTimeout(timer);
    });
    render(immediate ? selected + 1 : selected);
}

/**
 * Update all channel-info UI elements (number, name, picon, current program, progress bar, next program).
 * Called periodically or when the channel changes.
 *
 * @param channelId - The channel identifier from `curList[primaryIndex]`.
 * @returns void — early return if channelId is null/undefined or doesn't match the current primary channel.
 * @sideeffect Modifies innerHTML/textContent/style of many DOM elements: channel_number, channel_name, picon,
 *             programm_name, programm_name2, programm_descr, programm_duration, begin_time, end_time,
 *             nprogramm_name, nbegin_time, nend_time, progress, progress_r, progress_div.
 *             Sets `window._prog100` to the current EPG program or 0.
 * @analysis If EPG data (name/time/time_to) exists on the channel object, it renders current and next program info.
 *             Otherwise clears all program fields. When the channel is unavailable, shows "Channel is not available!!!".
 *             Progress percentage is clamped to 0-100.
 */

/**
 * Virtual timeshift window when EPG is missing: 1 hour lookback on the left,
 * live playhead at ~80% (15 min headroom on the right).
 */
export function virtualTimeshiftProg(nowSec?: number): {
    name: string;
    descr: string;
    time: number;
    time_to: number;
} {
    var now = nowSec != null ? nowSec : Date.now() / 1000;
    var lookback = 3600;
    var fill = 0.8;
    var total = lookback / fill;
    return {
        descr: "",
        name: "",
        time: now - lookback,
        time_to: now - lookback + total,
    };
}

export function updateChannelInfo(channelId: number): void {
    // A retained live guide subscription can fire during archive or VOD.
    // Those modes own their programme, playhead and footer rendering.
    var host = window as any;
    // Local files retain channel navigation, but enter finite playback before
    // this first repaint. Their current channel still owns the filename.
    var localFile =
        host.__ottActiveProviderDriver?.id === "offline" && host.playType < 0;
    if (channelId == null || (host.playType && !localFile)) return;
    if (
        localFile &&
        typeof host.__ottClassicPlayback?.programme === "function"
    ) {
        updateMediaInfo();
        return;
    }
    if (localFile) {
        var playback = host.__ottClassicPlayback;
        var state = playback && playback.snapshot();
        if (
            !state ||
            !state.target ||
            !state.historyTarget ||
            state.target.channelId !== "channel:" + channelId ||
            state.historyTarget.channelId !== String(channelId) ||
            state.target.sourceId !== playback.sourceId()
        )
            return;
    }
    var curList = (window as any).curList || [];
    var primaryIndex = (window as any).primaryIndex;
    if (channelId !== curList[primaryIndex]) return;
    var channelNumEl = document.getElementById("channel_number");
    var channelNameEl = document.getElementById("channel_name");
    var piconEl = document.getElementById("picon");
    var programNameEl = document.getElementById("programm_name");
    var programName2El = document.getElementById("programm_name2");
    var programDescrEl = document.getElementById("programm_descr");
    var programDurationEl = document.getElementById("programm_duration");
    var beginTimeEl = document.getElementById("begin_time");
    var endTimeEl = document.getElementById("end_time");
    var nextProgramNameElement = document.getElementById("nprogramm_name");
    var nbeginTimeEl = document.getElementById("nbegin_time");
    var nendTimeEl = document.getElementById("nend_time");
    var progressEl = document.getElementById("progress");
    var progressREl = document.getElementById("progress_r");
    var progressDivEl = document.getElementById("progress_div");

    // Channel number
    if (channelNumEl)
        channelNumEl.innerHTML =
            "" + ((primaryIndex != null ? primaryIndex : -1) + 1);

    // Channel info from global channels
    var t = (window as any).channels
        ? (window as any).channels[channelId]
        : undefined;
    if (t) {
        if (channelNameEl) channelNameEl.textContent = t.channel_name || "";
        if (piconEl)
            piconEl.style.backgroundImage =
                typeof (window as any).getChannelPicon === "function"
                    ? 'url("' +
                      metadataCssUrl(
                          (window as any).getChannelPicon(channelId)
                      ) +
                      '")'
                    : t.logo
                      ? 'url("' + metadataCssUrl(t.logo) + '")'
                      : "";
    } else {
        if (channelNameEl)
            channelNameEl.innerHTML =
                (typeof _ === "function"
                    ? _("Channel is not available!!!")
                    : "N/A") +
                " id=" +
                channelId;
        if (piconEl) piconEl.style.backgroundImage = 'url("")';
    }

    // Reset progress & next program
    if (progressDivEl)
        progressDivEl.style.backgroundColor = "rgba(68,68,102,0.55)";
    if (progressREl) progressREl.style.width = "0%";
    if (nextProgramNameElement) nextProgramNameElement.innerHTML = "&nbsp; ";
    if (nbeginTimeEl) nbeginTimeEl.textContent = "";
    if (nendTimeEl) nendTimeEl.textContent = "";

    // EPG data — legacy stbPlayer.js:1258-1281 uses observeCurrentProgramme return,
    // then always writes +remaining minutes and next-program duration.
    var hasProg =
        !localFile && observeCurrentProgramme(channelId, updateChannelInfo);
    if (hasProg && t && t.time_to) {
        // Has current EPG program
        if (programNameEl) programNameEl.textContent = t.name;
        if (programName2El) programName2El.textContent = t.name;
        (window as any)._prog100 = t;
        var nowSec = Date.now() / 1000;
        var pct = ((nowSec - t.time) / (t.time_to - t.time)) * 100;
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        if (progressEl) progressEl.style.width = pct + "%";
        if (beginTimeEl) beginTimeEl.textContent = time2time(t.time);
        // Legacy: $("#end_time").text("+" + Math.round((t.time_to - Date.now()/1e3)/60))
        if (endTimeEl)
            endTimeEl.textContent = "+" + Math.round((t.time_to - nowSec) / 60);
        if (programDurationEl) {
            programDurationEl.innerHTML =
                formatProgramDateTime(t.time) +
                " - " +
                time2time(t.time_to) +
                ' (<span id="cur_time">' +
                Math.round((nowSec - t.time) / 60) +
                "/</span>" +
                Math.round((t.time_to - t.time) / 60) +
                " " +
                (typeof _ === "function" ? _("min") : "min") +
                ")";
        }
        if (programDescrEl) {
            programDescrEl.innerHTML =
                (typeof getThumbnail === "function"
                    ? getThumbnail(t.icon || t.logo)
                    : "") + metadataHtml(t.descr);
        }
        // Next program
        if (t.nextpr && t.nextpr.length) {
            if (nextProgramNameElement)
                nextProgramNameElement.textContent = t.nextpr[0].name;
            if (nbeginTimeEl)
                nbeginTimeEl.textContent = time2time(t.nextpr[0].time);
            var nextDur = Math.round(
                (t.nextpr[0].time_to - t.nextpr[0].time) / 60
            );
            // Legacy: $("#nend_time").text(Math.round((next.time_to - next.time)/60))
            if (nendTimeEl) nendTimeEl.textContent = "" + nextDur;
        }
    } else {
        // No current EPG program
        var wAny = window as any;
        var canTimeshift = t && t.rec && Number(t.rec) > 0;
        if (canTimeshift) {
            // Live + catchup available, no EPG: 1h lookback, live at ~80%
            var _p = virtualTimeshiftProg();
            wAny._prog100 = _p;
            var nowSec2 = Date.now() / 1000;
            var dur = _p.time_to - _p.time;
            var pct2 = dur > 0 ? ((nowSec2 - _p.time) / dur) * 100 : 80;
            if (pct2 < 0) pct2 = 0;
            if (pct2 > 100) pct2 = 100;
            if (progressEl) progressEl.style.width = pct2 + "%";
            var remPct2 =
                _p.time_to > nowSec2
                    ? Math.min(
                          100,
                          Math.max(0, ((_p.time_to - nowSec2) / dur) * 100)
                      )
                    : 0;
            if (progressREl) progressREl.style.width = remPct2 + "%";
            if (progressDivEl) progressDivEl.style.backgroundColor = "#600";
            if (beginTimeEl) beginTimeEl.textContent = time2time(_p.time);
            var remMin2 = Math.round((_p.time_to - nowSec2) / 60);
            if (endTimeEl)
                endTimeEl.textContent = "+" + (remMin2 > 0 ? remMin2 : 0);
            if (programNameEl) programNameEl.innerHTML = "&nbsp; ";
            if (programName2El) programName2El.innerHTML = "";
            if (programDurationEl) programDurationEl.textContent = "";
            if (programDescrEl) programDescrEl.textContent = "";
        } else {
            if (programNameEl) {
                if (localFile && t)
                    programNameEl.textContent = t.channel_name || "";
                else programNameEl.innerHTML = "&nbsp; ";
            }
            wAny._prog100 = 0;
            if (progressEl) progressEl.style.width = "0%";
            if (progressREl) progressREl.style.width = "0%";
            if (beginTimeEl) beginTimeEl.textContent = "";
            if (endTimeEl) endTimeEl.textContent = "";
            if (programName2El)
                programName2El.textContent =
                    localFile && t ? t.channel_name || "" : "";
            if (programDurationEl) programDurationEl.textContent = "";
            if (programDescrEl) programDescrEl.textContent = "";
        }
    }
    // A repaint is not a programme change. Keep the last accepted identity
    // through guide misses so a refresh or periodic tick cannot reopen the bar.
    try {
        var w = window as any;
        var programmeKey =
            hasProg && t
                ? JSON.stringify([
                      w.__ottClassicGuide ? w.__ottClassicGuide.source() : "",
                      channelId,
                      t.time,
                  ])
                : "";
        var previous = w.__ottChannelInfoProgramme;
        var changed =
            programmeKey &&
            (!previous || previous.row !== t || previous.key !== programmeKey);
        if (programmeKey)
            w.__ottChannelInfoProgramme = { key: programmeKey, row: t };
        if (
            w.sInfoChange &&
            changed &&
            $infoBar &&
            typeof $infoBar.is === "function" &&
            !$infoBar.is(":visible") &&
            typeof w.showChannelInfo === "function"
        ) {
            w.showChannelInfo(1);
        }
    } catch (_info) {}
}

/**
 * Zero-pad a number to two digits for time display.
 *
 * @param n - A number (0-99 typically).
 * @returns string — Two-digit string, e.g. "05" or "12".
 */
function _t2(n: number): string {
    return n.toString().length === 1 ? "0" + n : "" + n;
}

/**
 * Start periodic timers:
 * 1. Every 1s — render clock displays and the backend-owned playback position.
 * 2. Every 30s — refresh channel info via `updateChannelInfo`.
 *
 * @returns void
 * @sideeffect Replaces the two owned intervals on restart. Updates DOM elements `current_t`,
 *             `current_s`, `list_t`, `list_s`, `permanentTime`. Reads backend-owned `window.playTime`.
 * @analysis Playback timing belongs to the backend; the 1s timer only renders it. The 30s timer keeps EPG data fresh.
 */
export function initBackgroundIntervals(): void {
    var host = window as any;
    var previous = host.__ottUiTimers;
    var owner: any = (host.__ottUiTimers = { clock: null, guide: null });
    if (previous) {
        clearInterval(previous.clock);
        clearInterval(previous.guide);
    }
    if (host.__ottStandby?.blocked()) return;
    function updateClockText(id: string, value: string): void {
        // Resolve the current node because menus can replace clock elements.
        var element = document.getElementById(id);
        if (element && element.textContent !== value)
            element.textContent = value;
    }
    owner.clock = setInterval(function () {
        if (host.__ottUiTimers !== owner) return;
        var now = new Date();
        var timeStr = _t2(now.getHours()) + ":" + _t2(now.getMinutes());
        var secStr = ":" + _t2(now.getSeconds());
        updateClockText("current_t", timeStr);
        updateClockText("current_s", secStr);
        updateClockText("list_t", timeStr);
        updateClockText("list_s", secStr);
        updateClockText("permanentTime", timeStr);
        // Drive archive OSD progress bar (stbPlayer.js:1744-1746 tick).
        // Skip live mode (playType === 0) — showChannelInfo already covers it.
        var w_t = window as any;
        if (
            w_t.playType > 0 &&
            typeof w_t.updateArchiveInfo === "function" &&
            typeof w_t.stbIsPlaying === "function" &&
            w_t.stbIsPlaying()
        ) {
            w_t.updateArchiveInfo(w_t.playType + (w_t.playTime || 0));
        } else if (
            w_t.playType < 0 &&
            typeof w_t.updateMediaInfo === "function"
        ) {
            w_t.updateMediaInfo();
        }
    }, 1000);
    owner.guide = setInterval(function () {
        if (host.__ottUiTimers !== owner) return;
        // Channel EPG must not replace the movie title/progress during VOD.
        if (
            !(window as any).playType &&
            typeof (window as any).updateChannelInfo === "function"
        ) {
            (window as any).updateChannelInfo(
                ((window as any).curList || [])[(window as any).primaryIndex]
            );
        }
    }, 30000);
}

/** Keep clock labels separate from decoder-relative seek/progress coordinates. */
function finiteProgrammeClock(timestamp: number | null): string {
    if (typeof timestamp !== "number" || !isFinite(timestamp) || timestamp <= 0)
        return "";
    var date = new Date(timestamp * 1000);
    if (!isFinite(date.getTime())) return "";
    return (
        formatTwoDigits(date.getHours()) +
        ":" +
        formatTwoDigits(date.getMinutes()) +
        ":" +
        formatTwoDigits(date.getSeconds())
    );
}

/** Render owned current/next metadata and decoder-relative progress in the shared footer. */
export function updateMediaInfo(): void {
    var w = window as any;
    if (w.playType < 0) {
        var ownedProgramme =
            typeof w.__ottClassicPlayback?.programme === "function";
        var programme = ownedProgramme
            ? w.__ottClassicPlayback.programme()
            : null;
        if (ownedProgramme) {
            // Null means the old source/selection no longer owns the footer.
            $("#channel_name").text(programme ? programme.collection : "");
            $("#programm_name").text(programme ? programme.title : "");
            $("#programm_name2").text(programme ? programme.title : "");
            $("#nprogramm_name").text(
                programme ? programme.nextTitle || "" : ""
            );
            $("#begin_time").text(
                finiteProgrammeClock(programme && programme.startedAt)
            );
            $("#nbegin_time").text(
                finiteProgrammeClock(
                    programme && programme.nextTitle
                        ? programme.nextStartedAt
                        : null
                )
            );
            $("#nend_time").text("");
            $("#programm_duration").text("");
            if (!programme || w.__ottActiveProviderDriver?.id === "offline")
                $("#programm_descr").text("");
            w._prog100 = 0;
        }
        var position = programme
            ? Math.max(0, Number(programme.position) || 0)
            : typeof w.stbGetPosTime === "function"
              ? Math.max(0, Number(w.stbGetPosTime()) || 0)
              : 0;
        var duration = programme
            ? Number(programme.duration)
            : typeof w.stbGetLen === "function"
              ? Number(w.stbGetLen())
              : 0;
        if (
            (!ownedProgramme || programme) &&
            duration > 0 &&
            isFinite(duration)
        ) {
            $("#progress").css(
                "width",
                Math.min(100, (position / duration) * 100) + "%"
            );
            if (!ownedProgramme)
                $("#begin_time").text(Math.round(position / 60));
            $("#end_time").text(
                "+" + Math.round(Math.max(0, duration - position) / 60)
            );
        } else if (ownedProgramme) {
            $("#progress").css("width", "0%");
            $("#end_time").text("");
        }
    }
    updateCoreVideoInfo();
    refreshAudioBadge();
}

/**
 * Show or hide the multi-audio badge in the video info bar.
 * Reads `stbAudioTracksExists()` from core and toggles `#audio_badge` visibility.
 *
 * @sideeffect Mutates `#audio_badge` display style.
 */
export function refreshAudioBadge(): void {
    var badge = document.getElementById("audio_badge");
    if (!badge) return;
    badge.title = _("Switch sound track") + " (S)";
    var hasMulti =
        typeof (window as any).stbAudioTracksExists === "function" &&
        (window as any).stbAudioTracksExists();
    badge.style.display = hasMulti ? "inline-block" : "none";
}

/**
 * Save the current list caption, footer, and detail elements into `ui_state` and clear them.
 * Used before showing a temporary overlay (e.g., info, edit, color dialog) so the state can be restored later.
 *
 * @returns void
 * @sideeffect Stores innerHTML of listCaptionElement, listFooterElement, listDetailElement in `ui_state` object.
 *             Clears the innerHTML of all three elements.
 */
export function saveListPanelState(): void {
    (window as any).__ottClassicScreenPort.savePanel({
        lc: listCaptionElement ? listCaptionElement.innerHTML : "",
        ld: listDetailElement ? listDetailElement.innerHTML : "",
        lp: listFooterElement ? listFooterElement.innerHTML : "",
    });
    if (listCaptionElement) listCaptionElement.innerHTML = "";
    if (listFooterElement) listFooterElement.innerHTML = "";
    if (listDetailElement) listDetailElement.innerHTML = "";
}

/**
 * Restore the list caption, footer, and detail elements from `ui_state` and reset the state object.
 *
 * @returns void
 * @sideeffect Restores innerHTML of listCaptionElement, listFooterElement, listDetailElement from saved values.
 *             Resets `ui_state` to an empty object.
 */
export function restoreListPanelState(): void {
    var ui_state = (window as any).__ottClassicScreenPort.restorePanel();
    if (!ui_state) return;
    if (listCaptionElement) listCaptionElement.innerHTML = ui_state.lc || "";
    if (listFooterElement) listFooterElement.innerHTML = ui_state.lp || "";
    if (listDetailElement) listDetailElement.innerHTML = ui_state.ld || "";
}

/**
 * Render an HTML snippet for a button hint (used in info bars and list footers).
 * The hint shows the key label, optional numeric/symbolic badge, color class, and translated description.
 *
 * @param keyLabel - The key code (used for color class and delegated dispatch).
 * @param label - The display label (e.g. HTML entity for arrow icon). Empty for color keys.
 * @param description - The button's function description text (passed through translate).
 * @param num - Optional numeric badge (e.g. "2", "8"). Hidden if sNoNumbersKeys is set.
 * @param extra - Optional extra badge text. Hidden if sNoNumbersKeys is set.
 * @returns string — HTML string for the button hint span. Returns empty string if description or keyLabel is falsy.
 * @analysis Color keys (RED/GREEN/YELLOW/BLUE) get a CSS class `.red`/`.green`/`.yellow`/`.blue` respectively.
 *             If both label and badges are empty, the description itself is wrapped in a plain `.btn` div.
 *             The data key is dispatched by the owning UI container.
 */
export function renderButtonHint(
    keyLabel: number,
    label: string,
    description: string,
    num?: string,
    extra?: string
): string {
    keyLabel = Number(keyLabel);
    if (!(description && keyLabel)) return "";
    description = metadataHtml(_(description));
    var cls = "btn";
    switch (keyLabel) {
        case keys.RED:
            cls += " red";
            if (!label) label = "&nbsp;";
            break;
        case keys.GREEN:
            cls += " green";
            if (!label) label = "&nbsp;";
            break;
        case keys.YELLOW:
            cls += " yellow";
            if (!label) label = "&nbsp;";
            break;
        case keys.BLUE:
            cls += " blue";
            if (!label) label = "&nbsp;";
            break;
    }
    if ((window as any).sNoNumbersKeys) {
        if ("0123456789".indexOf(num!) !== -1) num = undefined;
        if ("0123456789".indexOf(extra!) !== -1) extra = undefined;
    }
    var a = label
        ? '<div class="' + cls + '">' + metadataHtml(label) + "</div>&nbsp;"
        : "";
    if (
        (window as any).sNoColorKeys &&
        [keys.RED, keys.GREEN, keys.YELLOW, keys.BLUE].indexOf(keyLabel) !== -1
    )
        a = "";
    if (num) a += '<div class="btn">' + metadataHtml(num) + "</div>&nbsp;";
    if (extra) a += '<div class="btn">' + metadataHtml(extra) + "</div>&nbsp;";
    if (!a) description = '<div class="btn">' + description + "</div>";
    return (
        '<span role="button" tabindex="0" aria-label="' +
        metadataText(description.replace(/<[^<>]*>/g, " ")) +
        '" data-ott-key="' +
        keyLabel +
        '">' +
        a +
        description +
        "</span>&nbsp;&nbsp;"
    );
}

var detailTimer: any = null;
var detailScrollTimer: any = null;

/**
 * Debounced trigger for the detail-list action callback.
 * Clears any pending timeout, clears the detail element, then schedules `detailListActionFn` to run after 200ms.
 *
 * @returns void
 * @sideeffect Clears `detailTimer`. Clears `listDetailElement.innerHTML`. Calls `detailListActionFn` after delay.
 * @analysis This prevents rapid selection changes from producing excessive detail re-renders.
 */
function scheduleListDetailUpdate(): void {
    clearTimeout(detailTimer);
    clearTimeout(detailScrollTimer);
    if (listDetailElement) {
        var mediaControls = listDetailElement.firstChild as HTMLElement | null;
        if (
            mediaControls &&
            mediaControls.id === "mediaPlaybackControls" &&
            listKeyHandlerFn === mediaKeyHandler
        ) {
            // Keep the mode indicators visible while a row's details debounce.
            var description = listDetailElement.lastChild as HTMLElement | null;
            if (description && description.id === "_prd")
                description.innerHTML = "";
        } else listDetailElement.innerHTML = "";
    }
    var owner = (window as any).__ottClassicScreenPort.listOwner();
    if (!owner) return;
    if (owner.model.detailCleanup) owner.model.detailCleanup();
    var detail = detailListActionFn;
    var release = owner.own(function () {
        clearTimeout(timer);
        if (owner.model.detailCleanup === release)
            delete owner.model.detailCleanup;
    });
    owner.model.detailCleanup = release;
    var timer = setTimeout(
        owner.guard(function () {
            if (owner.model.detailCleanup !== release) return;
            release();
            if (owner.foreground() && detail) detail();
        }),
        200
    );
    detailTimer = timer;
}

/* ---------------------------------------------------------------------------
 * Time / position helpers
 * --------------------------------------------------------------------------- */

/**
 * Convert a Unix timestamp (seconds since epoch) to a "HH:MM:SS" time string.
 *
 * @param e - Unix timestamp in seconds.
 * @returns string — Formatted as "HH:MM:SS".
 */
export function formatClockTime(e: number): string {
    var t = new Date(e * 1e3);
    return (
        _t2(t.getHours()) +
        ":" +
        _t2(t.getMinutes()) +
        ":" +
        _t2(t.getSeconds())
    );
}

/**
 * Convert a time offset in seconds to a human-readable string like ">> 5 m 30 s" or "<< 2 m".
 * Positive values get ">> " prefix, negative get "<< " prefix.
 *
 * @param e - Offset in seconds (positive = forward, negative = backward).
 * @returns string — HTML string, or `&nbsp;` if offset is 0.
 */
export function formatSeekOffset(e: number): string {
    var t = Math.floor(Math.abs(e) / 60);
    var r = Math.abs(e) % 60;
    return !e
        ? "&nbsp;"
        : (e > 0 ? ">> " : "<< ") +
              (t ? t + _(" m ") : "") +
              (r ? r + _(" s") : "");
}

/**
 * Convert a Unix timestamp to a locale-formatted date+time string: "Su 12.05 14:30".
 * Day names are from the translations of "Su Mo Tu We Th Fr Sa".
 *
 * @param e - Unix timestamp in seconds.
 * @returns Escaped date and time in the selected interface locale.
 */
export function formatProgramDateTime(e: number): string {
    return metadataText(formatLocaleDateTime(e));
}

/* ---------------------------------------------------------------------------
 * Scroll helpers
 * --------------------------------------------------------------------------- */

/**
 * Initiate auto-scroll of the program description text.
 * Repositions the tooltip, resets description margin, calculates scroll distance, and starts the animation.
 *
 * @returns void
 * @sideeffect Calls `scrollUp()` which animates `#programm_descr` margin-top and schedules the animation.
 * @analysis The scroll distance is calculated as the overflow of description content beyond its container.
 */
export function scrollUpDescr(): void {
    var tooltip = document.getElementById("progress_span");
    var $progress_div = $("#progress_div");
    if (tooltip && tooltip.style.display) {
        tooltip.style.top =
            $progress_div.offset().top - $progress_div.height() + "px";
    }
    $("#programm_descr").stop(true).css("margin-top", 0);
    var e =
        $("#programm_descr").height() -
        $("#descr").height() +
        $("#programm_name2").height() +
        $("#programm_duration").height();
    scrollUp("programm_descr", e, 10000);
}

/**
 * Animate an element's `margin-top` upward by `px` pixels after a delay, for scrolling long content.
 *
 * @param el - The element ID (without `#`).
 * @param px - The number of pixels to scroll up.
 * @param delay - Delay in ms before starting the animation.
 * @returns void
 * @sideeffect Replaces the description animation timer. Uses jQuery `animate()` on the element.
 * @analysis The animation duration is `px * 80` milliseconds (linear). Only animates if `px > 0`.
 */
export function scrollUp(el: string, px: number, delay: number): void {
    // Playback descriptions may finish animating while a newly opened list is
    // waiting to render its details. Scrolling must not cancel that render.
    clearTimeout(detailScrollTimer);
    if (px > 0) {
        detailScrollTimer = setTimeout(function () {
            $("#" + el).animate({ "margin-top": "-=" + px }, px * 80);
        }, delay);
    }
}

/* ---------------------------------------------------------------------------
 * Info displays
 * --------------------------------------------------------------------------- */

/**
 * Show program info in the `#listAbout` overlay. Displays the title, description, and
 * buttons for TMDb search and close.
 *
 * @param title - The program title to display. If falsy, shows "no epg at current time" in an infoBox.
 * @returns void
 * @sideeffect Hides `listPopUp`. Calls `saveListPanelState()`. Sets caption/footer elements.
 *             Registers `aboutKeyHandler` for TMDb search and close. Shows `#listAbout`.
 */
export function showProgramInfo(title: string): void {
    if (!title) {
        infoBox(_("no epg at current time"));
        return;
    }
    $("#listPopUp").hide();
    saveListPanelState();
    if (listCaptionElement) listCaptionElement.textContent = title;
    if (listFooterElement) {
        var extra = "";
        if ((window as any).sArrowFun === 2) extra = strRIGHT;
        else if ((window as any).sRewFun === 1) extra = strFF;
        else if ((window as any).sPNFun === 1) extra = strNEXT;
        listFooterElement.innerHTML =
            renderButtonHint(keys.RETURN, strRETURN, "Close") +
            (title && hasTmdbService()
                ? renderButtonHint(keys.N2, strInfo, "TMDb", "2", extra)
                : "");
    }
    // Legacy stbPlayer.js:2251-2282 — TMDb keys search; any other key closes.
    (window as any).__ottClassicScreenPort.setOwnedCallback(
        "about",
        function (e: number): boolean {
            if (title) {
                switch (e) {
                    case keys.RIGHT:
                        if ((window as any).sArrowFun !== 2) break;
                    // fallthrough
                    case keys.N2:
                    case keys.INFO:
                        if (
                            hasTmdbService() &&
                            (window as any).TMDb &&
                            typeof (window as any).TMDb.search === "function"
                        )
                            (window as any).TMDb.search(title);
                        return true;
                    case keys.FF:
                        if ((window as any).sRewFun !== 1) break;
                        if (
                            hasTmdbService() &&
                            (window as any).TMDb &&
                            typeof (window as any).TMDb.search === "function"
                        )
                            (window as any).TMDb.search(title);
                        return true;
                    case keys.NEXT:
                        if ((window as any).sPNFun !== 1) break;
                        if (
                            hasTmdbService() &&
                            (window as any).TMDb &&
                            typeof (window as any).TMDb.search === "function"
                        )
                            (window as any).TMDb.search(title);
                        return true;
                }
            }
            restoreListPanelState();
            $("#listAbout").hide().text("");
            $("#_prd").css("margin-top", 0);
            if ((window as any).detailTimer)
                clearTimeout((window as any).detailTimer);
            aboutKeyHandler = null;
            return true;
        }
    );
    // Show the saved detail HTML (program description) in the about overlay.
    $("#listAbout")
        .html(
            '<div style="font-size:larger;">' +
                String(
                    (window as any).__ottClassicScreenPort.savedPanel().ld || ""
                ).replace(/\|/g, "<br/>") +
                "</div>"
        )
        .show();
    $("#_prd").css("margin-top", 0);
    $("#_nextpr").text("");
    var aboutH = ($("#listAbout").height() || 0) - ($("#_name").height() || 0);
    $("#_descr").height(aboutH > 0 ? aboutH : 0);
    var scrollPx = ($("#_prd").height() || 0) + 10 - aboutH;
    if (typeof (window as any).scrollUp === "function")
        (window as any).scrollUp("_prd", scrollPx, 10000);
}

/**
 * Show media item info in the `#listAbout` overlay. Displays the selected media item's
 * title and description with TMDb search and close buttons.
 *
 * @returns void — early return if the selected item has no description.
 * @sideeffect Hides `listPopUp`. Calls `saveListPanelState()`. Sets caption/footer elements.
 *             Registers `aboutKeyHandler` for TMDb search and close. Shows `#listAbout`.
 */
export function infoMedia(): void {
    var la = (window as any).listArray || [];
    var si = (window as any).selIndex || 0;
    var description = getMediaDescr(la[si]);
    if (!description) return;
    $("#listPopUp").hide();
    saveListPanelState();
    var t = la[si].title || "";
    if (listCaptionElement) listCaptionElement.textContent = t;
    if (listFooterElement) {
        var extra = "";
        if ((window as any).sArrowFun === 2) extra = strRIGHT;
        else if ((window as any).sRewFun === 1) extra = strFF;
        else if ((window as any).sPNFun === 1) extra = strNEXT;
        listFooterElement.innerHTML =
            renderButtonHint(keys.RETURN, strRETURN, "Close") +
            (t && hasTmdbService()
                ? renderButtonHint(keys.N2, strInfo, "TMDb", "2", extra)
                : "");
    }
    (window as any).__ottClassicScreenPort.setOwnedCallback(
        "about",
        function (e: number): boolean {
            if (t) {
                switch (e) {
                    case keys.RIGHT:
                        if ((window as any).sArrowFun !== 2) break;
                    // fallthrough
                    case keys.N2:
                    case keys.INFO:
                        if (
                            hasTmdbService() &&
                            (window as any).TMDb &&
                            typeof (window as any).TMDb.search === "function"
                        )
                            (window as any).TMDb.search(t);
                        return true;
                }
            }
            restoreListPanelState();
            $("#listAbout").hide().text("");
            aboutKeyHandler = null;
            return true;
        }
    );
    $("#listAbout")
        .html('<div id="_prd">' + description + "</div>")
        .show();
}

/**
 * Show the "Info" list — a generic list of information items with actions.
 * Populates the list from `window.infoArr`. Supports number-key and color-key shortcuts.
 *
 * @param e - Optional action name to pre-select. If provided, searches `infoArr` for a matching `.action` and selects it.
 * @returns void
 * @sideeffect Sets up `listDataArray`, `getListItemFn`, `detailListActionFn`, `listKeyHandlerFn`.
 *             Sets caption/footer. Calls `showPage()`.
 * @analysis Info items are rendered from `infoArr`; each has `.name` and `.action`. N2/INFO triggers pluginInfo.
 */
export function infoList(e?: string): void {
    var infoArr = (window as any).infoArr || [];
    listDataArray = [];
    infoArr.forEach(function (item: any) {
        listDataArray.push(_(item.name || ""));
    });
    if (!(window as any).sNoNumbersKeys) {
        prependMenuButtonHint(infoArr, (window as any).pluginInfo, "2");
        prependMenuButtonHint(infoArr, (window as any).betaPage, "8");
    }
    prependMenuButtonHint(infoArr, (window as any).pluginInfo, strInfo);
    selIndex = 0;
    if (typeof e !== "undefined") {
        for (var t = 0; t < infoArr.length; t++) {
            if (infoArr[t].action === e) {
                selIndex = t;
                break;
            }
        }
    }
    getListItemFn = function (item: any, _idx: number) {
        return "&nbsp;&nbsp;" + item;
    };
    detailListActionFn = function () {
        var arr = (window as any).infoArr || [];
        var item = arr[selIndex];
        if (item)
            listDetailElement!.innerHTML = _(item.desc || item.name || "");
    };
    listKeyHandlerFn = (window as any).__ottClassicScreenPort.ownListHandler(
        function (key: number): boolean {
            switch (key) {
                case keys.RETURN:
                    closeList();
                    return true;
                case keys.ENTER: {
                    var arr = (window as any).infoArr || [];
                    if (arr[selIndex] && arr[selIndex].action)
                        arr[selIndex].action();
                    return true;
                }
                case keys.N2:
                case keys.INFO:
                    if (typeof (window as any).pluginInfo === "function")
                        (window as any).pluginInfo();
                    return true;
            }
            return false;
        }
    );
    // Sync listArray and window variables for consistency with legacy
    listArray = listDataArray;
    (window as any).listDataArray = listDataArray;
    (window as any).listArray = listArray;
    if (listCaptionElement) listCaptionElement.innerHTML = _("Info");
    if (listFooterElement)
        listFooterElement.innerHTML = renderButtonHint(
            keys.RETURN,
            strRETURN,
            "Close"
        );
    showPage();
}

/* ---------------------------------------------------------------------------
 * Popup menu
 * --------------------------------------------------------------------------- */

/**
 * Show (or execute a specific action from) the popup menu.
 * Builds the full popup list from `window.popupActions`, filtering hidden items, adding
 * numeric/color/symbolic button labels, and registering key handlers.
 *
 * @param i - Optional: a numerical index (1-based) or action function to execute directly.
 *             If 0 or undefined, the full popup list is displayed.
 * @returns void
 * @sideeffect Hides `#listAbout` if visible and restores CPD. Builds `listArray` and `listDataArray`.
 *             Registers `listKeyHandlerFn` for all popup interactions. Shows `#list_window` and calls `showPage()`.
 * @analysis Items are filtered by `sHideMenus` array. Behavior switches (e.g. play/pause toggle) use `splitSlash` to
 *             show the active label. Number-key and color-key bindings are added conditionally based on settings.
 *             PIN-check items (toggleProviderSettingsVisibility) toggle `window.providerSettingsUnlockCount`.
 */
export function popupList(i?: any): void {
    var w = window as any;
    $("#dialogbox").hide();
    $("#buffering").hide();
    w.__ottClassicScreenPort.close("dialog");
    if ($("#listAbout").is(":visible")) {
        $("#listAbout").hide();
        restoreListPanelState();
    }
    var menu = w.__ottMenuRegistry.open(w, i);
    listArray = menu.rows;
    listDataArray = menu.rows;
    selIndex = menu.focus;
    getListItemFn = function (item: any) {
        return "&nbsp;&nbsp;" + item.name;
    };
    detailListActionFn = function () {
        var item = listArray[selIndex];
        if (item && listDetailElement) listDetailElement.innerHTML = item.desc;
        if (item && item.id === "provider.unlock")
            w.providerSettingsUnlockCount = 0;
    };
    listKeyHandlerFn = (window as any).__ottClassicScreenPort.ownListHandler(
        function (key: any): boolean {
            var code = typeof key === "number" ? key : key.keyCode;
            if (code === keys.RETURN) {
                closeList();
                return true;
            }
            if (code === keys.ENTER) {
                var row = listArray[selIndex];
                if (row) menu.invoke(row.id);
                return true;
            }
            var command = menu.command(code);
            if (!command) return false;
            menu.invoke(command);
            return true;
        }
    );
    if (listCaptionElement) listCaptionElement.innerHTML = _("Menu");
    if (listFooterElement)
        listFooterElement.innerHTML = renderButtonHint(
            keys.RETURN,
            strRETURN,
            "Close"
        );
    $("#list_window").show();
    if (typeof w.stbSetWindow === "function") w.stbSetWindow();
    w.__ottClassicScreenPort.commitList();
    showPage();
}

/* ---------------------------------------------------------------------------
 * Pop* shortcuts
 * --------------------------------------------------------------------------- */

/**
 * Shortcut: delegate to `window.bucketsList(catIndex)`.
 *
 * @returns void
 * @sideeffect Calls `window.bucketsList` with the current category index.
 */
export function popBuckets(): void {
    if (typeof (window as any).bucketsList === "function")
        (window as any).bucketsList((window as any).catIndex);
}

/**
 * Shortcut: delegate to `window.epgList(catIndex, primaryIndex, false)`.
 *
 * @returns void
 * @sideeffect Calls `window.epgList` with current category and primary indices.
 */
export function popEpg(): void {
    if (typeof (window as any).epgList === "function")
        (window as any).epgList(
            (window as any).catIndex,
            (window as any).primaryIndex,
            false
        );
}

/**
 * Shortcut: delegate to `window.recordsList(catIndex, primaryIndex, false)`.
 *
 * @returns void
 * @sideeffect Calls `window.recordsList` with current category and primary indices.
 */
export function popRecords(): void {
    if (typeof (window as any).recordsList === "function")
        (window as any).recordsList(
            (window as any).catIndex,
            (window as any).primaryIndex,
            false
        );
}

/**
 * Shortcut: delegate to `window.mediaList(null)` if both `getMediaArray` and `mediaList` are available.
 *
 * @returns void
 * @sideeffect Calls `window.mediaList(null)`.
 */
export function popMedia(): void {
    var host = window as any;
    if (host.__ottMedia && host.__ottMedia.useSource)
        host.__ottMedia.useSource(null);
    if (host.__ottActiveProviderDriver?.capabilities?.mediaPlaylist) {
        host.channelsList(host.catIndex, host.primaryIndex);
        return;
    }
    if (
        typeof (window as any).getMediaArray === "function" &&
        typeof (window as any).mediaList === "function"
    )
        (window as any).mediaList(null);
}

/**
 * Shortcut: close the list and show the previous-programs selector.
 *
 * @returns void
 * @sideeffect Calls `closeList()` then `window.prevProg()`.
 */
export function popPrevProg(): void {
    closeList();
    if (typeof (window as any).prevProg === "function")
        (window as any).prevProg();
}

/**
 * Shortcut: close the list and open the timeshift/archive selector at offset 0.
 *
 * @returns void
 * @sideeffect Calls `closeList()` then `window.showPlaybackSeekDialog(0)`.
 */
export function popShift(): void {
    closeList();
    if (typeof (window as any).showPlaybackSeekDialog === "function")
        (window as any).showPlaybackSeekDialog(0);
}

/**
 * Shortcut: close the list and dispatch N0 key (play/pause toggle).
 *
 * @returns void
 * @sideeffect Calls `closeList()` then `window._doKey(keys.N0)`.
 */
export function popPause(): void {
    closeList();
    if (typeof (window as any)._doKey === "function")
        (window as any)._doKey((window as any).keys.N0);
}

/**
 * Shortcut: close the list and dispatch STOP key.
 *
 * @returns void
 * @sideeffect Calls `closeList()` then `window._doKey(keys.STOP)`.
 */
export function popStop(): void {
    closeList();
    if (typeof (window as any)._doKey === "function")
        (window as any)._doKey((window as any).keys.STOP);
}

/**
 * Shortcut: close the list and toggle PiP.
 *
 * @returns void
 * @sideeffect Checks access, then closes the list and toggles PiP.
 */
export function popTogglePip(): void {
    togglePip(true);
}

/**
 * Shortcut: stop PiP (clear pipIndex, call stbStopPip) and close the list.
 *
 * @returns void
 * @sideeffect Sets `window.pipIndex = null`. Calls `window.stbStopPip()`. Calls `closeList()`.
 */
export function popStopPip(): void {
    (window as any).pipIndex = null;
    if (typeof (window as any).stbStopPip === "function")
        (window as any).stbStopPip();
    closeList();
}

/* ---------------------------------------------------------------------------
 * Volume / mute / pip
 * --------------------------------------------------------------------------- */

/**
 * Change the volume by a relative delta, clamped to [0, 100].
 *
 * @param delta - Signed integer to add to the current volume.
 * @returns void — early return if `stbGetVolume` is not a function.
 * @sideeffect Calls `window.stbGetVolume()`, `window.stbSetVolume()`, and `_showVolume()`.
 */
export function changeVolume(delta: number): void {
    if (typeof (window as any).stbGetVolume !== "function") return;
    var t = (window as any).stbGetVolume() + delta;
    t = Math.max(t, 0);
    t = Math.min(t, 100);
    if (typeof (window as any).stbSetVolume === "function")
        (window as any).stbSetVolume(t);
    _showVolume(t);
}

/**
 * Show the volume indicator overlay with the given level and auto-hide after 2 seconds.
 *
 * @param v - Volume level (0-100).
 * @returns void
 * @sideeffect Sets `#volume` height percentage. Shows `#volume_div`. Hides `#mute`. Sets a 2s timeout to hide.
 */
function _showVolume(v: number): void {
    $("#volume").css("height", v + "%");
    $("#volume_div").show();
    $("#mute").hide();
    clearTimeout(volumeTimeout);
    volumeTimeout = setTimeout(function () {
        $("#volume_div").hide();
    }, 2000);
}

/** Check the selected channel before any PiP state or playback changes. */
function withPipChannelAccess(
    category: number,
    index: number,
    onAllowed: (channelId: number) => void
): void {
    var w = window as any;
    var categoryName = w.catsArray[category];
    var list = w.cats[categoryName];
    var channelId = list && list[index];
    var channel = channelId != null && w.channels[channelId];
    if (!channel || typeof w.stbPlayPip !== "function") return;
    function resume(): void {
        // A PIN dialog can outlive a provider reload or category edit. Never
        // use the old index to start a replacement channel after authorizing.
        if (
            w.catsArray[category] !== categoryName ||
            !w.cats[categoryName] ||
            w.cats[categoryName][index] !== channelId ||
            w.channels[channelId] !== channel
        )
            return;
        if (ifParentalAccessChId(channelId, resume)) return;
        onAllowed(channelId);
    }
    resume();
}

/** Start or restore PiP only after checking access to its channel ID. */
export function playPipChannel(
    category: number,
    index: number,
    closeOverlay = false
): void {
    var w = window as any;
    withPipChannelAccess(category, index, function (channelId) {
        if (closeOverlay) closeList(false);
        w.pipCatIndex = category;
        w.pipIndex = index;
        w.stbPlayPip(w.getChannelUrl(channelId));
    });
}

/** Start PiP, or exchange the main and PiP channels after authorizing both. */
export function togglePip(closeOverlay = false): void {
    var w = window as any;
    var mainCategory = w.catIndex;
    var mainIndex = w.primaryIndex;
    if (w.pipIndex == null) {
        playPipChannel(mainCategory, mainIndex, closeOverlay);
        return;
    }
    var oldPipCategory = w.pipCatIndex;
    var oldPipIndex = w.pipIndex;
    if (oldPipCategory === mainCategory && oldPipIndex === mainIndex) {
        if (closeOverlay) closeList(false);
        return;
    }
    withPipChannelAccess(
        oldPipCategory,
        oldPipIndex,
        function (oldPipChannelId) {
            var oldPipChannel = w.channels[oldPipChannelId];
            var oldPipCategoryName = w.catsArray[oldPipCategory];
            withPipChannelAccess(
                mainCategory,
                mainIndex,
                function (mainChannelId) {
                    if (
                        w.pipCatIndex !== oldPipCategory ||
                        w.pipIndex !== oldPipIndex ||
                        w.catIndex !== mainCategory ||
                        w.primaryIndex !== mainIndex ||
                        w.catsArray[oldPipCategory] !== oldPipCategoryName ||
                        !w.cats[oldPipCategoryName] ||
                        w.cats[oldPipCategoryName][oldPipIndex] !==
                            oldPipChannelId ||
                        w.channels[oldPipChannelId] !== oldPipChannel
                    )
                        return;
                    if (closeOverlay) closeList(false);
                    w.pipCatIndex = mainCategory;
                    w.pipIndex = mainIndex;
                    w.playChannel(oldPipCategory, oldPipIndex);
                    w.stbPlayPip(w.getChannelUrl(mainChannelId));
                }
            );
        }
    );
}

/* ---------------------------------------------------------------------------
 * Color dialogs
 * --------------------------------------------------------------------------- */

/**
 * Convert HSV color values to RGB.
 *
 * @param h - Hue (0-360).
 * @param s - Saturation (0-100).
 * @param v - Value / brightness (0-100).
 * @returns number[] — Array of [R, G, B] each in range 0-255.
 * @analysis All inputs are clamped to their valid range before conversion.
 */
export function hsvToRgb(h: number, s: number, v: number): number[] {
    h = Math.max(0, Math.min(360, h));
    s = Math.max(0, Math.min(100, s));
    v = Math.max(0, Math.min(100, v));
    s /= 100;
    v /= 100;
    if (s === 0) {
        var g = Math.round(v * 255);
        return [g, g, g];
    }
    h /= 60;
    var a = Math.floor(h);
    var o = h - a;
    var l = v * (1 - s);
    var c = v * (1 - s * o);
    var u = v * (1 - s * (1 - o));
    var r: number, g2: number, b: number;
    switch (a) {
        case 0:
            r = v;
            g2 = u;
            b = l;
            break;
        case 1:
            r = c;
            g2 = v;
            b = l;
            break;
        case 2:
            r = l;
            g2 = v;
            b = u;
            break;
        case 3:
            r = l;
            g2 = c;
            b = v;
            break;
        case 4:
            r = u;
            g2 = l;
            b = v;
            break;
        default:
            r = v;
            g2 = l;
            b = c;
            break;
    }
    return [Math.round(r * 255), Math.round(g2 * 255), Math.round(b * 255)];
}

/** Share HSV input while each public dialog owns its layout and setting. */
function bindColorDialogInput(
    hue: number,
    saturation: number,
    value: number,
    cssProperty: string,
    settingKey: string
): void {
    function preview(): void {
        var rgb = hsvToRgb(hue, saturation, value);
        $("#step").css(
            cssProperty,
            "rgb(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ")"
        );
    }
    (window as any).__ottClassicScreenPort.setOwnedCallback(
        "about",
        function (key: number): boolean {
            switch (key) {
                case keys.UP:
                    saturation = Math.min(saturation + 5, 100);
                    break;
                case keys.DOWN:
                    saturation = Math.max(saturation - 5, 0);
                    break;
                case keys.RIGHT:
                    hue += 10;
                    if (hue > 360) hue = 0;
                    break;
                case keys.LEFT:
                    hue -= 10;
                    if (hue < 0) hue = 360;
                    break;
                case keys.YELLOW:
                    hue = 50;
                    saturation = 85;
                    break;
                case keys.GREEN:
                    hue = 90;
                    saturation = 85;
                    break;
                case keys.BLUE:
                    hue = 180;
                    saturation = 85;
                    break;
                case keys.ENTER:
                    (window as any)[settingKey] = hue + "," + saturation;
                case keys.RETURN:
                    $("#listAbout").text("").hide();
                    restoreListPanelState();
                    return true;
                default:
                    return false;
            }
            preview();
            return true;
        }
    );
    preview();
}

/** Share color-picker layout without changing the public dialog identities. */
function showColorDialog(
    settingKey: string,
    fallback: string,
    caption: string,
    value: number,
    foreground = false
): void {
    var setting = (window as any)[settingKey] || fallback;
    var hue = Number.parseInt(setting.split(",")[0]);
    var saturation = Number.parseInt(setting.split(",")[1]);
    saveListPanelState();
    if (listCaptionElement) listCaptionElement.innerHTML = caption;
    if (listFooterElement)
        listFooterElement.innerHTML =
            renderButtonHint(keys.RETURN, strRETURN, "Close") +
            renderButtonHint(keys.ENTER, strENTER, "Set");
    if (listDetailElement) listDetailElement.innerHTML = "";
    var preview = foreground
        ? '<span id="step" style="font-size: 150%;">&nbsp;1234567890&nbsp;<span style="background-color:' +
          (window as any).curColorB +
          '">&nbsp;1234567890&nbsp;</span></span>'
        : '<span id="step" style="font-size: 150%;background-color:' +
          (window as any).curColorB +
          '">&nbsp;1234567890&nbsp;</span>';
    function arrow(key: number, label: string): string {
        return (
            '<div class="btn" role="button" tabindex="0" data-ott-key="' +
            key +
            '">' +
            label +
            "</div>"
        );
    }
    var controls = foreground
        ? "<br/><br>" +
          arrow(keys.LEFT, strLEFT) +
          "&nbsp;" +
          arrow(keys.RIGHT, strRIGHT) +
          "&nbsp;" +
          _("Color") +
          "<br>" +
          arrow(keys.UP, strUP) +
          "&nbsp;" +
          arrow(keys.DOWN, strDOWN) +
          "&nbsp;" +
          _("Saturation") +
          "<br>" +
          renderButtonHint(keys.YELLOW, "", "Yellow") +
          "<br>" +
          renderButtonHint(keys.GREEN, "", "Green") +
          "<br>" +
          renderButtonHint(keys.BLUE, "", "Blue")
        : "";
    $("#listAbout")
        .html(
            '<div style="font-size:larger;">' +
                _("Color") +
                ":<br/><br/>&nbsp;" +
                preview +
                "&nbsp;" +
                controls +
                "</div>"
        )
        .show();
    bindColorDialogInput(
        hue,
        saturation,
        value,
        foreground ? "color" : "background-color",
        settingKey
    );
}

/** Adjust foreground text color, stored in eSHLcolor. */
export function colorDialog(): void {
    showColorDialog("eSHLcolor", "50,85", _("Color spectrum"), 100, true);
}

/** Adjust the selection background at HSV value 50, stored in eSHLcolSel. */
export function selColorDialog(): void {
    showColorDialog("eSHLcolSel", "50,85", _("Select color"), 50);
}

/** Adjust the list background at HSV value 100, stored in eSHLcolorB. */
export function backColorDialog(): void {
    showColorDialog("eSHLcolorB", "255,0", _("Background color"), 100);
}

/* ---------------------------------------------------------------------------
 * Joystick menu
 * --------------------------------------------------------------------------- */

/**
 * Show the joystick/remote-control overlay — a visual grid of directional buttons
 * with mapped actions (rewind, menu, pause, live, close, etc.).
 *
 * @returns void
 * @sideeffect Shows `#dialogbox` with button grid. Registers a one-shot `dialogBoxKeyHandler`.
 * @analysis Arrow keys are mapped to common actions (UP = archive select, DOWN = stop/live, etc.).
 *             RETURN dismisses the overlay without action.
 */
export function joyMenu(): void {
    var btn = '<td align="center" valign="top" width="30%">';
    $("#dialogbox")
        .html(
            '<table style="font-size:inherit">' +
                "<tr><td></td>" +
                btn +
                renderButtonHint(keys.UP, strUP, "<br>Rewind<br>") +
                "</td><td></td></tr>" +
                "<tr>" +
                btn +
                renderButtonHint(keys.LEFT, strLEFT, "<br>Menu") +
                "</td>" +
                btn +
                renderButtonHint(keys.ENTER, strENTER, "<br>Pause<br>") +
                "</td>" +
                btn +
                renderButtonHint(
                    keys.RIGHT,
                    strRIGHT,
                    "<br>Toggle<br>sound track"
                ) +
                "</td></tr>" +
                "<tr><td></td>" +
                btn +
                renderButtonHint(
                    keys.DOWN,
                    strDOWN,
                    (window as any).playType
                        ? "<br>Live"
                        : "<br>Previous<br>channel"
                ) +
                "</td><td></td></tr>" +
                "</table>" +
                renderButtonHint(keys.RETURN, strRETURN, "Close")
        )
        .show();
    (window as any).__ottClassicScreenPort.setOwnedCallback(
        "dialog",
        function (e: number): void {
            $("#dialogbox").hide();
            switch (e) {
                case keys.ENTER:
                    if (typeof (window as any)._doKey === "function")
                        (window as any)._doKey((window as any).keys.PLAY);
                    return;
                case keys.UP:
                    if (
                        typeof (window as any).showPlaybackSeekDialog ===
                        "function"
                    )
                        (window as any).showPlaybackSeekDialog(0);
                    return;
                case keys.DOWN:
                    (window as any).playType
                        ? typeof (window as any)._doKey === "function" &&
                          (window as any)._doKey((window as any).keys.STOP)
                        : typeof (window as any).prevProg === "function" &&
                          (window as any).prevProg();
                    return;
                case keys.RIGHT:
                    if (typeof (window as any).toggleAudioTrack === "function")
                        (window as any).toggleAudioTrack();
                    return;
                case keys.LEFT:
                    if (typeof popupList === "function") popupList();
                    return;
                case keys.RETURN:
                    return;
            }
        }
    );
}

/* ---------------------------------------------------------------------------
 * Edit key dialog
 * --------------------------------------------------------------------------- */

/**
 * Set the keyboard case (upper/lower). Preserves the original cells and updates the
 * shift-key symbol. Also adds a red underline indicator if color keys are enabled.
 *
 * @param e - true for uppercase, false for lowercase.
 * @returns void — early return if punctuation mode is active (`_keyP`).
 * @sideeffect Modifies `_keyUp`, `_keysSymbol[0].s`.
 */
function _setCase(e: boolean): void {
    if (_keyP) return;
    _keyUp = e;
    _keysSymbol[0].s = _keyUp ? "&darr;a" : "&uarr;A";
    if (!(window as any).sNoColorKeys)
        _keysSymbol[0].s =
            '<span style="border-bottom:3px solid red;">' +
            _keysSymbol[0].s +
            "</span>";
}

/** Case is derived from the original cell, never from a previous conversion. */
function _keyboardCharacter(value: string): string {
    if (!_keyUp || _keyP) return value;
    if (value === "i" && !_keyE && /^_(tur|aze)$/.test(_ottplaylang()))
        return "İ";
    if (value === "ß") return "ẞ";
    // Older TV engines predate Unicode 11's Georgian Mtavruli case mapping.
    var code = value.charCodeAt(0);
    if (code >= 0x10d0 && code <= 0x10f0)
        return String.fromCharCode(code + 0xbc0);
    // Expanded uppercase forms (e.g. Armenian և) still occupy one key cell.
    return value.toUpperCase();
}

function _ottplaylang(): any {
    try {
        if (typeof (window as any).stbGetItem === "function")
            return (window as any).stbGetItem("ottplaylang");
    } catch (_e) {}
    return undefined;
}

/** Cyrillic fallback when UI language has no OSK alphabet (e.g. old _eng.js). */
var _keysRu = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя";

/** Alphabet for the non-English OSK layout. */
function _localizedAlphabet(): string {
    var t = _("alhabet");
    if (typeof t === "string" && t.length > 0 && t !== "alhabet") return t;
    return _keysRu;
}

/** Start the English or localized layout at its first page. */
function _setLang(e: boolean): void {
    _keyE = e;
    _keyPage = 0;
    _buildKeyboard();
    _keysSymbol[2].s = "!?,";
    _setCase(_keyUp);
    _keyCur = _keys.length - 9;
}

/** Keep long alphabets reachable without making the remote-control grid taller. */
function _buildKeyboard(): void {
    var alphabet = _keyP ? _keysP : _keyE ? _keysL : _localizedAlphabet();
    _keyPages = Math.max(1, Math.ceil(alphabet.length / 40));
    _keyPage = _keyPage % _keyPages;
    var letters = alphabet.substr(_keyPage * 40, 40);
    var cells = Math.ceil(letters.length / 10) * 10;
    letters = (letters + _keysP).substr(0, cells);
    _keys = _keys1 + letters + _keysA;
    _keysSymbol[8].s =
        _keyPages > 1 ? _keyPage + 1 + "/" + _keyPages + " ›" : "";
}

/**
 * Toggle punctuation/symbol keyboard mode.
 *
 * @param _p - true to show punctuation layout, false to revert to letter layout.
 * @returns void
 * @sideeffect Modifies `_keys`, `_keyCur`, `_keyP`, `_keysSymbol[0].s`, `_keysSymbol[2].s`.
 * @analysis When entering punctuation mode, the shift and lang indicators are cleared. Exiting re-calls `_setLang`.
 */
function _setPunct(_p: boolean): void {
    _keyP = _p;
    if (_p) {
        _keyPage = 0;
        _buildKeyboard();
        _keysSymbol[0].s = "";
        _keysSymbol[2].s = "abc";
    } else {
        _setLang(_keyE);
    }
    _keyCur = _keys.length - 8;
}

/** Global alias – defaults to showEditKey1, providers can swap it */
var showEditKey: any = showEditKey1;

/**
 * Initialize and show the graphical on-screen keyboard (edit mode variant 1).
 * Sets up key symbols, color indicators, cursor position, and keyboard mode.
 *
 * @param _initKeys - Ignored (accepts any value for API compatibility with `showEdit`).
 * @param resume - Redraw after SWOP without replacing the editor or its save callback.
 * @returns void
 * @sideeffect Calls `saveListPanelState()`. Modifies `_keysSymbol` entries. Sets `editPos`, `_keyCur`. Calls `_setPunct` and `showEdit`.
 * @analysis Checks `window.stbGetItem('ottplaylang') === '_eng'` to determine initial language.
 *             Color-key underlines are added to shift/lang/backspace/ok symbols if color keys are enabled.
 */
export function showEditKey1(
    _initKeys: any,
    secret?: boolean,
    resume?: boolean
): void {
    // Desktop / Tauri / Capacitor use the native <input> line. CJK also needs
    // the system IME (or remote text entry) for phonetic conversion. Several
    // call sites still invoke
    // showEditKey1 (or a stale window.showEditKey alias) directly.
    var w = window as any;
    var isPc =
        typeof w.__TAURI__ !== "undefined" ||
        /^(pc|pc2|tauri|desktop|nodejs)$/.test(String(w.ott_device || ""));
    var isCap = typeof w.Capacitor !== "undefined";
    var needsIme = /^_(chi|jpn|kor)$/.test(String(_ottplaylang() || ""));
    var port = w.__ottClassicScreenPort;
    var previousEditor = resume && port.owner("editor");
    var nativeResume =
        previousEditor && previousEditor.model.nativeInputSecret !== undefined;
    if (
        (isPc || isCap || needsIme || nativeResume) &&
        typeof w.showEditKey2 === "function"
    ) {
        w.showEditKey2(_initKeys, secret, resume);
        return;
    }
    if (!resume) saveListPanelState();
    var editorOwner = resume ? previousEditor : port.openEditor();
    if (!editorOwner || !editorOwner.active()) return;
    // Legacy stbPlayer.js:3993 uses == "_eng" (not ===)
    if (_ottplaylang() == "_eng") _keyE = true;
    // English UI still needs access to its Cyrillic keyboard layout.
    _keysSymbol[1].s =
        '<span style="font-family:fontello;padding:0.2em;">&#xe80E;</span>';
    _keysSymbol[7].s =
        '<span style="font-family:fontello;padding:0.2em;">&#xe804;</span>';
    _keysSymbol[9].s = "Ok";
    if (!(window as any).sNoColorKeys) {
        _keysSymbol[1].s =
            '<span style="border-bottom:3px solid green;">' +
            _keysSymbol[1].s +
            "</span>";
        _keysSymbol[7].s =
            '<span style="border-bottom:3px solid #bb0;">' +
            _keysSymbol[7].s +
            "</span>";
        _keysSymbol[9].s =
            '<span style="border-bottom:3px solid blue;">' +
            _keysSymbol[9].s +
            "</span>";
    }
    editPos = (window as any).editvar.length;
    var r = _keyCur >= _keys.length - 10 ? 14 : _keyCur;
    _setPunct(_keyP);
    _keyCur = resume
        ? _keys.length - 1
        : r >= 0 && r < _keys.length - 10
          ? r
          : 14;
    showEdit();
}

/**
 * Render the on-screen keyboard (`#listEdit`) with all key cells, the current edit value,
 * and the cursor. Highlights the currently focused key.
 *
 * @returns void
 * @sideeffect Sets `#listEdit` innerHTML. Calls `_changeEdit()` to update the edit preview.
 *             Sets footer buttons for close/case/lang/delete/ok.
 * @analysis Keys are laid out in rows of 10. Each key cell has an `onclick` that calls `clickKey(s)`.
 *             Symbol keys (indices 0-9) use their custom render function; others show the raw character.
 */
export function showEdit(): void {
    var e = $("#listEdit").show();
    /* Slightly smaller than /12 so .osk-key margins fit a 10-key row. */
    var t = ((e.width() || 600) / 12.4) | 0;
    if (t < 24) t = 24;
    var r =
        '<div class="osk-cap">' +
        ((window as any).editCaption || "") +
        "</div>";
    r += '<div id="ee" dir="auto"></div><div class="osk-grid">';
    // Unicode marks in the shipped alphabets need a visible standalone label.
    var combiningMark =
        /^[\u0300-\u0304\u0307-\u0308\u0323\u064b-\u0652\u0654\u0670\u0901-\u0903\u093c\u093e-\u0943\u0945\u0947-\u0949\u094b-\u094d\u0981-\u0983\u09bc\u09be-\u09c4\u09c7-\u09c8\u09cb-\u09cd\u09d7\u09e2-\u09e3\u0a02\u0a3c\u0a3e-\u0a42\u0a47-\u0a48\u0a4b-\u0a4d\u0a70-\u0a71\u0a81-\u0a83\u0abc\u0abe-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd\u0b01-\u0b03\u0b3c\u0b3e-\u0b44\u0b47-\u0b48\u0b4b-\u0b4d\u0b56-\u0b57\u0b62-\u0b63\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0c01-\u0c03\u0c3e-\u0c44\u0c46-\u0c48\u0c4a-\u0c4d\u0c55-\u0c56\u0c82-\u0c83\u0cbc\u0cbe-\u0cc4\u0cc6-\u0cc8\u0cca-\u0ccd\u0cd5-\u0cd6\u0d02-\u0d03\u0d3e-\u0d44\u0d46-\u0d48\u0d4a-\u0d4d\u0d57\u0d62-\u0d63\u0d82-\u0d83\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf\u0df2-\u0df3\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0eb9\u0ebb-\u0ebc\u0ec8-\u0ecd\u102b-\u1032\u1036-\u103e\u17b6-\u17cb\u17cd\u17d0\u17d2\u3099-\u309a]/;
    for (var s = 0; s < _keys.length; s++) {
        if (s > 0 && s % 10 === 0) r += "<br/>";
        var charCode = _keys.charCodeAt(s);
        var sym = _keysSymbol[charCode];
        var n = sym ? sym.s : _keyboardCharacter(_keys[s]);
        if (!sym)
            n = metadataText(
                n === "\u200b"
                    ? "ZWSP"
                    : n === "\u200c"
                      ? "ZWNJ"
                      : n === "\u200d"
                        ? "ZWJ"
                        : combiningMark.test(n)
                          ? "◌" + n
                          : n
            );
        if (charCode === 0x200b || charCode === 0x200c || charCode === 0x200d)
            n = '<span style="font-size:60%">' + n + "</span>";
        r +=
            '<div id="ik' +
            s +
            '" class="osk-key"' +
            (charCode === 8 && _keyPages > 1
                ? ' aria-label="' + metadataText(_("Next keyboard page")) + '"'
                : "") +
            ' onclick="clickKey(' +
            s +
            ');">' +
            n +
            "</div>";
    }
    e.html(r + "</div>");
    var fontSize = parseFloat(e.css("font-size")) || 24;
    var textSize = Math.min(fontSize, (e.height() || 600) / 14);
    e.find(".osk-cap, #ee").css("font-size", textSize);
    _changeEdit();
    // Text settings can make the caption/input taller. Constrain cells by
    // available height as well as width, without changing the user's font setting.
    var grid = e.find(".osk-grid");
    var available =
        (e.height() || 600) -
        (grid.position().top - parseFloat(e.css("padding-top") || "0"));
    var rows = _keys.length / 10;
    var height = Math.max(16, Math.min(t, Math.floor(available / rows) - 4));
    grid.css({ "font-size": 0, "line-height": height + 4 + "px" });
    grid.find(".osk-key").css({
        "font-size": Math.min(fontSize, height * 0.65),
        height: height,
        "line-height": height + "px",
        width: t,
    });
    $("#ik" + _keyCur).css({
        "background-color": (window as any).curColorB,
        color: (window as any).curColor,
    });
    if (listFooterElement)
        listFooterElement.innerHTML =
            renderButtonHint(keys.RETURN, strRETURN, "Close") +
            renderButtonHint(
                keys.RED,
                "",
                _keysSymbol[0].s ? (_keyUp ? "&darr;a" : "&uarr;A") : "",
                strTools
            ) +
            renderButtonHint(
                keys.GREEN,
                "",
                _keysSymbol[1].s
                    ? _keyE
                        ? // Offer the other layout in the *current* UI language.
                          _ottplaylang() == "_eng"
                            ? "Russian"
                            : "lang"
                        : "English"
                    : "",
                strFF
            ) +
            renderButtonHint(keys.YELLOW, "", "Delete", strRW) +
            renderButtonHint(keys.BLUE, "", "Ok", strPlayPause);
}

/**
 * Update the edit text preview in the `#ee` element, placing a blinking cursor div at the current position.
 *
 * @returns void
 * @sideeffect Sets `#ee` text nodes around the cursor, preserving literal controls.
 *             Clears and restarts the cursor blink interval (500ms toggle).
 */
export function _changeEdit(): void {
    var value = (window as any).editvar;
    // External drafts and adjoining marks can move a boundary after any edit.
    editPos = textBoundary(value, editPos, 0);
    var field = document.getElementById("ee");
    if (field) {
        field.textContent = "";
        var caret = document.createElement("div");
        caret.id = "cursor";
        caret.style.backgroundColor = (window as any).curColor;
        field.appendChild(document.createTextNode(value.substr(0, editPos)));
        field.appendChild(caret);
        field.appendChild(document.createTextNode(value.substr(editPos)));
        field.scrollTop = caret.offsetTop - field.offsetTop;
    }
    clearInterval(cursorInterval);
    var owner = (window as any).__ottClassicScreenPort.owner("editor");
    if (!owner || !owner.active()) return;
    if (owner.model.cursorCleanup) owner.model.cursorCleanup();
    var blink = true;
    var cursor = $("#cursor");
    var timer = setInterval(function () {
        if (!owner.foreground()) return;
        blink = !blink;
        cursor.css(
            "background-color",
            blink ? (window as any).curColor : "inherit"
        );
    }, 500);
    cursorInterval = timer;
    owner.model.cursorCleanup = owner.own(function () {
        clearInterval(timer);
    });
}

/**
 * Handle a click on an on-screen keyboard key. Highlights the clicked key and
 * delegates to `editKey1` with ENTER to type it.
 *
 * @param e - The key index in the `_keys` string.
 * @returns void
 * @sideeffect Stops event propagation. Updates key highlight styles. Calls `editKey1(keys.ENTER)`.
 */
export function clickKey(e: number): void {
    if (
        typeof (window as any).event !== "undefined" &&
        (window as any).event &&
        (window as any).event.stopPropagation
    )
        (window as any).event.stopPropagation();
    $("#ik" + _keyCur).css({ "background-color": "", color: "" });
    _keyCur = e;
    $("#ik" + _keyCur).css({
        "background-color": (window as any).curColorB,
        color: (window as any).curColor,
    });
    editKey1((window as any).keys.ENTER);
}

/**
 * Handle a key press on the on-screen keyboard. Manages cursor movement, character insertion,
 * and special key actions (case, lang, punctuation, backspace, ok).
 *
 * @param e - The numeric key code from the remote/keyboard.
 * @returns void
 * @sideeffect Modifies `(window as any).editvar` and `editPos`. Updates key highlight styles. Calls `_changeEdit()`.
 *             Special keys: UP/DOWN/LEFT/RIGHT move keyboard focus. RED=case, GREEN=lang, YELLOW=delete,
 *             BLUE/PLAY=ok. ENTER types the focused character or invokes the symbol action.
 *             RETURN/EXIT closes the editor and calls `restoreListPanelState()`.
 * @analysis If the pressed key maps to a character in `_keys`, the behavior depends on whether that index
 *             is the currently focused key: if same, type it; if different, move focus and type.
 *             Symbol keys (charCode <= 9) invoke their action function instead of typing.
 */
export function editKey1(e: number): void {
    function focusKeyboardKey(index: number): void {
        $("#ik" + _keyCur).css({ "background-color": "", color: "" });
        _keyCur = index;
        $("#ik" + _keyCur).css({
            "background-color": (window as any).curColorB,
            color: (window as any).curColor,
        });
    }
    switch (e) {
        case (window as any).keys.UP:
            focusKeyboardKey(_keyCur + (_keyCur > 9 ? -10 : _keys.length - 10));
            return;
        case (window as any).keys.DOWN:
            focusKeyboardKey(
                _keyCur +
                    (_keyCur < _keys.length - 10 ? 10 : -_keys.length + 10)
            );
            return;
        case (window as any).keys.LEFT:
            focusKeyboardKey(_keyCur + (_keyCur % 10 > 0 ? -1 : 9));
            return;
        case (window as any).keys.RIGHT:
            focusKeyboardKey(_keyCur + (_keyCur % 10 < 9 ? 1 : -9));
            return;
        case (window as any).keys.TOOLS:
        case (window as any).keys.RED:
            _keysSymbol[0].a();
            return;
        case (window as any).keys.FF:
        case (window as any).keys.GREEN:
            _keysSymbol[1].a();
            return;
        case (window as any).keys.RW:
        case (window as any).keys.YELLOW:
            _keysSymbol[7].a();
            return;
        case (window as any).keys.PLAY:
        case (window as any).keys.PAUSE:
        case (window as any).keys.BLUE:
            _keysSymbol[9].a();
            return;
        case (window as any).keys.ENTER:
            if (_keys.charCodeAt(_keyCur) > 9) {
                var character = _keyboardCharacter(_keys[_keyCur]);
                editPos = textBoundary((window as any).editvar, editPos, 0);
                (window as any).editvar =
                    (window as any).editvar.substr(0, editPos) +
                    character +
                    (window as any).editvar.substr(editPos);
                editPos += character.length;
                _changeEdit();
            } else {
                _keysSymbol[_keys.charCodeAt(_keyCur)].a();
            }
            return;
        case (window as any).keys.EXIT:
        case (window as any).keys.RETURN:
            clearInterval(cursorInterval);
            if (typeof (window as any).restoreListPanelState === "function")
                (window as any).restoreListPanelState();
            $("#listEdit").hide();
            return;
        default: {
            var idx = -1;
            var typedCharacter = String.fromCharCode(e);
            for (var i = 0; i < _keys.length; i++) {
                if (_keyboardCharacter(_keys[i]) === typedCharacter) {
                    idx = i;
                    break;
                }
            }
            if (idx > -1) {
                focusKeyboardKey(idx);
                editKey1((window as any).keys.ENTER);
            }
            return;
        }
    }
}

/**
 * Handle key events for the native HTML input editor (edit mode variant 2).
 * ENTER saves via `setEdit` then closes the editor; RETURN/EXIT discards and restores.
 *
 * @param code - The numeric key code.
 * @returns void
 * @sideeffect Reads `#editvar` value on ENTER, calls `window.setEdit()`, then hides `#listEdit`
 *             and calls `window.restoreListPanelState()` (same teardown as RETURN/EXIT).
 */
export function editKey2(code: number): void {
    var w = window as any;
    var port = w.__ottClassicScreenPort;
    var owner = port.owner("editor");
    if (!owner || !owner.foreground() || owner.model.nativeInputComposing)
        return;
    var input = document.getElementById("editvar");
    var remote = document.getElementById("editRemoteInput");
    var save = owner.model.nativeInputIme
        ? document.querySelector(
              '#listEdit [data-ott-key="' + w.keys.ENTER + '"]'
          )
        : null;
    if (code === w.keys.UP || code === w.keys.DOWN) {
        var next = document.activeElement === remote ? input : remote;
        if (owner.model.nativeInputIme) {
            var controls = [input, remote, save];
            var index = controls.indexOf(document.activeElement);
            next = controls[
                (index + (code === w.keys.UP ? 2 : 1)) % 3
            ] as HTMLElement;
        }
        if (next) next.focus();
        return;
    }
    if (code === w.keys.ENTER && remote && document.activeElement === remote) {
        remote.click();
        return;
    }
    if (code !== w.keys.ENTER && code !== w.keys.EXIT && code !== w.keys.RETURN)
        return;
    if (
        code === w.keys.ENTER &&
        owner.model.nativeInputIme &&
        document.activeElement !== save
    )
        return;
    if (code === w.keys.ENTER)
        w.editvar = ($("#editvar").val() as string) || "";
    port.finishEditor(code === w.keys.ENTER, function () {
        $("#listEdit").hide();
        if (typeof w.restoreListPanelState === "function")
            w.restoreListPanelState();
    });
}

/**
 * Show the native HTML `<input>` editor (edit mode variant 2) as an alternative to the
 * graphical on-screen keyboard.
 *
 * @param _initKeys - Optional array of initial key values (unused, for API compatibility).
 * @param resume - Redraw after SWOP while retaining the current editor owner.
 * @returns void
 * @sideeffect Calls `window.saveListPanelState()` if available. Renders `#listEdit` with an `<input>` field
 *             with remote input and save/discard controls. Focuses the input field.
 */
export function showEditKey2(
    _initKeys?: number[],
    secret?: boolean,
    resume?: boolean
): void {
    var w = window as any;
    if (!resume && typeof w.saveListPanelState === "function")
        w.saveListPanelState();
    var port = w.__ottClassicScreenPort;
    var editorOwner = resume ? port.owner("editor") : port.openEditor();
    if (!editorOwner || !editorOwner.active()) return;
    if (!resume) {
        editorOwner.model.nativeInputSecret = !!secret;
        editorOwner.model.nativeInputIme = false;
    }
    if (editorOwner.model.releaseNativeInput)
        editorOwner.model.releaseNativeInput();
    var caption = w.editCaption || "";
    var val = w.editvar || "";
    var keys = w.keys || {};
    var strExit = w.strEXIT || "Esc";
    var strEnter = w.strENTER || "ENTER";
    if (w.listCaptionElement) w.listCaptionElement.textContent = caption;
    var escapedCaption = metadataText(caption);
    var hint =
        w.renderButtonHint ||
        function () {
            return "";
        };
    var html = escapedCaption + ":<br/><br/>";
    html +=
        '<br/><input type="' +
        (editorOwner.model.nativeInputSecret ? "password" : "text") +
        '" dir="auto" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="' +
        escapedCaption +
        '" id="editvar" style="color:' +
        (w.curColor || "#fff") +
        ';"><br/><br/>';
    html +=
        '<button type="button" id="editRemoteInput">' +
        metadataText(_("Remote text entry")) +
        "</button>";
    html += "<br/>" + hint(keys.EXIT || 27, strExit, "Cancel");
    html += "<br/>" + hint(keys.ENTER || 13, strEnter, "Set");
    $("#listEdit").show().html(html);
    var editEl = document.getElementById("editvar") as HTMLInputElement | null;
    var remoteButton = document.getElementById("editRemoteInput");
    function consumeEvent(event: Event): void {
        event.preventDefault();
        event.stopPropagation();
    }
    if (editEl) {
        // Assign the value as text: HTML entities in URLs/passwords must round-trip.
        editEl.value = String(val);
        var openingEvent = port.keyEvent();
        var openingCode =
            openingEvent &&
            openingEvent.type === "keydown" &&
            (openingEvent.keyCode || openingEvent.which);
        // LG can send keypress/repeats after a shortcut opens and focuses an
        // editor. Keep the field read-only until that physical key is released.
        editEl.readOnly = !!openingCode;
        var openingListeners = function (enabled: boolean): void {
            ["keydown", "keypress", "keyup"].forEach(function (type) {
                w[enabled ? "addEventListener" : "removeEventListener"](
                    type,
                    openingKey,
                    true
                );
            });
        };
        var releaseOpeningKey = function (): void {
            openingCode = 0;
            editEl!.readOnly = false;
            openingListeners(false);
        };
        var openingKey = editorOwner.guard(function (ev: KeyboardEvent): void {
            if (!openingCode || !editorOwner.foreground()) return;
            if ((ev.keyCode || ev.which) !== openingCode) {
                if (ev.type === "keydown") releaseOpeningKey();
                return;
            }
            consumeEvent(ev);
            if (ev.type === "keyup") {
                releaseOpeningKey();
                editEl!.focus();
            }
        });
        if (openingCode) openingListeners(true);
        editorOwner.model.nativeInputComposing = false;
        var onComposition = editorOwner.guard(function (
            ev: CompositionEvent
        ): void {
            editorOwner.model.nativeInputComposing =
                ev.type === "compositionstart";
            editorOwner.model.nativeInputIme = true;
            // The browser owns composition and commits to input.value. Never
            // append event.data: doing so duplicates or loses candidate text.
        });
        var onInput = editorOwner.guard(function (
            ev: KeyboardEvent | MouseEvent
        ): void {
            if (
                !editorOwner.foreground() ||
                document.getElementById("editvar") !== editEl
            )
                return;
            if (ev.type === "click") {
                consumeEvent(ev);
                if (editorOwner.model.nativeInputComposing) return;
                // Native typing lives in the input until save or remote handoff.
                w.editvar = editEl!.value;
                swopLoadValue();
                return;
            }
            // The only other registered event is keydown.
            var keyEvent = ev as KeyboardEvent;
            if (
                editorOwner.model.nativeInputComposing ||
                keyEvent.isComposing ||
                keyEvent.keyCode === 229
            ) {
                // Keep IME default handling, but do not let the window key router save.
                ev.stopPropagation();
                return;
            }
            // Composition-confirm Enter may arrive after compositionend in
            // some engines. Once using an IME, saving is an explicit action on
            // the existing focusable Save hint; no timeout/ignore-next-key guess.
            if (
                editorOwner.model.nativeInputIme &&
                ev.currentTarget === editEl &&
                (keyEvent.key === "Enter" || keyEvent.keyCode === 13)
            ) {
                ev.stopPropagation();
                return;
            }
            var command = 0;
            if (
                keyEvent.key === "ArrowUp" ||
                keyEvent.keyCode === (keys.UP || 38)
            )
                command = keys.UP || 38;
            else if (
                keyEvent.key === "ArrowDown" ||
                keyEvent.keyCode === (keys.DOWN || 40)
            )
                command = keys.DOWN || 40;
            else if (keyEvent.key === "Enter" || keyEvent.keyCode === 13)
                command = keys.ENTER || 13;
            else if (keyEvent.key === "Escape" || keyEvent.keyCode === 27)
                command = keys.EXIT || 27;
            if (command) {
                consumeEvent(ev);
                editKey2(command);
            } else if (
                ev.currentTarget === remoteButton &&
                (keyEvent.key === " " ||
                    keyEvent.key === "Tab" ||
                    keyEvent.keyCode === 9 ||
                    keyEvent.keyCode === 32)
            ) {
                // Keep Space/Tab native; do not let the global router save.
                ev.stopPropagation();
            }
        });
        editorOwner.model.releaseNativeInput = editorOwner.own(function () {
            releaseOpeningKey();
            editorOwner.model.nativeInputComposing = false;
            editEl!.removeEventListener("keydown", onInput);
            editEl!.removeEventListener("compositionstart", onComposition);
            editEl!.removeEventListener("compositionend", onComposition);
            if (remoteButton) {
                remoteButton.removeEventListener("click", onInput);
                remoteButton.removeEventListener("keydown", onInput);
            }
        });
        editEl.addEventListener("keydown", onInput);
        editEl.addEventListener("compositionstart", onComposition);
        editEl.addEventListener("compositionend", onComposition);
        if (remoteButton) {
            remoteButton.addEventListener("click", onInput);
            remoteButton.addEventListener("keydown", onInput);
        }
        if (!openingCode) editEl.focus();
    }
}

/* ---------------------------------------------------------------------------
 * Media list
 * --------------------------------------------------------------------------- */

declare function showMediaList(): void;
declare function getMediaDescr(item: any): string;
declare function mediaKeyHandler(keyCode: number): boolean;

function mediaPlaybackControls(view: any): string {
    var w = window as any;
    var repeatLabels: any = {
        all: "Repeat: All",
        off: "Repeat: Off",
        one: "Repeat: One",
    };
    var shuffleLabels: any = {
        loading: "Shuffle: Loading...",
        off: "Shuffle: Off",
        on: "Shuffle: On",
    };
    var controls = view.canRepeat
        ? '<div id="mediaPlaybackControls" aria-live="polite">' +
          (view.canShuffle
              ? w
                    .renderButtonHint(
                        w.keys.N5,
                        "&#8646;",
                        shuffleLabels[view.shuffle] || "Shuffle: Off",
                        "5"
                    )
                    .replace(
                        "<span role=",
                        '<span id="mediaShuffleControl" data-state="' +
                            view.shuffle +
                            '" aria-pressed="' +
                            (view.shuffle === "on") +
                            '" aria-busy="' +
                            (view.shuffle === "loading") +
                            '" role='
                    )
              : "") +
          w
              .renderButtonHint(
                  w.keys.N9,
                  "&#8635;",
                  repeatLabels[view.repeat] || "Repeat: All",
                  "9"
              )
              .replace(
                  "<span role=",
                  '<span id="mediaRepeatControl" data-state="' +
                      view.repeat +
                      '" role='
              ) +
          "</div>"
        : "";
    controls = controls.replace(/<\/span>&nbsp;&nbsp;/g, "</span>");
    return controls;
}

/** Update mode badges without replacing the list or an overlay it owns. */
function updateMediaPlaybackControls(view: any): void {
    var detail = document.getElementById("listDetail");
    var controls = detail && (detail.firstChild as HTMLElement | null);
    if (!controls || controls.id !== "mediaPlaybackControls") return;
    var shuffle = document.getElementById("mediaShuffleControl");
    var repeat = document.getElementById("mediaRepeatControl");
    if (shuffle && shuffle.parentNode !== controls) shuffle = null;
    if (!repeat || repeat.parentNode !== controls) return;
    if (
        repeat.getAttribute("data-state") === view.repeat &&
        (!shuffle || shuffle.getAttribute("data-state") === view.shuffle)
    )
        return;
    var focused = document.activeElement as HTMLElement | null;
    var focusId = focused && focused.parentNode === controls ? focused.id : "";
    var holder = document.createElement("div");
    holder.innerHTML = mediaPlaybackControls({
        canRepeat: true,
        canShuffle: !!shuffle,
        repeat: view.repeat,
        shuffle: view.shuffle,
    });
    controls.innerHTML = (holder.firstChild as HTMLElement).innerHTML;
    if (focusId) {
        var button = document.getElementById(focusId);
        if (button && button.parentNode === controls) button.focus();
    }
}

/**
 * Render the media library list from the already-loaded `window.mediaRecords`
 * (no provider refetch). Used by `mediaList()` for folder (submenu) navigation
 * and for the refresh path, where the records are in place and only the view
 * needs rebuilding. Mirrors the chrome of the fetching variant (`showMediaList`).
 *
 * @sideeffect Sets `window.listArray`, `window.getListItemFn`,
 *             `window.detailListActionFn`, `window.listKeyHandlerFn`; updates
 *             #listCaption / #listPodval; calls `window.showPage`.
 */
function showMediaList1(view?: any): void {
    var w = window as any;
    view = view || w.__ottMedia.snapshot();
    var frame = view.frame;
    var data: MediaHistoryEntry[] = frame
        ? frame.items.map(function (entry: any) {
              return entry.payload;
          })
        : [];
    w.selIndex = Math.max(
        0,
        Math.min(frame ? frame.selected : 0, data.length - 1)
    );
    w.listArray = data;
    w.listDataArray = data;
    var rowHeight =
        (window.innerHeight - 90 * getViewportHeightScale()) /
            (w.pageSize || settings.pageSize) -
        2;
    w.getListItemFn = function (item: MediaHistoryEntry, _idx: number) {
        return (
            (w.sShowPikon
                ? '<div class="img" style="background-image:url(\'' +
                  metadataText(metadataCssUrl(item.logo_30x30)) +
                  "');width:" +
                  rowHeight +
                  "px;margin-left:" +
                  6 * getViewportWidthScale() +
                  'px;"></div>&nbsp;'
                : "&nbsp;&nbsp;") +
            metadataText(
                (item as any).__ottMediaNext
                    ? w._(
                          (item as any).__ottMediaPageState === "error"
                              ? "Could not load. Select to retry."
                              : "Loading..."
                      )
                    : w.__ottMedia.title(item)
            )
        );
    };
    var controls = mediaPlaybackControls(view);
    w.detailListActionFn = function () {
        w.__ottMedia.highlight(w.selIndex, view.revision);
        var detailEl = document.getElementById("listDetail");
        var item = data[w.selIndex];
        if (!detailEl) return;
        if (!item) {
            detailEl.innerHTML = "";
            return;
        }
        var descr = (item as any).__ottMediaNext ? "" : getMediaDescr(item);
        var thumbnail =
            item.logo_30x30 && descr.indexOf("<img") === -1
                ? getThumbnail(item.logo_30x30)
                : "";
        var description = detailEl.lastChild as HTMLElement | null;
        if (description && description.id === "_prd")
            description.innerHTML = thumbnail + descr;
        else
            detailEl.innerHTML =
                controls + '<div id="_prd">' + thumbnail + descr + "</div>";
        if (!w.sNoSmall) $("img", $(detailEl)).not("#detal").remove();
        if (typeof w.scrollUp === "function")
            w.scrollUp(
                "_prd",
                $("#_prd").height() +
                    10 +
                    (controls
                        ? $("#mediaPlaybackControls").outerHeight(true)
                        : 0) -
                    $(detailEl).height(),
                5000
            );
    };
    w.listKeyHandlerFn = mediaKeyHandler;
    var captionEl = document.getElementById("listCaption");
    if (captionEl)
        captionEl.textContent =
            ((w.mediaNames || []).join(" / ") ||
                w.mediaName ||
                w._("Media Library")) +
            (view.filter ? " — " + w._("Filter") + ": " + view.filter : "");
    var detailEl = document.getElementById("listDetail");
    if (detailEl) detailEl.innerHTML = "";
    var footerElement = document.getElementById("listPodval");
    var depth = view.frames.length;
    if (footerElement) {
        footerElement.innerHTML =
            w.renderButtonHint(
                w.keys.RED,
                "",
                "Close",
                w.sArrowFun === 2 ? w.strRETURN : w.strPRECH,
                "0"
            ) +
            (w.sArrowFun === 2
                ? w.renderButtonHint(w.keys.LEFT, w.strLEFT, "Back")
                : w.renderButtonHint(
                      w.keys.RETURN,
                      w.strRETURN,
                      "Back",
                      w.sRewFun === 1
                          ? w.strRW
                          : w.sPNFun === 1
                            ? w.strPREV
                            : ""
                  )) +
            w.renderButtonHint(w.keys.N2, w.strInfo, "Description", "2") +
            (frame && frame.route.kind !== "variants"
                ? w.renderButtonHint(w.keys.BLUE, "", "Filter")
                : "") +
            (data.some(function (row) {
                return (
                    row &&
                    typeof row === "object" &&
                    !("__ottMediaFilter" in row && row.__ottMediaFilter)
                );
            }) &&
            w.sFavorites !== -1 &&
            depth > 1
                ? w.renderButtonHint(
                      w.keys.GREEN,
                      "",
                      frame && frame.route.kind === "favorites"
                          ? "Delete"
                          : "Add to favorites",
                      w.strTools,
                      "8"
                  )
                : "");
    }
    $("#listPopUp").html("").hide();
    if (typeof w.showPage === "function") w.showPage();
    // Mode changes are immediate; only metadata waits for the detail debounce.
    if (detailEl) detailEl.innerHTML = controls + '<div id="_prd"></div>';
}

if (typeof window !== "undefined") {
    (window as any).__ottRenderMedia = showMediaList1;
    (window as any).__ottUpdateMediaControls = updateMediaPlaybackControls;
}

/** Navigate legacy provider VOD URLs, fXML submenus and local history/favorites. */
export function mediaList(target: MediaTarget | null): void {
    (window as any).__ottMedia.open(target);
}

/* ---------------------------------------------------------------------------
 * Select value dialog
 * --------------------------------------------------------------------------- */

/**
 * Handle a click on a value option in the `selectValue` grid. If the clicked value is
 * already selected, dispatches ENTER to confirm it.
 *
 * @param e - The zero-based index of the clicked option.
 * @returns void
 * @sideeffect Updates highlight styles for old and new selection. The grid consumes the DOM click.
 *             Calls `aboutKeyHandler(keys.ENTER)` if clicking the already-selected item.
 */
export function clickVal(e: number): void {
    if (_curVal === e && aboutKeyHandler) {
        aboutKeyHandler((window as any).keys.ENTER);
        return;
    }
    $("#ik" + _curVal).css({ "background-color": "", color: "" });
    _curVal = e;
    var key = $("#ik" + _curVal);
    key.css({
        "background-color": (window as any).curColorB,
        color: (window as any).curColor,
    });
    if (listDetailElement) listDetailElement.innerHTML = key.html() || "";
}

/**
 * Show a grid-based value selection dialog in `#listAbout`. Values are laid out in a dynamically
 * calculated column count based on the longest text. Supports arrow-key navigation and ENTER to confirm.
 *
 * @param t - An object with `.name` (dialog title), `.values` (array of value strings), and `.val` (current value index).
 * @returns void
 * @sideeffect Calls `saveListPanelState()`. Sets caption/footer/detail. Shows `#listAbout` with a grid of clickable divs.
 *             Registers `aboutKeyHandler` for keyboard navigation.
 * @analysis Values containing "@@@" are filtered out. Column count is calculated by measuring the widest label
 *             text against `#listAbout` width. UP/DOWN/LEFT/RIGHT navigate the grid; ENTER saves the value;
 *             RETURN/EXIT discards and calls `restoreListPanelState()`.
 */
export function selectValue(t: any): void {
    function paintSelectedValue(): void {
        var key = $("#ik" + _curVal);
        key.css({
            "background-color": (window as any).curColorB,
            color: (window as any).curColor,
        });
        if (listDetailElement) listDetailElement.innerHTML = key.html() || "";
    }
    var r = t.values.filter(function (v: any) {
        return v !== "@@@";
    });
    _curVal = r.indexOf(t.values[t.val]);
    if (_curVal < 0) _curVal = 0;
    saveListPanelState();
    if (listCaptionElement) listCaptionElement.textContent = t.name;
    if (listFooterElement)
        listFooterElement.innerHTML =
            renderButtonHint(keys.RETURN, strRETURN, "Close") +
            renderButtonHint(keys.ENTER, strENTER, "Set");
    if (listDetailElement) listDetailElement.innerHTML = "";

    /* Measure longest text to calculate column count */
    var testEl = $("#testFont");
    var maxW = 0;
    for (var i = 0; i < r.length; i++) {
        testEl.html("&nbsp;" + r[i] + "&nbsp;");
        maxW = Math.max(maxW, testEl.width());
    }
    testEl.text("");
    var listAboutW = $("#listAbout").width();
    var n = 6;
    if (maxW > 0 && listAboutW > 0) {
        n = Math.max(
            Math.min(Math.round(listAboutW / maxW) - 1, r.length),
            Math.round(r.length / 6) + 1
        );
    }

    var lineHeight = Math.floor(
        (800 * getViewportHeightScale()) / settings.pageSize
    );

    var html = "";
    for (var i = 0; i < r.length; i++) {
        if (i % n === 0) html += "<br/>";
        html += '<div id="ik' + i + '" class="osk-key">' + r[i] + "</div>";
    }
    var grid = $("#listAbout")
        .html("<div>" + html + "</div>")
        .show()
        .children()
        .css("font-size", "larger");
    grid.find(".osk-key").css({
        lineHeight: lineHeight + "px",
        width: 98 / n + "%",
    });
    grid.on("click", ".osk-key", function (event: any) {
        event.stopPropagation();
        if (input.owner.foreground()) clickVal(Number(this.id.slice(2)));
    });
    paintSelectedValue();

    /**
     * Move the selection cursor by `delta` positions in the grid, wrapping at edges.
     *
     * @param delta - The number of positions to move (can be negative).
     * @returns void
     * @sideeffect Updates `_curVal` and highlight styles. Refreshes `listDetailElement`.
     */
    function move(delta: number): void {
        $("#ik" + _curVal).css({ "background-color": "", color: "" });
        _curVal += delta;
        if (_curVal < 0) _curVal = r.length - 1;
        if (_curVal >= r.length) _curVal = 0;
        paintSelectedValue();
    }

    var input = (window as any).__ottClassicScreenPort.setOwnedCallback(
        "about",
        function (e: number): boolean {
            switch (e) {
                case keys.UP:
                    move(
                        _curVal >= n
                            ? -n
                            : r.length -
                                  (r.length % n) +
                                  (_curVal + 1 > r.length % n ? -n : 0)
                    );
                    return true;
                case keys.DOWN:
                    move(_curVal < r.length - n ? n : -_curVal + (_curVal % n));
                    return true;
                case keys.LEFT:
                    move(
                        _curVal % n > 0
                            ? -1
                            : _curVal + n - 1 > r.length - 1
                              ? r.length - _curVal - 1
                              : n - 1
                    );
                    return true;
                case keys.RIGHT:
                    move(
                        _curVal % n < n - 1
                            ? _curVal + 1 == r.length
                                ? -_curVal % n
                                : 1
                            : -n + 1
                    );
                    return true;
                case keys.ENTER:
                    t.val = t.values.indexOf(r[_curVal]);
                /* fall through */
                case keys.RETURN:
                case keys.EXIT:
                    $("#listAbout").text("").hide();
                    restoreListPanelState();
                    showPage();
                    return true;
                default:
                    return false;
            }
        }
    );
}

/* ---------------------------------------------------------------------------
 * Settings helpers
 * --------------------------------------------------------------------------- */

/**
 * Show a confirmation dialog asking whether to exit the player. On confirm, saves the current
 * channel state, resets playType, and calls `stbExit()`.
 *
 * @returns void
 * @sideeffect Shows a `confirmBox`. On yes: calls `window.setCurrent()`, sets `window.playType = 0`,
 *             calls `window.stbExit()`.
 */
export function exitPortal(): void {
    var w = window as any;
    if (w.__ottRemoteInputActive) return;
    confirmBox(_("Do you want to exit player?"), function () {
        if (w.__ottRemoteInputActive) return;
        if (typeof w.setCurrent === "function")
            w.setCurrent(w.catIndex, w.primaryIndex);
        w.playType = 0;
        if (typeof w.stbExit === "function") w.stbExit();
    });
    var port = w.__ottClassicScreenPort;
    var owner = port && port.owner && port.owner("dialog");
    if (owner) owner.model.localOnlyInput = true;
}

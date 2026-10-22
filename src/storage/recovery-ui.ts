import { _ } from "../localization";
import { recoverStoredSettings, settingsRecoveryRequired } from "./index";

/** Minimal boot UI: no hydrated settings, player, jQuery or normal UI needed. */
export function showSettingsRecovery(): boolean {
    if (!settingsRecoveryRequired()) return false;
    if (document.getElementById("settingsRecovery")) return true;
    var root = document.createElement("section");
    root.id = "settingsRecovery";
    root.setAttribute("role", "alertdialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", _("Player could not start"));
    root.style.cssText =
        "position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;" +
        "background:#111;color:#fff;padding:2em;overflow:auto;font:24px sans-serif;";
    var title = document.createElement("h1");
    title.textContent = _("Player could not start");
    root.appendChild(title);
    var status = document.createElement("p");
    status.setAttribute("role", "status");
    root.appendChild(status);
    var controls = document.createElement("div");
    root.appendChild(controls);
    document.body.appendChild(root);
    var buttons: HTMLButtonElement[] = [];
    var actions: (() => void)[] = [];
    var selected = 0;
    var confirming = false;
    function select(index: number, focus = true): void {
        selected = (index + buttons.length) % buttons.length;
        buttons.forEach(function (button, i) {
            button.style.outline = i === selected ? "3px solid #ffc34d" : "";
        });
        if (focus) buttons[selected].focus();
    }
    function recover(clear: boolean): void {
        try {
            recoverStoredSettings(clear);
            window.location.reload();
        } catch (_error) {
            // Never print journal text, credential values or storage exceptions.
            render(false);
            status.textContent = _("ERROR!") + " " + _("Settings");
        }
    }
    function render(confirm: boolean): void {
        confirming = confirm;
        status.textContent = confirm
            ? _("Clear all settings?")
            : _("ERROR!") + " " + _("Settings");
        controls.textContent = "";
        buttons = [];
        var labels = confirm
            ? [_("Cancel"), _("Clear settings")]
            : [_("Retry"), _("Clear settings")];
        actions = confirm
            ? [
                  function () {
                      render(false);
                  },
                  function () {
                      recover(true);
                  },
              ]
            : [
                  function () {
                      recover(false);
                  },
                  function () {
                      render(true);
                  },
              ];
        labels.forEach(function (label, index) {
            var button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.style.cssText =
                "font:inherit;padding:.5em;margin:.5em;border:2px solid #aaa;" +
                "background:#222;color:#fff;";
            button.onclick = function () {
                actions[index]();
            };
            button.onfocus = function () {
                select(index, false);
            };
            controls.appendChild(button);
            buttons.push(button);
        });
        // Confirmation starts on Cancel, so a held OK can never erase settings.
        select(0);
    }
    window.addEventListener(
        "keydown",
        function (event: KeyboardEvent) {
            var w = window as any;
            var keys = w.keys || {};
            var key =
                typeof w.stbEventToKeyCode === "function"
                    ? w.stbEventToKeyCode(event)
                    : event.keyCode;
            var action: (() => void) | undefined;
            if (key === 13 || key === keys.ENTER) action = actions[selected];
            else if (
                key === 27 ||
                key === 8 ||
                key === keys.RETURN ||
                key === keys.EXIT
            )
                action = function () {
                    if (confirming) render(false);
                    else select(0);
                };
            else if (
                key === 37 ||
                key === 38 ||
                key === keys.LEFT ||
                key === keys.UP ||
                (key === 9 && event.shiftKey)
            )
                action = function () {
                    select(selected - 1);
                };
            else if (
                key === 39 ||
                key === 40 ||
                key === 9 ||
                key === keys.RIGHT ||
                key === keys.DOWN
            )
                action = function () {
                    select(selected + 1);
                };
            if (!action) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!event.repeat) action();
        },
        true
    );
    render(false);
    return true;
}

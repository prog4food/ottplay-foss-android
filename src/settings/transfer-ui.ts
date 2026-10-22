/** Settings transfer/editor boundary; legacy window bindings live in index.ts. */
/**
 * Export settings UI handler — serialises settings + stable channel libraries
 * to JSON envelope v2. Native shells show a copyable backup; browsers download it.
 *
 * Side effects: Creates a Blob download; no storage mutation.
 */
export function exportSettingsUI(): void {
    var w = window as any;
    function notice(key: string): void {
        if (typeof w.showShift === "function") w.showShift(w._(key));
    }
    if (w.__ottRemoteInputActive) return;
    if (typeof w.exportSettings !== "function") return;
    var jsonStr: string;
    try {
        jsonStr = w.exportSettings();
    } catch (_error) {
        notice("Settings could not be exported");
        return;
    }
    if (
        typeof w.__TAURI__ !== "undefined" ||
        typeof w.Capacitor !== "undefined"
    ) {
        // These native shells do not provide a Blob download destination.
        // Keep the JSON available even when clipboard permission is denied.
        w.saveListPanelState();
        var previousHandler = w.aboutKeyHandler;
        var caption = document.getElementById("listCaption");
        var detail = document.getElementById("listDetail");
        var footer = document.getElementById("listPodval");
        if (caption) caption.textContent = w._("Export settings");
        if (detail)
            detail.textContent = w._(
                "Copy the JSON to keep a backup. Use Import settings to restore it."
            );
        if (footer)
            footer.innerHTML =
                w.renderButtonHint(w.keys.RETURN, w.strRETURN, "Close") +
                w.renderButtonHint(w.keys.ENTER, w.strENTER, "Copy JSON");
        $("#listAbout")
            .show()
            .html(
                '<textarea id="settingsExportText" readonly style="box-sizing:border-box;width:100%;height:100%;resize:none;white-space:pre;overflow:auto;background:#17171c;color:inherit;font:inherit;user-select:text;-webkit-user-select:text;"></textarea>'
            );
        var output = document.getElementById(
            "settingsExportText"
        ) as HTMLTextAreaElement;
        output.setAttribute("aria-label", w._("Settings JSON"));
        output.value = jsonStr;
        var backupOpen = true;
        var selectBackup = function (): void {
            output.focus();
            output.select();
        };
        var copyBackup = function (): void {
            function manualCopy(): void {
                if (!backupOpen) return;
                selectBackup();
                notice(
                    "Copy the selected JSON with your device's copy command"
                );
            }
            try {
                if (
                    navigator.clipboard &&
                    typeof navigator.clipboard.writeText === "function"
                ) {
                    navigator.clipboard.writeText(jsonStr).then(function () {
                        if (!backupOpen) return;
                        notice("Settings copied");
                    }, manualCopy);
                    return;
                }
            } catch (_error) {}
            manualCopy();
        };
        var closeBackup = function (): void {
            backupOpen = false;
            $("#listAbout").hide().text("");
            w.aboutKeyHandler = previousHandler;
            w.restoreListPanelState();
        };
        w.aboutKeyHandler = function (key: number): boolean {
            if (key === w.keys.RETURN || key === w.keys.EXIT) {
                closeBackup();
                return true;
            }
            if (key === w.keys.ENTER) {
                copyBackup();
                return true;
            }
            return false;
        };
        output.addEventListener("keydown", function (event: KeyboardEvent) {
            if (event.key === "Escape" || event.keyCode === 27) {
                event.preventDefault();
                event.stopPropagation();
                closeBackup();
            } else if (event.key === "Enter" || event.keyCode === 13) {
                event.preventDefault();
                event.stopPropagation();
                copyBackup();
            }
        });
        selectBackup();
        return;
    }
    var blob = new Blob([jsonStr], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ottplay-settings-v2.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    notice("Settings download requested");
}

/** Open the shared text editor and finish teardown before applying a saved value. */
export function editSettingsText(
    caption: string,
    value: string,
    onSave: (value: string) => void,
    onClose?: (saved: boolean) => void,
    secret?: boolean
): void {
    var w = window as any;
    if (typeof w.showEditKey2 !== "function") {
        var result = prompt(caption + ":", secret ? "" : value);
        if (onClose) onClose(result !== null);
        if (result !== null) onSave(result);
        return;
    }
    var restore = w.restoreListPanelState;
    var previousSetEdit = w.setEdit;
    var savedValue: string | undefined;
    w.editCaption = caption;
    w.editvar = value;
    w.setEdit = function (): void {
        savedValue = String(w.editvar);
    };
    w.restoreListPanelState = function (): void {
        w.restoreListPanelState = restore;
        w.setEdit = previousSetEdit;
        restore();
        if (onClose) onClose(savedValue !== undefined);
        // Import opens a confirmation dialog: do not let editor teardown close it.
        if (savedValue !== undefined) onSave(savedValue);
    };
    w.showEditKey2(undefined, secret);
}

/** Read pasted settings JSON, then use the existing validated import/confirmation flow. */
export function importSettingsUI(): void {
    var w = window as any;
    if (w.__ottRemoteInputActive) return;
    if (typeof w.importSettings !== "function") return;
    editSettingsText(w._("Paste settings JSON"), "", function (value) {
        if (value.trim()) w.importSettings(value.trim());
    });
}

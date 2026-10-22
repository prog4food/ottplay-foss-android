import { beginSettingsDraft, settingsSchema } from "./index";

/** Stable row IDs are independent of filtering, position and translated labels. */
export function createSettingsEditor(host: any, rows: any[]) {
    if (host.__ottSettingsEditor) host.__ottSettingsEditor.cancel();
    var draft = beginSettingsDraft();
    var open = true;
    var owner: any = null;
    function active(): boolean {
        return (
            open &&
            draft.active() &&
            host.__ottSettingsEditor === editor &&
            (!owner || owner.active())
        );
    }
    function get(id: string): any {
        return draft.get(id);
    }
    function set(id: string, value: any): boolean {
        return active() && draft.set(id, value);
    }
    function errorDetail(): string {
        switch (draft.errorCode()) {
            case "source_changed":
                return host._("Settings source changed");
            case "concurrent_edit":
                return host._("Settings changed while editing");
            case "backup_changed":
                return host._("Backup state changed");
            case "write_rejected":
                return host._("Settings storage rejected write");
            case "invalid_setting":
                return host._("Invalid setting");
        }
        return "";
    }
    var editor = {
        active: active,
        attach: function () {
            var port = host.__ottClassicScreenPort;
            if (port && typeof port.listOwner === "function") {
                owner = port.listOwner();
                if (owner && typeof owner.own === "function")
                    owner.own(editor.cancel);
            }
        },
        cancel: function () {
            open = false;
            draft.cancel();
        },
        get: get,
        save: function (): boolean {
            if (!active() || host.listArray !== rows) return false;
            if (!draft.commit()) {
                var detail = errorDetail();
                if (host.showShift)
                    host.showShift(
                        host._("Settings could not be saved") +
                            (detail ? ": " + detail : "")
                    );
                return false;
            }
            open = false;
            return true;
        },
        set: set,
    };
    host.__ottSettingsEditor = editor;
    rows.forEach(function (row) {
        if (!row.settingId) return;
        var id = row.settingId;
        if (
            !settingsSchema.some(function (entry) {
                return entry.id === id;
            })
        )
            throw new Error("Unknown setting row: " + id);
        Object.defineProperty(row, "val", {
            configurable: true,
            enumerable: true,
            get: function () {
                var value = get(id);
                if (row.optionId)
                    return value.indexOf(row.optionId) < 0 ? 0 : 1;
                if (row.settingValues) return row.settingValues.indexOf(value);
                return typeof value === "number"
                    ? value - (row.settingOffset || 0)
                    : value;
            },
            set: function (value) {
                if (row.optionId) {
                    var hidden: string[] = get(id),
                        index = hidden.indexOf(row.optionId);
                    if (value && index < 0) hidden.push(row.optionId);
                    if (!value && index >= 0) hidden.splice(index, 1);
                    set(id, hidden);
                } else
                    set(
                        id,
                        row.settingValues
                            ? row.settingValues[value]
                            : typeof value === "number"
                              ? value + (row.settingOffset || 0)
                              : value
                    );
            },
        });
    });
    // Compatibility ports used only by the nested colour editor. Their backing
    // values belong to this draft; cancelling the page discards every colour edit.
    [
        ["eSHLcolor", "highlightColor"],
        ["eSHLcolSel", "highlightColorSel"],
        ["eSHLcolorB", "highlightColorB"],
    ].forEach(function (pair) {
        Object.defineProperty(host, pair[0], {
            configurable: true,
            get: function () {
                return get(pair[1]);
            },
            set: function (value) {
                // Accepting a custom colour selects Classic in this same draft.
                // Cancelling either picker or settings never changes the theme.
                if (set(pair[1], value)) set("interfaceTheme", 0);
            },
        });
    });
    return editor;
}

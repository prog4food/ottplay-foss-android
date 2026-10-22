// Built-in provider actions inserted into popupActions persist their function
// names as menu preference IDs. Global bindings are retained by the optimizer;
// these additional names belong to closures in the main/player provider assets.
// Callbacks supplied by separately loaded scripts are never rewritten here.
const CLASSIC_PLAYER_NAME_POLICY = Object.freeze({
    retainedFunctionNames: Object.freeze([
        "changeMode",
        "edit",
        "editAddress",
        "editKey",
        "editMode",
        "editPassword",
        "editSettings",
        "editSlot",
        "editUrl",
        "editUser",
        "info",
        "loadSlot",
        "settingsMenu",
        "showDetails",
        "showSlots",
        "subscription",
    ]),
});

module.exports = { CLASSIC_PLAYER_NAME_POLICY };

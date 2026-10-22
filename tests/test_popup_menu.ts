// Minimal window shim for Node.js. src/app/state.ts reads
// window.popupArray / window.popupDetail (the documented external override
// for skinned thin clients) and window.localStorage / window.WebSocket at
// module scope, so the stub must exist before the dynamic import below.
if (!(globalThis as { window?: unknown }).window) {
    (globalThis as { window?: unknown }).window = {} as unknown;
}

import assert from "node:assert";

async function runTests() {
    const state = await import("../src/app/state.ts");
    const {
        initPopupActions,
        POPUP_ACTION_NAMES,
        POPUP_LABELS,
        popupActions,
        popupArray,
        popupDetail,
    } = state;

    assert.strictEqual(
        popupArray.length,
        20,
        "popupArray should hold the 20 default labels after importing state.ts"
    );
    assert.strictEqual(
        popupDetail.length,
        popupArray.length,
        "popupDetail must be the same length as popupArray"
    );
    assert.strictEqual(
        POPUP_ACTION_NAMES.length,
        POPUP_LABELS.length,
        "POPUP_ACTION_NAMES must be the same length as POPUP_LABELS"
    );

    const rewindIdx = popupArray.indexOf("Rewind");
    assert.ok(rewindIdx >= 0, "Rewind label must exist in popupArray");
    assert.strictEqual(
        popupDetail[rewindIdx],
        "Show rewind window",
        "Show rewind window must sit at the same index as the Rewind label"
    );

    const recordsIdx = popupArray.indexOf(
        "Show list of channel archive records"
    );
    assert.ok(recordsIdx >= 0, "archive-records label must exist");
    assert.strictEqual(
        popupDetail[recordsIdx],
        "Show list of channel archive records without duplication",
        "archive-records detail must sit at the same index as its label"
    );

    assert.strictEqual(
        popupActions.length,
        0,
        "popupActions starts empty (handlers are late-bound off window.*)"
    );

    const w = (globalThis as { window: Record<string, unknown> }).window;
    for (const name of POPUP_ACTION_NAMES) {
        w[name] = function named() {
            return name;
        };
    }

    const arraysBefore = [popupActions, popupArray, popupDetail];
    const allResolved = initPopupActions();

    assert.ok(
        allResolved,
        "initPopupActions should report all 20 handlers resolved"
    );
    assert.strictEqual(
        popupActions.length,
        20,
        "popupActions must hold all 20 handlers after init"
    );
    assert.strictEqual(
        popupActions.length,
        popupArray.length,
        "popupActions.length must equal popupArray.length after init"
    );
    assert.strictEqual(
        popupDetail.length,
        popupArray.length,
        "popupDetail.length must equal popupArray.length after init"
    );
    for (let i = 0; i < popupActions.length; i++) {
        assert.strictEqual(typeof popupActions[i], "function");
        assert.strictEqual(popupActions[i], w[POPUP_ACTION_NAMES[i]]);
    }

    assert.strictEqual(arraysBefore[0], popupActions);
    assert.strictEqual(arraysBefore[1], popupArray);
    assert.strictEqual(arraysBefore[2], popupDetail);

    const marker = function providerEntry() {
        return "marker";
    };
    popupActions.splice(15, 0, marker);
    initPopupActions();
    assert.strictEqual(popupActions.length, 21);
    assert.strictEqual(popupActions[15], marker);
    popupActions.splice(15, 1);

    console.log("Popup menu tests passed!");
}

runTests().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});

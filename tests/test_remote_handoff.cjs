const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const code = ts.transpileModule(
    fs.readFileSync("src/commands/remote-handoff.ts", "utf8"),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
require("acorn").parse(code, { ecmaVersion: 5 });
const ctx = { exports: {} };
vm.runInNewContext(code, ctx);
let plays = [],
    locked = false;
const now = Math.floor(Date.now() / 1000);
const state = {
    generation: 1,
    phase: "playing",
    position: 30,
    target: { channelId: "7", kind: "live", sourceId: "xtream@account" },
};
const host = {
    __ottActiveProviderDriver: { id: "xtream" },
    __ottClassicArchive: { open: (value) => plays.push(["archive", value]) },
    __ottClassicPlayback: { snapshot: () => state },
    __ottParental: { needs: () => locked },
    __ottSourceIdentity: { current: () => "xtream@account" },
    cats: { all: [7] },
    catsArray: ["all"],
    channels: {
        7: {
            channel_name: "Fixture",
            itemId: "xtream:stream:100",
            rec: 24,
            url: "https://secret.invalid",
        },
    },
    getArchiveUrl: () => "https://target-resolved.invalid/archive",
    parentalArray: [],
    playChannel: (category, index) => plays.push(["live", category, index]),
    setCurrent: (category, index) => plays.push(["select", category, index]),
};
function call(action, params) {
    let result;
    ctx.exports.executeRemoteHandoff(
        host,
        { action: "playback_handoff_" + action, params },
        (value) => {
            result = value;
        }
    );
    return JSON.parse(JSON.stringify(result));
}
const exported = call("export", {});
assert.equal(exported.status, "ok");
assert(!JSON.stringify(exported).includes("secret"));
const handoff = exported.data.handoff;
assert.equal(call("import", { handoff }).status, "ok");
assert.deepEqual(plays, [["live", 0, 0]]);
assert.equal(
    call("import", { handoff: { ...handoff, source_id: "other" } }).data.error,
    "source_mismatch"
);
assert.equal(
    call("import", { handoff: { ...handoff, url: "https://evil.invalid" } })
        .data.error,
    "invalid_request"
);
assert.equal(
    call("import", { handoff: { ...handoff, item_id: "я".repeat(257) } }).data
        .error,
    "invalid_request"
);
assert.equal(
    call("import", { handoff: { ...handoff, item_id: "\ud800" } }).data.error,
    "invalid_request"
);
host.channels[8] = { ...host.channels[7] };
assert.equal(call("import", { handoff }).data.error, "ambiguous_item");
delete host.channels[8];
host.parentalArray = [7];
locked = true;
assert.equal(call("import", { handoff }).data.error, "policy_denied");
locked = false;
state.target.kind = "archive";
state.target.archiveStart = now - 300;
const archive = call("export", {}).data.handoff;
assert.equal(archive.archive_start, now - 270);
assert.equal(call("import", { handoff: archive }).status, "ok");
assert.deepEqual(plays.slice(-2), [
    ["select", 0, 0],
    ["archive", now - 270],
]);
const beforeFailedResolution = plays.length;
host.getArchiveUrl = () => "";
assert.equal(
    call("import", { handoff: archive }).data.error,
    "item_unavailable"
);
assert.equal(
    plays.length,
    beforeFailedResolution,
    "An unavailable archive must not mutate selection or acknowledge dispatch"
);
host.getArchiveUrl = () => {
    throw Error("private provider error");
};
assert.deepEqual(call("import", { handoff: archive }), {
    data: { error: "playback_failed" },
    status: "rejected",
});
assert.equal(plays.length, beforeFailedResolution);
host.getArchiveUrl = () => "https://target-resolved.invalid/archive";
assert.equal(
    call("import", { handoff: { ...archive, archive_start: now + 60 } }).data
        .error,
    "item_unavailable"
);
state.target.kind = "vod";
assert.equal(call("export", {}).data.error, "no_current_item");
host.__ottKiosk = { enabled: () => true };
assert.equal(call("import", { handoff }).data.error, "policy_denied");
console.log(
    "PASS handoff: exact source and unique stable ID, fresh target dispatch, archive position/window, kiosk/PIN, redaction"
);

// Real driver records differ: the classic M3U codec has no itemId, and a
// legacy Stalker identity may contain its credential-bearing stream URL.
const coreContext = vm.createContext({ encodeURIComponent, URL });
coreContext.window = coreContext;
const core = require("./helpers/shared-core-runtime.cjs")(coreContext, {
    vendorOnly: true,
});
vm.runInContext(
    ts.transpileModule(
        fs.readFileSync("src/provider/source-identity.ts", "utf8"),
        {
            compilerOptions: { target: ts.ScriptTarget.ES5 },
        }
    ).outputText,
    coreContext
);
function realHost(
    provider,
    channels,
    selected,
    sourceUrl = "https://list.invalid/get?password=PRIVATE_FIXTURE"
) {
    const calls = [];
    const host = {
        __ottActiveProviderDriver: { id: provider },
        __ottParental: { needs: () => false },
        __ottSourceIdentity: coreContext.__ottSourceIdentity,
        cats: { all: Object.keys(channels) },
        catsArray: ["all"],
        channels,
        m3uArr: { active: 0, M3Us: [{ www: sourceUrl }] },
        p_pref: provider,
        parentalArray: [],
        playChannel(category, index) {
            const id = this.cats[this.catsArray[category]][index];
            calls.push({ id, url: this.channels[id].url });
        },
    };
    host.__ottClassicPlayback = {
        snapshot: () => ({
            phase: "playing",
            position: 0,
            target: {
                channelId: String(selected),
                kind: "live",
                sourceId: host.__ottSourceIdentity.current(host),
            },
        }),
    };
    function invoke(action, params = {}) {
        let response;
        ctx.exports.executeRemoteHandoff(
            host,
            { action: "playback_handoff_" + action, params },
            (value) => {
                response = value;
            }
        );
        return JSON.parse(JSON.stringify(response));
    }
    return { calls, host, invoke };
}
function playlist(
    id,
    name,
    url = "https://video.invalid/live?token=PRIVATE_FIXTURE"
) {
    return core.parseProviderPlaylist(
        '#EXTM3U\n#EXTINF:-1 tvg-id="fixture" group-title="Demo",' +
            name +
            "\n" +
            url +
            "\n",
        "m3u",
        () => id,
        0
    ).channels;
}
{
    const original = realHost("m3u", playlist(101, "Original title"), 101);
    const receiver = realHost("m3u", playlist(909, "Translated title"), 909);
    assert.equal(
        original.host.channels[101].itemId,
        undefined,
        "Use the actual classic M3U shape"
    );
    const result = original.invoke("export");
    assert.equal(result.status, "ok");
    const handoff = result.data.handoff;
    assert.match(handoff.item_id, /^channel-v1:[0-9a-f]{8}\.[0-9a-f]{8}$/);
    assert(!JSON.stringify(result).includes("PRIVATE_FIXTURE"));
    assert(!JSON.stringify(result).includes("https:"));
    assert.equal(receiver.invoke("import", { handoff }).status, "ok");
    assert.equal(
        receiver.calls[0].id,
        "909",
        "Receiver resolves its own numeric channel mapping"
    );
    receiver.host.parentalArray = [909];
    receiver.host.__ottParental.needs = () => true;
    assert.equal(
        receiver.invoke("import", { handoff }).data.error,
        "policy_denied"
    );
    receiver.host.parentalArray = [];
    receiver.host.channels[910] = { ...receiver.host.channels[909] };
    assert.equal(
        receiver.invoke("import", { handoff }).data.error,
        "ambiguous_item"
    );
    assert.equal(receiver.invoke("export").data.error, "ambiguous_item");
    delete receiver.host.channels[910];
    receiver.host.channels[909].url =
        "https://video.invalid/changed?token=OTHER";
    assert.equal(
        receiver.invoke("import", { handoff }).data.error,
        "item_unavailable",
        "A changed signed URL cannot guess another matching channel"
    );
    receiver.host.m3uArr.M3Us[0].www += "&other-account=1";
    assert.equal(
        receiver.invoke("import", { handoff }).data.error,
        "source_mismatch"
    );
}
{
    const protocol = new core.LegacyStalkerClient(
        "https://portal.invalid",
        "02:00:00:00:00:01"
    );
    assert.equal(protocol.accept({ result: {} }), null);
    assert.equal(
        protocol.accept({
            result: [
                {
                    name: "No provider ID",
                    url: "https://video.invalid/live?token=PRIVATE_FIXTURE",
                },
            ],
        }),
        null
    );
    const channel = protocol.channelCatalog()[0];
    assert(
        channel.itemId.includes("PRIVATE_FIXTURE"),
        "Exercise the real raw-URL Stalker identity fallback"
    );
    const original = realHost("stalker", { 5: channel }, 5);
    const receiver = realHost("stalker", { 6: { ...channel } }, 6);
    const result = original.invoke("export");
    assert.equal(result.status, "ok");
    assert(!JSON.stringify(result).includes("PRIVATE_FIXTURE"));
    assert(!JSON.stringify(result).includes("https:"));
    assert.equal(
        receiver.invoke("import", { handoff: result.data.handoff }).status,
        "ok"
    );
    assert.equal(receiver.calls[0].id, "6");
}
console.log(
    "PASS handoff real driver codecs: M3U source/row identity, renamed/reindexed channels, URL secrecy, duplicate rejection and Stalker fallback"
);

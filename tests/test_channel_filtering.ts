// Minimal window shim for Node.js (channels module reads window.* directly).
// No jsdom dep — only stubs what src/channels/index.ts actually accesses.
declare global {
    // eslint-disable-next-line no-var
    var window: {
        stbGetItem: (key: string) => string | null;
        _: (s: string) => string;
        editvar: string;
        chSearch: string;
    };
}
// jQuery $ stub — channels module calls $("#listPopUp").hide() during reset
const noop = () => noop;
const jqueryStub = (() => {
    const handler: ProxyHandler<object> = {
        apply: () => jqueryStub,
        get: () => jqueryStub,
    };
    return new Proxy(noop, handler);
})();
(globalThis as { $?: unknown }).$ = jqueryStub;

if (!globalThis.window) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.window = {
        _: (s: string) => s,
        chSearch: "",
        editvar: "",
        stbGetItem: () => null,
    } as any;
}

import vm from "node:vm";
import assert from "assert";
import sharedCoreRuntime from "./helpers/shared-core-runtime.cjs";

sharedCoreRuntime(vm.createContext({ window: globalThis.window }));

async function getModule() {
    return await import("../src/channels/index.ts");
}

async function runTests() {
    const ch = await getModule();
    const {
        setSearchText,
        getFilteredHistory,
        getFilteredChannelList,
        searchHistoryChannel,
        historySearchText,
    } = await import("../src/channels/search.ts");
    const { medHistory, curList, channels } = ch;

    // Classic bundles share these bindings; expose the same state to ESM leaf helpers.
    Object.assign(globalThis, { channels, curList, medHistory });

    // Helper to reset state
    function resetState() {
        medHistory.splice(0);
        curList.splice(0);
        // Clear channels
        for (const key of Object.keys(channels)) {
            delete channels[key];
        }
        // Reset the filter strings directly; searchMedia opens a provider VOD search.
        searchHistoryChannel("");
        setSearchText("");
    }

    // Test getFilteredHistory
    {
        resetState();
        const result = getFilteredHistory();
        assert.deepStrictEqual(
            result,
            [],
            "getFilteredHistory should return empty array when medHistory is empty"
        );
    }

    {
        resetState();
        medHistory.push(
            { ch_id: 1, name: "Channel 1", title: "Show 1" },
            { ch_id: 2, name: "Channel 2", title: "Show 2" }
        );
        const result = getFilteredHistory();
        assert.deepStrictEqual(
            result,
            medHistory,
            "getFilteredHistory should return all medHistory when historySearchText is empty"
        );
    }

    {
        resetState();
        medHistory.push(
            { ch_id: 1, name: "BBC News", title: "News Hour" },
            { ch_id: 2, name: "EuroSport", title: "Football Live" }
        );
        searchHistoryChannel("bbc");
        const result = getFilteredHistory();
        assert.strictEqual(
            result.length,
            1,
            "getFilteredHistory should filter by name (bbc)"
        );
        assert.strictEqual(
            result[0].name,
            "BBC News",
            "getFilteredHistory should match the correct channel by name"
        );
    }

    {
        resetState();
        medHistory.push(
            { ch_id: 1, name: "BBC News", title: "News Hour" },
            { ch_id: 2, name: "EuroSport", title: "Football Live" }
        );
        searchHistoryChannel("football");
        const result = getFilteredHistory();
        assert.strictEqual(
            result.length,
            1,
            "getFilteredHistory should filter by title (football)"
        );
        assert.strictEqual(
            result[0].title,
            "Football Live",
            "getFilteredHistory should match the correct channel by title"
        );
    }

    {
        resetState();
        medHistory.push({ ch_id: 1, name: "BBC News", title: "News Hour" });
        searchHistoryChannel("BBC");
        const result = getFilteredHistory();
        assert.strictEqual(
            result.length,
            1,
            "getFilteredHistory should be case-insensitive for name"
        );
    }

    {
        resetState();
        medHistory.push({ ch_id: 1, name: "BBC News", title: "News Hour" });
        searchHistoryChannel("CNN");
        const result = getFilteredHistory();
        assert.deepStrictEqual(
            result,
            [],
            "getFilteredHistory should return empty array when no match"
        );
    }

    // Test getFilteredChannelList
    {
        resetState();
        const result = getFilteredChannelList();
        assert.deepStrictEqual(
            result,
            [],
            "getFilteredChannelList should return empty array when curList is empty"
        );
    }

    {
        resetState();
        curList.push(1, 2, 3);
        channels[1] = { ch_id: 1, channel_name: "CNN", name: "CNN" };
        channels[2] = { ch_id: 2, channel_name: "BBC", name: "BBC One" };
        channels[3] = { ch_id: 3, channel_name: "ESPN", name: "ESPN" };
        const result = getFilteredChannelList();
        assert.deepStrictEqual(
            result,
            [1, 2, 3],
            "getFilteredChannelList should return all curList when searchText is empty"
        );
    }

    {
        resetState();
        curList.push(1, 2, 3);
        channels[1] = { ch_id: 1, channel_name: "CNN", name: "CNN" };
        channels[2] = { ch_id: 2, channel_name: "BBC", name: "BBC One" };
        channels[3] = { ch_id: 3, channel_name: "ESPN", name: "ESPN" };
        setSearchText("bbc");
        const result = getFilteredChannelList();
        assert.deepStrictEqual(
            result,
            [2],
            "getFilteredChannelList should filter by channel_name (bbc)"
        );
    }

    {
        resetState();
        curList.push(1, 2, 3);
        channels[1] = { ch_id: 1, channel_name: "CNN", name: "CNN" };
        channels[2] = { ch_id: 2, channel_name: "BBC", name: "BBC One" };
        channels[3] = { ch_id: 3, channel_name: "ESPN", name: "ESPN" };
        setSearchText("espn");
        const result = getFilteredChannelList();
        assert.deepStrictEqual(
            result,
            [3],
            "getFilteredChannelList should filter by name (espn)"
        );
    }

    {
        resetState();
        curList.push(1, 2);
        channels[1] = { ch_id: 1, channel_name: "CNN", name: "CNN" };
        channels[2] = { ch_id: 2, channel_name: "BBC", name: "BBC One" };
        setSearchText("CNN");
        const result = getFilteredChannelList();
        assert.deepStrictEqual(
            result,
            [1],
            "getFilteredChannelList should be case-insensitive for channel_name"
        );
    }

    {
        resetState();
        curList.push(1, 2);
        channels[1] = { ch_id: 1, channel_name: "CNN", name: "CNN" };
        channels[2] = { ch_id: 2, channel_name: "BBC", name: "BBC One" };
        setSearchText("Fox");
        const result = getFilteredChannelList();
        assert.deepStrictEqual(
            result,
            [],
            "getFilteredChannelList should return empty array when no match"
        );
    }

    console.log("Channel filtering tests passed!");
}

runTests().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});

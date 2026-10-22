"use strict";
const assert = require("node:assert/strict");

// Exercise the delivered driver, transaction and ownership code. Callers supply
// only storage and HTTP ports; no source modules replace artifact implementations.
function assertCredentialReentry(host, saved, requests) {
    const lifetime = host.__ottProviderRuntime.createRegistry();
    const mount = (id) =>
        host.__ottProviderDrivers.mount(host, id, lifetime.activate(id));
    const read = host.stbGetItem,
        write = host.stbSetItem,
        project = host.__ottChannelCatalog.project;
    const config = {
        password: "old-pin",
        server: "https://old-account.test",
        username: "old-user",
    };
    const next = { ...config, username: "new-user" };
    try {
        if (host.__ottProviderDrivers.registry.has("1ott")) {
            for (const rejectRollback of [false, true]) {
                saved.set("1ottid", "old-user");
                saved.set("1ottpin", "old-pin");
                const driver = mount("1ott"),
                    start = requests.length;
                let entered = false;
                host.stbSetItem = (key, value) => {
                    if (
                        rejectRollback &&
                        entered &&
                        key === "1ottid" &&
                        value === "old-user"
                    )
                        throw new Error("rollback rejected");
                    write(key, value);
                    if (!entered && key === "1ottid" && value === "new-user") {
                        entered = true;
                        (rejectRollback ? driver : mount("1ott")).load(
                            () => {}
                        );
                    }
                };
                let saveResult;
                if (rejectRollback)
                    assert.throws(() => driver.saveCredentials(next));
                else saveResult = driver.saveCredentials(next);
                assert(entered, "storage reentry was exercised");
                assert.equal(requests.length, start + (rejectRollback ? 0 : 1));
                for (const request of requests.slice(start)) {
                    assert(!request.settings.url.includes("/new-user/old-pin"));
                    assert(request.settings.url.includes("/old-user/old-pin"));
                }
                if (!rejectRollback) assert.equal(saveResult, false);
                host.stbSetItem = write;
            }
        }

        saved.set("xtreamxtream_data", JSON.stringify(config));
        const driver = mount("xtream");
        let completed = 0;
        driver.load(() => completed++);
        const pending = requests.at(-1);
        host.__ottChannelCatalog.project = (...args) => {
            const value = project(...args);
            driver.saveCredentials(next);
            return value;
        };
        pending.resolve({ live_streams: [{ name: "Retired", stream_id: 42 }] });
        assert.equal(driver.credentials().username, "new-user");
        assert.equal(completed, 0, "retired projection cannot complete");
        assert.equal(driver.stream(42), "", "retired catalog cannot play");
        host.__ottChannelCatalog.project = project;

        for (const change of ["source", "save", "load"]) {
            saved.set("xtreamxtream_data", JSON.stringify(config));
            const active = mount("xtream");
            active.load(() => {});
            requests.at(-1).resolve({
                live_streams: [{ name: "Current", stream_id: 42 }],
            });
            const start = requests.length;
            let entered = false,
                guideCalls = 0;
            host.stbGetItem = (key) => {
                const value = read(key);
                if (!entered && key === "xtreamxtream_data") {
                    entered = true;
                    if (change === "source") mount("demo");
                    else if (change === "save") active.saveCredentials(next);
                    else active.load(() => {});
                }
                return value;
            };
            active.guide(42, () => guideCalls++);
            assert(entered, "guide storage reentry was exercised");
            assert.equal(
                guideCalls,
                0,
                change + ": retired guide cannot complete"
            );
            assert.equal(requests.length, start + (change === "load" ? 1 : 0));
            host.stbGetItem = read;
        }
    } finally {
        host.stbGetItem = read;
        host.stbSetItem = write;
        host.__ottChannelCatalog.project = project;
        lifetime.activate("credential-test-finished");
    }
}

module.exports = { assertCredentialReentry };

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");
const { cloudSource } = require("./helpers/cloud-source-fixture.cjs");
const source = cloudSource();
acorn.parse(source, { ecmaVersion: 5 });
let passed = 0;
function fixture() {
    const dom = new JSDOM('<div id="listAbout" style="display:none"></div>', {
        runScripts: "outside-only",
        url: "https://localhost/",
    });
    const w = dom.window,
        jobs = new Map(),
        requests = [],
        stored = new Map([
            ["ordinary", "before"],
            ["obsolete", "remove"],
        ]);
    let sequence = 0,
        restarted = 0,
        mutations = 0,
        hook = null,
        reject = null;
    Object.assign(w, {
        _: (v) => v,
        clearTimeout(id) {
            jobs.delete(id);
        },
        curColor: "gold",
        host_ott: "fixture.invalid",
        host_ott_proto: "https://",
        keys: { EXIT: 27, RETURN: 8 },
        m3uArr: {
            active: 0,
            M3Us: [
                { www: "https://one.invalid/list" },
                { www: "https://two.invalid/list" },
            ],
        },
        p_pref: "m3u",
        restart() {
            restarted++;
        },
        setTimeout(fn, delay) {
            jobs.set(++sequence, { delay, fn });
            return sequence;
        },
        stbClearAllItems() {
            throw new Error("Do not clear all storage");
        },
        stbDelItem(key) {
            mutations++;
            if (reject !== key) stored.delete(key);
            if (hook) hook(key, null);
        },
        stbGetAllItems: () => Object.fromEntries(stored),
        stbGetItem: (key) => stored.get(key) ?? null,
        stbSetItem(key, value) {
            mutations++;
            if (reject !== key) stored.set(key, value);
            if (hook) hook(key, value);
        },
    });
    require("./helpers/shared-core-runtime.cjs")(dom.getInternalVMContext());
    w.eval(
        fs.readFileSync(
            path.join(__dirname, "../js/jquery-1.11.1.min.js"),
            "utf8"
        )
    );
    w.$.expr.filters.visible = (e) => e.style.display !== "none";
    w.$.ajax = (options) => {
        const request = {
            abort() {
                this.aborted = true;
                options.error({ responseText: "aborted" });
            },
            aborted: false,
            options,
        };
        requests.push(request);
        return request;
    };
    require("./helpers/screen-runtime.cjs")(w);
    w.eval(source);
    function tick(delay) {
        const job = [...jobs].find((entry) => entry[1].delay === delay);
        assert(job, "scheduled timer: " + delay);
        jobs.delete(job[0]);
        job[1].fn();
    }
    const f = {
        close() {
            dom.window.close();
        },
        deliver(value) {
            const r = f.load();
            r.options.success({
                data: value === undefined ? f.payload() : value,
                status: "success",
            });
        },
        hook(fn) {
            hook = fn;
        },
        html: () => w.document.getElementById("listAbout").innerHTML,
        jobs,
        load() {
            w.cloudLoadSettings();
            requests.at(-1).options.success({ code: "transfer" });
            tick(10000);
            return requests.at(-1);
        },
        mutations: () => mutations,
        payload(value = { new: "added", ordinary: "after" }) {
            return w.__ottCloudSettingsCodec.write(value);
        },
        reject(key) {
            reject = key;
        },
        requests,
        restarts: () => restarted,
        shown: () =>
            w.document.getElementById("listAbout").style.display !== "none",
        stored,
        tick,
        w,
    };
    return f;
}
function check(name, fn) {
    const f = fixture();
    try {
        fn(f);
        passed++;
        console.log("PASS cloud session: " + name);
    } finally {
        f.close();
    }
}
check(
    "owned code remains visible, escaped and closes with remote Back",
    (f) => {
        f.w.cloudSendSettings();
        const r = f.requests[0];
        assert.equal(r.options.url, "https://fixture.invalid/swop/a.php");
        assert.equal(r.options.data.c, "send");
        r.options.success({ code: '<img src=x onerror="boom">&' });
        assert(f.shown());
        assert.equal(
            f.w.document.querySelectorAll("#listAbout img").length,
            1,
            "only the QR image"
        );
        assert(
            f.w.document
                .getElementById("listAbout")
                .textContent.includes('<img src=x onerror="boom">&')
        );
        f.w.aboutKeyHandler(8);
        assert(!f.shown());
        assert.equal(f.jobs.size, 0);
    }
);
check("load code is visible; polls after 10s then retries after 5s", (f) => {
    f.w.cloudLoadSettings();
    assert(f.shown());
    f.requests[0].options.success({ code: 123 });
    assert(f.shown());
    f.tick(10000);
    assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].options.data)), {
        c: "get",
        d: "123",
    });
    f.requests[1].options.success({ status: "forbidden" });
    f.tick(5000);
    assert.equal(f.requests.length, 3);
});
for (const stage of ["get_code", "poll", "send"])
    for (const cause of ["back", "screen", "source", "replacement", "expiry"]) {
        check(stage + " callback retired on " + cause, (f) => {
            if (stage === "send") f.w.cloudSendSettings();
            else if (stage === "poll") f.load();
            else f.w.cloudLoadSettings();
            const pending = f.requests.at(-1),
                before = [...f.stored];
            if (cause === "back") f.w.aboutKeyHandler(8);
            if (cause === "screen") f.w.__ottClassicScreenPort.invalidate();
            if (cause === "source") f.w.m3uArr.active = 1;
            if (cause === "replacement") f.w.cloudSendSettings();
            if (cause === "expiry") f.tick(600000);
            const html = f.html(),
                count = f.requests.length;
            pending.options.success(
                stage === "poll"
                    ? { data: f.payload(), status: "success" }
                    : { code: "late" }
            );
            pending.options.error({ responseText: "late error" });
            assert.equal(f.html(), html);
            assert.deepEqual([...f.stored], before);
            assert.equal(f.requests.length, count);
            assert.equal(f.restarts(), 0);
            assert(pending.aborted);
        });
    }
check("late poll timer cannot revive a replaced operation", (f) => {
    f.w.cloudLoadSettings();
    f.requests[0].options.success({ code: "old" });
    const oldTimer = [...f.jobs.values()].find((job) => job.delay === 10000).fn;
    f.w.cloudSendSettings();
    const count = f.requests.length;
    oldTimer();
    assert.equal(f.requests.length, count);
});
check("malformed complete response does not mutate storage", (f) => {
    const before = [...f.stored];
    f.deliver("corrupt-file <comment>OTT-Play Preferences</comment> trailing");
    assert.deepEqual([...f.stored], before);
    assert.equal(f.mutations(), 0);
    assert.equal(f.restarts(), 0);
});
check(
    "full replacement verifies writes and deletions, then retires authority",
    (f) => {
        f.stored.set("sLocalHttpEnabled", "1");
        f.stored.set("sLocalHttpDeviceCode", "own-code");
        const effects = [];
        f.w.__ottCommandServer = {
            configure(value) {
                assert.equal(value.enabled, false);
                effects.push("revoke");
            },
        };
        f.w.__ottClassicPlayback = {
            suspendPersistence() {
                effects.push("playback");
            },
        };
        f.w.__ottClassicGuide = {
            invalidate() {
                effects.push("guide");
            },
        };
        const request = f.load();
        const value = f.payload({
            commandServerToken: "injected",
            new: "added",
            ordinary: "after",
            sLocalHttpEnabled: "1",
        });
        request.options.success({ data: value, status: "success" });
        request.options.success({ data: value, status: "success" });
        assert.deepEqual(Object.fromEntries(f.stored), {
            new: "added",
            ordinary: "after",
        });
        assert.deepEqual(effects, ["revoke", "playback", "guide"]);
        assert.equal(f.restarts(), 1);
    }
);
for (const key of ["ordinary", "obsolete", "new"])
    check("silent storage rejection rolls back: " + key, (f) => {
        const before = Object.fromEntries(f.stored);
        f.reject(key);
        f.deliver();
        assert.deepEqual(Object.fromEntries(f.stored), before);
        assert.equal(f.restarts(), 0);
        assert(
            f.w.document
                .getElementById("listAbout")
                .textContent.includes("could not be saved")
        );
    });
check("write-then-throw rolls back the attempted key too", (f) => {
    const before = Object.fromEntries(f.stored);
    f.hook((key) => {
        if (key === "new") throw new Error("write then throw");
    });
    f.deliver();
    assert.deepEqual(Object.fromEntries(f.stored), before);
    assert.equal(f.restarts(), 0);
});
check(
    "source replacement in a setter stops further writes and restart",
    (f) => {
        f.hook(() => {
            f.w.m3uArr.active = 1;
        });
        f.deliver();
        assert.equal(f.mutations(), 1);
        assert.equal(f.restarts(), 0);
        assert.equal(f.stored.get("obsolete"), "remove");
    }
);
check("new external write survives optimistic conflict and rollback", (f) => {
    f.hook((key) => {
        if (key === "ordinary") f.stored.set("obsolete", "external");
    });
    f.deliver();
    assert.equal(f.stored.get("ordinary"), "before");
    assert.equal(f.stored.get("obsolete"), "external");
    assert.equal(f.restarts(), 0);
});
for (const effect of ["command", "playback", "guide"])
    check(
        "post-commit source change stops remaining effects: " + effect,
        (f) => {
            let later = 0;
            const change = () => {
                f.w.m3uArr.active = 1;
            };
            f.w.__ottCommandServer = {
                configure: effect === "command" ? change : () => {},
            };
            f.w.__ottClassicPlayback = {
                suspendPersistence:
                    effect === "playback"
                        ? change
                        : () => {
                              if (effect === "command") later++;
                          },
            };
            f.w.__ottClassicGuide = {
                invalidate:
                    effect === "guide"
                        ? change
                        : () => {
                              if (effect !== "guide") later++;
                          },
            };
            f.deliver();
            assert.equal(later, 0);
            assert.equal(f.restarts(), 0);
        }
    );
check("missing firmware host has a cancellable visible error", (f) => {
    delete f.w.host_ott;
    f.w.cloudLoadSettings();
    assert(f.shown());
    assert.equal(f.requests.length, 0);
    f.w.aboutKeyHandler(27);
    assert(!f.shown());
    assert.equal(f.jobs.size, 0);
});
check("native export retires any old cloud operation", (f) => {
    f.w.cloudLoadSettings();
    const old = f.requests[0];
    let exports = 0;
    f.w.__TAURI__ = {};
    f.w.exportSettingsUI = () => exports++;
    f.w.cloudSendSettings();
    old.options.success({ code: "late" });
    assert.equal(exports, 1);
    assert(old.aborted);
    assert.equal(f.jobs.size, 0);
});
check("restoring storage-backed credentials is an owned replacement", (f) => {
    f.w.p_pref = "xtream";
    f.stored.set("credentials", "old-account");
    f.w.__ottActiveProviderDriver = {
        credentials: () => ({ username: f.stored.get("credentials") }),
        id: "xtream",
    };
    f.deliver(f.payload({ credentials: "new-account", ordinary: "new-value" }));
    assert.deepEqual(Object.fromEntries(f.stored), {
        credentials: "new-account",
        ordinary: "new-value",
    });
    assert.equal(f.restarts(), 1);
});
check("failed restore rolls back storage-backed account bytes", (f) => {
    f.w.p_pref = "xtream";
    f.stored.clear();
    f.stored.set("credentials", "old-account");
    f.stored.set("ordinary", "before");
    f.w.__ottActiveProviderDriver = {
        credentials: () => ({ username: f.stored.get("credentials") }),
        id: "xtream",
    };
    f.reject("ordinary");
    f.deliver(f.payload({ credentials: "new-account", ordinary: "after" }));
    assert.deepEqual(Object.fromEntries(f.stored), {
        credentials: "old-account",
        ordinary: "before",
    });
    assert.equal(f.restarts(), 0);
});
for (const native of [false, true])
    check("newer intent created by abort owns the UI: " + native, (f) => {
        f.w.cloudLoadSettings();
        const first = f.requests[0];
        let exported = 0;
        first.abort = function () {
            this.aborted = true;
            delete f.w.__TAURI__;
            f.w.cloudSendSettings();
        };
        if (native) {
            f.w.__TAURI__ = {};
            f.w.exportSettingsUI = () => exported++;
            f.w.cloudSendSettings();
        } else f.w.cloudLoadSettings();
        assert.deepEqual(
            f.requests.map((r) => r.options.data.c),
            ["get_code", "send"]
        );
        assert.equal(exported, 0);
        f.requests[1].options.success({ code: "newer" });
        assert(
            f.w.document
                .getElementById("listAbout")
                .textContent.includes("newer")
        );
    });
check("screen created during old owner cleanup keeps its own panel", (f) => {
    f.w.aboutKeyHandler = () => true;
    const replacement = () => true;
    f.w.__ottClassicScreenPort.owner("about").own(() => {
        f.w.aboutKeyHandler = replacement;
        f.w.$("#listAbout").text("NEWER SCREEN").show();
    });
    f.w.cloudLoadSettings();
    assert.equal(f.w.aboutKeyHandler, replacement);
    assert.equal(
        f.w.document.getElementById("listAbout").textContent,
        "NEWER SCREEN"
    );
    assert.equal(f.requests.length, 0);
});
check(
    "rollback failure remains a visible failure on the same selection",
    (f) => {
        f.w.p_pref = "xtream";
        f.stored.clear();
        f.stored.set("credentials", "old-account");
        f.stored.set("ordinary", "before");
        f.w.__ottActiveProviderDriver = {
            credentials: () => ({ username: f.stored.get("credentials") }),
            id: "xtream",
        };
        f.w.stbSetItem = (key, value) => {
            if (key === "ordinary") return;
            if (value === "old-account") throw new Error("rollback rejected");
            f.stored.set(key, value);
        };
        f.deliver(f.payload({ credentials: "new-account", ordinary: "after" }));
        assert.equal(f.restarts(), 0);
        assert(f.shown());
        assert(
            f.w.document
                .getElementById("listAbout")
                .textContent.includes("could not be saved")
        );
    }
);
check("remote input cannot start cloud read/write or native export", (f) => {
    f.w.__ottRemoteInputActive = true;
    f.w.stbGetAllItems = () =>
        assert.fail("remote input cannot read private preferences");
    f.w.cloudLoadSettings();
    f.w.cloudSendSettings();
    f.w.__TAURI__ = {};
    f.w.exportSettingsUI = () =>
        assert.fail("remote input cannot start native export");
    f.w.cloudSendSettings();
    f.w.__ottRemoteInputActive = false;
    assert.equal(f.requests.length, 0);
    assert.equal(f.jobs.size, 0);
    assert.equal(f.mutations(), 0);
    assert.equal(f.restarts(), 0);
});
check(
    "rejected remote input cannot cancel an authorized local cloud transfer",
    (f) => {
        const pending = f.load();
        const count = f.requests.length;
        f.w.__ottRemoteInputActive = true;
        f.w.cloudLoadSettings();
        f.w.cloudSendSettings();
        f.w.__ottRemoteInputActive = false;
        assert.equal(f.requests.length, count);
        assert.equal(pending.aborted, false);
        assert.equal(
            f.w.__ottClassicScreenPort.owner("about").model.localOnlyInput,
            true
        );
        pending.options.success({ data: f.payload(), status: "success" });
        assert.equal(f.restarts(), 1);
    }
);
check(
    "Russian cloud errors translate UI keys while escaping external details",
    (f) => {
        const dictionary =
            require("../scripts/localization-catalog.cjs").readDictionary(
                path.join(__dirname, "../locales/russian.js")
            );
        f.w._ = (key) => dictionary[key] || key;
        f.w.cloudLoadSettings();
        f.requests.at(-1).options.error({
            responseText:
                '<img src=x onerror="attack()"> external-server-detail',
        });
        assert(dictionary["Cloud transfer failed"] !== "Cloud transfer failed");
        assert(f.html().includes(dictionary["Cloud transfer failed"]));
        assert(!f.w.document.querySelector("#listAbout img"));
        assert(
            f.w.document
                .getElementById("listAbout")
                .textContent.includes("external-server-detail")
        );
    }
);
check("successful restore notice uses the selected dictionary", (f) => {
    const dictionary =
        require("../scripts/localization-catalog.cjs").readDictionary(
            path.join(__dirname, "../locales/russian.js")
        );
    f.w._ = (key) => dictionary[key] || key;
    f.deliver();
    const key = "Settings received. Restarting player...";
    assert(dictionary[key] && dictionary[key] !== key);
    assert(
        f.w.document
            .getElementById("listAbout")
            .textContent.includes(dictionary[key])
    );
    assert.equal(f.restarts(), 1);
});
check(
    "cloud restore without PIN retains the current protected credential",
    (f) => {
        const pin =
            "pbkdf2-sha256$600000$" + "a".repeat(32) + "$" + "b".repeat(64);
        f.stored.set("parentPIN", pin);
        f.deliver();
        assert.equal(f.stored.get("parentPIN"), pin);
        assert.equal(f.restarts(), 1);
    }
);
check("cloud rollback restores the old PIN without writing plaintext", (f) => {
    f.stored.clear();
    f.stored.set("parentPIN", "2468");
    f.stored.set("ordinary", "before");
    const written = [];
    f.hook((key, value) => {
        if (key === "parentPIN") written.push(value);
    });
    f.reject("ordinary");
    f.deliver(f.payload({ ordinary: "after", parentPIN: "9876" }));
    assert.equal(f.restarts(), 0);
    assert.equal(written.length, 2);
    assert(written.every((value) => value.startsWith("pbkdf2-sha256$")));
    const [, , salt, digest] = f.stored.get("parentPIN").split("$");
    assert.equal(
        digest,
        require("node:crypto")
            .pbkdf2Sync("2468", Buffer.from(salt, "hex"), 600000, 32, "sha256")
            .toString("hex")
    );
});
check(
    "valid backup can replace a damaged PIN; failed restore retains its lock",
    (f) => {
        const protectedPin =
            "pbkdf2-sha256$600000$" + "a".repeat(32) + "$" + "b".repeat(64);
        f.stored.clear();
        f.stored.set("parentPIN", "!damaged-pin");
        f.stored.set("ordinary", "before");
        f.reject("ordinary");
        f.deliver(f.payload({ ordinary: "after", parentPIN: protectedPin }));
        assert.equal(f.stored.get("parentPIN"), "!damaged-pin");
        assert.equal(f.restarts(), 0);
        f.reject(null);
        f.deliver(f.payload({ ordinary: "after", parentPIN: protectedPin }));
        assert.equal(f.stored.get("parentPIN"), protectedPin);
        assert.equal(f.restarts(), 1);
    }
);
console.log("Cloud settings session: " + passed + " scenarios passed");

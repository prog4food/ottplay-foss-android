const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const ts = require("typescript");
function load(file, dependencies = {}, locales) {
    const source = ts.transpileModule(
        fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
    require("acorn").parse(source, { ecmaVersion: 5 });
    const module = { exports: {} };
    new Function(
        "require",
        "module",
        "exports",
        "__OTT_PHONE_LOCALES__",
        source
    )((id) => dependencies[id], module, module.exports, locales);
    return module.exports;
}
const core = load("src/swop/herenow.ts");
const w = {
    atob,
    btoa,
    crypto: webcrypto,
    location: { origin: "https://player.fixture", pathname: "/swop-input/" },
    Promise,
    Uint8Array,
};
let count = 0;
async function check(name, fn) {
    await fn();
    count++;
    console.log("PASS here.now SWOP: " + name);
}
function pair(id = "rec_01AAAAAAAAAAAAAAAAAAAAAAAA") {
    return {
        deadline: Date.now() + 600000,
        origin: w.location.origin,
        recordId: id,
        secret: core.hereNowRandom(w, 32),
        sid: core.hereNowBase64(w, core.hereNowRandom(w, 16)),
    };
}
async function main() {
    const a = pair(),
        b = pair("rec_01BBBBBBBBBBBBBBBBBBBBBBBB");
    const draft = "https://fixture.invalid/playlist?key=private-draft-test";
    const value = "https://fixture.invalid/playlist?key=private-reply-test";
    const offer = await core.hereNowSeal(w, a, "offer", {
        caption: "Title filter",
        draft,
    });
    const reply = await core.hereNowSeal(w, a, "reply", { value });
    await check(
        "public records do not expose draft, reply or pair secret",
        async () => {
            const stored = JSON.stringify({ offer, reply });
            for (const secret of [
                draft,
                value,
                core.hereNowBase64(w, a.secret),
            ])
                assert(!stored.includes(secret));
            assert.deepEqual(await core.hereNowOpen(w, a, "offer", offer), {
                caption: "Title filter",
                draft,
            });
        }
    );
    await check(
        "pair, record, role, origin and deadline all authenticate",
        async () => {
            await assert.rejects(() => core.hereNowOpen(w, b, "reply", reply));
            await assert.rejects(() => core.hereNowOpen(w, a, "reply", offer));
            for (const patch of [
                { recordId: b.recordId },
                { sid: b.sid },
                { origin: "https://elsewhere.invalid" },
                { deadline: a.deadline + 1 },
            ])
                await assert.rejects(() =>
                    core.hereNowOpen(w, { ...a, ...patch }, "reply", reply)
                );
        }
    );
    await check(
        "tamper is rejected; sixteen concurrent polls accept exactly once",
        async () => {
            const delivered = [];
            const receiver = core.hereNowReceiver(
                w,
                a,
                () => false,
                (value) => delivered.push(value)
            );
            const box = JSON.parse(reply);
            box.ciphertext =
                (box.ciphertext[0] === "A" ? "B" : "A") +
                box.ciphertext.slice(1);
            assert.equal(
                await receiver.receive(JSON.stringify(box)),
                "rejected"
            );
            const results = await Promise.all(
                Array.from({ length: 16 }, () => receiver.receive(reply))
            );
            assert.equal(
                results.filter((result) => result === "accepted").length,
                1
            );
            assert.deepEqual(delivered, [value]);
            assert.equal(await receiver.receive(reply), "closed");
        }
    );
    await check(
        "cancel and expiry while decryption is pending never apply text",
        async () => {
            let expired = false;
            const cancel = core.hereNowReceiver(
                w,
                a,
                () => false,
                () => assert.fail("cancelled apply")
            );
            const pending = cancel.receive(reply);
            cancel.cancel();
            assert.equal(await pending, "cancelled");
            const timeout = core.hereNowReceiver(
                w,
                a,
                () => expired,
                () => assert.fail("expired apply")
            );
            const finishing = timeout.receive(reply);
            expired = true;
            assert.equal(await finishing, "expired");
        }
    );
    await check(
        "full pairing link round trip uses fragment and rejects foreign links",
        async () => {
            const link = core.hereNowPairLink(w, a, "/swop-input/");
            assert.equal(new URL(link).search, "");
            assert.deepEqual(core.hereNowReadPair(w, link), a);
            assert.deepEqual(core.hereNowReadPair(w, new URL(link).hash), a);
            assert.throws(() =>
                core.hereNowReadPair(
                    w,
                    link.replace("player.fixture", "evil.invalid")
                )
            );
            assert.throws(() => core.hereNowReadPair(w, link + "&k=duplicate"));
        }
    );
    await check(
        "bounded full-size messages fit platform record cap",
        async () => {
            assert.equal(core.hereNowValidValue("x".repeat(4097)), false);
            assert.equal(core.hereNowValidValue('"'.repeat(4096)), false);
            assert.equal(core.hereNowValidValue("\n".repeat(4096)), false);
            const maximum = {
                ack: "",
                offer: await core.hereNowSeal(w, a, "offer", {
                    caption: "x".repeat(120),
                    draft: "a".repeat(4096),
                }),
                reply: await core.hereNowSeal(w, a, "reply", {
                    value: "b".repeat(4096),
                }),
                v: 1,
            };
            assert(Buffer.byteLength(JSON.stringify(maximum)) < 16384);
            assert(
                maximum.offer.length <= 6500 && maximum.reply.length <= 6500
            );
            await assert.rejects(() =>
                core.hereNowOpen(w, a, "reply", "x".repeat(6501))
            );
        }
    );
    await check(
        "store uses exact Site-local record API, no owner or installation credentials",
        async () => {
            const requests = [];
            const wire = {
                ...w,
                XMLHttpRequest: class {
                    open(method, url) {
                        this.method = method;
                        this.url = url;
                    }
                    setRequestHeader(name, value) {
                        (this.headers ||= {})[name] = value;
                    }
                    send(body) {
                        requests.push({
                            body,
                            headers: this.headers,
                            method: this.method,
                            url: this.url,
                        });
                        this.status = 200;
                        this.responseText = JSON.stringify({
                            record: { data: { offer, reply }, id: a.recordId },
                        });
                        this.onload();
                    }
                },
            };
            const store = core.hereNowStore(wire, "swop_pairs");
            assert.equal(await store.create(), a.recordId);
            await store.patch(a.recordId, { reply });
            assert.deepEqual(await store.get(a.recordId), { offer, reply });
            await store.remove(a.recordId);
            assert.deepEqual(
                requests.map((r) => r.method),
                ["POST", "PATCH", "GET", "DELETE"]
            );
            requests.forEach((r) => {
                assert(r.url.startsWith("/.herenow/data/swop_pairs"));
                assert.equal(r.headers.Authorization, undefined);
            });
            await assert.rejects(() => store.get("../other"));
        }
    );
    await check(
        "orphan cleanup is bounded, follows cursors and trusts only server metadata time",
        async () => {
            const storage = new Map(),
                requests = [];
            const serverNow = Date.parse("2026-09-28T00:00:00Z");
            const row = (n, age, data = {}) => ({
                createdAt: new Date(serverNow - age).toISOString(),
                data,
                id: "rec_01AAAAAAAAAAAAAAAAAAAAAAA" + n,
            });
            let records = [
                row(1, 86400001),
                row(2, 1000, { createdAt: "2000-01-01", expired: true }),
                row(3, 86400000),
                row(4, -1000),
                { ...row(5, 86400001), createdAt: "invalid" },
            ];
            let nextCursor = "opaque/next+page",
                date = new Date(serverNow).toUTCString();
            const wire = {
                ...w,
                localStorage: {
                    getItem: (key) => storage.get(key),
                    removeItem: (key) => storage.delete(key),
                    setItem: (key, value) => storage.set(key, value),
                },
                XMLHttpRequest: class {
                    open(method, url) {
                        this.method = method;
                        this.url = url;
                    }
                    setRequestHeader() {}
                    getResponseHeader(name) {
                        assert.equal(name, "Date");
                        return date;
                    }
                    send() {
                        requests.push({
                            method: this.method,
                            timeout: this.timeout,
                            url: this.url,
                        });
                        this.status = 200;
                        this.responseText = JSON.stringify(
                            this.method === "GET" ? { nextCursor, records } : {}
                        );
                        this.onload();
                    }
                },
            };
            const store = core.hereNowStore(wire, "swop_pairs");
            await store.collect();
            assert.deepEqual(
                requests.map((r) => r.method),
                ["GET", "DELETE"]
            );
            assert.equal(requests[1].url.split("/").pop(), row(1, 0).id);
            assert.equal(storage.get("ottplay.swop.gc.swop_pairs"), nextCursor);
            requests.length = 0;
            records = [1, 2, 3, 4, 5].map((n) => row(n, 90000000));
            nextCursor = null;
            await store.collect();
            assert(
                requests[0].url.endsWith("?limit=5&cursor=opaque%2Fnext%2Bpage")
            );
            assert.deepEqual(
                requests.map((r) => r.method),
                ["GET", "DELETE", "DELETE", "DELETE"]
            );
            assert(requests.every((r) => r.timeout === 3000));
            assert.equal(storage.size, 0);
            requests.length = 0;
            date = null; // An incorrect client clock is never used as a substitute.
            await store.collect();
            assert.deepEqual(
                requests.map((r) => r.method),
                ["GET"]
            );
            requests.length = 0;
            date = new Date(serverNow).toUTCString();
            records.push(row(6, 90000000));
            await store.collect();
            assert.deepEqual(
                requests.map((r) => r.method),
                ["GET"]
            );
        }
    );
    await check(
        "hosted profile overrides legacy only when explicitly selected; unsupported crypto fails closed",
        async () => {
            assert.equal(core.hereNowSwopConfig(w), null);
            const config = {
                collection: "swop_pairs",
                entryUrl: "/swop-input/",
                transport: "herenow",
            };
            assert.deepEqual(
                core.hereNowSwopConfig({
                    __OTTPLAY_HOSTED__: { swop: config, version: 1 },
                }),
                config
            );
            assert.throws(() =>
                core.hereNowSwopConfig({
                    __OTTPLAY_HOSTED__: {
                        swop: { ...config, entryUrl: "//external/" },
                        version: 1,
                    },
                })
            );
            assert.equal(core.hereNowCryptoAvailable({}), false);
            assert.throws(() => core.hereNowRandom({}, 32));
        }
    );
    await check(
        "hosted TV UI resumes the existing edit continuation including title-filter input",
        async () => {
            const { JSDOM } = require("jsdom");
            const dom = new JSDOM('<div id="listEdit"></div>', {
                runScripts: "outside-only",
                url: "https://player.fixture/",
            });
            const tv = dom.window;
            Object.defineProperty(tv, "crypto", { value: webcrypto });
            tv.eval(
                fs.readFileSync(
                    path.join(__dirname, "../js/jquery-1.11.1.min.js"),
                    "utf8"
                )
            );
            require("./helpers/screen-runtime.cjs")(tv);
            tv.__ottClassicScreenPort.openEditor();
            const records = new Map(),
                jobs = new Map();
            let job = 0,
                sequence = 0,
                link = "",
                resumed = 0,
                alerts = [];
            tv.__OTTPLAY_HOSTED__ = {
                swop: {
                    collection: "swop_pairs",
                    entryUrl: "/swop-input/",
                    transport: "herenow",
                },
                version: 1,
            };
            tv.keys = { EXIT: 27, RETURN: 8 };
            tv.editCaption = "Title filter";
            tv.editvar = "old filter";
            const originalKey = () => false;
            tv.editKey = originalKey;
            tv.showEditKey = () => resumed++;
            tv.alert = (text) => alerts.push(text);
            tv.setTimeout = (fn, delay) => {
                jobs.set(++job, { delay, fn });
                return job;
            };
            tv.clearTimeout = (id) => jobs.delete(id);
            tv.XMLHttpRequest = class {
                open(method, url) {
                    this.method = method;
                    this.url = url;
                }
                setRequestHeader() {}
                send(body) {
                    queueMicrotask(() => {
                        let id = this.url.split("/").pop(),
                            data;
                        if (this.method === "POST") {
                            id = "rec_01AAAAAAAAAAAAAAAAAAAAAAA" + ++sequence;
                            records.set(id, JSON.parse(body));
                        } else if (this.method === "PATCH")
                            records.set(id, {
                                ...records.get(id),
                                ...JSON.parse(body),
                            });
                        data = records.get(id);
                        if (this.method === "DELETE") records.delete(id);
                        this.status = 200;
                        this.responseText = JSON.stringify({
                            record: { data, id },
                        });
                        this.onload();
                    });
                }
            };
            tv.__ottInterfaceLanguage = "_rus";
            const ui = load("src/swop/herenow-ui.ts", { "./herenow": core });
            async function until(predicate) {
                const deadline = Date.now() + 2000;
                while (!predicate() && Date.now() < deadline)
                    await new Promise((resolve) => setImmediate(resolve));
                assert(predicate(), "asynchronous UI transition completed");
            }
            try {
                ui.openHereNowSwop(
                    tv,
                    (s) => s,
                    (text) => {
                        link = text;
                        return "<svg></svg>";
                    }
                );
                await until(() => link !== "");
                const phone = {
                    ...w,
                    location: {
                        origin: tv.location.origin,
                        pathname: "/swop-input/",
                    },
                };
                const pairing = core.hereNowReadPair(phone, link);
                const record = records.get(pairing.recordId);
                assert.deepEqual(
                    await core.hereNowOpen(
                        phone,
                        pairing,
                        "offer",
                        record.offer
                    ),
                    {
                        caption: "Title filter",
                        draft: "old filter",
                        language: "_rus",
                    }
                );
                record.reply = await core.hereNowSeal(phone, pairing, "reply", {
                    value: "РЕН ТВ",
                });
                const timer = [...jobs.entries()].find(
                    ([, value]) => value.delay === 5000
                );
                assert(timer);
                jobs.delete(timer[0]);
                timer[1].fn();
                await until(() => resumed === 1 && records.size === 0);
                assert.equal(tv.editvar, "РЕН ТВ");
                assert.equal(tv.editKey, originalKey);
                assert.equal(
                    tv.document.getElementById("listEdit").style.display,
                    "none"
                );
                assert.deepEqual(alerts, []);
                // Closing before create resolves must delete the late-created record.
                ui.openHereNowSwop(
                    tv,
                    (s) => s,
                    () => "<svg></svg>"
                );
                tv.editKey(tv.keys.RETURN);
                await until(() => sequence === 2 && records.size === 0);
                assert.equal(resumed, 2);
                assert.equal(tv.editvar, "РЕН ТВ");
                // Exercise the actual owner lifecycle, not only a callback stub.
                link = "";
                ui.openHereNowSwop(
                    tv,
                    (s) => s,
                    (text) => {
                        link = text;
                        return "<svg></svg>";
                    }
                );
                await until(() => link !== "");
                const oldPair = core.hereNowReadPair(phone, link);
                records.get(oldPair.recordId).reply = await core.hereNowSeal(
                    phone,
                    oldPair,
                    "reply",
                    { value: "must not reach new editor" }
                );
                const oldPoll = [...jobs.entries()].find(
                    ([, value]) => value.delay === 5000
                );
                jobs.delete(oldPoll[0]);
                oldPoll[1].fn();
                tv.__ottClassicScreenPort.openEditor();
                tv.editvar = "new editor value";
                const replacementKey = () => true;
                tv.editKey = replacementKey;
                tv.$("#listEdit").text("replacement editor").show();
                await until(() => records.size === 0);
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(tv.editvar, "new editor value");
                assert.equal(tv.editKey, replacementKey);
                assert.equal(tv.$("#listEdit").text(), "replacement editor");
                assert.notEqual(
                    tv.document.getElementById("listEdit").style.display,
                    "none"
                );
                assert.equal(resumed, 2);
            } finally {
                dom.window.close();
            }
        }
    );
    await check(
        "phone accepts a fresh same-page QR and discards the old asynchronous submission",
        async () => {
            const { JSDOM } = require("jsdom");
            const first = pair(),
                second = pair("rec_01BBBBBBBBBBBBBBBBBBBBBBBB");
            const records = new Map();
            records.set(first.recordId, {
                offer: await core.hereNowSeal(w, first, "offer", {
                    caption: "First",
                    draft: "first draft",
                    language: "_rus",
                }),
            });
            records.set(second.recordId, {
                offer: await core.hereNowSeal(w, second, "offer", {
                    caption: "Second",
                    draft: "second draft",
                    language: "_ara",
                }),
            });
            const dom = new JSDOM(
                '<p id="status"></p><form id="pairing"><textarea id="link"></textarea></form><form id="entry" hidden><label id="caption"></label><textarea id="value"></textarea><button id="send"></button><button id="cancel"></button></form>',
                {
                    runScripts: "outside-only",
                    url: core.hereNowPairLink(w, first, "/swop-input/"),
                }
            );
            const phone = dom.window,
                writes = [];
            Object.defineProperty(phone, "crypto", { value: webcrypto });
            phone.__OTTPLAY_HOSTED__ = {
                swop: {
                    collection: "swop_pairs",
                    entryUrl: "/swop-input/",
                    transport: "herenow",
                },
                version: 1,
            };
            let releaseOld,
                firstEncryptionStarted = false;
            const gate = new Promise((resolve) => {
                releaseOld = resolve;
            });
            const phoneCore = {
                ...core,
                hereNowSeal: async (...args) => {
                    const encrypted = await core.hereNowSeal(...args);
                    if (args[1].recordId === first.recordId) {
                        firstEncryptionStarted = true;
                        await gate;
                    }
                    return encrypted;
                },
            };
            phone.XMLHttpRequest = class {
                open(method, url) {
                    this.method = method;
                    this.url = url;
                }
                setRequestHeader() {}
                send(body) {
                    queueMicrotask(() => {
                        const id = this.url.split("/").pop();
                        if (/^_(rus|ara)\.json$/.test(id)) {
                            const {
                                readDictionary,
                                languageAssets,
                            } = require("../scripts/localization-catalog.cjs");
                            this.status = 200;
                            this.responseText = JSON.stringify(
                                readDictionary(
                                    path.join(
                                        __dirname,
                                        "..",
                                        languageAssets[id.slice(0, -5)]
                                    )
                                )
                            );
                            this.onload();
                            return;
                        }
                        if (this.method === "PATCH") {
                            writes.push({ body: JSON.parse(body), id });
                            records.set(id, {
                                ...records.get(id),
                                ...JSON.parse(body),
                            });
                        }
                        this.status = 200;
                        this.responseText = JSON.stringify({
                            record: { data: records.get(id), id },
                        });
                        this.onload();
                    });
                }
            };
            const assets = load("src/localization/assets.ts");
            const localization = load(
                "src/swop/phone-localization.ts",
                { "../localization/assets": assets },
                { _ara: "/_ara.json", _rus: "/_rus.json" }
            );
            phone.require = (id) =>
                id === "./herenow"
                    ? phoneCore
                    : id === "./phone-localization"
                      ? localization
                      : assets;
            phone.exports = {};
            const source = ts.transpileModule(
                fs.readFileSync(
                    path.join(__dirname, "../src/swop/herenow-phone.ts"),
                    "utf8"
                ),
                {
                    compilerOptions: {
                        module: ts.ModuleKind.CommonJS,
                        target: ts.ScriptTarget.ES5,
                    },
                }
            ).outputText;
            async function until(predicate) {
                const deadline = Date.now() + 2000;
                while (!predicate() && Date.now() < deadline)
                    await new Promise((resolve) => setImmediate(resolve));
                assert(predicate(), "phone transition completed");
            }
            const element = (id) => phone.document.getElementById(id);
            const submit = () =>
                element("entry").dispatchEvent(
                    new phone.Event("submit", { cancelable: true })
                );
            try {
                phone.eval(source);
                await until(() => !element("entry").hidden);
                assert.equal(phone.location.hash, "");
                assert.equal(phone.document.documentElement.lang, "ru");
                element("value").value = '"'.repeat(4096);
                submit();
                assert.equal(element("value").readOnly, false);
                assert.equal(writes.length, 0);
                element("value").value = "old response";
                submit();
                await until(() => firstEncryptionStarted);
                phone.location.hash = new URL(
                    core.hereNowPairLink(w, second, "/swop-input/")
                ).hash;
                await until(
                    () =>
                        element("value").value === "second draft" &&
                        !element("entry").hidden
                );
                assert.equal(phone.location.hash, "");
                assert.equal(element("value").readOnly, false);
                assert.equal(phone.document.documentElement.lang, "ar");
                assert.equal(phone.document.documentElement.dir, "rtl");
                releaseOld();
                await new Promise((resolve) => setImmediate(resolve));
                element("value").value = "new response";
                submit();
                const expectedSent =
                    require("../scripts/localization-catalog.cjs").readDictionary(
                        path.join(__dirname, "../locales/arabic.js")
                    )["Text sent. Check your TV to confirm it appeared."];
                await until(
                    () => element("status").textContent === expectedSent
                );
                assert.equal(writes.length, 1);
                assert.equal(writes[0].id, second.recordId);
                assert.deepEqual(
                    await core.hereNowOpen(
                        w,
                        second,
                        "reply",
                        writes[0].body.reply
                    ),
                    { value: "new response" }
                );
                phone.dispatchEvent(
                    new phone.PageTransitionEvent("pageshow", {
                        persisted: true,
                    })
                );
                assert.equal(element("pairing").hidden, false);
                assert.equal(element("entry").hidden, true);
                assert.equal(element("value").value, "");
            } finally {
                releaseOld();
                dom.window.close();
            }
        }
    );
    console.log("PASS here.now SWOP " + count + " checks");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

/** Encrypted same-Site mailbox. Storage permissions never authenticate a pair. */
export interface HereNowSwopPair {
    deadline: number;
    origin: string;
    recordId: string;
    secret: Uint8Array;
    sid: string;
}
export interface HereNowSwopConfig {
    collection: string;
    entryUrl: string;
    transport: string;
}
export const HERENOW_SWOP_TTL = 600000;
export const HERENOW_SWOP_VALUE_BYTES = 4096;
const hereNowProtocol = "ottplay.swop.v2";
if (typeof window !== "undefined" && (window as any).__OTTPLAY_HOSTED__)
    (window as any).__OTTPLAY_HOSTED_PROTOCOL__ = "hosted-profile-v1";

export function hereNowUtf8(value: string): Uint8Array {
    var encoded = encodeURIComponent(value);
    var bytes: number[] = [];
    for (var i = 0; i < encoded.length; i++) {
        if (encoded.charAt(i) === "%") {
            bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
            i += 2;
        } else bytes.push(encoded.charCodeAt(i));
    }
    return new Uint8Array(bytes);
}
function hereNowText(bytes: Uint8Array): string {
    var encoded = "";
    for (var i = 0; i < bytes.length; i++)
        encoded += "%" + ("0" + bytes[i].toString(16)).slice(-2);
    return decodeURIComponent(encoded);
}
export function hereNowBase64(w: any, bytes: Uint8Array): string {
    var binary = "";
    for (var i = 0; i < bytes.length; i++)
        binary += String.fromCharCode(bytes[i]);
    return w
        .btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}
function hereNowUnbase64(w: any, value: string, maximum: number): Uint8Array {
    if (
        typeof value !== "string" ||
        value.length > maximum ||
        !/^[A-Za-z0-9_-]+$/.test(value)
    )
        throw new Error("invalid_pair");
    var binary = w.atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (hereNowBase64(w, bytes) !== value) throw new Error("invalid_pair");
    return bytes;
}
export function hereNowCryptoAvailable(w: any): boolean {
    var c = w.crypto;
    return !!(
        c &&
        c.getRandomValues &&
        c.subtle &&
        c.subtle.importKey &&
        c.subtle.deriveKey &&
        c.subtle.encrypt &&
        c.subtle.decrypt &&
        w.Uint8Array &&
        w.Promise
    );
}
export function hereNowRandom(w: any, size: number): Uint8Array {
    if (!hereNowCryptoAvailable(w)) throw new Error("crypto_unavailable");
    return w.crypto.getRandomValues(new Uint8Array(size));
}
export function hereNowSwopConfig(w: any): HereNowSwopConfig | null {
    var hosted = w.__OTTPLAY_HOSTED__;
    var cfg = hosted && hosted.version === 1 && hosted.swop;
    if (!cfg || cfg.transport !== "herenow") return null;
    if (
        !/^[a-z][a-z0-9_]{0,63}$/.test(cfg.collection || "") ||
        typeof cfg.entryUrl !== "string" ||
        !/^\/[a-zA-Z0-9][a-zA-Z0-9_/-]*\/$/.test(cfg.entryUrl)
    )
        throw new Error("configuration");
    return cfg;
}
function hereNowAad(pair: HereNowSwopPair, role: string): Uint8Array {
    return hereNowUtf8(
        JSON.stringify([
            hereNowProtocol,
            pair.origin,
            pair.recordId,
            pair.sid,
            role,
            pair.deadline,
        ])
    );
}
async function hereNowKey(
    w: any,
    pair: HereNowSwopPair,
    role: string
): Promise<CryptoKey> {
    if (role !== "offer" && role !== "reply" && role !== "ack")
        throw new Error("invalid_role");
    var material = await w.crypto.subtle.importKey(
        "raw",
        pair.secret,
        "HKDF",
        false,
        ["deriveKey"]
    );
    return w.crypto.subtle.deriveKey(
        {
            hash: "SHA-256",
            info: hereNowAad(pair, role),
            name: "HKDF",
            salt: hereNowUnbase64(w, pair.sid, 22),
        },
        material,
        { length: 256, name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
    );
}
export async function hereNowSeal(
    w: any,
    pair: HereNowSwopPair,
    role: string,
    payload: any
): Promise<string> {
    var plain = hereNowUtf8(
        JSON.stringify({
            deadline: pair.deadline,
            payload: payload,
            role: role,
            sid: pair.sid,
            v: hereNowProtocol,
        })
    );
    if (plain.length > 4800) throw new Error("value_limit");
    // Fresh IV per encryption. Retries reuse the returned immutable envelope.
    var iv = hereNowRandom(w, 12);
    var ciphertext = await w.crypto.subtle.encrypt(
        {
            additionalData: hereNowAad(pair, role),
            iv: iv,
            name: "AES-GCM",
            tagLength: 128,
        },
        await hereNowKey(w, pair, role),
        plain
    );
    var envelope = JSON.stringify({
        ciphertext: hereNowBase64(w, new Uint8Array(ciphertext)),
        iv: hereNowBase64(w, iv),
    });
    if (envelope.length > 6500) throw new Error("value_limit");
    return envelope;
}
export async function hereNowOpen(
    w: any,
    pair: HereNowSwopPair,
    role: string,
    envelope: string
): Promise<any> {
    if (typeof envelope !== "string" || envelope.length > 6500)
        throw new Error("invalid_message");
    var box = JSON.parse(envelope);
    if (!box || Object.keys(box).sort().join(",") !== "ciphertext,iv")
        throw new Error("invalid_message");
    var iv = hereNowUnbase64(w, box.iv, 16);
    if (iv.length !== 12) throw new Error("invalid_message");
    var plain = await w.crypto.subtle.decrypt(
        {
            additionalData: hereNowAad(pair, role),
            iv: iv,
            name: "AES-GCM",
            tagLength: 128,
        },
        await hereNowKey(w, pair, role),
        hereNowUnbase64(w, box.ciphertext, 6500)
    );
    if (plain.byteLength > 4800) throw new Error("invalid_message");
    var body = JSON.parse(hereNowText(new Uint8Array(plain)));
    if (
        !body ||
        body.v !== hereNowProtocol ||
        body.sid !== pair.sid ||
        body.role !== role ||
        body.deadline !== pair.deadline
    )
        throw new Error("invalid_message");
    return body.payload;
}
export function hereNowValidValue(value: any): boolean {
    try {
        return (
            typeof value === "string" &&
            hereNowUtf8(value).length <= HERENOW_SWOP_VALUE_BYTES &&
            hereNowUtf8(JSON.stringify(value)).length <=
                HERENOW_SWOP_VALUE_BYTES + 2
        );
    } catch (_) {
        return false;
    }
}
export function hereNowPairLink(
    w: any,
    pair: HereNowSwopPair,
    entry: string
): string {
    return (
        pair.origin +
        entry +
        "#rid=" +
        encodeURIComponent(pair.recordId) +
        "&sid=" +
        pair.sid +
        "&exp=" +
        pair.deadline +
        "&k=" +
        hereNowBase64(w, pair.secret)
    );
}
export function hereNowReadPair(w: any, link: string): HereNowSwopPair {
    if (typeof link !== "string" || link.length > 1024)
        throw new Error("invalid_pair");
    var hash = link.indexOf("#");
    if (hash < 0) throw new Error("invalid_pair");
    var prefix = link.slice(0, hash);
    if (prefix && prefix !== w.location.origin + w.location.pathname)
        throw new Error("invalid_pair");
    var fields: any = {};
    link.slice(hash + 1)
        .split("&")
        .forEach(function (part) {
            var bits = part.split("=");
            if (
                bits.length !== 2 ||
                fields[bits[0]] !== undefined ||
                !/^(rid|sid|exp|k)$/.test(bits[0])
            )
                throw new Error("invalid_pair");
            fields[bits[0]] = decodeURIComponent(bits[1]);
        });
    if (
        Object.keys(fields).length !== 4 ||
        !/^rec_[0-9A-HJKMNP-TV-Z]{26}$/.test(fields.rid) ||
        !/^\d{13}$/.test(fields.exp)
    )
        throw new Error("invalid_pair");
    var secret = hereNowUnbase64(w, fields.k, 43);
    var sid = hereNowUnbase64(w, fields.sid, 22);
    if (secret.length !== 32 || sid.length !== 16)
        throw new Error("invalid_pair");
    return {
        deadline: Number(fields.exp),
        origin: w.location.origin,
        recordId: fields.rid,
        secret: secret,
        sid: fields.sid,
    };
}
export function hereNowStore(w: any, collection: string): any {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(collection))
        throw new Error("configuration");
    var base = "/.herenow/data/" + collection;
    function request(
        method: string,
        id?: string,
        body?: any,
        options?: any
    ): Promise<any> {
        if (id !== undefined && !/^rec_[0-9A-HJKMNP-TV-Z]{26}$/.test(id))
            return Promise.reject(new Error("invalid_pair"));
        return new Promise(function (resolve, reject) {
            var xhr = new w.XMLHttpRequest();
            xhr.open(
                method,
                base + (id ? "/" + id : "") + (options?.query || ""),
                true
            );
            xhr.timeout = options?.timeout || 15000;
            xhr.setRequestHeader("Accept", "application/json");
            xhr.setRequestHeader("Cache-Control", "no-store");
            if (body !== undefined)
                xhr.setRequestHeader("Content-Type", "application/json");
            xhr.onload = function () {
                if (xhr.status < 200 || xhr.status >= 300) {
                    reject(
                        new Error(
                            xhr.status === 429
                                ? "rate_limit"
                                : xhr.status === 404
                                  ? "gone"
                                  : "service_unavailable"
                        )
                    );
                    return;
                }
                try {
                    if (xhr.responseText.length > (options?.maximum || 20000))
                        throw new Error("response_limit");
                    var response = xhr.responseText
                        ? JSON.parse(xhr.responseText)
                        : {};
                    resolve(
                        options?.metadata
                            ? {
                                  body: response,
                                  date:
                                      typeof xhr.getResponseHeader ===
                                      "function"
                                          ? xhr.getResponseHeader("Date")
                                          : null,
                              }
                            : response
                    );
                } catch (_) {
                    reject(new Error("service_unavailable"));
                }
            };
            xhr.onerror = xhr.ontimeout = function () {
                reject(new Error("network"));
            };
            xhr.send(body === undefined ? null : JSON.stringify(body));
        });
    }
    return {
        collect: function (): Promise<void> {
            // One small page per attempt; the cursor eventually reaches old orphans.
            // Dates belong to Site Data metadata, never to visitor-controlled fields.
            var key = "ottplay.swop.gc." + collection;
            var cursor = "";
            try {
                cursor = w.localStorage.getItem(key) || "";
            } catch (_) {}
            if (cursor.length > 1024) cursor = "";
            return request("GET", undefined, undefined, {
                maximum: 80000,
                metadata: true,
                query:
                    "?limit=5" +
                    (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
                timeout: 3000,
            })
                .then(async function (response) {
                    var data = response.body;
                    var serverNow = Date.parse(response.date || "");
                    if (
                        !data ||
                        !Array.isArray(data.records) ||
                        data.records.length > 5 ||
                        !isFinite(serverNow)
                    )
                        throw new Error("invalid_list");
                    try {
                        if (
                            typeof data.nextCursor === "string" &&
                            data.nextCursor.length <= 1024
                        )
                            w.localStorage.setItem(key, data.nextCursor);
                        else w.localStorage.removeItem(key);
                    } catch (_) {}
                    var removed = 0;
                    for (
                        var i = 0;
                        i < data.records.length && removed < 3;
                        i++
                    ) {
                        var record = data.records[i];
                        var created =
                            record && typeof record.createdAt === "string"
                                ? Date.parse(record.createdAt)
                                : NaN;
                        if (
                            !record ||
                            !/^rec_[0-9A-HJKMNP-TV-Z]{26}$/.test(
                                record.id || ""
                            ) ||
                            !isFinite(created) ||
                            created <= 0 ||
                            serverNow - created <= 86400000
                        )
                            continue;
                        removed++;
                        await request("DELETE", record.id, undefined, {
                            timeout: 3000,
                        }).catch(function () {});
                    }
                })
                .catch(function () {
                    // Best effort only. A bad/stale cursor must not block a later sweep.
                    try {
                        w.localStorage.removeItem(key);
                    } catch (_) {}
                });
        },
        create: function () {
            return request("POST", undefined, {
                ack: "",
                offer: "",
                reply: "",
                v: 1,
            }).then(function (response) {
                var id = response && response.record && response.record.id;
                if (!/^rec_[0-9A-HJKMNP-TV-Z]{26}$/.test(id || ""))
                    throw new Error("service_unavailable");
                return id;
            });
        },
        get: function (id: string) {
            return request("GET", id).then(function (response) {
                if (!response || !response.record || !response.record.data)
                    throw new Error("service_unavailable");
                return response.record.data;
            });
        },
        patch: function (id: string, fields: any) {
            return request("PATCH", id, fields);
        },
        remove: function (id: string) {
            return request("DELETE", id);
        },
    };
}
export function hereNowReceiver(
    w: any,
    pair: HereNowSwopPair,
    expired: () => boolean,
    deliver: (value: string) => void
): any {
    var state = "waiting";
    var generation = 0;
    return {
        cancel: function () {
            state = "cancelled";
            generation++;
        },
        receive: function (envelope: string): Promise<string> {
            if (state !== "waiting") return Promise.resolve("closed");
            if (expired()) {
                state = "expired";
                return Promise.resolve("expired");
            }
            state = "verifying"; // synchronous lock before any promise work
            var revision = generation;
            return hereNowOpen(w, pair, "reply", envelope).then(
                function (payload) {
                    if (generation !== revision || state !== "verifying")
                        return "cancelled";
                    if (expired()) {
                        state = "expired";
                        return "expired";
                    }
                    if (!payload || !hereNowValidValue(payload.value)) {
                        state = "waiting";
                        return "rejected";
                    }
                    state = "consumed"; // UI reentry cannot deliver a second time
                    deliver(payload.value);
                    return "accepted";
                },
                function () {
                    if (generation === revision && state === "verifying")
                        state = "waiting";
                    return "rejected";
                }
            );
        },
    };
}

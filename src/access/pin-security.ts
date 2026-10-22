/** Versioned password storage. No plaintext writes, weak randomness or silent reset. */
function createPinSecurity(host: any) {
    var prefix = "pbkdf2-sha256$600000$";
    var format = /^pbkdf2-sha256\$600000\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
    var sjcl = host.__ottPinPrimitives;
    var busy = false;
    function legacy(value: any): boolean {
        return typeof value === "string" && /^\d{4}$/.test(value);
    }
    function record(value: any): boolean {
        return typeof value === "string" && format.test(value);
    }
    function hex(bytes: Uint8Array): string {
        var result = "";
        for (var i = 0; i < bytes.length; i++)
            result += (bytes[i] + 256).toString(16).slice(1);
        return result;
    }
    function bytes(value: string): Uint8Array {
        var result = new Uint8Array(value.length / 2);
        for (var i = 0; i < result.length; i++)
            result[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
        return result;
    }
    function equal(a: string, b: string): boolean {
        var difference = a.length ^ b.length;
        for (var i = 0; i < a.length; i++)
            difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
        return difference === 0;
    }
    function derive(
        pin: string,
        salt: string,
        current: () => boolean,
        done: (result: string | null) => void
    ): void {
        function finish(result: string | null): void {
            busy = false;
            // Always settle on a later turn: queued cancellation wins even on
            // a synchronous crypto failure or the final fallback chunk.
            host.setTimeout(function () {
                if (current()) done(result);
            }, 0);
        }
        if (busy || !current()) {
            host.setTimeout(function () {
                if (current()) done(null);
            }, 0);
            return;
        }
        busy = true;
        if (!legacy(pin) || !/^[a-f0-9]{32}$/.test(salt)) {
            finish(null);
            return;
        }
        var crypto = host.crypto || host.msCrypto;
        if (
            host.crypto &&
            crypto &&
            crypto.subtle &&
            typeof crypto.subtle.importKey === "function"
        ) {
            try {
                var secret = new Uint8Array(4);
                for (var p = 0; p < 4; p++) secret[p] = pin.charCodeAt(p);
                var imported = crypto.subtle.importKey(
                    "raw",
                    secret,
                    "PBKDF2",
                    false,
                    ["deriveBits"]
                );
                if (imported && typeof imported.then === "function") {
                    imported
                        .then(function (key: any) {
                            if (!current()) {
                                busy = false;
                                return null;
                            }
                            return crypto.subtle.deriveBits(
                                {
                                    hash: "SHA-256",
                                    iterations: 600000,
                                    name: "PBKDF2",
                                    salt: bytes(salt),
                                },
                                key,
                                256
                            );
                        })
                        .then(
                            function (bits: any) {
                                if (bits && bits.byteLength === 32)
                                    finish(hex(new Uint8Array(bits)));
                                else if (current()) finish(null);
                            },
                            function () {
                                finish(null);
                            }
                        );
                    return;
                }
                // Legacy msCrypto operations are not promises. Use the
                // bundled implementation, retaining CSPRNG salt generation.
            } catch (_error) {
                finish(null);
                return;
            }
        }
        try {
            var prf = new sjcl.misc.hmac(sjcl.codec.utf8String.toBits(pin));
            var u = prf.encrypt(
                sjcl.bitArray.concat(sjcl.codec.hex.toBits(salt), [1])
            );
            var result = u.slice();
            var iteration = 1;
            function chunk(): void {
                if (!current()) {
                    busy = false;
                    return;
                }
                try {
                    // PBKDF2 block 1 (dkLen = SHA256 length), identical to
                    // SJCL's loop. A bounded chunk keeps old STB input alive.
                    var limit = Math.min(600000, iteration + 1000);
                    for (; iteration < limit; iteration++) {
                        u = prf.encrypt(u);
                        for (var j = 0; j < u.length; j++) result[j] ^= u[j];
                    }
                    if (iteration < 600000) host.setTimeout(chunk, 0);
                    else finish(sjcl.codec.hex.fromBits(result));
                } catch (_error) {
                    finish(null);
                }
            }
            host.setTimeout(chunk, 0);
        } catch (_error) {
            finish(null);
        }
    }
    function salt(): string {
        var crypto = host.crypto || host.msCrypto;
        if (!crypto || typeof crypto.getRandomValues !== "function")
            throw new Error("CSPRNG unavailable");
        var random = new Uint8Array(16);
        if (crypto.getRandomValues(random) !== random)
            throw new Error("Invalid CSPRNG result");
        return hex(random);
    }
    // Legacy synchronous backup APIs must return a complete document. Convert
    // only old plaintext values at that boundary, never weaken the work factor.
    function prepare(value: string): string {
        if (value === "*" || record(value)) return value;
        if (!legacy(value)) throw new Error("Invalid parental PIN record");
        var random = salt();
        return (
            prefix +
            random +
            "$" +
            sjcl.codec.hex.fromBits(
                sjcl.misc.pbkdf2(
                    value,
                    sjcl.codec.hex.toBits(random),
                    600000,
                    256
                )
            )
        );
    }
    function protectSnapshot(items: any, key: string): any {
        var copy: any = Object.create(null);
        Object.keys(items).forEach(function (name) {
            copy[name] = items[name];
        });
        if (Object.prototype.hasOwnProperty.call(copy, key))
            copy[key] = prepare(copy[key]);
        return copy;
    }
    function create(
        pin: string,
        current: () => boolean,
        done: (value: string | null) => void
    ): void {
        try {
            var random = salt();
            derive(pin, random, current, function (digest) {
                done(digest === null ? null : prefix + random + "$" + digest);
            });
        } catch (_error) {
            host.setTimeout(function () {
                if (current()) done(null);
            }, 0);
        }
    }
    return {
        create: create,
        legacy: legacy,
        prepare: prepare,
        protectRollback: function (value: string | null): string | null {
            return legacy(value) ? prepare(value!) : value;
        },
        protectSnapshot: protectSnapshot,
        record: record,
        valid: function (value: any): boolean {
            return value === "*" || legacy(value) || record(value);
        },
        verify: function (
            pin: string,
            stored: string,
            current: () => boolean,
            done: (matched: boolean) => void
        ): void {
            var parsed =
                typeof stored === "string" ? format.exec(stored) : null;
            if (!parsed) {
                host.setTimeout(function () {
                    if (current()) done(false);
                }, 0);
                return;
            }
            derive(pin, parsed[1], current, function (digest) {
                done(digest !== null && equal(digest, parsed![2]));
            });
        },
    };
}
(window as any).__ottPinSecurity = createPinSecurity(window);

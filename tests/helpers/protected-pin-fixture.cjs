/** Use real protected records and await the shipped async verifier in ABI fixtures. */
const crypto = require("node:crypto");
const records = new Map();
function record(pin) {
    if (!records.has(pin)) {
        const salt = crypto.randomBytes(16);
        records.set(
            pin,
            "pbkdf2-sha256$600000$" +
                salt.toString("hex") +
                "$" +
                crypto
                    .pbkdf2Sync(pin, salt, 600000, 32, "sha256")
                    .toString("hex")
        );
    }
    return records.get(pin);
}
module.exports = function protectedPinFixture(host, pin, flush, native = true) {
    Object.defineProperty(host, "crypto", {
        configurable: true,
        value: native
            ? crypto.webcrypto
            : {
                  getRandomValues: crypto.webcrypto.getRandomValues.bind(
                      crypto.webcrypto
                  ),
              },
    });
    host.parentPIN = record(pin);
    const verify = host.__ottPinSecurity.verify;
    let pending = null;
    host.__ottPinSecurity.verify = (value, stored, current, done) => {
        const operation = { current, settled: false };
        pending = operation;
        verify(value, stored, current, (matched) => {
            operation.settled = true;
            done(matched);
        });
    };
    return async function settle() {
        const started = Date.now();
        // The real 600,000-iteration fallback runs inside a contextified VM.
        // Its 600 chunks take about 13.5s on local Node 22 and exceeded 30s on
        // a shared Linux runner. This is a bounded functional check, not a
        // device-latency requirement; keep native WebCrypto's existing bound.
        const deadline = native ? 30000 : 120000;
        let rounds = 0;
        while (pending && !pending.settled && pending.current()) {
            flush();
            rounds++;
            const elapsed = Date.now() - started;
            if (elapsed > deadline)
                throw Error(
                    "Real PIN verification timed out after " +
                        elapsed +
                        "ms (" +
                        (native ? "WebCrypto" : "ES5 fallback") +
                        "; flush rounds=" +
                        rounds +
                        ")"
                );
            await new Promise((resolve) => setImmediate(resolve));
        }
    };
};

module.exports.record = record;

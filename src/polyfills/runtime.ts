/** Web APIs shared by the page and the HLS worker, after core-js/stable. */

function runtimeGlobal(): any {
    if (typeof globalThis !== "undefined") return globalThis;
    if (typeof self !== "undefined") return self;
    if (typeof window !== "undefined") return window;
    return undefined;
}

function installPerformanceNow(target: any): void {
    var perf = target.performance;
    if (perf && typeof perf.now === "function") return;
    if (!perf) perf = target.performance = {};
    var clock = function (): number {
        return new target.Date().getTime();
    };
    var timing = perf.timing || (perf.timing = {});
    var origin =
        typeof perf.timeOrigin === "number"
            ? perf.timeOrigin
            : timing.navigationStart || clock();
    if (!timing.navigationStart) timing.navigationStart = origin;
    var previous = 0;
    perf.now = function (): number {
        // A wall-clock adjustment must not make elapsed time run backwards.
        previous = Math.max(previous, clock() - origin);
        return previous;
    };
}

function encoderString(value: any, optional: boolean): string {
    if (optional && value === undefined) return "";
    if (typeof value === "symbol") {
        throw new TypeError("Cannot convert a Symbol value to a string");
    }
    return String(value);
}

function writeUtf8(
    source: string,
    destination: Uint8Array
): { read: number; written: number } {
    var read = 0;
    var written = 0;
    while (read < source.length) {
        var point = source.charCodeAt(read);
        var units = 1;
        if (point >= 0xd800 && point <= 0xdbff) {
            var next = source.charCodeAt(read + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                point = 0x10000 + ((point - 0xd800) << 10) + next - 0xdc00;
                units = 2;
            } else point = 0xfffd;
        } else if (point >= 0xdc00 && point <= 0xdfff) point = 0xfffd;

        var size =
            point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
        // encodeInto never consumes or writes only part of a code point.
        if (written + size > destination.length) break;
        if (size === 1) destination[written++] = point;
        else {
            if (size === 2) destination[written++] = 0xc0 | (point >> 6);
            else {
                if (size === 3) destination[written++] = 0xe0 | (point >> 12);
                else {
                    destination[written++] = 0xf0 | (point >> 18);
                    destination[written++] = 0x80 | ((point >> 12) & 0x3f);
                }
                destination[written++] = 0x80 | ((point >> 6) & 0x3f);
            }
            destination[written++] = 0x80 | (point & 0x3f);
        }
        read += units;
    }
    return { read: read, written: written };
}

function installTextEncoder(target: any): void {
    var Encoder = target.TextEncoder;
    if (typeof Encoder !== "function") {
        Encoder = function TextEncoder(this: any) {
            if (!(this instanceof Encoder)) {
                throw new TypeError("TextEncoder requires new");
            }
        };
        Object.defineProperty(Encoder.prototype, "encoding", {
            configurable: true,
            enumerable: true,
            get: function (): string {
                return "utf-8";
            },
        });
        Object.defineProperty(Encoder.prototype, "encode", {
            configurable: true,
            enumerable: true,
            value: function (value?: any): Uint8Array {
                var source = encoderString(value, true);
                var bytes = new target.Uint8Array(source.length * 3);
                var result = writeUtf8(source, bytes);
                if (result.written === bytes.length) return bytes;
                var compact = new target.Uint8Array(result.written);
                compact.set(bytes.subarray(0, result.written));
                return compact;
            },
            writable: true,
        });
        target.TextEncoder = Encoder;
    }
    if (typeof Encoder.prototype.encodeInto !== "function") {
        Object.defineProperty(Encoder.prototype, "encodeInto", {
            configurable: true,
            enumerable: true,
            value: function (
                source: any,
                destination: Uint8Array
            ): { read: number; written: number } {
                if (arguments.length < 2) {
                    throw new TypeError(
                        "TextEncoder.encodeInto requires two arguments"
                    );
                }
                var input = encoderString(source, false);
                if (
                    Object.prototype.toString.call(destination) !==
                        "[object Uint8Array]" ||
                    (target.ArrayBuffer &&
                        typeof target.ArrayBuffer.isView === "function" &&
                        !target.ArrayBuffer.isView(destination))
                ) {
                    throw new TypeError(
                        "TextEncoder.encodeInto requires a Uint8Array"
                    );
                }
                return writeUtf8(input, destination);
            },
            writable: true,
        });
    }
}

/** Idempotent and safe in a worker with no window or document globals. */
export function applyWebRuntimePolyfills(target?: any): void {
    target = target || runtimeGlobal();
    if (!target) return;
    installPerformanceNow(target);
    installTextEncoder(target);
}

applyWebRuntimePolyfills();

/**
 * Convert a JavaScript string to a UTF-8 byte array.
 *
 * @param input - The source string to encode.
 * @returns An array of byte values (0–255) representing the UTF-8 encoding of the input.
 *
 * @remarks
 * Handles surrogate pairs (characters above U+FFFF) by encoding them as
 * 4-byte UTF-8 sequences. Characters up to U+1FFFFF are supported. This
 * matches the `TextEncoder.encode()` behaviour in modern browsers.
 */
export function stringToUtf8Bytes(input: string): number[] {
    var bytes: number[] = [];
    var index = -1;
    var length = input.length;
    while (++index < length) {
        var char = input.charCodeAt(index);
        if (char <= 0x7f) {
            bytes.push(char);
        } else if (char <= 0x7ff) {
            bytes.push(0xc0 | ((char >>> 6) & 0x1f));
            bytes.push(0x80 | (char & 0x3f));
        } else {
            var code = char;
            if (code >= 0xd800 && code <= 0xdbff && index + 1 < length) {
                var next = input.charCodeAt(index + 1);
                if (0xdc00 <= next && next <= 0xdfff) {
                    code = 0x10000 + ((code & 0x3ff) << 10) + (next & 0x3ff);
                    index++;
                }
            }
            if (code <= 0xffff) {
                bytes.push(0xe0 | ((code >>> 12) & 0x0f));
                bytes.push(0x80 | ((code >>> 6) & 0x3f));
                bytes.push(0x80 | (code & 0x3f));
            } else if (code <= 0x1fffff) {
                bytes.push(0xf0 | ((code >>> 18) & 0x07));
                bytes.push(0x80 | ((code >>> 12) & 0x3f));
                bytes.push(0x80 | ((code >>> 6) & 0x3f));
                bytes.push(0x80 | (code & 0x3f));
            }
        }
    }
    return bytes;
}

/**
 * Convert a string to a Latin-1 (ISO-8859-1) byte array.
 *
 * @param input - The source string to encode.
 * @returns An array of byte values — each character's code point masked to 8 bits.
 *
 * @remarks
 * Non-Latin-1 characters are silently truncated (code & 0xFF). This is
 * suitable for protocols or file formats that expect single-byte encoding.
 */
export function stringToLatin1Bytes(input: string): number[] {
    var length = input.length;
    var bytes: number[] = [];
    for (var index = 0; index < length; index++) {
        bytes.push(input.charCodeAt(index) & 0xff);
    }
    return bytes;
}

/** URL namespace codec. Case sensitivity preserves existing XMLTV and playlist keys. */
export function stripHttpScheme(input: string): string {
    return input.replace(/^https?:\/\//, "");
}

/**
 * Compute the MurmurHash3 32-bit hash of a byte array.
 *
 * @param bytes - The input byte values (0–255).
 * @param seed  - Optional seed value (default 0).
 * @returns The 32-bit unsigned hash as a JavaScript number.
 *
 * @remarks
 * Implements the canonical MurmurHash3 x86 32-bit algorithm. Processes
 * 4-byte words using the constants 0x85EBCA6B, 0xC2B2AE35, etc. The
 * remainder bytes (1–3) are handled with a fallthrough switch. The result
 * is finalised with XOR-folding and two additional mixing rounds.
 */
export function murmurhash3_32(bytes: number[], seed?: number): number {
    return mixMurmur32(bytes, seed, 0xcc9e2d51, 0x1b873593, 0x6b64, 0xe654);
}

/** Earlier port constants must remain unchanged to identify persisted channel IDs. */
function previousPortMurmur32(bytes: number[], seed?: number): number {
    return mixMurmur32(
        bytes,
        seed,
        0x85ebca6b,
        0xc2b2ae35,
        0x165667b1,
        0xe6546b64
    );
}

function previousPortXxHash32(bytes: number[], seed?: number): number {
    return mixXxHash32(
        bytes,
        seed,
        0x9e3779b9,
        0x85ebca6b,
        0xc2b2ae33,
        0x9e4c43cb,
        0x242f12f9
    );
}

// Keep hashing usable before the runtime bootstrap on older device adapters.
var hashMultiply32 =
    Math.imul ||
    function (left: number, right: number): number {
        return ((left & 0xffff) * right + (((left >>> 16) * right) << 16)) | 0;
    };

function mixMurmur32(
    bytes: number[],
    seed: number | undefined,
    c1: number,
    c2: number,
    addLow: number,
    addHigh: number
): number {
    if (seed === undefined) seed = 0;
    var multiply = hashMultiply32;
    var remainder = bytes.length & 3;
    var dataLen = bytes.length - remainder;
    var result = seed;
    var word0 = 0;
    var offset = 0;

    while (offset < dataLen) {
        word0 =
            (bytes[offset] & 0xff) |
            ((bytes[++offset] & 0xff) << 8) |
            ((bytes[++offset] & 0xff) << 16) |
            ((bytes[++offset] & 0xff) << 24);
        ++offset;
        word0 = multiply(word0, c1);
        word0 = (word0 << 15) | (word0 >>> 17);
        word0 = multiply(word0, c2);
        result ^= word0;
        result = (result << 13) | (result >>> 19);
        var product = multiply(result, 5);
        result =
            (product & 0xffff) +
            addLow +
            ((((product >>> 16) + addHigh) & 0xffff) << 16);
    }

    word0 = 0;
    switch (remainder) {
        case 3:
            word0 ^= (bytes[offset + 2] & 0xff) << 16;
        case 2:
            word0 ^= (bytes[offset + 1] & 0xff) << 8;
        case 1:
            word0 ^= bytes[offset] & 0xff;
            word0 = multiply(word0, c1);
            word0 = (word0 << 15) | (word0 >>> 17);
            word0 = multiply(word0, c2);
            result ^= word0;
    }

    result ^= bytes.length;
    result ^= result >>> 16;
    result = multiply(result, 0x85ebca6b);
    result ^= result >>> 13;
    result = multiply(result, 0xc2b2ae35);
    result ^= result >>> 16;
    return result >>> 0;
}

/** Optional upgrade observer installed only while a provider loads channels. */
function recordPreviousPortHash(
    kind: "murmur" | "xxhash",
    bytes: number[],
    seed: number,
    current: number
): void {
    if (typeof window === "undefined") return;
    var record = (window as any).__ottRecordPortHash;
    if (typeof record !== "function") return;
    var previous =
        kind === "murmur"
            ? previousPortMurmur32(bytes, seed)
            : previousPortXxHash32(bytes, seed);
    if (previous !== current) record(previous, current);
}

/**
 * Compute MurmurHash3 32-bit for a string (convenience wrapper).
 *
 * @param input - The string to hash.
 * @param seed  - Optional seed (default 0).
 * @returns The 32-bit hash, or 0 if the string is empty/falsy.
 *
 * @remarks
 * UTF-8-encodes the string first via `stringToUtf8Bytes`, then hashes the
 * resulting byte array. The suffix "gc" indicates this is the "garbage
 * collector" / string-friendly variant from the original MurmurHash3
 * reference implementation.
 */
export function murmurhash3_32_gc(input: string, seed?: number): number {
    if (input) {
        if (seed === undefined) seed = 0;
        var bytes = stringToUtf8Bytes(input);
        var result = murmurhash3_32(bytes, seed);
        recordPreviousPortHash("murmur", bytes, seed, result);
        return result;
    }
    return 0;
}

/**
 * Compute the xxHash32 of a byte array.
 *
 * @param bytes - The input byte values (0–255).
 * @param seed  - Optional seed value (default 0).
 * @returns The 32-bit unsigned hash.
 *
 * @remarks
 * Implements the xxHash32 algorithm. For inputs >= 16 bytes, processes
 * data in 4 parallel "lanes" with a round-robin accumulator, then
 * combines them with rotated sums. Remaining bytes are processed
 * one-by-one. The final output goes through three avalanche stages
 * (xor-shift-multiply). Integer multiplication uses a 32-bit operation
 * with a compatible fallback on hosts without Math.imul.
 */
export function xxHash32(bytes: number[], seed?: number): number {
    return mixXxHash32(
        bytes,
        seed,
        0x9e3779b1,
        0x85ebca77,
        0xc2b2ae3d,
        0x27d4eb2f,
        0x165667b1
    );
}

function mixXxHash32(
    bytes: number[],
    seed: number | undefined,
    p1: number,
    p2: number,
    p3: number,
    p4: number,
    p5: number
): number {
    if (seed === undefined) seed = 0;
    var multiply = hashMultiply32;
    var array = bytes;
    var result = (seed + p5) & 0xffffffff;
    var index = 0;

    if (array.length >= 16) {
        var lanes = [
            (seed + p1 + p2) & 0xffffffff,
            (seed + p2) & 0xffffffff,
            (seed + 0) & 0xffffffff,
            (seed - p1) & 0xffffffff,
        ];
        var tailEnd = array.length - 16;
        var lane = 0;
        for (index = 0; (index & 0xfffffff0) <= tailEnd; index += 4) {
            var offset = index;
            var word0 = array[offset + 0] + (array[offset + 1] << 8);
            var word1 = array[offset + 2] + (array[offset + 3] << 8);
            var product = multiply(word0 | (word1 << 16), p2);
            var acc = (lanes[lane] + product) & 0xffffffff;
            acc = (acc << 13) | (acc >>> 19);
            lanes[lane] = multiply(acc, p1);
            lane = (lane + 1) & 3;
        }
        result =
            (((lanes[0] << 1) | (lanes[0] >>> 31)) +
                ((lanes[1] << 7) | (lanes[1] >>> 25)) +
                ((lanes[2] << 12) | (lanes[2] >>> 20)) +
                ((lanes[3] << 18) | (lanes[3] >>> 14))) &
            0xffffffff;
    }

    result = (result + array.length) & 0xffffffff;
    var tailEnd2 = array.length - 4;
    for (; index <= tailEnd2; index += 4) {
        var offset2 = index;
        var word0b = array[offset2 + 0] + (array[offset2 + 1] << 8);
        var word1b = array[offset2 + 2] + (array[offset2 + 3] << 8);
        var product2 = multiply(word0b | (word1b << 16), p3);
        result = (result + product2) & 0xffffffff;
        result = (result << 17) | (result >>> 15);
        result = multiply(result, p4);
    }

    for (; index < array.length; ++index) {
        var byte = array[index];
        result += byte * p5;
        result = (result << 11) | (result >>> 21);
        result = multiply(result, p1);
    }

    result = result ^ (result >>> 15);
    result = multiply(result, p2);
    result = result ^ (result >>> 13);
    result = multiply(result, p3);
    result = result ^ (result >>> 16);
    return result >>> 0;
}

/**
 * Compute xxHash32 for a string with optional case insensitivity.
 *
 * @param input            - The string to hash.
 * @param caseInsensitive  - If true, lowercases the input before hashing.
 * @param seed             - Optional seed (default 0).
 * @returns The 32-bit hash, or 0 if the string is empty/falsy.
 *
 * @remarks
 * UTF-8-encodes the string before hashing. The "S" suffix in the function
 * name indicates "string" variant.
 */
export function xxHash32S(
    input: string,
    caseInsensitive?: boolean,
    seed?: number
): number {
    if (input) {
        if (caseInsensitive === true) {
            input = input.toLowerCase();
        }
        if (seed === undefined) seed = 0;
        var bytes = stringToUtf8Bytes(input);
        var result = xxHash32(bytes, seed);
        recordPreviousPortHash("xxhash", bytes, seed, result);
        return result;
    }
    return 0;
}

/**
 * Compute case-insensitive xxHash32, returning the hash as a decimal string.
 *
 * @param input - The string to hash (lowercased internally).
 * @returns The hash as a base-10 string, or `'0'` if the input is empty/falsy.
 *
 * @remarks
 * Convenience wrapper around `xxHash32(stringToUtf8Bytes(input.toLowerCase()), 0)`
 * that returns a string suitable for use as a key or identifier. The "Si"
 * suffix stands for "string, case-insensitive".
 */
export function xxHash32Si(input: string): string {
    if (!input) return "0";
    var bytes = stringToUtf8Bytes(input.toLowerCase());
    var result = xxHash32(bytes, 0);
    recordPreviousPortHash("xxhash", bytes, 0, result);
    return result.toString(10);
}

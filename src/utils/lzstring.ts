/**
 * LZ-String compression library.
 * Based on pieroxy/lz-string — compresses UTF-16 strings for storage.
 *
 * Provides compression/decompression to multiple encodings: plain string,
 * Base64, UTF-16, URI-component-safe, and Uint8Array.
 */

/** Base64 alphabet used by `compressToBase64` / `decompressFromBase64`. */
var _keyStrBase64 =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

/** URI-safe alphabet (no `+` or `/`, uses `-` and `$` instead). */
var _keyStrUriSafe =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";

/**
 * Cache of reverse-lookup dictionaries for character alphabets.
 * Maps alphabet string → { character → index }.
 */
var _baseReverseDic: Record<string, Record<string, number>> = {};

/**
 * Look up the numeric index of a character within a given alphabet,
 * building the reverse dictionary on first use.
 *
 * @param alphabet - The alphabet string (e.g. `_keyStrBase64`).
 * @param character - A single character to look up.
 * @returns The index of `character` in `alphabet`.
 *
 * @sideEffects
 * Populates `_baseReverseDic[alphabet]` on first invocation for a given
 * alphabet if it does not already exist.
 */
function getBaseValue(alphabet: string, character: string): number {
    if (!_baseReverseDic[alphabet]) {
        _baseReverseDic[alphabet] = {};
        for (var i = 0; i < alphabet.length; i++) {
            _baseReverseDic[alphabet][alphabet.charAt(i)] = i;
        }
    }
    return _baseReverseDic[alphabet][character];
}

/**
 * Compress a string using LZ-String's default compression (16 bits per char).
 *
 * @param uncompressed - The input string to compress.
 * @returns The compressed string, or an empty string if input is null/undefined.
 *
 * @remarks
 * Produces a plain UTF-16 string where each character represents a
 * 16-bit chunk of compressed data. Suitable for storage or transmission
 * where the charset is not restricted.
 */
export function compress(uncompressed: string): string {
    return _compress(uncompressed, 16, function (charCode: number) {
        return String.fromCharCode(charCode);
    }) as string;
}

/**
 * Core LZ-String compression engine.
 *
 * Implements a dictionary-based LZW-like algorithm with variable-length
 * bit encoding. Builds a dictionary incrementally from the input, writing
 * variable-bit-width codes into a stream, and flushing to output characters
 * when the bit buffer reaches `bitsPerChar` bits.
 *
 * @param uncompressed   - The raw input string.
 * @param bitsPerChar    - Number of bits per output character (e.g. 16 for
 *                         plain compress, 6 for Base64).
 * @param getCharFromInt - Callback that converts a bit-pattern (0-based
 *                         integer) to an output character for the target
 *                         encoding.
 * @returns The compressed output as a string.
 *
 * @remarks
 * Dictionary entries:
 * - 0–2: reserved (null/end-of-stream)
 * - 3+:    dynamic entries built from the input
 * Special char codes: < 256 → encoded as 8 bits; ≥ 256 → encoded as 16 bits.
 * The `contextEnlargeIn` counter triggers `contextNumBits` increases.
 */
function _compress(
    uncompressed: string,
    bitsPerChar: number,
    getCharFromInt: (n: number) => string
): string {
    if (uncompressed == null) return "";
    var contextDictionary: Record<string, number> = {};
    var contextDictionaryToCreate: Record<string, boolean> = {};
    var contextW = "";
    var contextDictSize = 3;
    var contextEnlargeIn = 2;
    var contextNumBits = 2;
    var contextData: string[] = [];
    var contextDataVal = 0;
    var contextDataPosition = 0;

    // Literal flags, code units and dictionary codes share the same bit stream.
    // Keep buffering inside the word writer instead of calling once per bit.
    function writeBits(count: number, value: number): void {
        for (var i = 0; i < count; i++) {
            contextDataVal = (contextDataVal << 1) | (value & 1);
            if (bitsPerChar - 1 === contextDataPosition) {
                contextDataPosition = 0;
                contextData.push(getCharFromInt(contextDataVal));
                contextDataVal = 0;
            } else {
                contextDataPosition++;
            }
            value >>= 1;
        }
    }

    // The last pending word follows exactly the same dictionary-width rules
    // as a word terminated by the next input character.
    function writeWord(): void {
        if (
            Object.prototype.hasOwnProperty.call(
                contextDictionaryToCreate,
                contextW
            )
        ) {
            var width = contextW.charCodeAt(0) < 256 ? 8 : 16;
            writeBits(contextNumBits, width === 8 ? 0 : 1);
            writeBits(width, contextW.charCodeAt(0));
            contextEnlargeIn--;
            if (contextEnlargeIn === 0) {
                contextEnlargeIn = 2 ** contextNumBits;
                contextNumBits++;
            }
            delete contextDictionaryToCreate[contextW];
        } else {
            writeBits(contextNumBits, contextDictionary[contextW]);
        }
        contextEnlargeIn--;
        if (contextEnlargeIn === 0) {
            contextEnlargeIn = 2 ** contextNumBits;
            contextNumBits++;
        }
    }

    for (var ii = 0; ii < uncompressed.length; ii++) {
        var contextC = uncompressed.charAt(ii);
        if (
            !Object.prototype.hasOwnProperty.call(contextDictionary, contextC)
        ) {
            contextDictionary[contextC] = contextDictSize++;
            contextDictionaryToCreate[contextC] = true;
        }
        var contextWc = contextW + contextC;
        if (
            Object.prototype.hasOwnProperty.call(contextDictionary, contextWc)
        ) {
            contextW = contextWc;
        } else {
            writeWord();
            contextDictionary[contextWc] = contextDictSize++;
            contextW = String(contextC);
        }
    }
    if (contextW !== "") writeWord();
    writeBits(contextNumBits, 2);

    // A full output character is emitted even when the end marker ended on
    // a character boundary; persisted LZ strings include this final padding.
    while (true) {
        contextDataVal <<= 1;
        if (bitsPerChar - 1 === contextDataPosition) {
            contextData.push(getCharFromInt(contextDataVal));
            break;
        }
        contextDataPosition++;
    }
    return contextData.join("");
}

/**
 * Decompress a string compressed with `compress()`.
 *
 * @param compressed - The compressed string (16-bit-per-char encoding).
 * @returns The original uncompressed string, `null` for empty input, or
 *          `''` if input is null/undefined.
 */
export function decompress(compressed: string): string | null {
    if (compressed == null) return "";
    if (compressed === "") return null;
    return _decompress(compressed.length, 32768, function (index: number) {
        return compressed.charCodeAt(index);
    });
}

/**
 * Core LZ-String decompression engine.
 *
 * Reads a variable-bit-width bit stream, reconstructs the dictionary
 * incrementally, and emits the decompressed output string.
 *
 * @param length       - The length (in characters) of the compressed input.
 * @param resetValue   - The initial `position` value for the bit reader
 *                       (corresponds to `bitsPerChar` from compression:
 *                       32768 for plain, 32 for Base64, 16384 for UTF-16).
 * @param getNextValue - Callback that returns the raw numeric value of the
 *                       character at the given index in the compressed stream.
 * @returns The decompressed string, `null` on corrupt data, or `''` for
 *          end-of-stream.
 *
 * @remarks
 * Dictionary entries 0–2 are reserved:
 * - 0: 8-bit literal follows
 * - 1: 16-bit literal follows
 * - 2: end-of-stream
 * Entry 3 is the first dynamically-added entry.
 * If an encountered code exceeds `dictSize`, the code is assumed to be the
 * next entry (LZW-like w+first-char-of-w rule).
 */
function _decompress(
    length: number,
    resetValue: number,
    getNextValue: (index: number) => number
): string | null {
    var dictionary: any[] = [];
    var enlargeIn = 4;
    var dictSize = 4;
    var numBits = 3;
    var entry = "";
    var result: string[] = [];
    var w = "";
    var c: any;
    var bits: number;
    var data: { val: number; position: number; index: number } = {
        index: 1,
        position: resetValue,
        val: getNextValue(0),
    };

    function readBits(count: number): number {
        var bits = 0;
        var power = 1;
        var maxpower = 2 ** count;
        while (power !== maxpower) {
            var resb = data.val & data.position;
            data.position >>= 1;
            if (data.position === 0) {
                data.position = resetValue;
                data.val = getNextValue(data.index++);
            }
            bits |= (resb > 0 ? 1 : 0) * power;
            power <<= 1;
        }
        return bits;
    }

    for (var i = 0; i < 3; i++) dictionary[i] = String.fromCharCode(i);

    var next = readBits(2);
    switch (next) {
        case 0:
        case 1:
            bits = readBits(next === 0 ? 8 : 16);
            c = String.fromCharCode(bits);
            break;
        case 2:
            return "";
    }
    dictionary[3] = c;
    w = c;
    result.push(c);

    while (true) {
        if (data.index > length) return "";
        next = readBits(numBits);
        switch (next) {
            case 0:
            case 1:
                bits = readBits(next === 0 ? 8 : 16);
                dictionary[dictSize++] = String.fromCharCode(bits);
                next = dictSize - 1;
                enlargeIn--;
                break;
            case 2:
                return result.join("");
        }
        if (enlargeIn === 0) {
            enlargeIn = 2 ** numBits;
            numBits++;
        }
        if (dictionary[next]) {
            entry = dictionary[next];
        } else {
            if (next === dictSize) {
                entry = w + w.charAt(0);
            } else {
                return null;
            }
        }
        result.push(entry);
        dictionary[dictSize++] = w + entry.charAt(0);
        w = entry;
        enlargeIn--;
        if (enlargeIn === 0) {
            enlargeIn = 2 ** numBits;
            numBits++;
        }
    }
}

/**
 * Compress to a Base64-encoded string.
 *
 * @param input - The string to compress.
 * @returns A Base64 string (with `=` padding), or `''` if input is null.
 *
 * @remarks
 * Uses 6 bits per output character with the standard Base64 alphabet
 * (A–Z, a–z, 0–9, +, /, = padding). Padding is added to make the output
 * length a multiple of 4.
 */
export function compressToBase64(input: string): string {
    if (input == null) return "";
    var res = _compress(input, 6, function (n: number) {
        return _keyStrBase64.charAt(n);
    });
    switch (res.length % 4) {
        default:
        case 0:
            return res;
        case 1:
            return res + "===";
        case 2:
            return res + "==";
        case 3:
            return res + "=";
    }
}

/**
 * Decompress from a Base64-encoded string produced by `compressToBase64`.
 *
 * @param input - The Base64 string to decompress.
 * @returns The original string, `null` for empty input, or `''` if input
 *          is null.
 */
export function decompressFromBase64(input: string): string | null {
    if (input == null) return "";
    if (input === "") return null;
    return _decompress(input.length, 32, function (index: number) {
        return getBaseValue(_keyStrBase64, input.charAt(index));
    });
}

/**
 * Compress to a UTF-16-compatible string (15 bits per char).
 *
 * @param input - The string to compress.
 * @returns A compressed string where each character code is shifted by +32
 *          to avoid control characters, terminated with a space.
 *
 * @remarks
 * Each output character encodes 15 bits of data plus 32 (to stay in the
 * printable range). A trailing space marks the end of the stream.
 */
export function compressToUTF16(input: string): string {
    if (input == null) return "";
    return (
        _compress(input, 15, function (n: number) {
            return String.fromCharCode(n + 32);
        }) + " "
    );
}

/**
 * Decompress from a UTF-16 string produced by `compressToUTF16`.
 *
 * @param input - The compressed UTF-16 string.
 * @returns The original string, `null` for empty input, or `''` if input
 *          is null.
 *
 * @remarks
 * Subtracts 32 from each character code to recover the 15-bit data values.
 */
export function decompressFromUTF16(input: string): string | null {
    if (input == null) return "";
    if (input === "") return null;
    return _decompress(input.length, 16384, function (index: number) {
        return input.charCodeAt(index) - 32;
    });
}

/**
 * Compress to a URI-component-safe string.
 *
 * @param input - The string to compress.
 * @returns A compressed string using the URI-safe alphabet (A–Z, a–z, 0–9,
 *          `-`, `$`), or `''` if input is null.
 *
 * @remarks
 * Uses 6 bits per output character with `_keyStrUriSafe`. No padding is
 * added. The output is safe to include directly in a URL query string
 * without percent-encoding (except for `%` itself).
 */
export function compressToEncodedURIComponent(input: string): string {
    if (input == null) return "";
    return _compress(input, 6, function (n: number) {
        return _keyStrUriSafe.charAt(n);
    });
}

/**
 * Decompress from a URI-component-safe string.
 *
 * @param input - The compressed URI-safe string.
 * @returns The original string, `null` for empty input, or `''` if input
 *          is null.
 *
 * @remarks
 * Replaces spaces with `'+'` before decoding to tolerate encoding artefacts
 * in query strings.
 */
export function decompressFromEncodedURIComponent(
    input: string
): string | null {
    if (input == null) return "";
    if (input === "") return null;
    var safe = input.replace(/ /g, "+");
    return _decompress(safe.length, 32, function (index: number) {
        return getBaseValue(_keyStrUriSafe, safe.charAt(index));
    });
}

/**
 * Compress to a `Uint8Array` (big-endian UTF-16 code units).
 *
 * @param uncompressed - The string to compress.
 * @returns A `Uint8Array` where every two bytes represent one character of
 *          the intermediate compressed string (high byte first).
 *
 * @remarks
 * Internally calls `compress()` then splits each 16-bit char code into two
 * bytes. The array length is `2 * compressed.length`.
 */
export function compressToUint8Array(uncompressed: string): Uint8Array {
    var compressed = compress(uncompressed);
    var result = new Uint8Array(compressed.length * 2);
    for (var i = 0, len = compressed.length; i < len; i++) {
        var charCode = compressed.charCodeAt(i);
        result[2 * i] = charCode >>> 8;
        result[2 * i + 1] = charCode % 256;
    }
    return result;
}

/**
 * Decompress from a `Uint8Array` produced by `compressToUint8Array`.
 *
 * @param byteArray - The byte array (big-endian 16-bit code units).
 * @returns The original string, or the result of `decompress(byteArray)` if
 *          `byteArray` is null (legacy fallback).
 *
 * @remarks
 * Reassembles pairs of bytes into 16-bit char codes, then calls
 * `decompress()` on the resulting string.
 */
export function decompressFromUint8Array(byteArray: Uint8Array): string | null {
    if (byteArray == null) return decompress(byteArray as any);
    var halfLength = byteArray.length / 2;
    var chars: number[] = new Array(halfLength);
    for (var i = 0; i < halfLength; i++) {
        chars[i] = 256 * byteArray[2 * i] + byteArray[2 * i + 1];
    }
    var result: string[] = [];
    chars.forEach(function (c: number) {
        result.push(String.fromCharCode(c));
    });
    return decompress(result.join(""));
}

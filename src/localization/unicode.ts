import {
    unicodeCanonicalData,
    unicodeCaseFoldData,
    unicodeCombiningData,
    unicodeCompositionData,
    unicodeConjunctData,
    unicodeGraphemeData,
    unicodePictographicData,
} from "./unicode-data";

var caseFoldMappings: Record<number, string> | null = null;
var canonicalDecompositions: Record<number, number[]> | null = null;
var canonicalCompositions: Record<string, number> | null = null;
var combiningClasses: Record<number, number> | null = null;
var graphemeRanges: number[][] | null = null;
var pictographicRanges: number[][] | null = null;
var conjunctRanges: number[][] | null = null;

function unicodePoint(value: string, at: number): number {
    var first = value.charCodeAt(at),
        second = value.charCodeAt(at + 1);
    return first >= 0xd800 &&
        first <= 0xdbff &&
        second >= 0xdc00 &&
        second <= 0xdfff
        ? (first - 0xd800) * 1024 + second - 0xdc00 + 0x10000
        : first;
}

function unicodeCharacter(point: number): string {
    return point < 0x10000
        ? String.fromCharCode(point)
        : String.fromCharCode(
              0xd800 + ((point - 0x10000) >> 10),
              0xdc00 + ((point - 0x10000) & 1023)
          );
}

/** Decode generated ASCII varints without atob, typed arrays or modern APIs. */
function readUnicodeData(data: string): number[] {
    var values: number[] = [],
        value = 0,
        factor = 1;
    for (var i = 0; i < data.length; i++) {
        var code = data.charCodeAt(i),
            part =
                code > 96
                    ? code - 71
                    : code > 64
                      ? code - 65
                      : code > 47
                        ? code + 4
                        : code === 43
                          ? 62
                          : 63;
        value += (part & 31) * factor;
        if (part < 32) {
            values.push(value);
            value = 0;
            factor = 1;
        } else factor *= 32;
    }
    return values;
}

function loadCanonicalDecompositions(): Record<number, number[]> {
    if (!canonicalDecompositions) {
        canonicalDecompositions = {};
        var values = readUnicodeData(unicodeCanonicalData),
            point = 0,
            previousTargets = [0, 0];
        for (var i = 0; i < values.length; ) {
            var header = values[i++],
                length = (header % 2) + 1,
                mapping: number[] = [];
            point += Math.floor(header / 2);
            for (var j = 0; j < length; j++) {
                var offset = values[i++];
                previousTargets[j] +=
                    offset % 2 ? -(offset + 1) / 2 : offset / 2;
                mapping.push(previousTargets[j]);
            }
            canonicalDecompositions[point] = mapping;
        }
    }
    return canonicalDecompositions;
}

function loadCombiningClasses(): Record<number, number> {
    if (!combiningClasses) {
        combiningClasses = {};
        var values = readUnicodeData(unicodeCombiningData),
            end = 0;
        for (var i = 0; i < values.length; i += 3) {
            var start = end + values[i];
            end = start + values[i + 1];
            for (var point = start; point <= end; point++)
                combiningClasses[point] = values[i + 2];
        }
    }
    return combiningClasses;
}

/** Canonical decomposition only: accents and compatibility distinctions survive. */
export function canonicalSearchText(value: string): string {
    if (/^[\x00-\x7f]*$/.test(value)) return value;
    var decompositions = loadCanonicalDecompositions();
    var points: number[] = [],
        classes = loadCombiningClasses();
    function append(point: number): void {
        if (point >= 0xac00 && point <= 0xd7a3) {
            var offset = point - 0xac00;
            append(0x1100 + Math.floor(offset / 588));
            append(0x1161 + Math.floor((offset % 588) / 28));
            if (offset % 28) append(0x11a7 + (offset % 28));
            return;
        }
        var decomposition = decompositions[point];
        if (decomposition) {
            decomposition.forEach(append);
            return;
        }
        points.push(point);
    }
    for (var i = 0; i < value.length; ) {
        var point = unicodePoint(value, i);
        append(point);
        i += point > 0xffff ? 2 : 1;
    }
    // Reorder only unsorted nonstarter runs. Stable CCC buckets avoid quadratic
    // insertion work on long pasted/provider text without relying on ES5 sort.
    var start = 0,
        previous = 0,
        unsorted = false;
    for (var end = 0; end <= points.length; end++) {
        var order = end < points.length ? classes[points[end]] || 0 : 0;
        if (!order) {
            if (unsorted) {
                var buckets: number[][] = [],
                    at = start;
                for (var index = start; index < end; index++) {
                    var current = classes[points[index]];
                    if (!buckets[current]) buckets[current] = [];
                    buckets[current].push(points[index]);
                }
                for (var rank = 1; rank < buckets.length; rank++) {
                    var bucket = buckets[rank];
                    if (bucket)
                        for (var item = 0; item < bucket.length; item++)
                            points[at++] = bucket[item];
                }
            }
            start = end + 1;
            unsorted = false;
        } else if (order < previous) unsorted = true;
        previous = order;
    }
    return points.map(unicodeCharacter).join("");
}

/** Recompose canonical text so a trailing accent stays part of substring matches. */
export function canonicalComposedText(value: string): string {
    if (/^[\x00-\x7f]*$/.test(value)) return value;
    value = canonicalSearchText(value);
    if (!canonicalCompositions) {
        canonicalCompositions = {};
        var compositions = readUnicodeData(unicodeCompositionData),
            cp = 0;
        var decompositions = loadCanonicalDecompositions();
        for (var n = 0; n < compositions.length; n++) {
            cp += compositions[n];
            var pair = decompositions[cp];
            canonicalCompositions[pair[0] + ":" + pair[1]] = cp;
        }
    }
    var points: number[] = [],
        classes = loadCombiningClasses(),
        starter = -1,
        previousClass = 0;
    for (var i = 0; i < value.length; ) {
        var point = unicodePoint(value, i),
            order = classes[point] || 0,
            combined = 0;
        i += point > 0xffff ? 2 : 1;
        if (starter >= 0 && (!previousClass || previousClass < order)) {
            var first = points[starter];
            if (
                first >= 0x1100 &&
                first < 0x1113 &&
                point >= 0x1161 &&
                point < 0x1176
            )
                combined =
                    0xac00 + ((first - 0x1100) * 21 + point - 0x1161) * 28;
            else if (
                first >= 0xac00 &&
                first <= 0xd7a3 &&
                (first - 0xac00) % 28 === 0 &&
                point > 0x11a7 &&
                point < 0x11c3
            )
                combined = first + point - 0x11a7;
            else combined = canonicalCompositions[first + ":" + point] || 0;
        }
        if (combined) points[starter] = combined;
        else {
            if (!order) starter = points.length;
            points.push(point);
            previousClass = order;
        }
    }
    return points.map(unicodeCharacter).join("");
}

/** Full default Unicode 17 C+F folding, including expansions and supplementary letters. */
function caseFoldText(value: string): string {
    if (/^[\x00-\x7f]*$/.test(value))
        return value.replace(/[A-Z]/g, function (char) {
            return String.fromCharCode(char.charCodeAt(0) + 32);
        });
    if (!caseFoldMappings) {
        caseFoldMappings = {};
        var values = readUnicodeData(unicodeCaseFoldData),
            point = 0,
            targets = [0, 0, 0];
        for (var i = 0; i < values.length; ) {
            var header = values[i++],
                length = (header % 4) + 1,
                text = "";
            point += Math.floor(header / 4);
            for (var j = 0; j < length; j++) {
                var offset = values[i++];
                targets[j] += offset % 2 ? -(offset + 1) / 2 : offset / 2;
                text += unicodeCharacter(targets[j]);
            }
            caseFoldMappings[point] = text;
        }
    }
    var result = "";
    for (var at = 0; at < value.length; ) {
        var current = unicodePoint(value, at);
        result += caseFoldMappings[current] || unicodeCharacter(current);
        at += current > 0xffff ? 2 : 1;
    }
    return result;
}

/** A comparison key; never write it back to user/provider text. */
export function unicodeSearchKey(value: string, locale: string): string {
    var text = canonicalSearchText(String(value || ""));
    if (/^(tr|az)(-|$)/i.test(locale) && text.indexOf("I") >= 0) {
        var classes = loadCombiningClasses(),
            parts: string[] = [],
            start = 0;
        for (var at = 0; at < text.length; at++) {
            if (text.charAt(at) !== "I") continue;
            var dot = -1;
            for (var next = at + 1; next < text.length; ) {
                var point = unicodePoint(text, next),
                    order = classes[point] || 0;
                if (point === 0x0307) {
                    dot = next;
                    break;
                }
                // SpecialCasing Before_Dot: lower-CCC marks do not block the dot.
                if (!order || order === 230) break;
                next += point > 0xffff ? 2 : 1;
            }
            parts.push(text.substring(start, at), dot < 0 ? "ı" : "i");
            start = at + 1;
            if (dot >= 0) {
                parts.push(text.substring(start, dot));
                start = dot + 1;
                at = dot;
            }
        }
        // Copy each unchanged span once, including long pasted/provider text.
        parts.push(text.substring(start));
        text = parts.join("");
    }
    // Fold decomposed text first: U+0345 can become a starter, and expansions
    // can expose new compositions. Final NFC keeps substring accents intact.
    return canonicalComposedText(caseFoldText(text));
}

function unicodeRanges(data: string, withProperty: boolean): number[][] {
    var values = readUnicodeData(data),
        ranges: number[][] = [],
        end = 0;
    for (var i = 0; i < values.length; ) {
        var start = end + values[i++];
        end = start + values[i++];
        ranges.push([start, end, withProperty ? values[i++] : 1]);
    }
    return ranges;
}

function unicodeRangeProperty(point: number, ranges: number[][]): number {
    var low = 0,
        high = ranges.length - 1;
    while (low <= high) {
        var middle = (low + high) >> 1,
            range = ranges[middle];
        if (point < range[0]) high = middle - 1;
        else if (point > range[1]) low = middle + 1;
        else return range[2];
    }
    return 0;
}

/** GCB: Other0 CR1 LF2 Control3 Extend4 ZWJ5 RI6 Prepend7 SpacingMark8 L9 V10 T11 LV12 LVT13. */
function graphemeProperty(point: number): number {
    if (point >= 0xac00 && point <= 0xd7a3)
        return (point - 0xac00) % 28 ? 13 : 12;
    if (!graphemeRanges)
        graphemeRanges = unicodeRanges(unicodeGraphemeData, true);
    return unicodeRangeProperty(point, graphemeRanges);
}

/** Unicode 17 extended grapheme clusters, UAX #29 GB3–GB13/GB999. */
function legacyTextBoundaries(value: string): number[] {
    if (!pictographicRanges)
        pictographicRanges = unicodeRanges(unicodePictographicData, false);
    if (!conjunctRanges)
        conjunctRanges = unicodeRanges(unicodeConjunctData, true);
    var boundaries = [0],
        previous = 0,
        regionalCount = 0;
    var pictographicChain = false,
        afterPictographicZwj = false,
        conjunctState = 0;
    for (var i = 0; i < value.length; ) {
        var point = unicodePoint(value, i),
            current = graphemeProperty(point);
        var pictographic = !!unicodeRangeProperty(point, pictographicRanges);
        // InCB: Linker1 Consonant2 Extend3; state2 means a consonant + linker prefix.
        var conjunct = unicodeRangeProperty(point, conjunctRanges);
        var joined = i === 0 || (previous === 1 && current === 2);
        if (
            !joined &&
            !(previous >= 1 && previous <= 3) &&
            !(current >= 1 && current <= 3)
        ) {
            joined =
                (previous === 9 &&
                    (current === 9 ||
                        current === 10 ||
                        current === 12 ||
                        current === 13)) ||
                ((previous === 10 || previous === 12) &&
                    (current === 10 || current === 11)) ||
                ((previous === 11 || previous === 13) && current === 11) ||
                current === 4 ||
                current === 5 ||
                current === 8 ||
                previous === 7 ||
                (conjunctState === 2 && conjunct === 2) ||
                (afterPictographicZwj && pictographic) ||
                (previous === 6 && current === 6 && regionalCount % 2 === 1);
        }
        if (!joined) boundaries.push(i);
        regionalCount = current === 6 ? regionalCount + 1 : 0;
        afterPictographicZwj = current === 5 && pictographicChain;
        pictographicChain =
            pictographic || (current === 4 && pictographicChain);
        if (conjunct === 2) conjunctState = 1;
        else if (conjunct === 1 && conjunctState) conjunctState = 2;
        else if (conjunct !== 3) conjunctState = 0;
        previous = current;
        i += point > 0xffff ? 2 : 1;
    }
    if (value.length) boundaries.push(value.length);
    return boundaries;
}

/** Previous/next whole grapheme; direction 0 moves to a boundary at or after position. */
export function textBoundary(
    value: string,
    position: number,
    direction: number
): number {
    position = Math.max(0, Math.min(value.length, position || 0));
    if (!direction) {
        if (!position) return 0;
        position = Math.ceil(position) - 1;
        direction = 1;
    }
    if (
        (direction < 0 && !position) ||
        (direction > 0 && position === value.length)
    )
        return position;
    // Pinned boundaries also cover engines exposing an older Intl.Segmenter.
    if (/^[\x20-\x7e]*$/.test(value))
        return direction < 0
            ? Math.max(0, Math.ceil(position) - 1)
            : Math.min(value.length, Math.floor(position) + 1);
    var boundaries = legacyTextBoundaries(value);
    if (direction < 0) {
        for (var i = boundaries.length - 1; i >= 0; i--)
            if (boundaries[i] < position) return boundaries[i];
        return 0;
    }
    for (var j = 0; j < boundaries.length; j++)
        if (boundaries[j] > position) return boundaries[j];
    return value.length;
}

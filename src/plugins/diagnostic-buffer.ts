/** Bounded FIFO for already-sanitized JSON events. Sequence IDs never repeat. */
export interface DiagnosticBufferOptions {
    maxBytes: number;
    maxEntries: number;
    maxEventBytes: number;
}
interface DiagnosticEntry {
    bytes: number;
    payload: string;
    sequence: number;
}
export function createDiagnosticBuffer(options: DiagnosticBufferOptions) {
    var maximum = 9007199254740991;
    function integer(value: number, max: number, min = 0): boolean {
        return (
            typeof value === "number" &&
            isFinite(value) &&
            value >= min &&
            value <= max &&
            Math.floor(value) === value
        );
    }
    if (
        !options ||
        !integer(options.maxEntries, 800, 1) ||
        !integer(options.maxBytes, 512 * 1024, 1) ||
        !integer(
            options.maxEventBytes,
            Math.min(options.maxBytes, 32 * 1024),
            1
        )
    )
        throw new Error("Invalid diagnostic buffer limits");
    var maxEntries = options.maxEntries;
    var maxBytes = options.maxBytes;
    var maxEventBytes = options.maxEventBytes;
    var entries: DiagnosticEntry[] = [];
    var bytes = 0;
    var latest = 0;
    var dropped = 0;
    function drop(count: number): void {
        dropped = Math.min(maximum, dropped + count);
    }
    function size(value: string): number {
        var length = 0;
        for (var i = 0; i < value.length; i++) {
            var code = value.charCodeAt(i);
            if (code < 128) length++;
            else if (code < 2048) length += 2;
            else if (
                code >= 0xd800 &&
                code <= 0xdbff &&
                value.charCodeAt(i + 1) >= 0xdc00 &&
                value.charCodeAt(i + 1) <= 0xdfff
            ) {
                length += 4;
                i++;
            } else length += 3;
        }
        return length;
    }
    function append(payload: string): number | null {
        if (
            typeof payload !== "string" ||
            !payload.length ||
            payload.length > maxEventBytes ||
            latest === maximum
        ) {
            drop(1);
            return null;
        }
        var eventBytes = size(payload);
        if (eventBytes > maxEventBytes) {
            drop(1);
            return null;
        }
        try {
            var parsed = JSON.parse(payload);
            if (
                !parsed ||
                typeof parsed !== "object" ||
                Array.isArray(parsed)
            ) {
                drop(1);
                return null;
            }
        } catch (_) {
            drop(1);
            return null;
        }
        while (entries.length >= maxEntries || bytes + eventBytes > maxBytes) {
            bytes -= entries.shift()!.bytes;
            drop(1);
        }
        latest++;
        entries.push({ bytes: eventBytes, payload: payload, sequence: latest });
        bytes += eventBytes;
        return latest;
    }
    function read(afterSequence: number, limit: number, byteLimit: number) {
        if (
            !integer(afterSequence, maximum) ||
            !integer(limit, maximum) ||
            !integer(byteLimit, maximum)
        )
            throw new Error("Invalid diagnostic cursor or limits");
        var page: DiagnosticEntry[] = [];
        var pageBytes = 0;
        var next = afterSequence;
        // Accepted IDs remain consecutive in the FIFO; rejected appends allocate none.
        var oldest = entries.length ? entries[0].sequence : 0;
        for (
            var i = Math.max(0, afterSequence - oldest + 1);
            i < entries.length && page.length < limit;
            i++
        ) {
            var entry = entries[i];
            if (pageBytes + entry.bytes > byteLimit) break;
            page.push({
                bytes: entry.bytes,
                payload: entry.payload,
                sequence: entry.sequence,
            });
            next = entry.sequence;
            pageBytes += entry.bytes;
        }
        return {
            droppedCount: dropped,
            entries: page,
            gap: afterSequence < (oldest ? oldest - 1 : latest),
            latestSequence: latest,
            nextSequence: next,
            oldestSequence: oldest,
        };
    }
    function clear(): void {
        drop(entries.length);
        entries = [];
        bytes = 0;
    }
    function stats() {
        return {
            bytes: bytes,
            droppedCount: dropped,
            entries: entries.length,
            latestSequence: latest,
        };
    }
    return { append: append, clear: clear, read: read, stats: stats };
}

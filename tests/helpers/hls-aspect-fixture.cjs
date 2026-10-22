const assert = require("node:assert/strict");

// This parser accepts only the bounded, ordinary-size boxes emitted by our
// pinned mux.js fixture generator. It is not a general media-file parser.
function boxes(bytes, start = 0, end = bytes.length) {
    const result = [];
    for (let offset = start; offset < end; ) {
        assert.ok(offset + 8 <= end, "Truncated fixture box header");
        const size = bytes.readUInt32BE(offset);
        assert.ok(
            size >= 8 && size <= end - offset,
            "Invalid fixture box size"
        );
        result.push({
            end: offset + size,
            start: offset,
            type: bytes.toString("ascii", offset + 4, offset + 8),
        });
        offset += size;
    }
    return result;
}
function one(rows, type) {
    const matches = rows.filter((box) => box.type === type);
    assert.equal(matches.length, 1, "Expected one fixture " + type);
    return matches[0];
}
function initHeaders(bytes) {
    assert.ok(bytes.length > 0 && bytes.length <= 1024 * 1024);
    const top = boxes(bytes);
    assert.deepEqual(
        top.map((box) => box.type),
        ["ftyp", "moov"]
    );
    const ftyp = one(top, "ftyp");
    assert.ok(ftyp.end - ftyp.start >= 20);
    assert.equal((ftyp.end - ftyp.start) % 4, 0);
    const moov = one(top, "moov");
    const movie = boxes(bytes, moov.start + 8, moov.end);
    const mvhd = one(movie, "mvhd");
    const trak = one(movie, "trak");
    const track = boxes(bytes, trak.start + 8, trak.end);
    const tkhd = one(track, "tkhd");
    const mdia = one(track, "mdia");
    const minf = one(boxes(bytes, mdia.start + 8, mdia.end), "minf");
    const stbl = one(boxes(bytes, minf.start + 8, minf.end), "stbl");
    const stsd = one(boxes(bytes, stbl.start + 8, stbl.end), "stsd");
    assert.ok(stsd.end - stsd.start >= 16);
    assert.equal(bytes.readUInt32BE(stsd.start + 8), 0);
    assert.equal(bytes.readUInt32BE(stsd.start + 12), 1);
    const samples = boxes(bytes, stsd.start + 16, stsd.end);
    assert.equal(samples.length, 1);
    const sample = samples[0];
    assert.ok(sample.type === "avc1" || sample.type === "mp4a");
    let avcC;
    if (sample.type === "avc1") {
        assert.ok(sample.end - sample.start >= 94);
        avcC = one(boxes(bytes, sample.start + 86, sample.end), "avcC");
        assert.ok(avcC.end - avcC.start >= 15);
        assert.equal(bytes[avcC.start + 8], 1);
    }
    one(movie, "mvex");
    for (const header of [mvhd, tkhd]) {
        assert.equal(
            bytes[header.start + 8],
            0,
            "Expected version-zero fixture header"
        );
        assert.ok(
            header.end - header.start >= 32,
            "Truncated fixture timing header"
        );
    }
    return { avcC, ftyp, mvhd, sample, tkhd };
}
function normalizeHlsInit(input) {
    const bytes = Buffer.from(input);
    const { avcC, ftyp, mvhd, sample, tkhd } = initHeaders(bytes);
    // RFC 8216 section 3.3 requires an iso6-compatible brand and zero movie /
    // track durations for HLS fMP4 initialization. mux.js emits isom and an
    // unknown-duration sentinel. Track IDs, timescales and media samples stay
    // intact. For AVC, also normalize the required reserved bits / constant
    // fields; the SPS/PPS codec parameter sets are not modified.
    bytes.write("iso6", ftyp.start + 8, 4, "ascii");
    bytes.writeUInt32BE(0, mvhd.start + 24);
    bytes.writeUInt32BE(0, tkhd.start + 28);
    if (avcC) {
        bytes.writeUInt16BE(0xffff, sample.start + 84);
        bytes[avcC.start + 13] |= 0xe0;
    }
    validateHlsInit(bytes);
    return bytes;
}
function validateHlsInit(bytes) {
    const { avcC, ftyp, mvhd, sample, tkhd } = initHeaders(bytes);
    assert.equal(
        bytes.toString("ascii", ftyp.start + 8, ftyp.start + 12),
        "iso6"
    );
    assert.equal(bytes.readUInt32BE(mvhd.start + 24), 0);
    assert.equal(bytes.readUInt32BE(tkhd.start + 28), 0);
    if (avcC) {
        assert.equal(bytes.readUInt16BE(sample.start + 84), 0xffff);
        assert.equal(bytes[avcC.start + 13] & 0xe0, 0xe0);
    }
}
function createHlsAspectFixture(tsBytes) {
    // Separate fMP4 renditions exercise real HLS audio/video decoding without
    // relying on GStreamer's multiplexed SourceBuffer path or re-encoding.
    const fixture = {};
    const transmuxer = new (require("mux.js").mp4.Transmuxer)({ remux: false });
    transmuxer.on("data", (segment) => {
        const type = segment.type;
        assert.ok(type === "audio" || type === "video");
        assert.equal(fixture[type + "-init.mp4"], undefined);
        fixture[type + ".m3u8"] =
            '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="' +
            type +
            '-init.mp4"\n#EXTINF:2,\n' +
            type +
            "-segment.m4s\n#EXT-X-ENDLIST\n";
        fixture[type + "-init.mp4"] = normalizeHlsInit(segment.initSegment);
        fixture[type + "-segment.m4s"] = Buffer.from(segment.data);
    });
    transmuxer.push(new Uint8Array(tsBytes));
    transmuxer.flush();
    assert.equal(
        Object.keys(fixture).length,
        6,
        "Expected both HLS renditions"
    );
    return fixture;
}
module.exports = { createHlsAspectFixture, normalizeHlsInit, validateHlsInit };

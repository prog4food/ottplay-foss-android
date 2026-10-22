const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const {
    createHlsAspectFixture,
    normalizeHlsInit,
    validateHlsInit,
} = require("./helpers/hls-aspect-fixture.cjs");
const ts = fs.readFileSync(
    path.join(__dirname, "fixtures/media-runtime/segment00.ts")
);
const original = {};
const muxer = new (require("mux.js").mp4.Transmuxer)({ remux: false });
muxer.on("data", (segment) => {
    original[segment.type] = segment;
});
muxer.push(new Uint8Array(ts));
muxer.flush();
const fixture = createHlsAspectFixture(ts);
// Independently locate the fields in these generated version-zero boxes.
function timingOffset(bytes, type, delta) {
    const index = bytes.indexOf(Buffer.from(type));
    assert.ok(index > 4);
    assert.equal(bytes.indexOf(Buffer.from(type), index + 4), -1);
    assert.equal(bytes[index + 4], 0);
    return index - 4 + delta;
}
for (const type of ["audio", "video"]) {
    test(
        type +
            " HLS init meets header syntax without changing codec parameters or sample bytes",
        () => {
            const before = Buffer.from(original[type].initSegment);
            const after = fixture[type + "-init.mp4"];
            validateHlsInit(after);
            assert.throws(() => validateHlsInit(before));
            assert.equal(after.length, before.length);
            const expected = Buffer.from(before);
            expected.write("iso6", 8, 4, "ascii");
            expected.writeUInt32BE(0, timingOffset(before, "mvhd", 24));
            expected.writeUInt32BE(0, timingOffset(before, "tkhd", 28));
            if (type === "video") {
                const sample = before.indexOf(
                    Buffer.from("avc1"),
                    before.indexOf(Buffer.from("moov"))
                );
                const config = before.indexOf(Buffer.from("avcC"));
                // Independent positions in the known generated sample entry.
                assert.equal(sample, 417);
                assert.equal(config, 503);
                expected.writeUInt16BE(0xffff, sample + 80);
                expected[config + 9] |= 0xe0;
            }
            assert.deepEqual(after, expected);
            assert.deepEqual(
                fixture[type + "-segment.m4s"],
                Buffer.from(original[type].data)
            );
            assert.deepEqual(Buffer.from(original[type].initSegment), before);
            assert.deepEqual(normalizeHlsInit(after), after);
        }
    );
    test(
        type + " validator rejects each incorrect HLS initialization field",
        () => {
            const valid = fixture[type + "-init.mp4"];
            for (const offset of [
                8,
                timingOffset(valid, "mvhd", 24),
                timingOffset(valid, "tkhd", 28),
            ]) {
                const invalid = Buffer.from(valid);
                invalid.writeUInt32BE(0xffffffff, offset);
                assert.throws(() => validateHlsInit(invalid));
            }
        }
    );
}
test("fixture normalization rejects malformed or unsupported boxes", () => {
    const valid = fixture["video-init.mp4"];
    for (const input of [
        Buffer.alloc(0),
        valid.subarray(0, valid.length - 1),
        Buffer.alloc(1024 * 1024 + 1),
    ]) {
        assert.throws(() => normalizeHlsInit(input));
    }
    for (const size of [0, 1, 7, 0xffffffff]) {
        const invalid = Buffer.from(valid);
        invalid.writeUInt32BE(size, 0);
        assert.throws(() => normalizeHlsInit(invalid));
    }
    const unsupported = Buffer.from(valid);
    unsupported[timingOffset(valid, "mvhd", 8)] = 1;
    assert.throws(() => normalizeHlsInit(unsupported));
});
test("AVC validator rejects incorrect reserved fields independently", () => {
    const valid = fixture["video-init.mp4"];
    for (const offset of [497, 498, 512]) {
        const invalid = Buffer.from(valid);
        invalid[offset] = 0;
        assert.throws(() => validateHlsInit(invalid));
    }
});

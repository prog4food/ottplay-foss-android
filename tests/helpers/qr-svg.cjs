const assert = require("node:assert/strict");

function raster(svg, dimension) {
    assert.equal((svg.match(/<path /g) || []).length, 1);
    const data = /<path fill="#000000" d="([^"]*)"\/>/.exec(svg)[1];
    const commands = /M(\d+),(\d+)h(\d+)v1h-(\d+)z/g;
    const cells = Array.from({ length: dimension }, () =>
        Array(dimension).fill(false)
    );
    let match;
    let end = 0;
    let segments = 0;
    while ((match = commands.exec(data))) {
        assert.equal(match.index, end, "every path command must be understood");
        end = commands.lastIndex;
        const [x, y, width, reverse] = match.slice(1).map(Number);
        assert.equal(width, reverse, "each rectangle must close");
        assert.ok(width > 0);
        assert.ok(x >= 2 && y >= 2 && y < dimension - 2);
        assert.ok(x + width <= dimension - 2);
        for (let column = x; column < x + width; column++) {
            assert.equal(cells[y][column], false, "rectangles cannot overlap");
            cells[y][column] = true;
        }
        segments++;
    }
    assert.equal(end, data.length, "no unsupported trailing path commands");
    return { cells, segments };
}

function assertQrSvg(context, payload) {
    const { QrCode, QrSegment } = context.qrcodegen;
    assert.equal(context.makeQrSvg.length, 2);
    assert.equal(typeof QrCode.encodeBinary, "function");
    assert.equal(typeof QrSegment.makeEci, "function");
    assert.ok(QrSegment.Mode.KANJI);
    assert.ok(QrSegment.Mode.ECI);
    const qr = QrCode.encodeText(payload, QrCode.Ecc.MEDIUM);
    const dimension = qr.size + 4;
    const svg = context.makeQrSvg(payload);
    assert.ok(svg.includes(`viewBox="0 0 ${dimension} ${dimension}"`));
    assert.ok(svg.includes('width="240" height="240"'));
    assert.ok(
        svg.includes('<rect width="100%" height="100%" fill="#ffffff"/>')
    );
    const actual = raster(svg, dimension);
    let dark = 0;
    let runs = 0;
    for (let y = 0; y < dimension; y++) {
        for (let x = 0; x < dimension; x++) {
            const expected = qr.getModule(x - 2, y - 2);
            assert.equal(actual.cells[y][x], expected, `module ${x},${y}`);
            if (expected) {
                dark++;
                if (!qr.getModule(x - 3, y - 2)) runs++;
            }
        }
    }
    assert.equal(
        actual.segments,
        runs,
        "one rectangle per horizontal dark run"
    );
    assert.ok(actual.segments < dark, "coalescing must reduce the path count");
    return {
        dark,
        modules: qr.size,
        segments: actual.segments,
        svgBytes: Buffer.byteLength(svg),
    };
}

module.exports = { assertQrSvg };

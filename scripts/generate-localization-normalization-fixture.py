#!/usr/bin/env python3
"""Recreate the test-only Unicode normalization fixture from official local files.

No network is used. Pass --unicode16 and --unicode17 paths to NormalizationTest.txt.
Original source hashes are checked before any output is written.
"""
import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path

SOURCES = {'16.0.0': {'url': 'https://www.unicode.org/Public/16.0.0/ucd/NormalizationTest.txt', 'sha256': 'd811971453e7075e1ad56fb1b301eece5aa80757b81f6156e74a1bfb3ae5ceb1', 'vectors': 19965}, '17.0.0': {'url': 'https://www.unicode.org/Public/17.0.0/ucd/NormalizationTest.txt', 'sha256': '5019ffd530751a741900c849c0e010332f142a3612234639bd200b82138a87db', 'vectors': 20034}}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_vectors(path, version):
    raw = path.read_bytes()
    assert digest(raw) == SOURCES[version]["sha256"], "Unexpected official source bytes"
    rows = []
    for line in raw.decode().splitlines():
        text = line.split("#")[0].strip()
        if not text or text.startswith("@"):
            continue
        rows.append(["".join(chr(int(n, 16)) for n in col.split())
                     for col in text.split(";")[:5]])
    assert len(rows) == SOURCES[version]["vectors"]
    return rows


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--unicode16", type=Path, required=True)
parser.add_argument("--unicode17", type=Path, required=True)
args = parser.parse_args()
old = read_vectors(args.unicode16, "16.0.0")
new = read_vectors(args.unicode17, "17.0.0")
previous, added = 0, []
for index, row in enumerate(new):
    if previous < len(old) and row == old[previous]:
        previous += 1
    else:
        added.append(index)
assert previous == len(old) and len(added) == 69
payload = json.dumps(new, ensure_ascii=False, separators=(",", ":")).encode()
encoded = base64.b64encode(gzip.compress(payload, compresslevel=9, mtime=0)).decode()
fixture = {
    "version": "17.0.0",
    "license": "js/licenses/Unicode-3.0.txt",
    "sources": SOURCES,
    "encoding": "gzip+base64 of UTF-8 JSON arrays [source,NFC,NFD,NFKC,NFKD]",
    "payloadSha256": digest(payload),
    "unicode16PayloadSha256": digest(json.dumps(old, ensure_ascii=False, separators=(",", ":")).encode()),
    "unicode17AddedIndexes": added,
    "gzipBase64": [encoded[i:i + 120] for i in range(0, len(encoded), 120)],
}
(Path(__file__).resolve().parents[1] / "tests/fixtures/unicode-normalization-17.json").write_text(json.dumps(fixture, indent=2) + "\n")

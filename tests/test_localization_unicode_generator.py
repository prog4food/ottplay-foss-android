#!/usr/bin/env python3
"""Reject malformed offline Unicode inputs before replacing generated data."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = "scripts/generate-localization-unicode.py"
NORMALIZATION = "scripts/localization-unicode-normalization.json"
GRAPHEMES = "scripts/localization-unicode-graphemes.json"
DATA = "src/localization/unicode-data.ts"
SENTINEL = b"previous generated data must survive invalid inputs\n"


class UnicodeGeneratorInputs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in [SCRIPT, NORMALIZATION, GRAPHEMES, "tests/fixtures/unicode/CaseFolding-17.0.0.txt"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        (self.root / DATA).parent.mkdir(parents=True)
        self.normalization = json.loads((ROOT / NORMALIZATION).read_text())
        self.graphemes = json.loads((ROOT / GRAPHEMES).read_text())

    def run_generator(self, normalization=None, graphemes=None, *, args=("--check-inputs",), optimized=False):
        (self.root / NORMALIZATION).write_text(json.dumps(self.normalization if normalization is None else normalization))
        (self.root / GRAPHEMES).write_text(json.dumps(self.graphemes if graphemes is None else graphemes))
        (self.root / DATA).write_bytes(SENTINEL)
        command = [sys.executable, *(["-O"] if optimized else []), str(self.root / SCRIPT), *args]
        return subprocess.run(command, cwd=self.root, capture_output=True, text=True,
                              timeout=30, env=os.environ | {"PYTHONDONTWRITEBYTECODE": "1"})

    def assert_rejected(self, **kwargs):
        result = self.run_generator(**kwargs)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Invalid Unicode input:", result.stderr)
        self.assertEqual((self.root / DATA).read_bytes(), SENTINEL)

    def test_current_inputs_validate_without_writing(self):
        result = self.run_generator()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / DATA).read_bytes(), SENTINEL)

    def test_reversed_overlapping_and_unordered_ranges(self):
        cases = [
            ("CR", "d-c"), ("LF", "d-d"), ("CR", "d-d;d-e"),
            ("CR", "20-20;d-d"), ("CR", "d-d;d-d"),
            ("CR", "110000-110000"), ("CR", "-1-d"),
            ("CR", "d"), ("CR", "d-e-f"), ("CR", "g-g"),
            ("CR", ""), ("CR", []),
        ]
        for name, value in cases:
            with self.subTest(name=name, value=value):
                data = copy.deepcopy(self.graphemes)
                data["properties"]["gcb"][name] = value
                self.assert_rejected(graphemes=data)

    def test_integer_combining_classes_and_codepoint_bounds(self):
        for rank in [-1, 256, 1.5, True, "230", None]:
            with self.subTest(rank=rank):
                data = copy.deepcopy(self.normalization)
                data["combiningClassOverlay"]["1acf"] = rank
                self.assert_rejected(normalization=data)
        for point in ["110000", "-1", "0x1acf", "_1acf", "zzzz", ""]:
            with self.subTest(point=point):
                data = copy.deepcopy(self.normalization)
                data["combiningClassOverlay"][point] = 230
                self.assert_rejected(normalization=data)
        data = copy.deepcopy(self.normalization)
        data["combiningClassOverlay"]["01acf"] = 230
        self.assert_rejected(normalization=data)

    def test_schema_and_version_errors(self):
        for field, value in [("version", "18.0.0"), ("baseVersion", "17.0.0"),
                             ("combiningClassCount", True), ("combiningClassCount", -1),
                             ("combiningClassCount", 0x110001), ("combiningClassOverlay", []),
                             ("canonicalDecompositionSha256", "invalid")]:
            with self.subTest(field=field, value=value):
                data = copy.deepcopy(self.normalization)
                data[field] = value
                self.assert_rejected(normalization=data)
        for field, value in [("version", "16.0.0"), ("properties", []), ("sources", {})]:
            with self.subTest(field=field):
                data = copy.deepcopy(self.graphemes)
                data[field] = value
                self.assert_rejected(graphemes=data)
        data = copy.deepcopy(self.graphemes)
        data["properties"]["gcb"]["unknown"] = "d-d"
        self.assert_rejected(graphemes=data)

    def test_normal_generation_and_optimized_python_reject_before_write(self):
        for optimized in [False, True]:
            for field, value in [("CR", "d-c"), ("LF", "d-d")]:
                with self.subTest(optimized=optimized, field=field):
                    data = copy.deepcopy(self.graphemes)
                    data["properties"]["gcb"][field] = value
                    self.assert_rejected(graphemes=data, args=(), optimized=optimized)
            data = copy.deepcopy(self.normalization)
            data["combiningClassOverlay"]["1acf"] = 256
            self.assert_rejected(normalization=data, args=(), optimized=optimized)

    def test_valid_zero_surrogates_and_maximum_codepoint_ranges(self):
        # Property files cover codepoints, including surrogate code units.
        for field, value in [("Control", "0-0;1-1"), ("CR", "d800-dfff"),
                             ("CR", "10ffff-10ffff")]:
            with self.subTest(field=field, value=value):
                data = copy.deepcopy(self.graphemes)
                data["properties"]["gcb"][field] = value
                result = self.run_generator(graphemes=data)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((self.root / DATA).read_bytes(), SENTINEL)

    @unittest.skipUnless(unicodedata.unidata_version == "16.0.0", "full generation requires pinned host UCD16")
    def test_integrity_checks_survive_optimized_python(self):
        for optimized in [False, True]:
            for field, value in [("canonicalDecompositionSha256", "0" * 64),
                                 ("compositionSha256", "0" * 64),
                                 ("combiningClassCount", self.normalization["combiningClassCount"] + 1)]:
                with self.subTest(optimized=optimized, field=field):
                    data = copy.deepcopy(self.normalization)
                    data[field] = value
                    self.assert_rejected(normalization=data, args=(), optimized=optimized)
        fixture = self.root / "tests/fixtures/unicode/CaseFolding-17.0.0.txt"
        fixture.write_bytes(fixture.read_bytes() + b"\n# altered source\n")
        for optimized in [False, True]:
            self.assert_rejected(args=(), optimized=optimized)

    @unittest.skipUnless(unicodedata.unidata_version == "16.0.0", "full generation requires pinned host UCD16")
    def test_current_data_regenerates_byte_exactly(self):
        result = self.run_generator(args=())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / DATA).read_bytes(), (ROOT / DATA).read_bytes())


if __name__ == "__main__":
    unittest.main()

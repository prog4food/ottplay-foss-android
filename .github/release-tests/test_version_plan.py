# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Offline contracts for frozen identities and owned version-file projections."""

# Fixture byte layouts and descriptive test names are intentional; cleanup uses unittest.
# The adapter contracts ship together as one vendored suite.
# pylint: disable=too-many-lines
# pylint: disable=missing-function-docstring,missing-class-docstring,line-too-long,consider-using-with

import copy
import importlib.util
import io
import json
import os
import plistlib
# Subprocess calls below use argument vectors with shell=False.
import subprocess  # nosec B404
import sys
import tarfile
import tempfile
import tomllib
import unittest
import zipfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "version_plan.py"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("version_plan", SCRIPT)
version = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(version)
SHA = "a" * 40


def policy(files=None, promotion="final-build"):
    return {
        "mode": "release",
        "repository": "example/product",
        "version_file": "package.json",
        "versioning": {
            "schema": 1,
            "promotion": promotion,
            "files": files
            or [
                {
                    "path": "package.json",
                    "format": "json",
                    "field": "version",
                    "package": "product",
                    "value": "package",
                }
            ],
        },
    }


class PlanTest(unittest.TestCase):
    def test_nightly_sequence_requires_ascii_digits(self):
        configuration = policy()
        sequence = "20261008123456.1.1"
        plan = version.create_plan("1.2.3", "nightly", sequence, SHA, configuration)
        self.assertEqual(plan["tag"], "v1.2.3-nightly." + sequence)
        invalid_sequences = (
            "２０２６１００８１２３４５６.1.1",
            "20261008123456.١.1",
            "20261008123456.1.𝟙",
            "20261008123456.1١.1",
            "20261008123456.1.1𝟙",
        )
        for invalid in invalid_sequences:
            with self.subTest(sequence=invalid), self.assertRaises(ValueError):
                version.create_plan("1.2.3", "nightly", invalid, SHA, configuration)

    def test_exact_identity_and_package_profiles(self):
        for profile in ("final-build", "promote-bytes"):
            config = policy(promotion=profile)
            beta = version.create_plan("2.5.42", "beta", 2, SHA, config)
            rc = version.create_plan("2.5.42", "rc", 3, SHA, config)
            stable = version.create_plan("2.5.42", "stable", None, SHA, config)
            self.assertEqual(beta["tag"], "v2.5.42-beta.2")
            self.assertEqual(version.projections(beta, "pep440")["package"], "2.5.42b2")
            self.assertEqual(version.projections(rc)["full"], "2.5.42-rc.3")
            self.assertEqual(
                version.projections(rc)["package"],
                "2.5.42-rc.3" if profile == "final-build" else "2.5.42",
            )
            self.assertEqual(
                version.projections(rc, "pep440")["package"],
                "2.5.42rc3" if profile == "final-build" else "2.5.42",
            )
            self.assertEqual(stable["version"], "2.5.42")

    def test_nightly_identity_is_frozen_and_pep440_has_no_local_suffix(self):
        plan = version.create_plan(
            "1.2.3", "nightly", "20260913235959.123.2", SHA, policy()
        )
        self.assertEqual(plan["tag"], "v1.2.3-nightly.20260913235959.123.2")
        projected = version.projections(plan, "pep440")["package"]
        self.assertRegex(projected, r"^1\.2\.3\.dev\d+$")
        later = version.create_plan(
            "1.2.3", "nightly", "20260913235959.123.10", SHA, policy()
        )
        self.assertLess(
            int(projected.split("dev")[1]),
            int(version.projections(later, "pep440")["package"].split("dev")[1]),
        )

    def test_malformed_identity_fails_closed(self):
        configuration = policy()
        uppercase_sha = SHA.upper()
        for base in ("v1.2.3", "1.02.3", "1.2", "1.2.3-beta.1", "1.2.3\n", "1.2.٣"):
            with self.subTest(base=base), self.assertRaises(ValueError):
                version.create_plan(base, "beta", 1, SHA, configuration)
        for sequence in (True, 0, -1, "1", None):
            with self.subTest(sequence=sequence), self.assertRaises(ValueError):
                version.create_plan("1.2.3", "rc", sequence, SHA, configuration)
        with self.assertRaises(ValueError):
            version.create_plan("1.2.3", "stable", 1, SHA, configuration)
        with self.assertRaises(ValueError):
            version.create_plan("1.2.3", "nightly", "20260230235959.1.1", SHA, configuration)
        with self.assertRaises(ValueError):
            version.create_plan("1.2.3", "beta", 1, uppercase_sha, configuration)

    def test_real_nightly_run_fits_uv_numeric_limit(self):
        plan = version.create_plan(
            "1.3.3", "nightly", "20260919073112.35429540547.1", SHA, policy()
        )
        projected = version.projections(plan, "pep440")["package"]
        self.assertEqual(projected, "1.3.3.dev35429540547000001")
        self.assertLessEqual(int(projected.split("dev")[1]), 2**64 - 2)

    def test_nightly_runs_and_attempts_cannot_collide_or_overflow(self):
        def project(run, attempt):
            plan = version.create_plan(
                "1.2.3", "nightly", f"20260919073112.{run}.{attempt}", SHA, policy()
            )
            return int(version.projections(plan, "pep440")["package"].split("dev")[1])

        self.assertLess(project(12, 999999), project(13, 1))
        run, attempt = divmod(2**64 - 2, 1_000_000)
        self.assertEqual(project(run, attempt), 2**64 - 2)
        for args in ((12, 1000000), (run, attempt + 1), (run + 1, 1)):
            with self.subTest(args=args), self.assertRaises(ValueError):
                project(*args)

    def test_plan_policy_source_and_canonical_digest_binding(self):
        config = policy()
        plan = version.create_plan("1.2.3", "beta", 1, SHA, config)
        self.assertIs(version.validate_plan(plan, config, SHA), plan)
        reversed_plan = dict(reversed(list(plan.items())))
        self.assertEqual(version.plan_digest(plan), version.plan_digest(reversed_plan))
        changed = copy.deepcopy(config)
        changed["versioning"]["files"][0]["field"] = "other"
        with self.assertRaisesRegex(ValueError, "policy digest"):
            version.validate_plan(plan, changed)
        with self.assertRaisesRegex(ValueError, "source SHA"):
            version.validate_plan(plan, source_sha="b" * 40)
        for field, value in (
            ("tag", "v9.9.9"),
            ("schema_version", True),
            ("build_number", True),
            ("unexpected", "x"),
        ):
            broken = {**plan, field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                version.validate_plan(broken)

    def test_allocated_counter_must_exceed_declared_migration_floor(self):
        config = policy()
        config["versioning"]["build_number_floor"] = 2005042
        with self.assertRaisesRegex(ValueError, "migration floor"):
            version.create_plan("2.5.42", "beta", 1, SHA, config, 2005042)
        plan = version.create_plan("2.5.42", "beta", 1, SHA, config, 2005043)
        with self.assertRaisesRegex(ValueError, "migration floor"):
            version.validate_plan({**plan, "build_number": 2005041}, config)

    def test_unknown_or_ambiguous_policy_fields_are_rejected(self):
        for change in (
            lambda p: p["versioning"].update({"promotion": "silently-rebuild"}),
            lambda p: p["versioning"].update({"wildcard": "*"}),
            lambda p: p["versioning"]["files"][0].update({"replace_all": True}),
            lambda p: p["versioning"]["files"][0].update({"format": "yaml"}),
            lambda p: p["versioning"]["files"].append(
                p["versioning"]["files"][0].copy()
            ),
            lambda p: p["versioning"].update({"build_number_floor": True}),
        ):
            config = policy()
            change(config)
            with self.assertRaises(ValueError):
                version.create_plan("1.2.3", "beta", 1, SHA, config)

    def test_apple_build_projection_is_valid_monotonic_and_bounded(self):
        config = policy(
            [
                {
                    "path": "Info.plist",
                    "format": "plist",
                    "field": "CFBundleVersion",
                    "value": "apple-build",
                }
            ]
        )
        values = []
        for counter in (1, 99, 100, 9999, 10000, 10001, 2005043, 99_990_000):
            plan = version.create_plan("1.2.3", "beta", 1, SHA, config, counter)
            output = version.projections(plan)["apple-build"]
            self.assertRegex(output, r"^[1-9]\d{0,3}\.\d{1,2}\.\d{1,2}$")
            values.append(tuple(map(int, output.split("."))))
        self.assertEqual(values, sorted(values))
        self.assertEqual(values[0], (1, 0, 0))
        self.assertEqual(values[-1], (9999, 99, 99))
        for counter in (None, 0, True, 99_990_001, 2_100_000_001):
            with self.subTest(counter=counter), self.assertRaises(ValueError):
                version.create_plan("1.2.3", "beta", 1, SHA, config, counter)


class AdapterTest(unittest.TestCase):  # pylint: disable=too-many-public-methods
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value.encode() if isinstance(value, str) else value)
        return path

    def sync(self, files, channel="beta", profile="final-build", number=2005043):
        config = policy(files, profile)
        plan = version.create_plan(
            "2.5.42", channel, None if channel == "stable" else 2, SHA, config, number
        )
        return config, plan, version.sync_versions(self.root, config, plan)

    def test_json_exact_fields_minimal_diff_and_second_sync_idempotent(self):
        before = '{\n  "name": "product",\n  "version": "2.5.42",\n  "dependencies": {"other":"2.5.42"},\n  "extra": "Привет"\n}\n'
        path = self.write("package.json", before)
        config, plan, evidence = self.sync(policy()["versioning"]["files"])
        self.assertEqual(
            path.read_text(),
            before.replace('"version": "2.5.42"', '"version": "2.5.42-beta.2"'),
        )
        self.assertTrue(evidence[0]["changed"])
        again = version.sync_versions(self.root, config, plan)
        self.assertFalse(again[0]["changed"])
        self.assertEqual(
            version.effective_inputs_digest(evidence),
            version.effective_inputs_digest(again),
        )
        version.sync_versions(self.root, config, plan, check=True)

    def test_json_array_field_supports_literal_dotted_and_empty_keys(self):
        path = self.write(
            "meta.json", '{"": {"release.version": "2.5.42"}, "other": "2.5.42"}\n'
        )
        self.sync(
            [
                {
                    "path": "meta.json",
                    "format": "json",
                    "field": ["", "release.version"],
                    "value": "full",
                }
            ]
        )
        self.assertEqual(
            json.loads(path.read_bytes())[""]["release.version"], "2.5.42-beta.2"
        )
        self.assertEqual(json.loads(path.read_bytes())["other"], "2.5.42")

    def test_check_rejects_drift_without_writing(self):
        before = '{"name":"product","version":"2.5.42"}\n'
        path = self.write("package.json", before)
        config = policy()
        plan = version.create_plan("2.5.42", "beta", 1, SHA, config)
        with self.assertRaisesRegex(ValueError, "do not match"):
            version.sync_versions(self.root, config, plan, check=True)
        self.assertEqual(path.read_text(), before)

    def test_all_edits_validate_before_any_file_is_written(self):
        before = '{"name":"product","version":"2.5.42"}\n'
        path = self.write("package.json", before)
        self.write("bad.toml", '[project]\nname = "another"\nversion = "2.5.42"\n')
        files = policy()["versioning"]["files"] + [
            {
                "path": "bad.toml",
                "format": "toml",
                "field": "project.version",
                "package": "product",
            }
        ]
        with self.assertRaisesRegex(ValueError, "identity"):
            self.sync(files)
        self.assertEqual(path.read_text(), before)
        self.assertFalse(list(self.root.glob(".version-sync-*")))

    def test_json_missing_duplicate_and_wrong_owner_rejected(self):
        files = policy()["versioning"]["files"]
        for raw in (
            '{"name":"product"}',
            '{"name":"other","version":"2.5.42"}',
            '{"name":"product","version":"1.0.0","version":"2.5.42"}',
        ):
            path = self.write("package.json", raw)
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                self.sync(files)
            self.assertEqual(path.read_text(), raw)

    def test_npm_lock_changes_only_root_owned_entries(self):
        before = '{\n "name":"product", "version":"2.5.42", "lockfileVersion":3,\n "packages": {"":{"name":"product", "version":"2.5.42"}, "node_modules/product":{"version":"2.5.42"}, "node_modules/other":{"version":"2.5.42"}}\n}\n'
        path = self.write("package-lock.json", before)
        self.sync(
            [{"path": "package-lock.json", "format": "npm-lock", "package": "product"}]
        )
        after = path.read_text()
        self.assertEqual(
            after, before.replace('"version":"2.5.42"', '"version":"2.5.42-beta.2"', 2)
        )

    def test_cargo_lock_owns_only_unregistered_package_and_keeps_comments(self):
        before = '# lock generated\nversion = 4\n\n[[package]]\nname = "product"\nversion = "2.5.42" # own\n\n[[package]]\nname = "product"\nversion = "2.5.42"\nsource = "registry+https://example.test"\n\n[[package]]\nname = "other"\nversion = "2.5.42"\n'
        path = self.write("Cargo.lock", before)
        self.sync(
            [{"path": "Cargo.lock", "format": "cargo-lock", "package": "product"}]
        )
        self.assertEqual(
            path.read_text(),
            before.replace(
                'version = "2.5.42" # own', 'version = "2.5.42-beta.2" # own'
            ),
        )

    def test_cargo_lock_rejects_ambiguous_or_dependency_only_selector(self):
        for content in (
            '[[package]]\nname="product"\nversion="2.5.42"\nsource="registry+example"\n',
            '[[package]]\nname="product"\nversion="2.5.42"\n\n[[package]]\nname="product"\nversion="2.5.41"\n',
        ):
            self.write("Cargo.lock", content)
            with self.assertRaisesRegex(ValueError, "exactly one owned"):
                self.sync(
                    [
                        {
                            "path": "Cargo.lock",
                            "format": "cargo-lock",
                            "package": "product",
                        }
                    ]
                )

    def test_uv_lock_changes_only_editable_owned_package(self):
        before = 'version = 1\n[[package]]\nname = "product"\nversion = "2.5.42"\nsource = { editable = "." }\n[[package]]\nname = "other"\nversion = "2.5.42"\nsource = { registry = "https://pypi.org/simple" }\n'
        path = self.write("uv.lock", before)
        self.sync(
            [
                {
                    "path": "uv.lock",
                    "format": "uv-lock",
                    "package": "product",
                    "ecosystem": "pep440",
                }
            ]
        )
        self.assertEqual(
            path.read_text(),
            before.replace('version = "2.5.42"', 'version = "2.5.42b2"', 1),
        )

    def test_toml_exact_owned_fields_preserve_quotes_comments_and_dependencies(self):
        before = "# versions\n[project]\nname = 'product'\nversion  = '2.5.42' # own value\n[tool.other]\nversion = '2.5.42'\n"
        path = self.write("pyproject.toml", before)
        self.sync(
            [
                {
                    "path": "pyproject.toml",
                    "format": "toml",
                    "field": "project.version",
                    "package": "product",
                    "ecosystem": "pep440",
                }
            ]
        )
        self.assertEqual(
            path.read_text(),
            before.replace("version  = '2.5.42'", "version  = '2.5.42b2'"),
        )

    def test_toml_quoted_table_keys_and_dotted_assignments(self):
        self.write("config.toml", '[tool."product.name"]\nrelease.version = "2.5.42"\n')
        self.sync(
            [
                {
                    "path": "config.toml",
                    "format": "toml",
                    "field": ["tool", "product.name", "release", "version"],
                }
            ]
        )
        self.assertIn(
            'release.version = "2.5.42-beta.2"', (self.root / "config.toml").read_text()
        )

    def test_toml_table_delimiters_inside_quoted_keys_are_literal(self):
        for quoted, key in (
            ('"bracket]#key"', "bracket]#key"),
            ("'bracket]#key'", "bracket]#key"),
            ('"escaped\\\"quote]key"', 'escaped"quote]key'),
        ):
            with self.subTest(quoted=quoted):
                before = f"[tool.{quoted}] # trailing [comment]\nversion = '2.5.42'\n"
                path = self.write("config.toml", before)
                self.sync([{
                    "path": "config.toml", "format": "toml",
                    "field": ["tool", key, "version"],
                }])
                self.assertEqual(path.read_text(), before.replace("2.5.42", "2.5.42-beta.2"))

    def test_toml_quoted_assignment_keys_preserve_delimiters_and_escapes(self):
        cases = (
            ('"a=b"', "a=b"),
            ('"a#b"', "a#b"),
            ("'literal=#key'", "literal=#key"),
            (r'"escaped\"=quote#key"', 'escaped"=quote#key'),
            (r'"backslash\\=key#"', 'backslash\\=key#'),
            (r'"\u0023\u003d"', "#="),
            ('""', ""),
            (r"'literal\=#key'", 'literal\\=#key'),
        )
        for quoted, key in cases:
            with self.subTest(quoted=quoted):
                assignment = f'release.{quoted} = "2.5.42"'
                before = (
                    '# release.fake = "2.5.42"\n[tool]\n'
                    'unrelated = "2.5.42"\n'
                    + assignment + ' # preserve = and # here\n'
                )
                self.assertEqual(tomllib.loads(before)["tool"]["release"][key], "2.5.42")
                path = self.write("config.toml", before)
                self.sync([{
                    "path": "config.toml", "format": "toml",
                    "field": ["tool", "release", key],
                }])
                expected = before.replace(assignment, assignment.replace('"2.5.42"', '"2.5.42-beta.2"'))
                self.assertEqual(path.read_text(), expected)
                self.assertEqual(tomllib.loads(expected)["tool"]["release"][key], "2.5.42-beta.2")

    def test_toml_unrelated_quoted_assignment_keys_do_not_block_version_sync(self):
        before = (
            '"a=b" = 1\n"a#b" = "2.5.42"\n'
            "'literal=#key' = 2\n"
            '# "fake=key" = "2.5.42"\n[project]\n'
            'version = "2.5.42" # retain comment = text\n'
        )
        self.assertEqual(tomllib.loads(before)["a#b"], "2.5.42")
        path = self.write("config.toml", before)
        self.sync([{
            "path": "config.toml", "format": "toml", "field": "project.version",
        }])
        self.assertEqual(path.read_text(), before.replace('version = "2.5.42"', 'version = "2.5.42-beta.2"'))

    def test_toml_long_quoted_assignment_key_preserves_layout(self):
        key = 'escaped"=#\\' * 10000
        before = json.dumps(key) + ' = 1 # ignored = delimiter\nversion = "2.5.42"\n'
        self.assertEqual(tomllib.loads(before)[key], 1)
        path = self.write("config.toml", before)
        self.sync([{"path": "config.toml", "format": "toml", "field": "version"}])
        self.assertEqual(path.read_text(), before.replace('version = "2.5.42"', 'version = "2.5.42-beta.2"'))

    def test_toml_long_whitespace_and_header_comment_preserve_layout(self):
        padding = " " * 4000
        before = (
            padding + "\n"
            + padding + "[project]" + padding + "# [brackets] in comment\n"
            + 'name = "product"\n'
            + "version" + padding + "=" + padding + '"2.5.42" # retained\n'
        )
        path = self.write("pyproject.toml", before)
        self.sync(
            [{"path": "pyproject.toml", "format": "toml", "field": "project.version"}]
        )
        self.assertEqual(path.read_text(), before.replace('"2.5.42"', '"2.5.42-beta.2"'))

    def test_toml_continued_arrays_inline_tables_and_strings_are_not_assignments(self):
        before = (
            """[project]
name = "product"
dependencies = [
  "requests>=2.0", # = and quote are data
  "paho-mqtt==2.1",
]
authors = [
 {name = "Maintainer", email = "email@example.test"},
]
description = """
            + "'''"
            + """
version = "do not edit string content"
"""
            + "'''"
            + """
version = "2.5.42"
"""
        )
        path = self.write("pyproject.toml", before)
        self.sync(
            [
                {
                    "path": "pyproject.toml",
                    "format": "toml",
                    "field": "project.version",
                    "package": "product",
                    "ecosystem": "pep440",
                }
            ]
        )
        self.assertEqual(
            path.read_text(),
            before.replace('version = "2.5.42"', 'version = "2.5.42b2"'),
        )

    def test_python_updates_module_constant_not_dependencies_or_functions(self):
        before = '# coding: utf-8\nVERSION: str = "2.5.42"  # Own version\nOTHER = "2.5.42"\ndef dependency():\n    VERSION = "2.5.42"\n    return VERSION\n'
        path = self.write("runtime.py", before)
        self.sync(
            [
                {
                    "path": "runtime.py",
                    "format": "python",
                    "field": "VERSION",
                    "ecosystem": "pep440",
                }
            ]
        )
        self.assertEqual(
            path.read_text(),
            before.replace('VERSION: str = "2.5.42"', 'VERSION: str = "2.5.42b2"'),
        )

    def test_python_rejects_computed_shared_or_reassigned_constant(self):
        for content in (
            "VERSION = get_version()\n",
            'VERSION = OTHER = "2.5.42"\n',
            'VERSION = "2.5.42"\nVERSION = "2.5.43"\n',
        ):
            self.write("runtime.py", content)
            with self.assertRaises(ValueError):
                self.sync(
                    [{"path": "runtime.py", "format": "python", "field": "VERSION"}]
                )

    def test_python_base_check_preserves_existing_quote_style(self):
        original = 'VERSION = "2.5.42"  # no formatting changes\n'
        path = self.write("runtime.py", original)
        config = policy(
            [{"path": "runtime.py", "format": "python", "field": "VERSION"}]
        )
        config["version_file"] = "runtime.py"
        version.check_base_versions(self.root, config)
        self.assertEqual(path.read_text(), original)

    def test_python_version_updates_preserve_single_and_double_quotes(self):
        for quote in ("'", '"'):
            with self.subTest(quote=quote):
                before = f"__version__: str = {quote}2.5.42{quote}  # public identity\n"
                path = self.write("runtime.py", before)
                self.sync(
                    [
                        {
                            "path": "runtime.py",
                            "format": "python",
                            "field": "__version__",
                            "ecosystem": "pep440",
                        }
                    ]
                )
                self.assertEqual(path.read_text(), before.replace("2.5.42", "2.5.42b2"))

    def test_text_prefix_and_whitespace_preserved(self):
        path = self.write("VERSION", "  v2.5.42\r\n")
        files = [{"path": "VERSION", "format": "text", "prefix": "v"}]
        self.sync(files)
        self.assertEqual(path.read_bytes(), b"  v2.5.42-beta.2\r\n")
        self.write("VERSION", "v2.5.42\nother\n")
        with self.assertRaises(ValueError):
            self.sync(files)

    def test_plist_base_and_build_fields_preserve_other_data(self):
        original = {
            "CFBundleShortVersionString": "2.5.42",
            "CFBundleVersion": "2.5.42",
            "CFBundleIdentifier": "com.example.product",
            "Nested": {"version": "keep"},
        }
        self.write("Info.plist", plistlib.dumps(original))
        files = [
            {
                "path": "Info.plist",
                "format": "plist",
                "field": "CFBundleShortVersionString",
                "value": "base",
            },
            {
                "path": "Info.plist",
                "format": "plist",
                "field": "CFBundleVersion",
                "value": "apple-build",
            },
        ]
        config, plan, _ = self.sync(files)
        actual = plistlib.loads((self.root / "Info.plist").read_bytes())
        self.assertEqual(
            actual,
            {**original, "CFBundleVersion": version.projections(plan)["apple-build"]},
        )
        version.sync_versions(self.root, config, plan, check=True)

    def test_plist_rejects_full_prerelease_in_numeric_marketing_field(self):
        self.write(
            "Info.plist", plistlib.dumps({"CFBundleShortVersionString": "2.5.42"})
        )
        with self.assertRaisesRegex(ValueError, "numeric X.Y.Z"):
            self.sync(
                [
                    {
                        "path": "Info.plist",
                        "format": "plist",
                        "field": "CFBundleShortVersionString",
                        "value": "full",
                    }
                ]
            )

    def test_pbxproj_edits_only_explicit_configuration_uuid(self):
        a, b = "A" * 24, "B" * 24
        block = "\tUUID /* Debug */ = {\n\t\tisa = XCBuildConfiguration;\n\t\tbuildSettings = {\n\t\t\tMARKETING_VERSION = 2.5.41;\n\t\t\tCURRENT_PROJECT_VERSION = 2.5.41;\n\t\t};\n\t};\n"
        before = block.replace("UUID", a) + block.replace("UUID", b)
        path = self.write("project.pbxproj", before)
        self.sync(
            [
                {
                    "path": "project.pbxproj",
                    "format": "pbxproj",
                    "package": a,
                    "field": "MARKETING_VERSION",
                    "value": "base",
                }
            ]
        )
        self.assertEqual(
            path.read_text(),
            before.replace(
                "MARKETING_VERSION = 2.5.41", "MARKETING_VERSION = 2.5.42", 1
            ),
        )

    def test_path_traversal_symlinks_and_hardlinks_are_rejected(self):
        self.write("original.json", '{"version":"2.5.42"}')
        (self.root / "alias.json").symlink_to(self.root / "original.json")
        os.link(self.root / "original.json", self.root / "hard.json")
        (self.root / "linked").symlink_to(self.root, target_is_directory=True)
        for name in (
            "../escape",
            # Malicious absolute-path fixture verifies rejection; no file is created.
            "/outside-checkout/escape",
            "sub/../original.json",
            "alias.json",
            "linked/original.json",
            "hard.json",
            ".git/config",
        ):
            with self.subTest(path=name), self.assertRaises(ValueError):
                self.sync([{"path": name, "format": "json", "field": "version"}])

    def test_conflicting_overlapping_selectors_fail_before_write(self):
        before = '{"name":"product","version":"2.5.42","packages":{"":{"name":"product","version":"2.5.42"}}}'
        path = self.write("package-lock.json", before)
        files = [
            {
                "path": "package-lock.json",
                "format": "npm-lock",
                "package": "product",
                "value": "base",
            },
            {
                "path": "package-lock.json",
                "format": "json",
                "field": "version",
                "value": "full",
            },
        ]
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            self.sync(files)
        self.assertEqual(path.read_text(), before)

    def test_base_check_ignores_dynamic_counter_but_checks_every_companion(self):
        self.write(
            "package.json", '{"name":"product","version":"2.5.42","build":2005042}'
        )
        self.write("version.txt", "v2.5.42\n")
        files = policy()["versioning"]["files"] + [
            {
                "path": "package.json",
                "format": "json",
                "field": "build",
                "value": "build",
            },
            {"path": "version.txt", "format": "text", "prefix": "v"},
        ]
        config = policy(files)
        self.assertEqual(version.read_base_version(self.root, config), "2.5.42")
        version.check_base_versions(self.root, config)
        self.write("version.txt", "v2.5.41\n")
        with self.assertRaisesRegex(ValueError, "version.txt"):
            version.check_base_versions(self.root, config)

    def test_cli_writes_plan_bound_receipt_and_check_does_not_modify_it(self):
        self.write("package.json", '{"name":"product","version":"2.5.42"}')
        config = policy()
        plan = version.create_plan("2.5.42", "beta", 1, SHA, config)
        self.write(".release-policy.json", json.dumps(config))
        self.write(".release-plan.json", json.dumps(plan))
        command = [
            sys.executable,
            str(SCRIPT),
            "sync",
            "--root",
            str(self.root),
            "--plan",
            ".release-plan.json",
        ]
        # Isolated test fixture; explicit argv, never shell interpolation.
        subprocess.run(command, check=True, capture_output=True)  # nosec B603
        receipt = self.root / ".release-inputs.json"
        before = receipt.read_bytes()
        actual = json.loads(before)
        self.assertEqual(actual["schema"], 1)
        self.assertEqual(actual["source_sha"], SHA)
        self.assertEqual(actual["plan_sha256"], version.plan_digest(plan))
        self.assertEqual(
            actual["effective_inputs_sha256"],
            version.effective_inputs_digest(actual["files"]),
        )
        # Isolated test fixture; explicit argv, never shell interpolation.
        subprocess.run(command + ["--check"], check=True, capture_output=True)  # nosec B603
        self.assertEqual(receipt.read_bytes(), before)

    def test_git_source_binding_rejects_unrelated_input_changes(self):
        self.write(
            "package.json", '{"name":"product","version":"2.5.42","other":true}\n'
        )

        def git(*args):
            # Test harness intentionally uses its fixture-controlled PATH.
            return subprocess.check_output(  # nosec B603, B607
                ["git", "-C", str(self.root), *args],
                stderr=subprocess.DEVNULL,
                text=True,
            ).strip()

        git("init")
        git("add", "package.json")
        git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "fixture",
        )
        config = policy()
        plan = version.create_plan(
            "2.5.42", "beta", 1, git("rev-parse", "HEAD"), config
        )
        version.verify_checkout(self.root, config, plan)
        version.sync_versions(self.root, config, plan)
        version.verify_checkout(self.root, config, plan)
        path = self.root / "package.json"
        path.write_text(path.read_text().replace("true", "false"))
        with self.assertRaisesRegex(ValueError, "Undeclared changes"):
            version.verify_checkout(self.root, config, plan)
        with self.assertRaisesRegex(ValueError, "HEAD differs"):
            version.verify_checkout(self.root, config, {**plan, "source_sha": SHA})

    def test_git_source_binding_accepts_declared_checkout_eol_conversion(self):
        self.write(
            ".gitattributes", "package.json text eol=crlf\nVERSION text eol=crlf\n"
        )
        self.write(
            "package.json", '{"name":"product","version":"2.5.42","other":true}\n'
        )
        self.write("VERSION", "2.5.42\n")

        def git(*args):
            # Test harness intentionally uses its fixture-controlled PATH.
            return subprocess.check_output(  # nosec B603, B607
                ["git", "-C", str(self.root), *args],
                stderr=subprocess.DEVNULL,
                text=True,
            ).strip()

        git("init")
        git("add", ".gitattributes", "package.json", "VERSION")
        git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "fixture",
        )
        path = self.root / "package.json"
        path.unlink()
        (self.root / "VERSION").unlink()
        git("checkout", "--", "package.json", "VERSION")
        self.assertIn(b"\r\n", path.read_bytes())
        self.assertIn(b"\r\n", (self.root / "VERSION").read_bytes())
        config = policy(
            [
                {
                    "path": "package.json",
                    "format": "json",
                    "field": "version",
                    "package": "product",
                    "value": "package",
                },
                {"path": "VERSION", "format": "text", "value": "package"},
            ]
        )
        plan = version.create_plan(
            "2.5.42", "beta", 2, git("rev-parse", "HEAD"), config
        )
        version.verify_checkout(self.root, config, plan)
        version.sync_versions(self.root, config, plan)
        version.verify_checkout(self.root, config, plan)
        path.write_bytes(path.read_bytes().replace(b"true", b"false"))
        with self.assertRaisesRegex(ValueError, "Undeclared changes"):
            version.verify_checkout(self.root, config, plan)


class ArtifactTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.plan = version.create_plan("2.5.42", "beta", 2, SHA, policy(), 2005043)

    def zip(self, name, entries):
        path = self.root / name
        with zipfile.ZipFile(path, "w") as archive:
            for member, raw in entries:
                archive.writestr(member, raw)
        return path

    def tar(self, name, entries):
        path = self.root / name
        with tarfile.open(path, "w:gz") as archive:
            for member, raw in entries:
                raw = raw.encode() if isinstance(raw, str) else raw
                entry = tarfile.TarInfo(member)
                entry.size = len(raw)
                archive.addfile(entry, io.BytesIO(raw))
        return path

    def oci_entries(  # pylint: disable=too-many-locals
        self,
        labels=("2.5.42-beta.2",),
        nested=False,
        attestation=False,
        artifact_attestation=False,
    ):
        entries = {"oci-layout": b'{"imageLayoutVersion":"1.0.0"}'}
        prefix = "application/vnd.oci.image."

        def blob(data, media):
            raw = version.json_bytes(data)
            identity = version.digest(raw)
            entries["blobs/sha256/" + identity] = raw
            return {
                "mediaType": media,
                "digest": "sha256:" + identity,
                "size": len(raw),
            }

        manifests = []
        for index, label in enumerate(labels):
            architecture = ("amd64", "arm64")[index % 2]
            config = {
                "architecture": architecture,
                "os": "linux",
                "config": {"Labels": {}},
            }
            if label is not None:
                config["config"]["Labels"]["org.opencontainers.image.version"] = label
            descriptor = blob(
                {
                    "schemaVersion": 2,
                    "mediaType": prefix + "manifest.v1+json",
                    "config": blob(config, prefix + "config.v1+json"),
                    "layers": [],
                },
                prefix + "manifest.v1+json",
            )
            descriptor["platform"] = {"architecture": architecture, "os": "linux"}
            manifests.append(descriptor)
        if attestation:
            descriptor = blob(
                {
                    "schemaVersion": 2,
                    "mediaType": prefix + "manifest.v1+json",
                    "config": blob(
                        {"architecture": "unknown", "os": "unknown"},
                        prefix + "config.v1+json",
                    ),
                    "layers": [
                        blob(
                            {"_type": "https://in-toto.io/Statement/v0.1"},
                            "application/vnd.in-toto+json",
                        )
                    ],
                },
                prefix + "manifest.v1+json",
            )
            descriptor["annotations"] = {
                "vnd.docker.reference.type": "attestation-manifest"
            }
            descriptor["platform"] = {"architecture": "unknown", "os": "unknown"}
            manifests.append(descriptor)
        if artifact_attestation:
            subject = {
                key: manifests[0][key] for key in ("mediaType", "digest", "size")
            }
            empty = blob({}, "application/vnd.oci.empty.v1+json")
            empty["data"] = "e30="
            descriptor = blob(
                {
                    "schemaVersion": 2,
                    "mediaType": prefix + "manifest.v1+json",
                    "artifactType": "application/vnd.docker.attestation.manifest.v1+json",
                    "config": empty,
                    "layers": [
                        blob(
                            {
                                "_type": "https://in-toto.io/Statement/v1",
                                "subject": [
                                    {
                                        "name": "_",
                                        "digest": {"sha256": subject["digest"][7:]},
                                    }
                                ],
                                "predicateType": "https://slsa.dev/provenance/v1",
                                "predicate": {},
                            },
                            "application/vnd.in-toto+json",
                        )
                    ],
                    "subject": subject,
                },
                prefix + "manifest.v1+json",
            )
            descriptor["annotations"] = {
                "vnd.docker.reference.type": "attestation-manifest",
                "vnd.docker.reference.digest": subject["digest"],
            }
            descriptor["platform"] = {"architecture": "unknown", "os": "unknown"}
            manifests.append(descriptor)
        if nested:
            manifests = [
                blob(
                    {
                        "schemaVersion": 2,
                        "mediaType": prefix + "index.v1+json",
                        "manifests": manifests,
                    },
                    prefix + "index.v1+json",
                )
            ]
        entries["index.json"] = version.json_bytes(
            {"schemaVersion": 2, "manifests": manifests}
        )
        return entries

    def verify_oci(self, entries):
        path = self.tar("image.oci.tar", list(entries.items()))
        return version.verify_artifact(
            path,
            {
                "format": "oci",
                "field": ["config", "Labels", "org.opencontainers.image.version"],
                "value": "package",
            },
            self.plan,
        )

    def test_oci_nested_multiarch_checks_each_image_and_known_attestation(self):
        result = self.verify_oci(
            self.oci_entries(
                ("2.5.42-beta.2", "2.5.42-beta.2"), nested=True, attestation=True
            )
        )
        self.assertEqual(
            {item["architecture"] for item in result["images"]}, {"amd64", "arm64"}
        )
        self.assertEqual(result["version"], "2.5.42-beta.2")

    def test_oci_buildkit_artifact_attestation_checks_subject_and_empty_config(  # pylint: disable=too-many-locals
        self,
    ):
        result = self.verify_oci(self.oci_entries(artifact_attestation=True))
        self.assertEqual(result["images"][0]["version"], "2.5.42-beta.2")

        for change, error in (
            (lambda manifest: manifest["config"].update(data="e31="), "config"),
            (lambda manifest: manifest.pop("subject"), "subject"),
            (
                lambda manifest: manifest.update(
                    artifactType="application/vnd.example.attestation"
                ),
                "artifact type",
            ),
        ):
            entries = self.oci_entries(artifact_attestation=True)
            index = json.loads(entries["index.json"])
            descriptor = index["manifests"][-1]
            manifest = json.loads(entries["blobs/sha256/" + descriptor["digest"][7:]])
            change(manifest)
            raw = version.json_bytes(manifest)
            identity = version.digest(raw)
            entries["blobs/sha256/" + identity] = raw
            descriptor["digest"] = "sha256:" + identity
            descriptor["size"] = len(raw)
            entries["index.json"] = version.json_bytes(index)
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                self.verify_oci(entries)

    def test_oci_missing_or_wrong_label_on_any_platform_fails(self):
        for label in (None, "2.5.42", "2.5.41-beta.2"):
            entries = self.oci_entries(("2.5.42-beta.2", label), nested=True)
            with self.subTest(label=label), self.assertRaises(ValueError):
                self.verify_oci(entries)

    def test_oci_tampered_config_digest_and_size_fail(self):
        original = self.oci_entries()
        name = next(name for name, raw in original.items() if b'"Labels"' in raw)
        for raw in (original[name].replace(b"amd64", b"arm64"), original[name] + b" "):
            entries = dict(original)
            entries[name] = raw
            with self.assertRaisesRegex(ValueError, "digest mismatch|different size"):
                self.verify_oci(entries)

    def test_oci_duplicate_missing_and_non_sha256_blobs_fail(self):
        original = self.oci_entries()
        identity = next(name for name in original if name.startswith("blobs/"))
        removed = dict(original)
        del removed[identity]
        with self.assertRaisesRegex(ValueError, "blob is missing"):
            self.verify_oci(removed)
        duplicated = dict(original)
        duplicated["./" + identity] = original[identity]
        with self.assertRaisesRegex(ValueError, "duplicate OCI"):
            self.verify_oci(duplicated)
        unsupported = dict(original)
        unsupported["index.json"] = original["index.json"].replace(
            b"sha256:", b"sha512:"
        )
        with self.assertRaisesRegex(ValueError, "sha256 digest"):
            self.verify_oci(unsupported)

    def test_oci_no_runnable_image_or_disguised_attestation_fails(self):
        empty_entries = self.oci_entries((), attestation=True)
        with self.assertRaisesRegex(ValueError, "no runnable images"):
            self.verify_oci(empty_entries)
        entries = self.oci_entries()
        index = json.loads(entries["index.json"])
        descriptor = index["manifests"][0]
        descriptor["platform"] = {"architecture": "unknown", "os": "unknown"}
        descriptor["annotations"] = {
            "vnd.docker.reference.type": "attestation-manifest"
        }
        entries["index.json"] = version.json_bytes(index)
        with self.assertRaisesRegex(
            ValueError, "attestation contains a runnable image"
        ):
            self.verify_oci(entries)

    def test_oci_descriptor_graph_has_a_depth_limit(self):
        entries = self.oci_entries()
        descriptor = json.loads(entries["index.json"])["manifests"][0]
        media = "application/vnd.oci.image.index.v1+json"
        for _ in range(10):
            raw = version.json_bytes(
                {"schemaVersion": 2, "mediaType": media, "manifests": [descriptor]}
            )
            identity = version.digest(raw)
            entries["blobs/sha256/" + identity] = raw
            descriptor = {
                "mediaType": media,
                "digest": "sha256:" + identity,
                "size": len(raw),
            }
        entries["index.json"] = version.json_bytes(
            {"schemaVersion": 2, "manifests": [descriptor]}
        )
        with self.assertRaisesRegex(ValueError, "graph exceeds limits"):
            self.verify_oci(entries)

    def test_actual_wheel_metadata_and_package_identity(self):
        path = self.zip(
            "product.whl",
            [
                (
                    "product-2.5.42b2.dist-info/METADATA",
                    "Metadata-Version: 2.4\nName: Product_Name\nVersion: 2.5.42b2\n",
                )
            ],
        )
        declaration = {
            "format": "wheel",
            "package": "product-name",
            "ecosystem": "pep440",
        }
        self.assertEqual(
            version.verify_artifact(path, declaration, self.plan)["version"], "2.5.42b2"
        )
        with self.assertRaisesRegex(ValueError, "name mismatch"):
            version.verify_artifact(
                path, {**declaration, "package": "other"}, self.plan
            )
        with self.assertRaisesRegex(ValueError, "version mismatch"):
            version.verify_artifact(path, {**declaration, "value": "base"}, self.plan)

    def test_duplicate_wheel_metadata_and_duplicate_headers_rejected(self):
        paths = [
            self.zip(
                "ambiguous.whl",
                [
                    ("a.dist-info/METADATA", "Name: product\nVersion: 2.5.42b2\n"),
                    ("b.dist-info/METADATA", "Name: product\nVersion: 2.5.42b2\n"),
                ],
            ),
            self.zip(
                "headers.whl",
                [
                    (
                        "a.dist-info/METADATA",
                        "Name: product\nVersion: 2.5.42b2\nVersion: 9.9.9\n",
                    )
                ],
            ),
        ]
        for path in paths:
            with self.assertRaises(ValueError):
                version.verify_artifact(
                    path,
                    {"format": "wheel", "package": "product", "ecosystem": "pep440"},
                    self.plan,
                )

    def test_sdist_and_npm_metadata_are_read_without_extracting(self):
        sdist = self.tar(
            "product.tar.gz",
            [
                ("product-2.5.42b2/PKG-INFO", "Name: product\nVersion: 2.5.42b2\n"),
                ("product-2.5.42b2/nested/PKG-INFO", "Version: ignore\n"),
            ],
        )
        version.verify_artifact(
            sdist,
            {"format": "sdist", "package": "product", "ecosystem": "pep440"},
            self.plan,
        )
        npm = self.tar(
            "npm.tgz",
            [
                (
                    "package/package.json",
                    json.dumps(
                        {"name": "@example/product", "version": "2.5.42-beta.2"}
                    ),
                ),
                ("../must-not-extract", "content"),
            ],
        )
        version.verify_artifact(
            npm, {"format": "npm-tar", "package": "@example/product"}, self.plan
        )
        self.assertFalse((self.root.parent / "must-not-extract").exists())

    def test_ipa_numeric_version_and_build_metadata(self):
        path = self.zip(
            "product.ipa",
            [
                (
                    "Payload/Product.app/Info.plist",
                    plistlib.dumps(
                        {
                            "CFBundleShortVersionString": "2.5.42",
                            "CFBundleVersion": version.projections(self.plan)[
                                "apple-build"
                            ],
                        }
                    ),
                )
            ],
        )
        version.verify_artifact(
            path,
            {"format": "ipa", "field": "CFBundleShortVersionString", "value": "base"},
            self.plan,
        )
        version.verify_artifact(
            path,
            {"format": "ipa", "field": "CFBundleVersion", "value": "apple-build"},
            self.plan,
        )
        with self.assertRaisesRegex(ValueError, "mismatch"):
            version.verify_artifact(
                path,
                {
                    "format": "ipa",
                    "field": "CFBundleShortVersionString",
                    "value": "full",
                },
                self.plan,
            )

    def test_exact_archive_members_verify_source_and_runtime_versions(self):
        path = self.tar(
            "source.tgz",
            [
                ("product/version", "v2.5.42-beta.2\n"),
                (
                    "product/pyproject.toml",
                    '[project]\nname="product"\nversion="2.5.42b2"\n',
                ),
                ("release-version.json", '{"version":"2.5.42-beta.2"}'),
            ],
        )
        version.verify_artifact(
            path,
            {"format": "tar-text", "member": "product/version", "prefix": "v"},
            self.plan,
        )
        version.verify_artifact(
            path,
            {
                "format": "tar-toml",
                "member": "product/pyproject.toml",
                "field": "project.version",
                "package": "product",
                "ecosystem": "pep440",
            },
            self.plan,
        )
        version.verify_artifact(
            path,
            {
                "format": "tar-json",
                "member": "release-version.json",
                "field": "version",
            },
            self.plan,
        )
        with self.assertRaisesRegex(ValueError, "missing"):
            version.verify_artifact(
                path, {"format": "tar-text", "member": "other/version"}, self.plan
            )
        with self.assertRaises(ValueError):
            version.verify_artifact(
                path, {"format": "tar-text", "member": "../version"}, self.plan
            )

    def test_archive_dot_prefix_matches_but_duplicate_aliases_rejected(self):
        declaration = {
            "format": "tar-json",
            "member": "build-info.json",
            "field": "version",
        }
        path = self.tar(
            "web.tgz", [("./build-info.json", '{"version":"2.5.42-beta.2"}')]
        )
        version.verify_artifact(path, declaration, self.plan)
        duplicate = self.tar(
            "duplicate.tgz",
            [
                ("./build-info.json", '{"version":"2.5.42-beta.2"}'),
                ("build-info.json", '{"version":"2.5.42-beta.2"}'),
            ],
        )
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            version.verify_artifact(duplicate, declaration, self.plan)

    def test_unsupported_artifacts_fail_closed(self):
        path = self.root / "app.apk"
        path.write_bytes(b"binary")
        with self.assertRaisesRegex(ValueError, "Unsupported version format"):
            version.verify_artifact(path, {"format": "apk"}, self.plan)


class EvidenceOutputTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        self.root = self.parent / "checkout"
        self.root.mkdir()
        self.config = policy()
        self.plan = version.create_plan("2.5.42", "beta", 1, SHA, self.config)
        (self.root / "package.json").write_text('{"name":"product","version":"2.5.42"}')
        (self.root / ".release-policy.json").write_text(json.dumps(self.config))
        (self.root / ".release-plan.json").write_text(json.dumps(self.plan))
        self.outside = self.parent / "outside.json"
        self.outside.write_bytes(b"outside sentinel\n")

    def sync(self, output):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            return version.main(
                [
                    "sync",
                    "--root",
                    str(self.root),
                    "--plan",
                    ".release-plan.json",
                    "--output",
                    str(output),
                ]
            )

    def test_hardlinked_output_preserves_outside_bytes_and_plan_hashes(self):
        output = self.root / "custom-evidence.json"
        os.link(self.outside, output)
        self.assertEqual(self.sync(output), 0)
        self.assertEqual(self.outside.read_bytes(), b"outside sentinel\n")
        raw = output.read_bytes()
        evidence = json.loads(raw)
        self.assertEqual(raw, version.json_bytes(evidence) + b"\n")
        self.assertEqual(evidence["source_sha"], SHA)
        self.assertEqual(evidence["plan_sha256"], version.plan_digest(self.plan))
        self.assertEqual(
            evidence["effective_inputs_sha256"],
            version.effective_inputs_digest(evidence["files"]),
        )
        self.assertEqual(
            evidence["files"][0]["after_sha256"],
            version.digest((self.root / "package.json").read_bytes()),
        )
        self.assertNotEqual(output.stat().st_ino, self.outside.stat().st_ino)

    def test_output_guards_reject_escape_symlink_directory_and_version_input(self):
        (self.root / "alias.json").symlink_to(self.outside)
        (self.root / "directory").mkdir()
        (self.root / "parent-alias").symlink_to(self.parent, target_is_directory=True)
        for output in (
            "../outside.json",
            self.outside,
            "alias.json",
            "directory",
            "parent-alias/outside.json",
            "package.json",
        ):
            with self.subTest(output=str(output)):
                self.assertEqual(self.sync(output), 1)
                self.assertEqual(self.outside.read_bytes(), b"outside sentinel\n")
                self.assertEqual(
                    json.loads((self.root / "package.json").read_bytes()),
                    {"name": "product", "version": "2.5.42-beta.1"},
                )
        self.assertEqual(list(self.root.glob(".release-output-*")), [])


if __name__ == "__main__":
    unittest.main()

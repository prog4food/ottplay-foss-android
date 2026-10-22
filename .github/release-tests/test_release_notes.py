# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Keep human release notes bound to the source used to build the package."""

import base64
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_SPEC = importlib.util.spec_from_file_location(
    "notes_release_control", Path(__file__).parents[2] / "scripts/release_control.py"
)
release = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(release)
SOURCE = "a" * 40


class StrictGitHub:
    """Permit only the expected source read and reject all remote mutation."""

    def __init__(self, response: dict | None = None):
        self.responses = [] if response is None else [response]
        self.calls = []
        self.writes = []

    def api(self, path: str, method: str = "GET", body: dict | None = None):
        self.calls.append((method, path, body))
        if method != "GET":
            self.writes.append((method, path, body))
            message = f"Unexpected remote write: {method} {path}"
            raise AssertionError(message)
        if path != f"contents/CHANGELOG.md?ref={SOURCE}" or not self.responses:
            message = f"Unexpected remote read: {path}"
            raise AssertionError(message)
        return self.responses.pop(0)

    def upload(self, tag: str, path: Path):
        self.writes.append(("upload", tag, path))
        message = f"Unexpected remote upload: {tag} {path}"
        raise AssertionError(message)


def contents(text):
    raw = text.encode()
    return {
        "type": "file",
        "path": "CHANGELOG.md",
        "encoding": "base64",
        "content": base64.b64encode(raw).decode(),
        "size": len(raw),
        "sha": release.hashlib.sha1(
            b"blob " + str(len(raw)).encode() + b"\0" + raw, usedforsecurity=False
        ).hexdigest(),
    }


NOTES = """# Changelog
## [1.2.4] - Unreleased
Do not publish this later change.
## [1.2.3] - 2026-10-07
### Fixed
Preserve unavailable telemetry instead of reporting zero.
### Upgrade
Review optional site settings before enabling the feature.
### Security
Reject malformed requests before issuing hardware commands.
## [1.2.2] - 2026-10-01
Do not copy older notes either.
"""


def render(text=NOTES, tag="v1.2.3-beta.8", response_change=None):
    response = contents(text)
    response.update(response_change or {})
    github = StrictGitHub(response)
    with patch.object(
        release,
        "source_policy_snapshot",
        return_value={"data": {"release_notes": "CHANGELOG.md"}},
    ):
        body = release.release_notes(
            github, tag, SOURCE, "Original source and validation links."
        )
    assert github.calls == [("GET", f"contents/CHANGELOG.md?ref={SOURCE}", None)]
    assert not github.responses
    assert not github.writes
    return body


class ClosingReleaseHeadingsTests(unittest.TestCase):
    def test_closing_hashes_select_version_and_required_guidance(self):
        for suffix in (" #", " ### \t", "\t########"):
            for newline in ("\n", "\r\n"):
                text = NOTES.replace("[1.2.3] - 2026-10-07", "[1.2.3]")
                text = newline.join(
                    line + suffix if line.startswith("#") else line
                    for line in text.split("\n")
                )
                with self.subTest(suffix=suffix, newline=newline):
                    body = render(text)
                    self.assertIn("## Changes in 1.2.3", body)
                    self.assertIn("### Upgrade" + suffix.rstrip(), body)
                    self.assertIn("Reject malformed requests", body)
                    self.assertNotIn("Do not publish", body)
                    self.assertNotIn("Do not copy", body)

    def test_closing_hashes_do_not_hide_duplicate_version_sections(self):
        text = NOTES + "\n## [1.2.3] ##\nDuplicate release.\n"
        with self.assertRaises(release.ReleaseError):
            render(text)

    def test_literal_and_escaped_hashes_are_not_guidance_titles(self):
        for title in (
            "Upgrade#",
            r"Upgrade \###",
            r"Upgrade #\##",
            "Upgrade ### trailing",
            "Upgrade\u00a0###",
        ):
            text = NOTES.replace("### Upgrade", "### " + title)
            with self.subTest(title=title), self.assertRaises(release.ReleaseError):
                render(text)


class ReleaseNotesTests(unittest.TestCase):
    def test_separator_or_subheading_alone_is_not_release_guidance(self):
        for section in ("Upgrade", "Security"):
            for content in (
                "\n---\n",
                "\n* * *\n",
                "\n___\n",
                "\n   -\t-\t-\n",
                "#### Migration\n",
                "######\n",
                "<!-- hidden instructions -->\n\n---\n",
                "#### Migration\n\n***\n",
            ):
                original = (
                    "Review optional site settings before enabling the feature."
                    if section == "Upgrade"
                    else "Reject malformed requests before issuing hardware commands."
                )
                text = NOTES.replace(original, content)
                with (
                    self.subTest(section=section, content=content),
                    self.assertRaisesRegex(release.ReleaseError, section + " guidance"),
                ):
                    render(text)

    def test_empty_markdown_containers_are_not_release_guidance(self):
        for section in ("Upgrade", "Security"):
            for content in (
                "-",
                "+",
                "*",
                "1.",
                "2)",
                "123456789.",
                ">",
                "> >",
                ">>",
                ">>>",
                ">---",
                ">#### Details",
                "> -",
                "- >",
                "1. > -",
                "> - [ ]",
                "- [x]",
                "- [X]",
                "> ---",
                "> #### Details",
                "-\n+\n1.",
                "   >\t- ",
                "> \t-",
            ):
                original = (
                    "Review optional site settings before enabling the feature."
                    if section == "Upgrade"
                    else "Reject malformed requests before issuing hardware commands."
                )
                text = NOTES.replace(original, content)
                with (
                    self.subTest(section=section, content=content),
                    self.assertRaisesRegex(release.ReleaseError, section + " guidance"),
                ):
                    render(text)

    def test_markdown_containers_preserve_actual_guidance_and_literals(self):
        for content in (
            "- Restart the service.",
            "1. Restart the service.",
            "> Restart the service.",
            ">Restart the service.",
            "> - Restart the service.",
            "- [ ] Restart the service.",
            "`-`",
            "```text\n-\n```",
            "    -",
            "\\-",
            "_",
            "1234567890.",
            "١.",
            ">     -",
            "-     +",
            ">     ---",
            "-     ####",
            "> `-`",
            "- > Restart the service.",
            "> [ ]",
            "- > [ ]",
        ):
            text = NOTES.replace(
                "Review optional site settings before enabling the feature.", content
            )
            with self.subTest(content=content):
                self.assertIn(content.strip(), render(text))

    def test_tabbed_containers_preserve_literal_code(self):
        for content in (">\t\t-", "-\t\t+", "> >\t\t---", ">\t\t####"):
            text = NOTES.replace(
                "Review optional site settings before enabling the feature.", content
            )
            with self.subTest(content=content):
                self.assertIn(content, render(text))

    def test_guidance_after_separator_and_subheading_is_preserved(self):
        content = "#### Migration\n\n---\n\n- Restart the worker after upgrading."
        text = NOTES.replace("Review optional site settings before enabling the feature.", content)
        self.assertIn(content, render(text))

    def test_literal_markers_in_code_remain_guidance(self):
        for content in ("```sh\n---\n```", "    ---", "`---`", "\\- - -", "***Restart***"):
            text = NOTES.replace(
                "Review optional site settings before enabling the feature.", content
            )
            with self.subTest(content=content):
                self.assertIn(content.strip(), render(text))

    def _assert_notes_rejected_before_publication(self, text):
        github = StrictGitHub(contents(text))
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                release,
                "source_policy_snapshot",
                return_value={"data": {"release_notes": "CHANGELOG.md"}},
            ),
            self.assertRaisesRegex(release.ReleaseError, "Upgrade guidance"),
        ):
            release.publish(
                github, "v1.2.3", SOURCE, Path(directory), False, "provenance"
            )
        self.assertEqual(
            github.calls, [("GET", f"contents/CHANGELOG.md?ref={SOURCE}", None)]
        )
        self.assertEqual(github.writes, [])

    def test_indented_version_and_guidance_headings_are_supported(self):
        for indentation in (" ", "  ", "   "):
            text = "\n".join(
                indentation + line if line.startswith(("## ", "### ")) else line
                for line in NOTES.split("\n")
            )
            with self.subTest(indentation=indentation):
                body = render(text)
                self.assertIn("## Changes in 1.2.3", body)
                self.assertIn(
                    "Preserve unavailable telemetry instead of reporting zero.", body
                )
                self.assertNotIn("Do not copy older notes either.", body)

    def test_comments_between_text_and_setext_underlines_do_not_hide_ambiguity(self):
        text = (
            "## [1.2.3]\nAppendix\n<!-- comment -->\n===\n"
            "### Upgrade\nRead migration.\n### Security\nNo changes.\n"
        )
        with self.assertRaisesRegex(release.ReleaseError, "ATX"):
            render(text)

    def test_setext_appendices_cannot_supply_release_guidance(self):
        for underline in ("=", "===", "-", "---", "   ===", "   ---"):
            text = (
                "## [1.2.3]\nAppendix\n" + underline + "\n"
                "### Upgrade\nRead migration.\n### Security\nNo changes.\n"
            )
            with (
                self.subTest(underline=underline),
                self.assertRaisesRegex(release.ReleaseError, "ATX"),
            ):
                render(text)
            crlf = text.replace("\n", "\r\n")
            with (
                self.subTest(underline=underline, newline="CRLF"),
                self.assertRaisesRegex(release.ReleaseError, "ATX"),
            ):
                render(crlf)

    def test_setext_heading_inside_guidance_is_rejected(self):
        text = NOTES.replace("### Security", "Underlined appendix\n---\n### Security")
        with self.assertRaisesRegex(release.ReleaseError, "ATX"):
            render(text)

    def test_thematic_breaks_and_literal_setext_examples_remain_supported(self):
        for example in (
            "\n---\n",
            "\n===\n",
            "```markdown\nAppendix\n===\n```",
            "~~~markdown\nAppendix\n---\n~~~",
            "    Appendix\n    ===",
            "<!--\nAppendix\n===\n-->",
        ):
            text = NOTES.replace("### Upgrade", example + "\n### Upgrade")
            with self.subTest(example=example):
                self.assertIn(example.strip(), render(text))
        text = NOTES.replace("### Upgrade\n", "### Upgrade\n---\n")
        self.assertIn("### Upgrade\n---\n", render(text))

    def test_setext_outside_selected_release_does_not_change_body(self):
        self.assertEqual(render("Changelog\n===\n" + NOTES), render(NOTES))

    def test_empty_higher_level_atx_headings_end_sections(self):
        for heading in ("#", "##"):
            for ending in ("", "\n", "\r\n"):
                text = "### Upgrade\nBefore.\n" + heading + ending
                with self.subTest(heading=heading, ending=ending):
                    [(title, raw, visible)] = list(release._release_sections(text, 3))
                    self.assertEqual(
                        (title, raw, visible.strip()), ("Upgrade", "Before.", "Before.")
                    )
        text = (
            "## [1.2.3]\n#\n### Upgrade\nRead migration.\n### Security\nNo changes.\n"
        )
        with self.assertRaises(release.ReleaseError):
            render(text)

    def test_higher_level_appendix_cannot_supply_version_guidance(self):
        for indent in ("", " ", "  ", "   "):
            text = (
                "## [1.2.3]\n" + indent + "# Appendix\n"
                "### Upgrade\nRead unrelated migration.\n"
                "### Security\nUnrelated security guidance.\n"
            )
            with self.subTest(indent=indent), self.assertRaises(release.ReleaseError):
                render(text)

    def test_valid_notes_stop_before_higher_level_appendix(self):
        text = NOTES.replace("## [1.2.2]", "# Appendix\nUnrelated text.\n## [1.2.2]")
        self.assertEqual(render(text), render(NOTES))

    def test_higher_level_headings_end_raw_and_visible_guidance_sections(self):
        for heading in ("# Appendix", "## [1.2.4]"):
            text = (
                "### Upgrade\nBefore <!-- hidden --> after.\n"
                + heading
                + "\nUnrelated.\n"
            )
            [(title, raw, visible)] = list(release._release_sections(text, 3))
            self.assertEqual(title, "Upgrade")
            self.assertEqual(raw, "Before <!-- hidden --> after.")
            self.assertNotIn("hidden", visible)
            self.assertNotIn("Unrelated", visible)
            self.assertNotIn(heading, visible)

    def test_higher_level_heading_does_not_hide_later_version_selection(self):
        text = "# Introduction\nUnrelated.\n" + NOTES
        self.assertEqual(render(text), render(NOTES))

    def test_literal_and_commented_higher_level_headings_do_not_end_sections(self):
        for example in (
            "```markdown\n# Appendix\n```",
            "~~~markdown\n# Appendix\n~~~",
            "<!--\n# Appendix\n-->",
            "<!-- comment --># Appendix",
            "    # Appendix",
            "#### Nested details",
            "####### Not an ATX heading",
            "#not-an-atx-heading",
        ):
            text = NOTES.replace("### Upgrade", example + "\n### Upgrade")
            with self.subTest(example=example):
                self.assertIn(example, render(text))

    def test_comment_only_guidance_is_rejected(self):
        for heading in ("Upgrade", "Security"):
            for comment in (
                "<!-- placeholder -->",
                "<!-- first --> \t <!-- second -->",
                "<!-- first\nsecond\n-->",
                "<!-- unclosed",
            ):
                text = (
                    "## [1.2.3]\n### Upgrade\nRead migration instructions.\n"
                    "### Security\nNo security change.\n"
                )
                if heading == "Upgrade":
                    text = text.replace("Read migration instructions.", comment)
                else:
                    text = text.replace("No security change.", comment)
                with (
                    self.subTest(heading=heading, comment=comment),
                    self.assertRaisesRegex(release.ReleaseError, "guidance"),
                ):
                    render(text)

    def test_commented_headings_do_not_select_or_split_sections(self):
        hidden = (
            "<!--\n## [1.2.3]\n### Upgrade\nHidden migration.\n"
            "### Security\nHidden security.\n-->\n"
        )
        self.assertEqual(render(hidden + NOTES), render(NOTES))
        text = NOTES.replace(
            "### Upgrade", "<!--\n## [9.9.9]\n### Upgrade\n-->\n### Upgrade"
        )
        self.assertIn("<!--\n## [9.9.9]", render(text))
        for heading in ("Upgrade", "Security"):
            with self.subTest(heading=heading):
                text = NOTES.replace("### " + heading, "<!-- ### " + heading + " -->")
                with self.assertRaisesRegex(
                    release.ReleaseError, heading + " guidance"
                ):
                    render(text)

    def test_comments_started_on_headings_keep_following_content_hidden(self):
        for heading in ("## [1.2.3]", "### Upgrade", "### Security"):
            text = "## [1.2.3]\n### Upgrade\nRead migration.\n### Security\nNo security change.\n"
            text = text.replace(heading, heading + " <!--")
            with (
                self.subTest(heading=heading),
                self.assertRaisesRegex(release.ReleaseError, "guidance"),
            ):
                render(text)

    def test_visible_text_survives_inline_multiline_and_unclosed_comments(self):
        guidance = "Read <!-- hidden\nprivate --> the migration guide. <!-- another -->"
        text = NOTES.replace(
            "Review optional site settings before enabling the feature.", guidance
        )
        self.assertIn(guidance, render(text))
        self.assertEqual(render(text.replace("\n", "\r\n")), render(text))
        text = (
            "## [1.2.3]\n### Upgrade\nRead migration.\n"
            "### Security\nNo security change. <!-- unfinished"
        )
        self.assertIn("No security change. <!-- unfinished", render(text))

    def test_comments_do_not_open_fences_or_hide_literal_code(self):
        hidden_fence = "<!--\n```\n-->\n"
        self.assertEqual(render(hidden_fence + NOTES), render(NOTES))
        for guidance in (
            "```html\n<!-- literal comment -->\n```",
            "~~~html\n<!-- literal comment -->\n~~~",
            "`<!-- literal inline comment -->`",
            "``an embedded ` and <!-- literal comment -->``",
            "    <!-- literal indented comment -->",
        ):
            with self.subTest(guidance=guidance):
                text = NOTES.replace(
                    "Review optional site settings before enabling the feature.",
                    guidance,
                )
                self.assertIn(guidance.strip(), render(text))

    def test_empty_fences_are_not_visible_guidance(self):
        for marker in ("```", "~~~"):
            text = NOTES.replace(
                "Review optional site settings before enabling the feature.",
                marker + "\n\n" + marker,
            )
            with (
                self.subTest(marker=marker),
                self.assertRaisesRegex(release.ReleaseError, "Upgrade guidance"),
            ):
                render(text)

    def test_many_inline_comments_keep_linear_scanning_and_offsets(self):
        comments = "<!-- x -->" * 10000
        text = NOTES.replace(
            "Review optional site settings before enabling the feature.", comments
        )
        with self.assertRaisesRegex(release.ReleaseError, "Upgrade guidance"):
            render(text)
        text = NOTES.replace(
            "Review optional site settings before enabling the feature.",
            comments + "Read migration.",
        )
        self.assertIn(comments + "Read migration.", render(text))

    def test_comment_only_notes_fail_before_any_remote_mutation(self):
        text = "## [1.2.3]\n### Upgrade\n<!-- todo -->\n### Security\nNo security change.\n"
        self._assert_notes_rejected_before_publication(text)

    def test_fenced_guidance_cannot_satisfy_real_sections(self):
        for marker in ("```", "````", "~~~", "~~~~~"):
            for indentation in ("", " ", "  ", "   "):
                text = (
                    "## [1.2.3]\n"
                    + indentation
                    + marker
                    + "markdown\n"
                    + "### Upgrade\nExample upgrade.\n"
                    + "### Security\nExample security.\n"
                    + indentation
                    + marker
                    + "\n"
                )
                with (
                    self.subTest(marker=marker, indentation=indentation),
                    self.assertRaisesRegex(release.ReleaseError, "Upgrade guidance"),
                ):
                    render(text)

    def test_fenced_version_headings_do_not_select_or_split_sections(self):
        for marker in ("```", "~~~~"):
            example = marker + "markdown\n## [1.2.3]\n## [9.9.9]\n" + marker + "\n"
            text = example + NOTES.replace("### Fixed", example + "### Fixed")
            body = render(text)
            self.assertIn(example, body)
            self.assertIn("Preserve unavailable telemetry", body)
            self.assertNotIn("Do not publish", body)
            self.assertNotIn("Do not copy", body)

    def test_fence_closes_only_with_matching_marker_and_sufficient_length(self):
        for opening, false_closer in (
            ("````", "```"),
            ("```", "~~~"),
            ("~~~~", "~~~"),
            ("~~~", "```"),
            ("```", "``` trailing text"),
            ("```", "    ```"),
            ("```", "```\u00a0"),
        ):
            text = (
                "## [1.2.3]\n"
                + opening
                + "\n"
                + false_closer
                + "\n### Upgrade\nExample upgrade.\n### Security\nExample security.\n"
            )
            with (
                self.subTest(opening=opening, false_closer=false_closer),
                self.assertRaisesRegex(release.ReleaseError, "Upgrade guidance"),
            ):
                render(text)

    def test_longer_matching_fences_restore_heading_recognition(self):
        for marker in ("```", "~~~"):
            prefix = marker + "text\n## [1.2.3]\n   " + marker * 2 + " \t\n"
            self.assertEqual(render(prefix + NOTES), render(NOTES))

    def test_unclosed_fences_keep_following_headings_inside_example(self):
        for marker in ("```", "~~~"):
            with self.subTest(marker=marker):
                with self.assertRaisesRegex(release.ReleaseError, "changelog section"):
                    render(marker + "markdown\n" + NOTES)
                text = NOTES.replace("### Upgrade", marker + "\n### Upgrade")
                with self.assertRaisesRegex(release.ReleaseError, "Upgrade guidance"):
                    render(text)

    def test_real_guidance_can_contain_fenced_commands_verbatim(self):
        for marker in ("```", "~~~"):
            command = marker + "shell\nupgrade --check\n" + marker
            text = NOTES.replace(
                "Review optional site settings before enabling the feature.", command
            )
            self.assertIn(command, render(text))
            self.assertEqual(render(text.replace("\n", "\r\n")), render(text))

    def test_invalid_backtick_info_and_inline_markers_do_not_start_fences(self):
        for prefix in ("```invalid`info\n", "Text with ``` inline markers.\n"):
            self.assertEqual(render(prefix + NOTES), render(NOTES))

    def test_unicode_line_separator_does_not_introduce_a_heading(self):
        text = "## [1.2.3]\nExample\u2028### Upgrade\nExample upgrade.\n### Security\nSafe.\n"
        with self.assertRaisesRegex(release.ReleaseError, "Upgrade guidance"):
            render(text)

    def test_fenced_only_notes_fail_before_any_remote_mutation(self):
        text = "## [1.2.3]\n```\n### Upgrade\nExample.\n### Security\nExample.\n```\n"
        self._assert_notes_rejected_before_publication(text)

    def test_exact_base_and_provenance(self):
        for tag in ("v1.2.3", "v1.2.3-rc.1", "v1.2.3-beta.8"):
            with self.subTest(tag=tag):
                body = render(tag=tag)
                self.assertIn("Preserve unavailable telemetry", body)
                self.assertNotIn("Do not publish", body)
                self.assertNotIn("Do not copy", body)
                self.assertTrue(body.endswith("Original source and validation links."))
                self.assertIn("## Build provenance", body)

    def test_crlf_notes_preserve_source_byte_verification(self):
        crlf = NOTES.replace("\n", "\r\n")
        self.assertEqual(render(crlf), render(NOTES))
        lf_contents = contents(NOTES)
        with self.assertRaisesRegex(release.ReleaseError, "size mismatch"):
            render(crlf, response_change={"size": lf_contents["size"]})
        with self.assertRaisesRegex(release.ReleaseError, "blob identity"):
            render(crlf, response_change={"sha": lf_contents["sha"]})

    def test_missing_or_incomplete_sections(self):
        for text in (
            NOTES.replace("[1.2.3]", "[2.0.0]"),
            NOTES + "\n## [1.2.3]\nDuplicate version.\n",
            NOTES.replace("### Upgrade", "### Other"),
            NOTES.replace("### Security", "### Other"),
            "## [1.2.3]\n### Upgrade\n\n### Security\nNo vulnerabilities fixed.\n",
        ):
            with self.subTest(text=text), self.assertRaises(release.ReleaseError):
                render(text)

    def test_rejects_invalid_source_content(self):
        for changes in (
            {"type": "symlink"},
            {"path": "other.md"},
            {"size": 1},
            {"sha": "b" * 40},
            {"content": "!invalid!"},
            {"content": "a" * 400_001},
        ):
            with (
                self.subTest(changes=list(changes)),
                self.assertRaises(release.ReleaseError),
            ):
                render(response_change=changes)

    def test_policy_is_opt_in(self):
        github = StrictGitHub()
        with patch.object(release, "source_policy_snapshot", return_value={"data": {}}):
            self.assertEqual(
                release.release_notes(github, "v1.2.3", SOURCE, "provenance"),
                "provenance",
            )
        self.assertEqual(github.calls, [])
        self.assertEqual(github.writes, [])

    def test_missing_notes_abort_before_mutation(self):
        github = StrictGitHub()
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                release,
                "release_notes",
                side_effect=release.ReleaseError("missing notes"),
            ),
            self.assertRaisesRegex(release.ReleaseError, "missing notes"),
        ):
            release.publish(
                github, "v1.2.3", SOURCE, Path(directory), False, "provenance"
            )
        self.assertEqual(github.calls, [])
        self.assertEqual(github.writes, [])

    def test_api_requires_commit_pinned_source(self):
        import re

        allowed = release.API_PATHS["GET"]
        self.assertTrue(
            any(re.fullmatch(p, f"contents/CHANGELOG.md?ref={SOURCE}") for p in allowed)
        )
        for ref in ("main", "v1.2.3", "a" * 39, "../main"):
            self.assertFalse(
                any(
                    re.fullmatch(p, f"contents/CHANGELOG.md?ref={ref}") for p in allowed
                )
            )

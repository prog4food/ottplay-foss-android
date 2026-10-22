#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Check the CI entry point and CodeQL compatibility before expensive validation."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import yaml


COMMIT_SHA_PATTERN = r"[0-9a-f]{40}"
QUALITY_GATE = "quality-gate.yml"
RELEASE_PIPELINE = "release-pipeline.yml"
LOCAL_WORKFLOW_PREFIX = "./.github/workflows/"


class UniqueKeyLoader(yaml.BaseLoader):
    """Keep YAML scalars as strings and reject ambiguous mappings."""

    def construct_mapping(self, node, deep=False):
        mapping = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in mapping:
                raise ValueError(
                    f"Duplicate or non-string YAML key at {key_node.start_mark}"
                )
            mapping[key] = self.construct_object(value_node, deep=deep)
        return mapping


def codeql_pins(job):
    """Read just the analyzer action references from one job."""
    return {
        step["uses"].rsplit("@", 1)[-1]
        for step in job.get("steps", [])
        if re.match(
            r"github/codeql-action/(init|autobuild|analyze|upload-sarif)@",
            step.get("uses", ""),
        )
    }


def validate_codeql(workflows):
    """All CodeQL components in the repository share one immutable release."""
    repository_pins = set()
    for filename, workflow in workflows.items():
        for name, job in workflow.get("jobs", {}).items():
            pins = codeql_pins(job)
            if len(pins) > 1 or any(
                not re.fullmatch(COMMIT_SHA_PATTERN, pin) for pin in pins
            ):
                raise ValueError(
                    f"{filename}/{name}: CodeQL actions must share one full commit SHA"
                )
            repository_pins.update(pins)
    if len(repository_pins) > 1:
        raise ValueError(
            "CodeQL actions across workflows must share one full commit SHA"
        )


def yaml_member(node, name):
    """Locate one parsed YAML value without constructing Python objects."""
    if isinstance(node, yaml.MappingNode):
        return next((value for key, value in node.value if key.value == name), None)
    return None


def yaml_step_references(source):
    """Yield action reference nodes while retaining their source locations."""
    root = yaml.compose(source, Loader=yaml.BaseLoader)
    jobs = yaml_member(root, "jobs")
    if not isinstance(jobs, yaml.MappingNode):
        return
    for _, job in jobs.value:
        steps = yaml_member(job, "steps")
        if not isinstance(steps, yaml.SequenceNode):
            continue
        for step in steps.value:
            yield yaml_member(step, "uses")


def codeql_release_comment(filename, reference, lines):
    """Read the ASCII release comment adjacent to an immutable CodeQL reference."""
    mark = reference.end_mark
    tail = lines[mark.line][mark.column:] if mark.line < len(lines) else ""
    comment = re.match(r"[ \t]*#[ \t]*(v\d+\.\d+\.\d+)(?:[ \t]|$)", tail, flags=re.ASCII)
    if comment is None:
        raise ValueError(
            f"{filename}:{reference.start_mark.line + 1}: "
            "CodeQL SHA needs an inline full release comment for Renovate"
        )
    return comment[1]


def validate_codeql_update_metadata(sources):
    """Keep every CodeQL SHA discoverable by Renovate, including SARIF uploads."""
    versions = set()
    for filename, source in sources.items():
        lines = source.splitlines()
        for reference in yaml_step_references(source):
            if not isinstance(reference, yaml.ScalarNode) or not re.fullmatch(
                r"github/codeql-action/(init|autobuild|analyze|upload-sarif)@"
                + COMMIT_SHA_PATTERN, reference.value
            ):
                continue
            versions.add(codeql_release_comment(filename, reference, lines))
    if len(versions) > 1:
        raise ValueError("CodeQL version comments must name the same release")


def validate_action_reference(filename, reference, pins):
    """Check one external action against immutable and canonical pins."""
    if not reference or reference.startswith("./"):
        return
    action, _, revision = reference.partition("@")
    if reference.startswith("docker://"):
        if not re.fullmatch(
            r"docker://[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}", reference
        ):
            raise ValueError(f"{filename}: Docker actions must use an immutable SHA-256 digest")
    elif not re.fullmatch(COMMIT_SHA_PATTERN, revision):
        raise ValueError(f"{filename}: {action} must use a full commit SHA")
    if pins is not None and (action not in pins or revision != pins[action]):
        raise ValueError(f"{filename}: {action} differs from generator pins")


def validate_workflow_pins(filename, workflow, pins):
    """Require immutable actions and compare canonical generator pins when present."""
    for job in workflow.get("jobs", {}).values():
        references = [job.get("uses", "")] + [
            step.get("uses", "") for step in job.get("steps", [])
        ]
        for reference in references:
            validate_action_reference(filename, reference, pins)


def configured_workflow_pins(directory):
    """Allow only canonical toolkit workflows explicitly enabled by the policy."""
    policy_path = directory / ".release-policy.json"
    policy = json.loads(policy_path.read_text()) if policy_path.exists() else {}
    pins = {}
    for section, workflow in (("coverage", "coverage-upload.yml"), ("fuzzing", "fuzz.yml")):
        configuration = policy.get(section)
        if configuration:
            reference = configuration["toolkit_ref"]
            if not isinstance(reference, str) or not re.fullmatch(COMMIT_SHA_PATTERN, reference):
                raise ValueError("Toolkit workflow pins must be full commit SHAs")
            pins[f"victron-venus/venus-os-ci-toolkit/.github/workflows/{workflow}"] = reference
    return pins


def generator_pins(directory):
    """Load canonical action pins and explicitly configured toolkit workflows."""
    manifest = directory / ".github/action-pins.json"
    # Consumers vendor the generated scripts, not the generator or its manifest.
    # The canonical toolkit must retain the manifest consumed by its generator.
    if not manifest.exists() and (directory / "scripts/install_release.py").exists():
        raise ValueError("Missing generator action-pin manifest")
    pins = (
        None
        if not manifest.exists()
        else {
            pin["packageName"]: pin["digest"]
            for pin in json.loads(manifest.read_text())
        }
    )
    if pins is not None and any(
        not re.fullmatch(COMMIT_SHA_PATTERN, pin) for pin in pins.values()
    ):
        raise ValueError("Generator pins must be full commit SHAs")
    if pins is not None:
        pins.update(configured_workflow_pins(directory))
    return pins


def validate_generator_pins(directory, workflows):
    """Validate generated consumers and the toolkit's canonical pin manifest."""
    pins = generator_pins(directory)
    for filename, workflow in workflows.items():
        if filename not in {QUALITY_GATE, RELEASE_PIPELINE, "release-quality-gate.yml"}:
            validate_workflow_pins(filename, workflow, None)
            continue
        source = (directory / ".github/workflows" / filename).read_text()
        if not source.startswith(
            "# Generated by venus-os-ci-toolkit/scripts/install_release.py;"
        ):
            raise ValueError(f"{filename}: missing generator marker")
        validate_workflow_pins(filename, workflow, pins)
    validate_fuzz_pins(directory, workflows)


def validate_fuzz_pins(directory, workflows):
    """Consumers must update their wrapper, runtime and policy atomically."""
    configured = configured_workflow_pins(directory)
    action = "victron-venus/venus-os-ci-toolkit/.github/workflows/fuzz.yml"
    if action not in configured:
        return
    reference = configured[action]
    job = workflows.get(RELEASE_PIPELINE, {}).get("jobs", {}).get("fuzz", {})
    if job.get("uses") != action + "@" + reference or job.get("with", {}).get("toolkit-ref") != reference:
        raise ValueError("Fuzz workflow, runtime and policy toolkit_ref must match")


def _callable_workflow(workflows, visited, filename, chain=()):
    """Traverse callable workflows, retaining cycle detection before visited pruning."""
    if filename in chain:
        raise ValueError(f"Recursive validation: {chain} -> {filename}")
    if filename in visited:
        return
    workflow = workflows[filename]
    triggers = workflow.get("on", {})
    if not isinstance(triggers, dict) or "workflow_call" not in triggers:
        raise ValueError(f"{filename}: missing workflow_call")
    if set(triggers) - {"workflow_call", "workflow_dispatch"}:
        raise ValueError(f"{filename}: validation must start through Quality gate")
    visited.add(filename)
    for name, job in workflow.get("jobs", {}).items():
        reference = job.get("uses", "")
        if reference.startswith(LOCAL_WORKFLOW_PREFIX):
            _callable_workflow(workflows, visited, reference.rsplit("/", 1)[-1], (*chain, filename))
        elif "runs-on" in job and "timeout-minutes" not in job:
            raise ValueError(f"{filename}/{name}: an explicit timeout is required")


def validate_graph(workflows, validators):
    """Walk callable validators and enforce one orchestration entry point."""
    visited = set()

    for filename in validators:
        _callable_workflow(workflows, visited, filename)
    return visited


def validate_coverage_producer(producer, report, ref):
    """Keep a producer's exported artifact and shared pin aligned with policy."""
    name = "coverage-" + report["name"]
    if "uses" in producer:
        workflow = {"cobertura": "python-ci.yml", "go": "go-ci.yml"}.get(report["format"])
        expected = f"victron-venus/venus-os-ci-toolkit/.github/workflows/{workflow}@{ref}"
        if (
            workflow is None
            or producer["uses"] != expected
            or producer.get("with", {}).get("coverage-artifact-name") != name
        ):
            raise ValueError("Coverage producer pin or artifact differs from policy")
        return
    step_id = "export_coverage_" + report["name"].replace("-", "_")
    exports = [step for step in producer.get("steps", []) if step.get("id") == step_id]
    if (
        len(exports) != 1
        or not re.fullmatch(
            r"actions/upload-artifact@" + COMMIT_SHA_PATTERN,
            exports[0].get("uses", ""),
        )
        or exports[0].get("with", {}).get("name") != name + "-${{ github.run_attempt }}"
        or exports[0].get("with", {}).get("path") != report["path"]
    ):
        raise ValueError("Coverage producer export differs from policy")


def validate_coverage_callers(policy, workflows, gate):
    """Validate the opt-in upload graph and return its expected remote reference."""
    coverage = policy.get("coverage")
    if not coverage:
        return set()
    ref = coverage["toolkit_ref"]
    if not isinstance(ref, str) or not re.fullmatch(COMMIT_SHA_PATTERN, ref):
        raise ValueError("Coverage toolkit_ref must be a full commit SHA")
    reference = (
        "victron-venus/venus-os-ci-toolkit/.github/workflows/coverage-upload.yml@" + ref
    )
    for report in coverage["reports"]:
        name = "coverage-" + report["name"]
        upload = gate.get(name, {})
        producer_index = policy["validation_workflows"].index(report["workflow"])
        if (
            upload.get("uses") != reference
            or upload.get("needs") != ["scope", f"check-{producer_index}"]
            or upload.get("permissions")
            != {"contents": "read", "actions": "read", "id-token": "write"}
            or upload.get("with")
            != {
                "artifact-name": name,
                "report-file": report["path"].rsplit("/", 1)[-1],
                "format": report["format"],
                "flags": report["name"],
                "required": str(report["required"]).lower(),
            }
        ):
            raise ValueError(
                "Coverage upload caller differs from its policy or producer dependency"
            )
        producer = workflows[report["workflow"]]["jobs"][report["job"]]
        validate_coverage_producer(producer, report, ref)
    return {reference}


def validate_release_baseline(jobs, baseline):
    """Retain each default check and its original condition outside beta releases."""
    for job_name, original in baseline.items():
        if job_name in {"scope", "gate"}:
            continue
        actual = jobs[job_name]
        wanted = dict(original)
        if job_name.startswith(("check-", "coverage-")):
            condition = original.get("if", "${{ success() }}")[3:-3].strip()
            wanted["if"] = "${{ inputs.channel != 'beta' && (" + condition + ") }}"
        if actual != wanted:
            raise ValueError(
                "Release validation must retain the complete default checks"
            )


def validate_beta_callers(jobs, beta):
    """Require the policy-selected beta workflows and their dependencies."""
    for index, filename in enumerate(beta):
        job = jobs[f"beta-check-{index}"]
        if (
            job.get("uses") != LOCAL_WORKFLOW_PREFIX + filename
            or job.get("needs") != ["scope", "workflow-contracts"]
            or job.get("if")
            != "${{ inputs.channel == 'beta' && needs.scope.outputs.run == 'true' }}"
        ):
            raise ValueError("Beta validation caller differs from channel policy")


def validate_release_scope(scope):
    """Require explicit channel selection and full validation in the release scope."""
    selector = [
        step
        for step in scope.get("steps", [])
        if step.get("name") == "Validate release channel"
    ]
    if (
        scope.get("name") != "Validation profile (${{ inputs.channel }})"
        or "if" in scope
        or len(selector) != 1
        or selector[0].get("run")
        != 'python3 scripts/release_validation.py select --channel "$RELEASE_CHANNEL"'
        or selector[0].get("env") != {"RELEASE_CHANNEL": "${{ inputs.channel }}"}
        or not any(
            step.get("env", {}).get("FORCE_FULL") == "true"
            for step in scope.get("steps", [])
        )
    ):
        raise ValueError(
            "Release validation must prove its channel and force real checks"
        )


def validate_release_gate(gate, workflow=None):
    """Require the shared fail-closed gate with all dependency results."""
    commands = [step for step in gate.get("steps", []) if "run" in step]
    execution_overrides = {"shell", "working-directory"}
    for scope in (workflow or {}, gate):
        if execution_overrides.intersection(scope.get("defaults", {}).get("run", {})):
            raise ValueError("Release validation gate cannot override its shell or working-directory")
    if any(execution_overrides.intersection(step) for step in commands):
        raise ValueError("Release validation gate cannot override its shell or working-directory")
    if (
        gate.get("name") != "CI gate"
        or gate.get("if") != "${{ always() }}"
        or gate.get("continue-on-error", "false") != "false"
        or len(commands) != 1
        or commands[0].get("continue-on-error", "false") != "false"
        or "if" in commands[0]
        or commands[0].get("run")
        != 'python3 scripts/release_validation.py gate --channel "$RELEASE_CHANNEL"'
        or commands[0].get("env")
        != {
            "RESULTS": "${{ toJSON(needs) }}",
            "RELEASE_CHANNEL": "${{ inputs.channel }}",
        }
    ):
        raise ValueError("Release validation must use the fail-closed profile gate")


def validate_release_channels(policy, workflows):
    """A channel-specific release gate cannot alter or bypass the required PR gate."""
    name = "release-quality-gate.yml"
    if "channel_validation_workflows" not in policy:
        if name in workflows:
            raise ValueError("Release validation workflow has no channel policy")
        return
    if __package__:
        from .release_validation import channel_workflows, expected_results
    else:
        from release_validation import channel_workflows, expected_results

    beta = channel_workflows(policy)
    validate_graph(workflows, beta)
    wrapper = workflows.get(name, {})
    if wrapper.get("on") != {
        "workflow_call": {
            "inputs": {
                "channel": {"type": "string", "required": "true"},
            }
        }
    }:
        raise ValueError("Release validation requires only its explicit channel input")
    jobs = wrapper.get("jobs", {})
    expected = set(expected_results(policy, "beta"))
    if (
        set(jobs) != expected | {"gate"}
        or set(jobs["gate"].get("needs", [])) != expected
    ):
        raise ValueError(
            "Release validation gate inventory differs from channel policy"
        )
    validate_release_baseline(jobs, workflows[QUALITY_GATE]["jobs"])
    validate_beta_callers(jobs, beta)
    validate_release_scope(jobs["scope"])
    validate_release_gate(jobs["gate"], wrapper)
    caller = workflows.get(RELEASE_PIPELINE, {}).get("jobs", {}).get("checks", {})
    if (
        caller.get("uses") != LOCAL_WORKFLOW_PREFIX + name
        or caller.get("needs") != "prepare"
        or caller.get("with") != {"channel": "${{ needs.prepare.outputs.channel }}"}
    ):
        raise ValueError("Release validation must consume the prepared channel")


def validate(directory: Path, *, actions_only=False) -> None:
    """Reject duplicate validation triggers, missing gate jobs and mixed CodeQL pins."""
    policy = json.loads((directory / ".release-policy.json").read_text())
    sources = {
        path.name: path.read_text()
        for path in (directory / ".github/workflows").glob("*.y*ml")
    }
    workflows = {
        # UniqueKeyLoader inherits BaseLoader: no Python object construction.
        name: yaml.load(source, Loader=UniqueKeyLoader)  # nosec B506
        for name, source in sources.items()
    }
    validate_codeql(workflows)
    validate_codeql_update_metadata(sources)
    validate_generator_pins(directory, workflows)
    if actions_only:
        return
    visited = validate_graph(workflows, policy["validation_workflows"])
    for filename, workflow in workflows.items():
        if (
            "pull_request" in workflow.get("on", {})
            and filename not in visited
            and filename not in {QUALITY_GATE, "auto-approve.yml", "auto-merge.yml"}
        ):
            raise ValueError(f"{filename}: PR validator is outside the required gate")
    gate = workflows[QUALITY_GATE]["jobs"]
    expected = {
        f"./.github/workflows/{filename}" for filename in policy["validation_workflows"]
    }
    expected.update(validate_coverage_callers(policy, workflows, gate))
    actual = {job.get("uses") for job in gate.values() if "uses" in job}
    if actual != expected or set(gate["gate"].get("needs", [])) != set(gate) - {"gate"}:
        raise ValueError(
            "CI gate must require every configured validator and contract job"
        )
    if "workflow-contracts" not in gate:
        raise ValueError("CI gate must include its configuration contracts")
    validate_release_channels(policy, workflows)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--actions-only", action="store_true")
    validate(Path.cwd(), actions_only=parser.parse_args().actions_only)
    print("CI entry point, timeouts and CodeQL pins are consistent.")

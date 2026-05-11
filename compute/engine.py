"""Wrap axiom-rules-engine so the rest of the service treats it as a black-box function.

We support two modes, picked at runtime:

* `real`   — `axiom_rules_engine` Python package is importable and an
              `AXIOM_RULES_ENGINE_BIN` env var points to the compiled engine binary.
              We compile the requested program once, cache the artifact, and
              run compiled executions per request.
* `demo`   — neither is available. We return the .test.yaml expected outputs
              for the program, clearly flagged in the response so the UI can
              say "demo mode — not real computation". Lets the dashboard run
              end-to-end without a Rust toolchain.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import yaml

from spec_loader import (
    first_test_case,
    find_test_template,
    is_relation_id,
    iter_outputs_in_template,
    merge_with_template,
    template_period,
)
from graph import build_graph, resolve_input_legal_id


@dataclass
class ComputeMode:
    name: str  # "real" | "demo"
    detail: str


def detect_mode() -> ComputeMode:
    binary = os.environ.get("AXIOM_RULES_ENGINE_BIN")
    if not binary:
        return ComputeMode("demo", "AXIOM_RULES_ENGINE_BIN not set; serving expected outputs from .test.yaml")
    if not Path(binary).exists():
        return ComputeMode("demo", f"AXIOM_RULES_ENGINE_BIN={binary} does not exist; falling back to demo mode")
    return ComputeMode("real", f"using engine at {binary}")


def _month_bounds(period: str) -> tuple[str, str]:
    """`2026-01` → (`2026-01-01`, `2026-02-01`)."""
    year_str, month_str = period.split("-")
    year, month = int(year_str), int(month_str)
    start = date(year, month, 1)
    end = date(year + (month // 12), (month % 12) + 1, 1)
    return start.isoformat(), end.isoformat()


def _coerce_value(raw: Any) -> dict[str, Any]:
    """Convert a Python value to axiom-rules-engine ScalarValue dict."""
    if isinstance(raw, bool):
        return {"kind": "bool", "value": raw}
    if isinstance(raw, int):
        return {"kind": "integer", "value": raw}
    if isinstance(raw, float):
        return {"kind": "decimal", "value": str(raw)}
    if isinstance(raw, str):
        # date strings → date kind; otherwise text.
        if len(raw) == 10 and raw[4] == "-" and raw[7] == "-":
            return {"kind": "date", "value": raw}
        return {"kind": "text", "value": raw}
    raise TypeError(f"unsupported scalar value: {raw!r}")


def _flat_inputs_to_records(
    flat: dict[str, Any],
    *,
    entity: str,
    entity_id: str,
    interval_start: str,
    interval_end: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split a flat `<id>: value` map into engine input records and relation records."""
    inputs: list[dict[str, Any]] = []
    relations: list[dict[str, Any]] = []

    for legal_id, value in flat.items():
        if is_relation_id(legal_id):
            if not isinstance(value, list):
                continue
            for idx, member in enumerate(value, start=1):
                member_id = f"person:{idx}"
                # axiom-rules-engine convention: related entity first, current
                # (host) entity second. count_where iterates the related
                # slot and looks up its inputs there. Inverting these has
                # been silently dropping every per-member input.
                relations.append({
                    "name": legal_id,
                    "tuple": [member_id, entity_id],
                    "interval": {"start": interval_start, "end": interval_end},
                })
                if isinstance(member, dict):
                    for sub_id, sub_value in member.items():
                        inputs.append({
                            "name": sub_id,
                            "entity": "Person",
                            "entity_id": member_id,
                            "interval": {"start": interval_start, "end": interval_end},
                            "value": _coerce_value(sub_value),
                        })
            continue
        inputs.append({
            "name": legal_id,
            "entity": entity,
            "entity_id": entity_id,
            "interval": {"start": interval_start, "end": interval_end},
            "value": _coerce_value(value),
        })

    return inputs, relations


def _output_to_response(output: dict[str, Any]) -> dict[str, Any]:
    if output.get("kind") == "judgment":
        outcome = output.get("outcome")
        return {
            "legalId": output.get("id") or output.get("name"),
            "value": outcome,
            "dtype": "judgment",
        }
    scalar = output.get("value", {})
    raw = scalar.get("value")
    if scalar.get("kind") == "decimal" and isinstance(raw, str):
        try:
            raw = float(raw)
        except ValueError:
            pass
    return {
        "legalId": output.get("id") or output.get("name"),
        "value": raw,
        "dtype": output.get("dtype") or scalar.get("kind") or "decimal",
    }


def _trace_node(
    legal_id: str,
    node: dict[str, Any],
    rule_formula: str | None = None,
) -> dict[str, Any]:
    if node.get("kind") == "judgment":
        return {
            "legalId": legal_id,
            "label": node.get("name"),
            "value": node.get("outcome"),
            "dtype": "judgment",
            "source": node.get("source"),
            "formula": rule_formula,
            "children": [],
        }
    scalar = node.get("value", {})
    raw = scalar.get("value")
    if scalar.get("kind") == "decimal" and isinstance(raw, str):
        try:
            raw = float(raw)
        except ValueError:
            pass
    return {
        "legalId": legal_id,
        "label": node.get("name"),
        "value": raw,
        "dtype": node.get("dtype") or scalar.get("kind") or "decimal",
        "source": node.get("source"),
        "formula": rule_formula,
        "children": [],
    }


def _input_leaf(
    legal_id: str,
    flat_inputs: dict[str, Any],
    user_keys: set[str],
) -> dict[str, Any]:
    """Build a leaf trace node for an input dependency.

    The leaf reports the value the engine actually used and flags whether it
    came from the user (the renderer supplied it) or from the program's
    test-fixture default. `source` is a humanized citation (e.g. "10 CCR
    2506-1 § 4.407.31") derived from the input's file legal ID — that's the
    answer to "where is this input declared?".
    """
    raw_value = flat_inputs.get(legal_id)
    file_part, _, _ = legal_id.partition("#")
    return {
        "legalId": legal_id,
        "label": legal_id.split("#")[-1].removeprefix("input."),
        "value": _normalize_input_value(raw_value),
        "dtype": "input",
        "inputSource": "user" if legal_id in user_keys else "default",
        "source": _humanize_citation(file_part),
        "homeFile": file_part,
        "children": [],
    }


def _humanize_citation(file_legal_id: str) -> str:
    """Best-effort human citation from a RuleSpec file legal ID.

    Examples:
      us:statutes/7/2017/a                  -> "7 USC § 2017(a)"
      us:regulations/7-cfr/273/8            -> "7 CFR § 273.8"
      us-co:regulations/10-ccr-2506-1/4.207.31
                                            -> "10 CCR 2506-1 § 4.207.31 (Colorado)"
      us-co:policies/cdhs/snap/fy-2026-benefit-calculation
                                            -> "Colorado · CDHS · SNAP · FY 2026 benefit calculation"
    """
    if not file_legal_id or ":" not in file_legal_id:
        return file_legal_id
    jurisdiction, _, body = file_legal_id.partition(":")
    parts = body.split("/")
    if not parts:
        return file_legal_id

    kind = parts[0]
    rest = parts[1:]

    if kind == "statutes" and len(rest) >= 2:
        title = rest[0]
        section = rest[1]
        subsections = rest[2:]
        suffix = "".join(f"({s})" for s in subsections)
        return f"{title} USC § {section}{suffix}"

    if kind == "regulations" and len(rest) >= 2:
        # rest[0] is the regulation slug ("7-cfr" or "10-ccr-2506-1")
        slug = rest[0]
        path = ".".join(rest[1:])
        if slug.lower() == "7-cfr":
            return f"7 CFR § {path}"
        # State CCRs / state regs — show slug as-is, uppercased
        readable = slug.replace("-", " ").upper()
        suffix = " (Colorado)" if jurisdiction == "us-co" else ""
        return f"{readable} § {path}{suffix}"

    if kind == "policies":
        head = jurisdiction_label(jurisdiction)
        crumbs = [seg.replace("-", " ") for seg in rest]
        return " · ".join([head, *crumbs])

    # Fallback: show as-is, just nicer separators.
    return f"{jurisdiction_label(jurisdiction)} · {body}"


def jurisdiction_label(j: str) -> str:
    return {
        "us": "Federal",
        "us-co": "Colorado",
        "us-ca": "California",
        "us-ny": "New York",
        "us-tx": "Texas",
        "us-fl": "Florida",
        "us-ga": "Georgia",
        "us-md": "Maryland",
        "us-nc": "North Carolina",
        "us-sc": "South Carolina",
        "us-tn": "Tennessee",
        "us-al": "Alabama",
        "us-ar": "Arkansas",
        "uk": "UK",
        "ca": "Canada",
    }.get(j, j)


def _normalize_input_value(raw: Any) -> Any:
    """Engine returns native types directly; nothing to do beyond sanity."""
    if isinstance(raw, list):
        # A relation's value is its list of member dicts — render as length.
        return f"{len(raw)} member(s)"
    return raw


def _collect_user_keys(
    user_inputs: dict[str, Any] | None,
    relations: dict[str, list[dict[str, Any]]] | None,
) -> set[str]:
    """Every legalId the renderer supplied (scalars + per-member inside relations)."""
    keys: set[str] = set(user_inputs.keys()) if user_inputs else set()
    if relations:
        for rel_id, members in relations.items():
            keys.add(rel_id)
            for member in members:
                if isinstance(member, dict):
                    keys.update(member.keys())
    return keys


def _build_trace_tree(
    queried: list[str],
    raw_trace: dict[str, dict[str, Any]],
    flat_inputs: dict[str, Any],
    user_keys: set[str],
    rule_input_deps: dict[str, list[str]] | None = None,
    rule_formulas: dict[str, str] | None = None,
) -> dict[str, dict[str, Any]]:
    """Convert flat trace dict into a per-output tree.

    Rule deps come from the engine's `dependencies` field. Input deps are
    sourced separately from a rule→input mapping (built from formula
    parsing in graph.py) since the engine response only lists rule
    dependencies. Input leaves are annotated with `inputSource: user|default`
    so the builder can flag dashboards that can never flip an outcome.
    `rule_formulas` lets the UI display each rule's actual condition.
    """
    formulas = rule_formulas or {}
    nodes: dict[str, dict[str, Any]] = {
        legal_id: _trace_node(legal_id, raw_trace[legal_id], formulas.get(legal_id))
        for legal_id in raw_trace
    }
    rule_input_deps = rule_input_deps or {}

    for legal_id, raw in raw_trace.items():
        node = nodes[legal_id]
        for dep_id in raw.get("dependencies") or []:
            if dep_id in nodes:
                node["children"].append(nodes[dep_id])

        # Append input deps last so they sit at the bottom of the rule's
        # children list (rules first, then their leaf inputs).
        for input_id in rule_input_deps.get(legal_id, []):
            node["children"].append(_input_leaf(input_id, flat_inputs, user_keys))

    return {q: nodes[q] for q in queried if q in nodes}


def _coverage(flat_inputs: dict[str, Any], user_keys: set[str]) -> dict[str, Any]:
    """High-level "how user-driven is this dashboard?" stats for the response."""
    all_keys = set(flat_inputs.keys())
    user = sorted(k for k in all_keys if k in user_keys)
    default = sorted(k for k in all_keys if k not in user_keys)
    return {
        "userInputs": user,
        "defaultInputs": default,
        "userInputCount": len(user),
        "defaultInputCount": len(default),
    }


def execute_real(
    *,
    program_yaml: Path,
    rules_root: Path,
    user_inputs: dict[str, Any],
    relations: dict[str, list[dict[str, Any]]] | None,
    queried_outputs: list[str],
    period: str,
) -> dict[str, Any]:
    """Run the axiom-rules-engine engine against a program, return outputs + traces.

    On failure we automatically isolate: compute outputs one at a time so a
    single broken output doesn't kill the whole batch. The good ones return
    real engine values; the failures fall back to test-fixture values with a
    per-output warning naming the engine error.
    """
    try:
        return _execute_real_batch(
            program_yaml=program_yaml,
            user_inputs=user_inputs,
            relations=relations,
            queried_outputs=queried_outputs,
            period=period,
        )
    except RuntimeError as batch_err:
        # The whole batch failed — try one output at a time.
        return _execute_real_isolated(
            program_yaml=program_yaml,
            user_inputs=user_inputs,
            relations=relations,
            queried_outputs=queried_outputs,
            period=period,
            batch_error=str(batch_err),
        )


def _execute_real_isolated(
    *,
    program_yaml: Path,
    user_inputs: dict[str, Any],
    relations: dict[str, list[dict[str, Any]]] | None,
    queried_outputs: list[str],
    period: str,
    batch_error: str,
) -> dict[str, Any]:
    """Compute each queried output independently. Fall back to fixture for failures."""
    template = first_test_case(t) if (t := find_test_template(program_yaml)) else None
    expected = dict(iter_outputs_in_template(template))

    outputs: list[dict[str, Any]] = []
    traces: dict[str, dict[str, Any]] = {}
    failed_outputs: list[str] = []

    for legal_id in queried_outputs:
        try:
            single = _execute_real_batch(
                program_yaml=program_yaml,
                user_inputs=user_inputs,
                relations=relations,
                queried_outputs=[legal_id],
                period=period,
            )
            outputs.extend(single.get("outputs", []))
            traces.update(single.get("traces", {}))
        except RuntimeError:
            failed_outputs.append(legal_id)
            # Fall back to fixture value if available, marked clearly.
            if legal_id in expected:
                raw = expected[legal_id]
                if isinstance(raw, str) and raw in {"holds", "not_holds", "undetermined"}:
                    outputs.append({"legalId": legal_id, "value": raw, "dtype": "judgment"})
                else:
                    outputs.append({"legalId": legal_id, "value": raw, "dtype": "decimal"})
                traces[legal_id] = {
                    "legalId": legal_id,
                    "label": legal_id.split("#")[-1],
                    "value": raw,
                    "dtype": "judgment" if isinstance(raw, str) else "decimal",
                    "source": "engine couldn't compute live; using test-fixture value",
                    "children": [],
                }

    user_keys = _collect_user_keys(user_inputs, relations)
    template_inputs = template.get("input", {}) if template else {}
    coverage = _coverage(template_inputs, user_keys)

    warnings: list[str] = []
    if failed_outputs:
        names = ", ".join(legal_id.split("#")[-1] for legal_id in failed_outputs[:5])
        warnings.append(
            f"engine couldn't compute {len(failed_outputs)} output(s) ({names}"
            f"{'…' if len(failed_outputs) > 5 else ''}). "
            f"Showing test-fixture values instead. "
            f"Underlying error: {batch_error[:300]}"
        )
    return {
        "outputs": outputs,
        "traces": traces,
        "coverage": coverage,
        "warnings": warnings,
    }


def _execute_real_batch(
    *,
    program_yaml: Path,
    user_inputs: dict[str, Any],
    relations: dict[str, list[dict[str, Any]]] | None,
    queried_outputs: list[str],
    period: str,
) -> dict[str, Any]:
    """Single batch run against the engine — no fallback. Raises on failure."""
    binary = os.environ["AXIOM_RULES_ENGINE_BIN"]
    template = first_test_case(test) if (test := find_test_template(program_yaml)) else None

    flat = merge_with_template(template, user_inputs, relations)
    interval_start, interval_end = _month_bounds(period)
    inputs, relation_records = _flat_inputs_to_records(
        flat,
        entity="Household",
        entity_id="household:1",
        interval_start=interval_start,
        interval_end=interval_end,
    )

    request_payload = {
        "mode": "explain",
        "dataset": {"inputs": inputs, "relations": relation_records},
        "queries": [
            {
                "entity_id": "household:1",
                "period": {
                    "period_kind": "month",
                    "start": interval_start,
                    "end": interval_end,
                },
                "outputs": queried_outputs,
            }
        ],
    }

    artifact = _ensure_compiled(binary, program_yaml)
    proc = _run_with_missing_input_retries(
        binary,
        artifact,
        request_payload,
        entity_id="household:1",
        interval_start=interval_start,
        interval_end=interval_end,
        program_yaml=program_yaml,
    )

    response = json.loads(proc.stdout)
    if not response.get("results"):
        return {"outputs": [], "traces": {}, "warnings": ["no results returned"]}

    result = response["results"][0]
    outputs = [_output_to_response(o) for o in result.get("outputs", {}).values()]
    user_keys = _collect_user_keys(user_inputs, relations)
    rule_input_deps, rule_formulas = _rule_metadata_for(program_yaml)
    traces = _build_trace_tree(
        queried_outputs,
        result.get("trace", {}),
        flat,
        user_keys,
        rule_input_deps,
        rule_formulas,
    )
    coverage = _coverage(flat, user_keys)
    return {"outputs": outputs, "traces": traces, "coverage": coverage}


_graph_cache: dict[Path, tuple[dict[str, list[str]], dict[str, str]]] = {}


def _rule_metadata_for(
    program_yaml: Path,
) -> tuple[dict[str, list[str]], dict[str, str]]:
    """Cached (rule→input-deps, rule→formula) maps for a program.

    Both maps key off rule legal ID. `formula` is the latest version's raw
    condition text from the YAML, used by the UI to explain *why* a rule
    holds or fails. Empty maps on graph-build failure.
    """
    if program_yaml in _graph_cache:
        return _graph_cache[program_yaml]
    try:
        graph = build_graph(program_yaml, _infer_repo(program_yaml))
    except Exception:
        _graph_cache[program_yaml] = ({}, {})
        return ({}, {})
    deps: dict[str, list[str]] = {}
    formulas: dict[str, str] = {}
    for rule in graph.rules.values():
        deps[rule.legal_id] = list(rule.input_deps) + list(rule.relation_deps)
        if rule.formula:
            formulas[rule.legal_id] = rule.formula
    _graph_cache[program_yaml] = (deps, formulas)
    return (deps, formulas)


def _infer_repo(program_yaml: Path) -> str:
    """Walk up from the program YAML until a `rulespec-*` directory is hit."""
    current = program_yaml.resolve()
    for parent in current.parents:
        if parent.name.startswith("rules-"):
            return parent.name
    return ""


_MISSING_INPUT_RE = re.compile(
    r"missing input `([^`]+)`(?: for entity `([^`]+)`)?"
)
_BARE_NAME_RE = re.compile(r"dataset input `([^`]+)` must use an absolute legal RuleSpec reference")
_TYPE_MISMATCH_RE = re.compile(r"type mismatch: right side of comparison is not numeric")


def _infer_default_value(legal_id: str) -> dict[str, Any]:
    """Best-effort default for an input the engine demands but the fixture lacks.

    Boolean-shaped names (predicates) default to false; everything else
    defaults to 0. The fragment after `#input.` is what carries the semantic
    cue. This is heuristic but bounded — only kicks in for inputs the
    test-fixture forgot to enumerate.
    """
    fragment = legal_id.split("#")[-1].removeprefix("input.").lower()
    boolean_starts = ("is_", "has_", "was_", "were_", "does_", "do_", "will_", "should_", "can_", "must_")
    boolean_endings = (
        "_eligible", "_active", "_received", "_paid", "_applies",
        "_required", "_present", "_member", "_holds", "_passed",
        "_satisfied", "_met", "_complies", "_complying", "_provided",
        "_disqualified", "_disqualification", "_pending", "_excluded",
        "_exempt", "_owned", "_purchased", "_terminated", "_known",
        "_anticipated", "_assigned", "_referred", "_offered", "_allowed",
        "_verified", "_confirmed", "_separately",
    )
    if (
        fragment.startswith(boolean_starts)
        or any(fragment.endswith(s) for s in boolean_endings)
        or "_holds" in fragment
    ):
        return {"kind": "bool", "value": False}
    if "date" in fragment:
        return {"kind": "date", "value": "2026-01-01"}
    return {"kind": "decimal", "value": "0"}


def _run_with_missing_input_retries(
    binary: str,
    artifact: Path,
    request_payload: dict[str, Any],
    *,
    entity_id: str,
    interval_start: str,
    interval_end: str,
    program_yaml: Path,
    max_retries: int = 300,
) -> subprocess.CompletedProcess[str]:
    """Run the engine; on missing-input errors, default the input and retry.

    The engine reports two distinct errors:
      1. `missing input ` — when no record exists for the input
      2. `must use an absolute legal RuleSpec reference` — when we sent a
         bare name but the engine demanded a `<file>#input.<name>` form

    For (1) we add a record under the bare legal ID. For (2) we look up the
    bare name in the program graph's rule formulas, find any file that
    references it, and try `<file>#input.<name>` candidates until the engine
    accepts one.
    """
    # Keyed (legal_id, entity_class) — "person" misses and "household"
    # misses for the same legal ID are tracked separately so adding the
    # default under one scope doesn't preempt a retry under the other.
    rejected_legal_ids: set[tuple[str, str]] = set()
    pending_candidates: dict[str, list[str]] = {}
    # Track records by (name, entity_id) so we don't mark a per-member input
    # as "tried" after flipping just one member — every relation member is a
    # separate record with the same name but different entity_id.
    upgraded_to_numeric: set[tuple[str, str]] = set()
    graph_loader: Any = None

    def _graph() -> Any:
        nonlocal graph_loader
        if graph_loader is None:
            graph_loader = build_graph(program_yaml, _infer_repo(program_yaml))
        return graph_loader

    for _attempt in range(max_retries):
        proc = subprocess.run(
            [binary, "run-compiled", "--artifact", str(artifact)],
            input=json.dumps(request_payload),
            text=True,
            capture_output=True,
            check=False,
        )
        if proc.returncode == 0:
            return proc

        stderr = proc.stderr or ""

        # Type-mismatch: a comparison expected a number but got a non-numeric.
        # Flip any non-numeric input (bool / text / date) to integer one at a
        # time, in reverse order of appearance, until the error clears. We
        # don't know which input the engine choked on, so we walk back through
        # the dataset and try each candidate. Bools convert to 1/0 by
        # truthiness; text/date become 0 (the comparison was always wrong on
        # those types — the rule won't make sense, but the engine will run).
        if _TYPE_MISMATCH_RE.search(stderr):
            target_index: int | None = None
            for idx in range(len(request_payload["dataset"]["inputs"]) - 1, -1, -1):
                rec = request_payload["dataset"]["inputs"][idx]
                kind = rec.get("value", {}).get("kind")
                if kind in ("integer", "decimal"):
                    continue
                key = (rec["name"], rec.get("entity_id", ""))
                if key in upgraded_to_numeric:
                    continue
                target_index = idx
                break
            if target_index is None:
                # Surface a full diagnostic: which inputs we flipped, the
                # remaining non-numeric inputs in the dataset (if any), and
                # the engine's stderr verbatim. This is the data we'd ask
                # the user to paste back when troubleshooting.
                non_numeric_remaining = [
                    f"{rec['name']}@{rec.get('entity_id','')}={rec['value'].get('kind')}"
                    for rec in request_payload["dataset"]["inputs"]
                    if rec.get("value", {}).get("kind") not in ("integer", "decimal")
                ]
                upgraded = sorted(f"{n}@{e}" for n, e in upgraded_to_numeric)
                raise RuntimeError(
                    "axiom-rules-engine type mismatch persists after upgrading every "
                    f"non-numeric input to integer. The offending value is "
                    f"likely a derived rule output or a parameter, not an input.\n"
                    f"Stderr: {stderr.strip()}\n"
                    f"Upgraded ({len(upgraded)}): {upgraded[:30]}{'…' if len(upgraded) > 30 else ''}\n"
                    f"Still non-numeric ({len(non_numeric_remaining)}): {non_numeric_remaining[:30]}"
                )
            target_rec = request_payload["dataset"]["inputs"][target_index]
            old_kind = target_rec["value"].get("kind")
            old_val = target_rec["value"].get("value")
            int_value = 1 if (old_kind == "bool" and old_val) else 0
            target_rec["value"] = {"kind": "integer", "value": int_value}
            upgraded_to_numeric.add((target_rec["name"], target_rec.get("entity_id", "")))
            continue

        bare_match = _BARE_NAME_RE.search(stderr)
        miss_match = _MISSING_INPUT_RE.search(stderr)

        if bare_match:
            bare_name = bare_match.group(1)
            # Drop the rejected record so we don't keep sending it.
            request_payload["dataset"]["inputs"] = [
                rec
                for rec in request_payload["dataset"]["inputs"]
                if rec["name"] != bare_name
            ]
            rejected_legal_ids.add((bare_name, "bare"))

            if bare_name not in pending_candidates:
                try:
                    pending_candidates[bare_name] = resolve_input_legal_id(_graph(), bare_name)
                except Exception:
                    pending_candidates[bare_name] = []

            candidates = pending_candidates[bare_name]
            if not candidates:
                raise RuntimeError(
                    f"axiom-rules-engine: cannot resolve legal ID for bare input `{bare_name}`. "
                    f"No rule in the program graph references it. Stderr: {stderr.strip()}"
                )
            chosen = candidates.pop(0)
            value = _infer_default_value(chosen)
            request_payload["dataset"]["inputs"].append({
                "name": chosen,
                "entity": "Household",
                "entity_id": entity_id,
                "interval": {"start": interval_start, "end": interval_end},
                "value": value,
            })
            continue

        if miss_match:
            legal_id = miss_match.group(1)
            miss_entity_id = miss_match.group(2) or ""
            entity_class = (
                "person" if miss_entity_id.startswith("person:") else "household"
            )
            rejection_key = (legal_id, entity_class)
            if rejection_key in rejected_legal_ids:
                raise RuntimeError(
                    f"axiom-rules-engine: defaulting input `{legal_id}` doesn't satisfy the engine. "
                    f"Last stderr: {stderr.strip()}"
                )
            rejected_legal_ids.add(rejection_key)
            value = _infer_default_value(legal_id)
            if entity_class == "person":
                # The engine only complains about one missing person at a
                # time; fill the default for every person already in the
                # dataset so we don't burn retries one member at a time.
                # Pull person IDs from existing input records and from
                # relation tuples (in case some persons have no inputs yet).
                person_ids: set[str] = set()
                for rec in request_payload["dataset"]["inputs"]:
                    if rec.get("entity") == "Person":
                        eid = rec.get("entity_id")
                        if eid:
                            person_ids.add(eid)
                for rel in request_payload["dataset"].get("relations", []):
                    for tup_id in rel.get("tuple", []):
                        if isinstance(tup_id, str) and tup_id.startswith("person:"):
                            person_ids.add(tup_id)
                if not person_ids:
                    person_ids = {miss_entity_id or "person:1"}
                for pid in sorted(person_ids):
                    request_payload["dataset"]["inputs"].append({
                        "name": legal_id,
                        "entity": "Person",
                        "entity_id": pid,
                        "interval": {"start": interval_start, "end": interval_end},
                        "value": value,
                    })
            else:
                request_payload["dataset"]["inputs"].append({
                    "name": legal_id,
                    "entity": "Household",
                    "entity_id": entity_id,
                    "interval": {"start": interval_start, "end": interval_end},
                    "value": value,
                })
            continue

        raise RuntimeError(f"axiom-rules-engine failed: {stderr.strip()}")

    raise RuntimeError(
        f"axiom-rules-engine: too many missing inputs ({max_retries}+), giving up."
    )


_compile_cache: dict[Path, Path] = {}


def _ensure_compiled(binary: str, program_yaml: Path) -> Path:
    if program_yaml in _compile_cache:
        return _compile_cache[program_yaml]
    artifact_dir = Path(__file__).parent / "artifacts"
    artifact_dir.mkdir(exist_ok=True)
    artifact = artifact_dir / (program_yaml.stem + ".compiled.json")
    proc = subprocess.run(
        [binary, "compile", "--program", str(program_yaml), "--output", str(artifact)],
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"axiom-rules-engine compile failed: {proc.stderr.strip()}")
    _compile_cache[program_yaml] = artifact
    return artifact


def execute_demo(
    *,
    program_yaml: Path,
    queried_outputs: list[str],
    user_inputs: dict[str, Any] | None = None,
    relations: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """Demo-mode fallback: return expected outputs from the program's .test.yaml."""
    test = find_test_template(program_yaml)
    template = first_test_case(test) if test else None
    expected = dict(iter_outputs_in_template(template))

    outputs = []
    traces: dict[str, dict[str, Any]] = {}
    for legal_id in queried_outputs:
        if legal_id not in expected:
            continue
        raw = expected[legal_id]
        if isinstance(raw, str) and raw in {"holds", "not_holds", "undetermined"}:
            outputs.append({"legalId": legal_id, "value": raw, "dtype": "judgment"})
        else:
            outputs.append({"legalId": legal_id, "value": raw, "dtype": "decimal"})
        traces[legal_id] = {
            "legalId": legal_id,
            "label": legal_id.split("#")[-1],
            "value": raw,
            "dtype": "judgment" if isinstance(raw, str) else "decimal",
            "source": "demo mode (.test.yaml fixture)",
            "children": [],
        }

    user_keys = _collect_user_keys(user_inputs, relations)
    template_inputs = template.get("input", {}) if template else {}
    coverage = _coverage(template_inputs, user_keys)

    return {
        "outputs": outputs,
        "traces": traces,
        "coverage": coverage,
        "warnings": [
            "demo mode: returning expected outputs from .test.yaml. "
            "Set AXIOM_RULES_ENGINE_BIN and install the axiom_rules_engine Python package for live computation."
        ],
    }

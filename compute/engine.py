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
import hashlib
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
                relation_name = legal_id.split("#relation.", 1)[-1]
                relations.append({
                    "name": relation_name,
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


def _fixture_output_node(legal_id: str, raw_value: Any) -> dict[str, Any]:
    file_part, _, name = legal_id.partition("#")
    if isinstance(raw_value, str) and raw_value in {"holds", "not_holds", "undetermined"}:
        dtype = "judgment"
    elif isinstance(raw_value, bool):
        dtype = "boolean"
    elif isinstance(raw_value, int) and not isinstance(raw_value, bool):
        dtype = "integer"
    elif isinstance(raw_value, float):
        dtype = "decimal"
    elif isinstance(raw_value, str) and len(raw_value) == 10 and raw_value[4] == "-" and raw_value[7] == "-":
        dtype = "date"
    elif isinstance(raw_value, str):
        dtype = "string"
    else:
        dtype = "decimal"
    return {
        "legalId": legal_id,
        "label": name,
        "value": _normalize_input_value(raw_value),
        "dtype": dtype,
        "source": _humanize_citation(file_part),
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


def _filter_user_supplied_values(
    program_yaml: Path,
    user_inputs: dict[str, Any],
    relations: dict[str, list[dict[str, Any]]] | None,
) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]] | None]:
    """Drop submitted values that are not real graph inputs/relations.

    This is a defensive boundary: older drafts or curated starter lists may
    still contain generic statutory `#input.*` IDs that the composed graph now
    resolves as computed outputs. Passing those through lets the dashboard
    override part of the calculation. The graph is the source of truth for
    what a user may supply.
    """
    try:
        graph = build_graph(program_yaml, _infer_repo(program_yaml))
    except Exception:
        return user_inputs, relations

    allowed_inputs = set(graph.inputs)
    allowed_relations = set(graph.relations)

    filtered_inputs = {
        legal_id: value
        for legal_id, value in user_inputs.items()
        if legal_id in allowed_inputs or legal_id in allowed_relations
    }

    if not relations:
        return filtered_inputs, relations

    filtered_relations: dict[str, list[dict[str, Any]]] = {}
    for relation_id, members in relations.items():
        if relation_id not in allowed_relations:
            continue
        filtered_members: list[dict[str, Any]] = []
        for member in members:
            if not isinstance(member, dict):
                continue
            filtered_members.append({
                legal_id: value
                for legal_id, value in member.items()
                if legal_id in allowed_inputs
            })
        filtered_relations[relation_id] = filtered_members

    return filtered_inputs, filtered_relations


_CO_SNAP_PROGRAM_SUFFIX = "policies/cdhs/snap/fy-2026-benefit-calculation.yaml"


def _dynamic_input_defaults(program_yaml: Path, flat: dict[str, Any]) -> dict[str, Any]:
    """Computed bridge defaults for imported rules that still ask for generic inputs.

    The Colorado SNAP composition computes income through state rules, while
    some imported federal modules still request generic income inputs by name.
    Without this bridge the missing-input retry path fills those names from
    the fixture baseline, so changing employee wages affects deductions but
    leaves monthly/gross income stuck at the original fixture value.
    """
    program_posix = program_yaml.as_posix()
    if not program_posix.endswith(_CO_SNAP_PROGRAM_SUFFIX):
        return {}

    co_403 = "us-co:regulations/10-ccr-2506-1/4.403#input."
    co_403_2 = "us-co:regulations/10-ccr-2506-1/4.403.2#input."
    co_403_11 = "us-co:regulations/10-ccr-2506-1/4.403.11#input."
    co_404 = "us-co:regulations/10-ccr-2506-1/4.404#input."

    def amount(legal_id: str) -> float:
        raw = flat.get(legal_id, 0)
        if isinstance(raw, bool):
            return 1.0 if raw else 0.0
        try:
            return float(raw)
        except (TypeError, ValueError):
            return 0.0

    def flag(legal_id: str) -> bool:
        raw = flat.get(legal_id, False)
        if isinstance(raw, str):
            return raw.strip().lower() in {"true", "1", "yes", "y"}
        return bool(raw)

    wage_income = 0.0
    if not flag(f"{co_403}higher_education_state_work_study_or_work_requirement_fellowship_income"):
        wage_income = sum(
            amount(f"{co_403}{name}")
            for name in (
                "employee_wages_received",
                "garnished_or_diverted_wages_for_household_expenses",
                "wages_held_at_employee_request_that_would_have_been_paid",
                "wages_previously_withheld_by_employer_general_practice_received",
                "reasonably_anticipated_wage_advances_received",
            )
        )

    sick_vacation_bonus = (
        amount(f"{co_403}sick_vacation_or_bonus_pay_received")
        if flag(f"{co_403}person_still_employed_when_sick_vacation_or_bonus_pay_received")
        else 0.0
    )
    rental_gross = amount(f"{co_403}rental_property_gross_income")
    rental_costs = amount(f"{co_403}rental_property_business_costs")
    rental_is_earned = amount(f"{co_403}average_rental_property_management_hours_per_week") >= 20
    earned_rental = max(0.0, rental_gross - rental_costs) if rental_is_earned else 0.0
    boarder_income = max(
        0.0,
        amount(f"{co_403_2}boarder_payments_for_room_meals_and_shelter_contributions")
        - amount(f"{co_403_2}actual_documented_boarder_room_and_meal_costs"),
    )
    other_self_employment = max(
        0.0,
        amount(f"{co_403_11}self_employment_gross_income_for_period")
        + amount(f"{co_403_11}self_employment_capital_gains_for_period")
        - amount(f"{co_403_11}allowable_self_employment_business_costs_for_period"),
    )
    earned = (
        wage_income
        + amount(f"{co_403}household_vista_or_title_i_domestic_volunteer_earned_income")
        + amount(f"{co_403}household_training_allowance_earned_income")
        + amount(f"{co_403}household_wioa_ojt_earned_income")
        + sick_vacation_bonus
        + earned_rental
        + amount(f"{co_403}household_llc_s_corporation_owner_earned_income")
        + (0.0 if flag(f"{co_403_2}boarder_income_is_foster_care_payment") else boarder_income)
        + other_self_employment
        + amount(f"{co_403}capital_goods_services_or_property_sale_proceeds_connected_to_self_employment")
    )

    unearned_rental = max(0.0, rental_gross - rental_costs) if not rental_is_earned else 0.0
    terminated_installment = (
        amount(f"{co_404}vacation_sick_or_bonus_pay")
        if (
            flag(f"{co_404}vacation_sick_or_bonus_pay_after_terminated_employment")
            and flag(f"{co_404}vacation_sick_or_bonus_pay_received_in_installments")
        )
        else 0.0
    )
    nonprofit_gift = max(0.0, amount(f"{co_404}nonprofit_gifts_received_in_fiscal_quarter") - 300)
    other_gift = (
        amount(f"{co_404}gifts_from_other_sources")
        if flag(f"{co_404}gifts_from_other_sources_can_be_anticipated")
        else 0.0
    )
    lottery = (
        amount(f"{co_404}household_member_allocated_lottery_or_gambling_winnings")
        if flag(f"{co_404}substantial_lottery_or_gambling_winnings_received")
        else 0.0
    )
    sponsor = (
        amount(f"{co_404}sponsor_income_deemed_to_household")
        if flag(f"{co_404}sponsored_noncitizen_household")
        else 0.0
    )
    unearned = (
        amount(f"{co_404}assistance_payments")
        + amount(f"{co_404}retirement_disability_payments")
        + amount(f"{co_404}direct_support_and_alimony_payments")
        + unearned_rental
        + sponsor
        + terminated_installment
        + nonprofit_gift
        + other_gift
        + amount(f"{co_404}other_gain_or_benefit_payments")
        + amount(f"{co_404}trust_fund_withdrawals")
        + amount(f"{co_404}available_trust_dividends")
        + lottery
    )
    gross = earned + unearned

    def scalar(value: float) -> int | float:
        return int(value) if value.is_integer() else value

    earned_value = scalar(earned)
    unearned_value = scalar(unearned)
    gross_value = scalar(gross)

    defaults = {
        "snap_countable_earned_income": earned_value,
        "snap_countable_unearned_income": unearned_value,
        "snap_gross_monthly_earned_income": earned_value,
        "snap_total_monthly_unearned_income": unearned_value,
        "snap_gross_monthly_income": gross_value,
        "snap_monthly_household_income": gross_value,
        "us:statutes/7/2014/e/2#input.snap_countable_earned_income": earned_value,
        "us:regulations/7-cfr/273/10#input.snap_countable_earned_income": earned_value,
        "us:regulations/7-cfr/273/10#input.snap_gross_monthly_earned_income": earned_value,
        "us:regulations/7-cfr/273/10#input.snap_countable_unearned_income": unearned_value,
        "us:regulations/7-cfr/273/10#input.snap_total_monthly_unearned_income": unearned_value,
        "us:regulations/7-cfr/273/9#input.snap_gross_monthly_income": gross_value,
        "us:statutes/7/2014/e/6/A#input.snap_monthly_household_income": gross_value,
        "us-co:regulations/10-ccr-2506-1/4.403#snap_countable_earned_income": earned_value,
        "us-co:regulations/10-ccr-2506-1/4.404#snap_countable_unearned_income": unearned_value,
        "us:regulations/7-cfr/273/10#snap_gross_monthly_income": gross_value,
        "us:regulations/7-cfr/273/10#snap_monthly_household_income": gross_value,
    }
    return defaults


def _fixture_outputs_for_trace(
    program_yaml: Path,
    dynamic_defaults: dict[str, Any] | None,
) -> dict[str, Any]:
    if not dynamic_defaults:
        return {}
    return {
        key: value
        for key, value in dynamic_defaults.items()
        if "#" in key and "#input." not in key
    }


def _build_trace_tree(
    queried: list[str],
    raw_trace: dict[str, dict[str, Any]],
    flat_inputs: dict[str, Any],
    user_keys: set[str],
    rule_rule_deps: dict[str, list[str]] | None = None,
    rule_input_deps: dict[str, list[str]] | None = None,
    rule_formulas: dict[str, str] | None = None,
    fixture_outputs: dict[str, Any] | None = None,
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
    fixture_outputs = fixture_outputs or {}
    rule_rule_deps = rule_rule_deps or {}
    rule_input_deps = rule_input_deps or {}

    for legal_id, raw in raw_trace.items():
        node = nodes[legal_id]
        seen_child_ids: set[str] = set()
        for dep_id in raw.get("dependencies") or []:
            if dep_id in nodes:
                node["children"].append(nodes[dep_id])
                seen_child_ids.add(dep_id)

        # Engine traces only report runtime rule dependencies. The graph also
        # knows about fixture-only outputs that stand in for generic statutory
        # inputs; include those as output-like leaves instead of demoting them
        # to user inputs.
        for dep_id in rule_rule_deps.get(legal_id, []):
            if dep_id in seen_child_ids:
                continue
            if dep_id in nodes:
                node["children"].append(nodes[dep_id])
                seen_child_ids.add(dep_id)
            elif dep_id in fixture_outputs:
                node["children"].append(_fixture_output_node(dep_id, fixture_outputs[dep_id]))
                seen_child_ids.add(dep_id)

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
    real engine values; failures return neutral defaults with a per-output
    warning naming the engine error.
    """
    user_inputs, relations = _filter_user_supplied_values(
        program_yaml,
        user_inputs,
        relations,
    )
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
    """Compute each queried output independently. Fall back to neutral defaults."""
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
            fallback = _neutral_output_fallback(legal_id, expected.get(legal_id))
            outputs.append(fallback)
            traces[legal_id] = {
                "legalId": legal_id,
                "label": legal_id.split("#")[-1],
                "value": fallback["value"],
                "dtype": fallback["dtype"],
                "source": "engine couldn't compute live; using neutral default",
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
            f"Showing neutral defaults instead. "
            f"Underlying error: {batch_error[:300]}"
        )
    return {
        "outputs": outputs,
        "traces": traces,
        "coverage": coverage,
        "warnings": warnings,
    }


def _neutral_output_fallback(legal_id: str, sample: Any) -> dict[str, Any]:
    if isinstance(sample, str) and sample in {"holds", "not_holds", "undetermined"}:
        return {"legalId": legal_id, "value": "not_holds", "dtype": "judgment"}
    if isinstance(sample, bool):
        return {"legalId": legal_id, "value": False, "dtype": "bool"}
    return {"legalId": legal_id, "value": 0, "dtype": "decimal"}


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
    dynamic_defaults = _dynamic_input_defaults(program_yaml, flat)
    interval_start, interval_end = _month_bounds(period)
    inputs, relation_records = _flat_inputs_to_records(
        flat,
        entity="Household",
        entity_id="household:1",
        interval_start=interval_start,
        interval_end=interval_end,
    )

    artifact = _ensure_compiled(binary, program_yaml)
    query_refs = {
        legal_id: _query_reference(legal_id, artifact)
        for legal_id in queried_outputs
    }

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
                "outputs": [query_refs[o] for o in queried_outputs],
            }
        ],
    }

    try:
        proc = _run_with_missing_input_retries(
            binary,
            artifact,
            request_payload,
            entity_id="household:1",
            interval_start=interval_start,
            interval_end=interval_end,
            program_yaml=program_yaml,
            dynamic_defaults=dynamic_defaults,
        )
    except RuntimeError as err:
        if "unknown derived output" not in str(err):
            raise
        alternate_refs = {
            legal_id: _alternate_query_reference(legal_id, query_refs[legal_id])
            for legal_id in queried_outputs
        }
        if alternate_refs == query_refs:
            raise
        request_payload["queries"][0]["outputs"] = [
            alternate_refs[o] for o in queried_outputs
        ]
        query_refs = alternate_refs
        proc = _run_with_missing_input_retries(
            binary,
            artifact,
            request_payload,
            entity_id="household:1",
            interval_start=interval_start,
            interval_end=interval_end,
            program_yaml=program_yaml,
            dynamic_defaults=dynamic_defaults,
        )

    response = json.loads(proc.stdout)
    if not response.get("results"):
        return {"outputs": [], "traces": {}, "warnings": ["no results returned"]}

    result = response["results"][0]
    queried_by_name = {
        ref: legal_id
        for legal_id, ref in query_refs.items()
    } | {
        _query_name(legal_id): legal_id
        for legal_id in queried_outputs
    }
    outputs = [
        _normalize_output_response(_output_to_response(o), queried_by_name)
        for o in result.get("outputs", {}).values()
    ]
    user_keys = _collect_user_keys(user_inputs, relations)
    rule_rule_deps, rule_input_deps, rule_formulas, rule_id_by_name = _rule_metadata_for(program_yaml)
    raw_trace = _normalize_trace_keys(
        result.get("trace", {}),
        rule_id_by_name | queried_by_name,
    )
    traces = _build_trace_tree(
        queried_outputs,
        raw_trace,
        flat,
        user_keys,
        rule_rule_deps,
        rule_input_deps,
        rule_formulas,
        _fixture_outputs_for_trace(program_yaml, dynamic_defaults),
    )
    coverage = _coverage(flat, user_keys)
    return {"outputs": outputs, "traces": traces, "coverage": coverage}


def _query_name(legal_id: str) -> str:
    return legal_id.split("#")[-1]


def _query_reference(legal_id: str, artifact: Path) -> str:
    """Use the reference form this compiled artifact can resolve.

    Recent repo-backed artifacts expose public RuleSpec IDs and reject bare
    names. Older/local artifacts for composition files may still have derived
    records without ids, so those must be queried by bare rule name.
    """
    if _artifact_has_derived_id(artifact, legal_id):
        return legal_id
    return _query_name(legal_id)


def _alternate_query_reference(legal_id: str, current: str) -> str:
    if current == legal_id:
        return _query_name(legal_id)
    if "#" in legal_id:
        return legal_id
    return current


_artifact_derived_id_cache: dict[Path, set[str]] = {}


def _artifact_has_derived_id(artifact: Path, legal_id: str) -> bool:
    if artifact not in _artifact_derived_id_cache:
        try:
            raw = json.loads(artifact.read_text())
            program = raw.get("program", raw)
            derived = program.get("derived", [])
            ids = {
                rule.get("id")
                for rule in derived
                if isinstance(rule, dict) and rule.get("id")
            }
        except Exception:
            ids = set()
        _artifact_derived_id_cache[artifact] = ids
    return legal_id in _artifact_derived_id_cache[artifact]


def _normalize_output_response(
    output: dict[str, Any],
    queried_by_name: dict[str, str],
) -> dict[str, Any]:
    legal_id = output.get("legalId")
    if isinstance(legal_id, str) and legal_id in queried_by_name:
        return {**output, "legalId": queried_by_name[legal_id]}
    return output


def _normalize_trace_keys(
    raw_trace: dict[str, dict[str, Any]],
    rule_id_by_name: dict[str, str],
) -> dict[str, dict[str, Any]]:
    normalized: dict[str, dict[str, Any]] = {}
    for key, node in raw_trace.items():
        full_key = rule_id_by_name.get(key, key)
        deps = [
            rule_id_by_name.get(dep, dep)
            for dep in (node.get("dependencies") or [])
        ]
        normalized[full_key] = {**node, "dependencies": deps}
    return normalized


_graph_cache: dict[
    Path,
    tuple[dict[str, list[str]], dict[str, list[str]], dict[str, str], dict[str, str]],
] = {}


def _rule_metadata_for(
    program_yaml: Path,
) -> tuple[dict[str, list[str]], dict[str, list[str]], dict[str, str], dict[str, str]]:
    """Cached rule dependency and formula maps for a program.

    Maps key off rule legal ID. `formula` is the latest version's raw
    condition text from the YAML, used by the UI to explain why a rule holds
    or fails. Empty maps on graph-build failure.
    """
    if program_yaml in _graph_cache:
        return _graph_cache[program_yaml]
    try:
        graph = build_graph(program_yaml, _infer_repo(program_yaml))
    except Exception:
        _graph_cache[program_yaml] = ({}, {}, {}, {})
        return ({}, {}, {}, {})
    rule_deps: dict[str, list[str]] = {}
    input_deps: dict[str, list[str]] = {}
    formulas: dict[str, str] = {}
    rule_id_by_name: dict[str, str] = {}
    for rule in graph.rules.values():
        rule_deps[rule.legal_id] = list(rule.rule_deps)
        input_deps[rule.legal_id] = list(rule.input_deps) + list(rule.relation_deps)
        rule_id_by_name.setdefault(rule.name, rule.legal_id)
        if rule.formula:
            formulas[rule.legal_id] = rule.formula
    _graph_cache[program_yaml] = (rule_deps, input_deps, formulas, rule_id_by_name)
    return (rule_deps, input_deps, formulas, rule_id_by_name)


def _infer_repo(program_yaml: Path) -> str:
    """Walk up from the program YAML until a `rulespec-*` directory is hit."""
    current = program_yaml.resolve()
    for parent in current.parents:
        if parent.name.startswith("rules-"):
            return parent.name
    return ""


_input_fixture_id_cache: dict[Path, dict[str, list[str]]] = {}


def _fixture_input_candidates(program_yaml: Path, input_name: str) -> list[str]:
    """Find legal IDs for imported inputs that graph parsing did not index."""
    root = _rules_workspace_root(program_yaml)
    if root not in _input_fixture_id_cache:
        pattern = re.compile(
            r"([A-Za-z0-9_-]+:[^\s:#]+(?:/[^\s:#]+)*#input\.[A-Za-z0-9_]+)\s*:"
        )
        by_name: dict[str, list[str]] = {}
        for repo in root.iterdir() if root.exists() else []:
            if not repo.is_dir() or not repo.name.startswith(("rules-", "rulespec-")):
                continue
            for test_file in repo.rglob("*.test.yaml"):
                try:
                    text = test_file.read_text()
                except OSError:
                    continue
                for legal_id in pattern.findall(text):
                    name = legal_id.split("#input.", 1)[-1]
                    by_name.setdefault(name, [])
                    if legal_id not in by_name[name]:
                        by_name[name].append(legal_id)
        _input_fixture_id_cache[root] = by_name
    return _input_fixture_id_cache[root].get(input_name, [])


def _unique_candidates(candidates: list[str], exclude: set[str] | None = None) -> list[str]:
    excluded = exclude or set()
    seen: set[str] = set()
    unique: list[str] = []
    for candidate in candidates:
        if candidate in excluded or candidate in seen:
            continue
        seen.add(candidate)
        unique.append(candidate)
    return unique


def _rules_workspace_root(program_yaml: Path) -> Path:
    for parent in program_yaml.resolve().parents:
        if parent.name.startswith(("rules-", "rulespec-")):
            return parent.parent
    return program_yaml.resolve().parent


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
    boolean_starts = (
        "is_", "has_", "was_", "were_", "does_", "do_", "will_", "should_",
        "can_", "must_", "member_is_", "member_has_", "household_is_",
        "household_has_", "household_pays_", "household_received_",
        "household_contains_", "resource_is_",
    )
    boolean_endings = (
        "_eligible", "_active", "_received", "_paid", "_applies",
        "_required", "_present", "_member", "_holds", "_passed",
        "_satisfied", "_met", "_complies", "_complying", "_provided",
        "_disqualified", "_disqualification", "_pending", "_excluded",
        "_exempt", "_owned", "_purchased", "_terminated", "_known",
        "_anticipated", "_assigned", "_referred", "_offered", "_allowed",
        "_verified", "_confirmed", "_separately",
    )
    boolean_contains = (
        "_entitled_to_", "_eligible_for_", "_subject_to_",
        "_responsible_for_", "_required_to_", "_exempt_from_",
        "_is_", "_has_",
    )
    if (
        fragment.startswith(boolean_starts)
        or any(fragment.endswith(s) for s in boolean_endings)
        or any(s in fragment for s in boolean_contains)
        or "_holds" in fragment
    ):
        return {"kind": "bool", "value": False}
    if "date" in fragment:
        return {"kind": "date", "value": "2026-01-01"}
    return {"kind": "decimal", "value": "0"}


_fixture_input_default_cache: dict[Path, dict[str, dict[str, Any]]] = {}
_workspace_fixture_input_default_cache: dict[Path, dict[str, dict[str, Any]]] = {}


def _fixture_input_defaults(program_yaml: Path) -> dict[str, dict[str, Any]]:
    """Neutral defaults keyed by legal ID and bare name, using fixtures for dtype only."""
    if program_yaml in _fixture_input_default_cache:
        return _fixture_input_default_cache[program_yaml]

    template = first_test_case(t) if (t := find_test_template(program_yaml)) else None
    defaults: dict[str, dict[str, Any]] = {}
    if template:
        for legal_id, raw in _iter_fixture_inputs(template.get("input", {})):
            default = _neutral_default_for_fixture_input(legal_id, raw)
            fragment = legal_id.split("#")[-1]
            defaults.setdefault(legal_id, default)
            defaults.setdefault(fragment, default)
            defaults.setdefault(fragment.removeprefix("input."), default)

    _fixture_input_default_cache[program_yaml] = defaults
    return defaults


def _workspace_fixture_input_defaults(program_yaml: Path) -> dict[str, dict[str, Any]]:
    """Neutral input defaults inferred from every local rule-pack test fixture."""
    root = _rules_workspace_root(program_yaml)
    if root in _workspace_fixture_input_default_cache:
        return _workspace_fixture_input_default_cache[root]

    defaults: dict[str, dict[str, Any]] = {}
    for repo in root.iterdir() if root.exists() else []:
        if not repo.is_dir() or not repo.name.startswith(("rules-", "rulespec-")):
            continue
        for test_file in repo.rglob("*.test.yaml"):
            try:
                raw = yaml.safe_load(test_file.read_text())
            except (OSError, yaml.YAMLError):
                continue
            for case in _fixture_cases(raw):
                for legal_id, value in _iter_fixture_inputs(case.get("input", {})):
                    default = _neutral_default_for_fixture_input(legal_id, value)
                    fragment = legal_id.split("#")[-1]
                    defaults.setdefault(legal_id, default)
                    defaults.setdefault(fragment, default)
                    defaults.setdefault(fragment.removeprefix("input."), default)

    _workspace_fixture_input_default_cache[root] = defaults
    return defaults


def _fixture_cases(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        return [case for case in raw if isinstance(case, dict)]
    if isinstance(raw, dict) and isinstance(raw.get("cases"), list):
        return [case for case in raw["cases"] if isinstance(case, dict)]
    if isinstance(raw, dict):
        return [raw]
    return []


def _iter_fixture_inputs(raw_inputs: Any) -> list[tuple[str, Any]]:
    items: list[tuple[str, Any]] = []
    if not isinstance(raw_inputs, dict):
        return items
    for legal_id, raw in raw_inputs.items():
        if is_relation_id(legal_id):
            if isinstance(raw, list):
                for member in raw:
                    items.extend(_iter_fixture_inputs(member))
            continue
        items.append((legal_id, raw))
    return items


def _neutral_default_for_fixture_input(legal_id: str, raw: Any) -> dict[str, Any]:
    fragment = legal_id.split("#")[-1].removeprefix("input.")
    if fragment in {"member_is_us_citizen"}:
        return {"kind": "bool", "value": True}
    if fragment in {
        "self_employment_income_period_months",
        "real_property_assessment_percentage_rate",
    }:
        return {"kind": "integer", "value": 1}
    if isinstance(raw, bool):
        return {"kind": "bool", "value": False}
    if isinstance(raw, int):
        return {"kind": "integer", "value": 0}
    if isinstance(raw, float):
        return {"kind": "decimal", "value": "0"}
    if isinstance(raw, str) and len(raw) == 10 and raw[4] == "-" and raw[7] == "-":
        return {"kind": "date", "value": raw}
    if isinstance(raw, str):
        return {"kind": "text", "value": ""}
    return _infer_default_value(legal_id)


_fixture_output_default_cache: dict[Path, dict[str, Any]] = {}


def _fixture_output_defaults(program_yaml: Path) -> dict[str, Any]:
    """Map fixture output legal IDs and bare rule names to scalar defaults.

    Newer axiom-rules builds can report some upstream rule outputs as missing
    dataset inputs by bare name. The SNAP test fixture already contains the
    coherent baseline values for those upstream outputs, so prefer those values
    over heuristic zero/false defaults when the engine asks for them.
    """
    if program_yaml in _fixture_output_default_cache:
        return _fixture_output_default_cache[program_yaml]

    template = first_test_case(t) if (t := find_test_template(program_yaml)) else None
    defaults: dict[str, Any] = {}
    if template:
        for legal_id, raw in iter_outputs_in_template(template):
            if _is_engine_scalar_default(raw):
                defaults[legal_id] = raw
                fragment = legal_id.split("#")[-1]
                defaults.setdefault(fragment, raw)
                defaults.setdefault(fragment.removeprefix("input."), raw)

    _fixture_output_default_cache[program_yaml] = defaults
    return defaults


def _fixture_output_defaults_by_legal_id(program_yaml: Path) -> dict[str, Any]:
    return {
        key: value
        for key, value in _fixture_output_defaults(program_yaml).items()
        if "#" in key and "#input." not in key
    }


def _is_engine_scalar_default(raw: Any) -> bool:
    if isinstance(raw, bool | int | float):
        return True
    if isinstance(raw, str):
        if raw in {"holds", "not_holds", "undetermined"}:
            return False
        return len(raw) == 10 and raw[4] == "-" and raw[7] == "-"
    return False


def _default_value_for_missing_input(
    program_yaml: Path,
    full_id: str,
    reported_id: str,
    dynamic_defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    for key in (
        full_id,
        reported_id,
        full_id.split("#")[-1],
        full_id.split("#")[-1].removeprefix("input."),
        reported_id.removeprefix("input."),
    ):
        if dynamic_defaults and key in dynamic_defaults:
            return _coerce_value(dynamic_defaults[key])
        if key in _fixture_input_defaults(program_yaml):
            return _fixture_input_defaults(program_yaml)[key]
        if key in _workspace_fixture_input_defaults(program_yaml):
            return _workspace_fixture_input_defaults(program_yaml)[key]
    return _infer_default_value(full_id)


def _run_with_missing_input_retries(
    binary: str,
    artifact: Path,
    request_payload: dict[str, Any],
    *,
    entity_id: str,
    interval_start: str,
    interval_end: str,
    program_yaml: Path,
    dynamic_defaults: dict[str, Any] | None = None,
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
    dropped_rejected_absolute_inputs: set[str] = set()
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

            # Some engine builds report an already-qualified fixture record as
            # needing an absolute RuleSpec reference. In that case the record
            # itself is what the engine rejects. Drop it once and retry; if the
            # rule actually needs the value, the next run will produce a normal
            # missing-input error and the branch below will fill a default.
            if "#input." in bare_name and bare_name not in dropped_rejected_absolute_inputs:
                dropped_rejected_absolute_inputs.add(bare_name)
                continue

            if bare_name not in pending_candidates:
                try:
                    lookup_name = bare_name.split("#input.", 1)[-1]
                    pending_candidates[bare_name] = _unique_candidates(
                        [
                            *resolve_input_legal_id(_graph(), lookup_name),
                            *_fixture_input_candidates(program_yaml, lookup_name),
                        ],
                        exclude={bare_name},
                    )
                except Exception:
                    pending_candidates[bare_name] = []

            candidates = pending_candidates[bare_name]
            if not candidates:
                raise RuntimeError(
                    f"axiom-rules-engine: cannot resolve legal ID for bare input `{bare_name}`. "
                    f"No rule in the program graph references it. Stderr: {stderr.strip()}"
                )
            chosen = candidates.pop(0)
            value = _default_value_for_missing_input(
                program_yaml,
                chosen,
                bare_name,
                dynamic_defaults,
            )
            request_payload["dataset"]["inputs"].append({
                "name": chosen,
                "entity": "Household",
                "entity_id": entity_id,
                "interval": {"start": interval_start, "end": interval_end},
                "value": value,
            })
            continue

        if miss_match:
            reported_id = miss_match.group(1)
            miss_entity_id = miss_match.group(2) or ""
            entity_class = (
                "person" if miss_entity_id.startswith("person:") else "household"
            )

            if "#" in reported_id:
                full_candidates = [reported_id]
            else:
                if reported_id not in pending_candidates:
                    try:
                        resolved = _unique_candidates([
                            *resolve_input_legal_id(_graph(), reported_id),
                            *_fixture_input_candidates(program_yaml, reported_id),
                        ])
                        pending_candidates[reported_id] = resolved or [reported_id]
                    except Exception:
                        pending_candidates[reported_id] = [reported_id]
                full_candidates = pending_candidates[reported_id]

            # Pick the first candidate we haven't already tried for this
            # entity scope. If they're all exhausted, bail with a clear
            # diagnostic.
            full_id: str | None = None
            for candidate in full_candidates:
                if (candidate, entity_class) not in rejected_legal_ids:
                    full_id = candidate
                    break
            if full_id is None:
                raise RuntimeError(
                    f"axiom-rules-engine: exhausted candidates for missing input `{reported_id}` "
                    f"(scope {entity_class}). Last stderr: {stderr.strip()}"
                )

            rejected_legal_ids.add((full_id, entity_class))
            value = _default_value_for_missing_input(
                program_yaml,
                full_id,
                reported_id,
                dynamic_defaults,
            )

            if entity_class == "person":
                # Engine reports one person at a time — fill the default
                # for every person already in the dataset (from input
                # records + relation tuples) so we don't burn retries
                # one member at a time.
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
                # Drop any prior bare-named records for this input so
                # the engine doesn't see two entries (bare + full).
                if reported_id != full_id:
                    request_payload["dataset"]["inputs"] = [
                        rec
                        for rec in request_payload["dataset"]["inputs"]
                        if rec["name"] != reported_id
                    ]
                for pid in sorted(person_ids):
                    request_payload["dataset"]["inputs"].append({
                        "name": full_id,
                        "entity": "Person",
                        "entity_id": pid,
                        "interval": {"start": interval_start, "end": interval_end},
                        "value": value,
                    })
            else:
                if reported_id != full_id:
                    request_payload["dataset"]["inputs"] = [
                        rec
                        for rec in request_payload["dataset"]["inputs"]
                        if rec["name"] != reported_id
                    ]
                request_payload["dataset"]["inputs"].append({
                    "name": full_id,
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
    program_key = str(program_yaml.resolve())
    program_hash = hashlib.sha256(program_key.encode("utf-8")).hexdigest()[:12]
    artifact = artifact_dir / f"{program_yaml.stem}-{program_hash}.compiled.json"
    rules_root = Path(os.environ.get("AXIOM_RULESPEC_ROOT", program_yaml.parents[1]))
    env = dict(os.environ)
    env.setdefault("AXIOM_RULESPEC_REPO_ROOTS", str(rules_root))
    proc = subprocess.run(
        [binary, "compile", "--program", str(program_yaml), "--output", str(artifact)],
        cwd=rules_root,
        env=env,
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
    user_inputs, relations = _filter_user_supplied_values(
        program_yaml,
        user_inputs or {},
        relations,
    )
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

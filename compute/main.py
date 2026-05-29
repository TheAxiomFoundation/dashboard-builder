"""FastAPI service for dashboard-builder.

Endpoints:
    GET  /healthz                         service + engine mode
    GET  /repos                           known rule-pack repos
    GET  /repos/{repo}/programs           RuleSpec YAML programs in a repo
    GET  /repos/{repo}/programs/{path...} program metadata: rules, inputs, sample dataset
    POST /compute                         run the engine against a DashboardSpec + user inputs
"""

from __future__ import annotations

import os
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Auto-load `.env` so `uvicorn main:app` picks up AXIOM_RULES_ENGINE_BIN and friends
# without needing the operator to remember to export them.
try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

from engine import ComputeMode, detect_mode, execute_demo, execute_real
from graph import build_graph, graph_to_dict, transitive_dependencies
from registry import (
    RegistryConfig,
    list_known_repos,
    list_programs,
    resolve_program,
)
from spec_loader import (
    collect_required_input_keys,
    find_test_template,
    first_test_case,
    is_input_id,
    is_relation_id,
    iter_test_cases,
)

app = FastAPI(title="dashboard-builder compute", version="0.0.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("ALLOW_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

_config = RegistryConfig.from_env()
_mode: ComputeMode = detect_mode()
_sensitivity_cache: dict[str, SensitivityResponseBody] = {}
# Multi-scenario sensitivity submits (scenario × input) perturbations
# to a single pool, so the worker count needs to absorb several scenarios
# at once. The bottleneck is the engine subprocess, not the wrapper.
_SENSITIVITY_MAX_WORKERS = 16


class HealthResponse(BaseModel):
    status: str
    mode: str
    detail: str
    rules_root: str


@app.get("/healthz", response_model=HealthResponse)
def healthz() -> HealthResponse:
    return HealthResponse(
        status="ok",
        mode=_mode.name,
        detail=_mode.detail,
        rules_root=str(_config.root),
    )


@app.get("/repos")
def repos() -> dict[str, Any]:
    return {"repos": list_known_repos(_config)}


@app.get("/repos/{repo}/programs")
def programs(repo: str) -> dict[str, Any]:
    try:
        return {"programs": list_programs(_config, repo)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"failed to list programs: {exc}") from exc


@app.get("/repos/{repo}/programs/{path:path}/graph")
def program_graph(repo: str, path: str) -> dict[str, Any]:
    """Full rule dependency graph for a program. Used by the builder to drive output-first selection."""
    try:
        program_path = resolve_program(_config, repo, path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        graph = build_graph(program_path, repo)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"failed to build graph: {exc}") from exc
    return graph_to_dict(graph)


class TransitiveBody(BaseModel):
    outputs: list[str]


@app.post("/repos/{repo}/programs/{path:path}/transitive")
def program_transitive(repo: str, path: str, body: TransitiveBody) -> dict[str, Any]:
    """Given queried outputs, return the transitive input/relation deps with depth."""
    try:
        program_path = resolve_program(_config, repo, path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    graph = build_graph(program_path, repo)
    return transitive_dependencies(graph, body.outputs)


@app.get("/repos/{repo}/programs/{path:path}")
def program(repo: str, path: str) -> dict[str, Any]:
    """Inspect a program: list of rule outputs, inferred inputs, and a sample row from .test.yaml."""
    try:
        program_path = resolve_program(_config, repo, path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    parsed = yaml.safe_load(program_path.read_text())
    rules = parsed.get("rules", []) if isinstance(parsed, dict) else []
    summary = ""
    if isinstance(parsed.get("module"), dict):
        summary = parsed["module"].get("summary", "")

    test = find_test_template(program_path)
    template = first_test_case(test) if test else None
    inferred_input_keys = sorted(collect_required_input_keys(template) if template else [])

    output_rules = [
        {
            "name": r.get("name"),
            "kind": r.get("kind"),
            "entity": r.get("entity"),
            "dtype": r.get("dtype"),
            "period": r.get("period"),
            "unit": r.get("unit"),
            "source": r.get("source"),
        }
        for r in rules
        if isinstance(r, dict) and r.get("name")
    ]

    inputs_summary = []
    relations_summary = []
    for key in inferred_input_keys:
        if is_relation_id(key):
            relations_summary.append({"legalId": key})
        elif is_input_id(key):
            sample = template.get("input", {}).get(key) if template else None
            inputs_summary.append({"legalId": key, "sample": sample})

    return {
        "repo": repo,
        "path": path,
        "summary": summary,
        "outputs": output_rules,
        "inputs": inputs_summary,
        "relations": relations_summary,
        "samplePeriod": template.get("period") if template else None,
    }


class ComputeRequestBody(BaseModel):
    program: dict[str, Any] = Field(..., description="ProgramRef from DashboardSpec")
    period: dict[str, Any] = Field(..., description="PeriodRef")
    inputs: dict[str, Any] = Field(default_factory=dict)
    relations: dict[str, list[dict[str, Any]]] | None = None
    queried_outputs: list[str]


class ComputeResponseBody(BaseModel):
    outputs: list[dict[str, Any]]
    traces: dict[str, dict[str, Any]]
    coverage: dict[str, Any] | None = None
    warnings: list[str] = Field(default_factory=list)
    mode: str




@app.post("/compute", response_model=ComputeResponseBody)
def compute(body: ComputeRequestBody) -> ComputeResponseBody:
    repo = body.program.get("repo")
    path = body.program.get("path")
    if not repo or not path:
        raise HTTPException(status_code=400, detail="program.repo and program.path are required")
    try:
        program_path = resolve_program(_config, repo, path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    period_start = body.period.get("start", "2026-01-01")
    period = period_start[:7]  # `YYYY-MM`

    if _mode.name == "real":
        try:
            payload = execute_real(
                program_yaml=program_path,
                rules_root=_config.root,
                user_inputs=body.inputs,
                relations=body.relations,
                queried_outputs=body.queried_outputs,
                period=period,
            )
        except Exception as exc:
            # Don't 500 — degrade gracefully. The dashboard renderer can show
            # a warning while the user keeps editing. The full message ends
            # up in `warnings` so we can debug from the UI.
            return ComputeResponseBody(
                outputs=[],
                traces={},
                coverage=None,
                warnings=[f"engine error: {exc}"],
                mode=_mode.name,
            )
    else:
        payload = execute_demo(
            program_yaml=program_path,
            queried_outputs=body.queried_outputs,
            user_inputs=body.inputs,
            relations=body.relations,
        )

    return ComputeResponseBody(
        outputs=payload.get("outputs", []),
        traces=payload.get("traces", {}),
        coverage=payload.get("coverage"),
        warnings=payload.get("warnings", []),
        mode=_mode.name,
    )


# ─────────────────────────────────────────────────────────────────────────
# Sensitivity analysis — which inputs actually move the picked outputs?
# ─────────────────────────────────────────────────────────────────────────

class SensitivityRequestBody(BaseModel):
    program: dict[str, Any] = Field(..., description="ProgramRef from DashboardSpec")
    period: dict[str, Any] | None = None
    queried_outputs: list[str]
    # Optional baseline state — frontend can pass the user's currently-
    # exposed inputs/relations so we test perturbations on top of that.
    # If empty, the baseline is "engine defaults" (test fixture + retry
    # heuristics).
    inputs: dict[str, Any] = Field(default_factory=dict)
    relations: dict[str, list[dict[str, Any]]] | None = None


class SensitivityResponseBody(BaseModel):
    baseline: list[dict[str, Any]]
    # output_legal_id → list of input_legal_ids that move that output.
    load_bearing: dict[str, list[str]]
    # input_legal_id → perturbation evidence for each output it moved.
    effects: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    # Inputs we tested but found no effect on any picked output.
    no_effect: list[str]
    # Inputs we couldn't perturb (date / string / unknown shape) or
    # that crashed the engine on perturbation.
    skipped: list[str]
    # Names of scenarios whose baseline ran cleanly. A scenario is the
    # synthetic household we perturb against. Multi-scenario analysis
    # unions the load-bearing sets so an input counts as load-bearing
    # if it moves any picked output for any household.
    scenarios_tested: list[str] = Field(default_factory=list)
    scenarios_skipped: list[str] = Field(default_factory=list)
    mode: str


_BOOLEAN_STARTS = (
    "is_", "has_", "was_", "were_", "does_", "do_", "will_", "should_",
    "can_", "must_",
)
_BOOLEAN_ENDINGS = (
    "_eligible", "_active", "_received", "_paid", "_applies",
    "_required", "_present", "_member", "_holds", "_passed",
    "_satisfied", "_met", "_complies", "_complying", "_provided",
    "_disqualified", "_disqualification", "_pending", "_excluded",
    "_exempt", "_owned", "_purchased", "_terminated", "_known",
    "_anticipated", "_assigned", "_referred", "_offered", "_allowed",
    "_verified", "_confirmed", "_separately",
)


def _looks_boolean(name: str, sample: Any) -> bool:
    if isinstance(sample, bool):
        return True
    n = name.lower()
    return n.startswith(_BOOLEAN_STARTS) or any(
        n.endswith(s) for s in _BOOLEAN_ENDINGS
    )


def _pick_perturbation(name: str, sample: Any) -> Any | None:
    """Pick a value far enough from `sample` (or from the inferred
    default if sample is None) to cross any threshold the rules might
    care about. Returns None to skip — dates, strings, and inputs
    whose shape we can't determine."""
    if _looks_boolean(name, sample):
        return False if sample is True else True
    if isinstance(sample, bool):
        return not sample
    if isinstance(sample, (int, float)):
        # Push the value away from the default by a wide margin so we
        # cross income limits, age cutoffs, etc. without picking a value
        # so wild that the engine balks.
        magnitude = max(5000.0, abs(float(sample)) * 4 + 100)
        return float(sample) + magnitude
    if sample is None:
        # No fixture sample — assume numeric and pick something
        # non-trivial. Engine retry will infer dtype.
        return 5000
    # Date or string — skip.
    return None


@dataclass
class Scenario:
    """One representative household to perturb against. Built from a
    program's `.test.yaml` fixture — each test case is a fully-specified,
    program-author-curated input set that's guaranteed runnable (it's a
    test). Using fixtures means we never have to guess input names; the
    program's own naming convention is followed automatically.
    """
    name: str
    inputs: dict[str, Any]
    relations: dict[str, list[dict[str, Any]]]


# Cap the number of fixture cases used as scenarios. Each case is N
# engine calls (one per closure input), so cost is linear in cases.
# Three covers most real fixtures' diversity without burning minutes.
_MAX_FIXTURE_SCENARIOS = 3


def _file_path_for_legal_id(file_legal_id: str) -> Path | None:
    """Map `us:regulations/7-cfr/273/10` → `<rules_root>/rules-us/regulations/7-cfr/273/10.yaml`.

    The repo prefix convention is `<prefix>:` → `rules-<prefix>`. If the
    target file doesn't exist on disk we return None and the caller
    falls back to the next candidate fixture source.
    """
    head, sep, rest = file_legal_id.partition(":")
    if not sep or not rest:
        return None
    repo = f"rules-{head}"
    try:
        return resolve_program(_config, repo, f"{rest}.yaml")
    except FileNotFoundError:
        return None


def _load_cases_from_fixture(yaml_path: Path) -> list[Scenario]:
    """Parse every test case from the sibling .test.yaml into Scenarios."""
    template = find_test_template(yaml_path)
    if not template:
        return []
    scenarios: list[Scenario] = []
    for index, case in enumerate(iter_test_cases(template)):
        flat = case.get("input") or {}
        if not isinstance(flat, dict):
            continue
        case_inputs: dict[str, Any] = {}
        case_relations: dict[str, list[dict[str, Any]]] = {}
        for legal_id, value in flat.items():
            if is_relation_id(legal_id):
                members = value if isinstance(value, list) else []
                case_relations[legal_id] = [
                    dict(m) for m in members if isinstance(m, dict)
                ]
            else:
                case_inputs[legal_id] = value
        name = case.get("name") or f"case_{index}"
        scenarios.append(
            Scenario(name=name, inputs=case_inputs, relations=case_relations)
        )
    return scenarios


def _stack_scenarios(base: Scenario | None, overlay: Scenario) -> Scenario:
    """Layer `overlay` on top of `base` and return a merged Scenario.
    Overlay wins on conflicts. If `base` is None, returns a copy of
    `overlay`.

    This composes a program-baseline fixture case (which knows about
    composing-program-specific input slots, e.g. CO's household_size)
    with a source-file fixture case (which knows about the queried
    rule's natural inputs, e.g. federal aggregate shelter expenses).
    """
    if base is None:
        return Scenario(
            name=overlay.name,
            inputs=dict(overlay.inputs),
            relations={
                k: [dict(m) for m in v] for k, v in overlay.relations.items()
            },
        )
    inputs = dict(base.inputs)
    inputs.update(overlay.inputs)
    relations: dict[str, list[dict[str, Any]]] = {
        k: [dict(m) for m in v] for k, v in base.relations.items()
    }
    for rel_id, members in overlay.relations.items():
        relations[rel_id] = [dict(m) for m in members]
    return Scenario(name=overlay.name, inputs=inputs, relations=relations)


def _load_fixture_scenarios(
    program_path: Path,
    queried_outputs: list[str],
) -> list[Scenario]:
    """Pull representative households to perturb against.

    Strategy: layer two fixtures.
      1. **Program fixture** (e.g. CO SNAP) — provides values for the
         composing program's specific input slots (CO-namespaced
         household_size, residency flags, etc.). Used as the baseline
         foundation so the engine has a runnable household shape.
      2. **Source-file fixture** (the file defining a queried output)
         — overlays the aggregate inputs that the queried rule reads
         directly (e.g. federal `snap_total_allowable_shelter_expenses`
         when querying a federal output from CO SNAP). Without this
         layer, those aggregates default to 0 and most perturbations
         can't move the result.

    Falling back to either fixture alone is supported when one is
    missing. We dedupe scenarios by name and cap the total to keep
    sensitivity latency bounded.
    """
    program_cases = _load_cases_from_fixture(program_path)
    program_base = program_cases[0] if program_cases else None

    # Collect cases from each unique queried-output source file.
    overlay_cases: list[Scenario] = []
    seen_files: set[Path] = {program_path}
    seen_names: set[str] = set()

    for oid in queried_outputs:
        file_legal_id = oid.split("#", 1)[0]
        source_yaml = _file_path_for_legal_id(file_legal_id)
        if not source_yaml or source_yaml in seen_files:
            continue
        seen_files.add(source_yaml)
        for case in _load_cases_from_fixture(source_yaml):
            if case.name in seen_names:
                continue
            seen_names.add(case.name)
            overlay_cases.append(case)

    # When the queried outputs all live in the program's own file
    # (or no source file resolved), the program's cases ARE the
    # scenarios — no overlay needed.
    if not overlay_cases:
        return program_cases[:_MAX_FIXTURE_SCENARIOS]

    # Otherwise stack each overlay case on the program baseline.
    scenarios = [
        _stack_scenarios(program_base, overlay) for overlay in overlay_cases
    ]
    return scenarios[:_MAX_FIXTURE_SCENARIOS]


def _merge_scenario_payload(
    scenario: Scenario,
    base_inputs: dict[str, Any],
    base_relations: dict[str, list[dict[str, Any]]] | None,
) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    """Layer the caller's inputs/relations on top of the fixture case.
    Caller wins on conflicts — they're explicitly specifying values they
    want the perturbation to be measured against.
    """
    inputs = dict(scenario.inputs)
    inputs.update(base_inputs)

    relations: dict[str, list[dict[str, Any]]] = {
        k: [dict(m) for m in v] for k, v in scenario.relations.items()
    }
    if base_relations:
        for rel_id, members in base_relations.items():
            relations[rel_id] = [dict(m) for m in members]
    return inputs, relations


_SENSITIVITY_CACHE_VERSION = 4  # bump when scenarios or perturbation logic changes


def _sensitivity_cache_key(body: SensitivityRequestBody, period: str) -> str:
    return json.dumps(
        {
            "v": _SENSITIVITY_CACHE_VERSION,
            "program": body.program,
            "period": period,
            "queried_outputs": sorted(body.queried_outputs),
            "inputs": body.inputs,
            "relations": body.relations,
            "mode": _mode.name,
        },
        sort_keys=True,
        default=str,
    )


@app.post("/sensitivity", response_model=SensitivityResponseBody)
def sensitivity(body: SensitivityRequestBody) -> SensitivityResponseBody:
    repo = body.program.get("repo")
    path = body.program.get("path")
    if not repo or not path:
        raise HTTPException(
            status_code=400,
            detail="program.repo and program.path are required",
        )
    try:
        program_path = resolve_program(_config, repo, path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    period_obj = body.period or {}
    period_start = period_obj.get("start", "2026-01-01")
    period = period_start[:7]
    cache_key = _sensitivity_cache_key(body, period)
    if cached := _sensitivity_cache.get(cache_key):
        return cached.model_copy(deep=True)

    # Build graph and find the transitive closure of inputs from the
    # picked outputs — no point perturbing inputs no rule reaches.
    graph = build_graph(program_path, repo)
    closure = transitive_dependencies(graph, body.queried_outputs)
    closure_input_ids = list(closure["inputs"].keys())
    inputs_by_id = {i.legal_id: i for i in graph.inputs.values()}

    def _outputs_map(payload: dict[str, Any]) -> dict[str, Any]:
        return {o["legalId"]: o.get("value") for o in payload.get("outputs", [])}

    if _mode.name != "real":
        # Demo mode short-circuits — every input looks load-bearing
        # because the demo always returns fixture values regardless.
        # Be honest: nothing tested.
        return SensitivityResponseBody(
            baseline=[],
            load_bearing={oid: [] for oid in body.queried_outputs},
            effects={},
            no_effect=[],
            skipped=closure_input_ids,
            mode=_mode.name,
        )

    # ── Scenarios ───────────────────────────────────────────────────
    # Pull representative households from the program's own test
    # fixture instead of hand-tuning pattern-based seeds. Fixtures are
    # program-author curated, guaranteed runnable, and naturally use
    # the program's naming convention. Iterating across cases +
    # unioning load-bearing sets catches inputs that only move the
    # result for certain household shapes (elderly, homeless, etc.).
    fixture_scenarios = _load_fixture_scenarios(program_path, body.queried_outputs)
    if not fixture_scenarios:
        raise HTTPException(
            status_code=502,
            detail=(
                f"no test fixture for {path} or its queried outputs; cannot "
                "run sensitivity without a representative household to perturb against"
            ),
        )
    aggregate_load_bearing: dict[str, set[str]] = {
        oid: set() for oid in body.queried_outputs
    }
    aggregate_effects: dict[str, list[dict[str, Any]]] = {}
    tested_inputs: set[str] = set()
    perturbation_unsupported: set[str] = set()
    scenarios_tested: list[str] = []
    scenarios_skipped: list[dict[str, str]] = []
    first_successful_baseline: list[dict[str, Any]] | None = None

    def perturb_one(
        input_id: str,
        scenario_inputs: dict[str, Any],
        scenario_relations: dict[str, list[dict[str, Any]]],
        baseline_outputs: dict[str, Any],
    ) -> tuple[str, dict[str, Any]]:
        node = inputs_by_id.get(input_id)
        if not node:
            return ("skipped", {"input_id": input_id})

        perturbation = _pick_perturbation(node.name, node.sample)
        if perturbation is None:
            return ("unsupported", {"input_id": input_id})

        pert_inputs = dict(scenario_inputs)
        pert_relations: dict[str, list[dict[str, Any]]] = (
            {k: [dict(m) for m in v] for k, v in scenario_relations.items()}
        )
        if node.entity == "Person" and node.relation_legal_id:
            members = pert_relations.setdefault(node.relation_legal_id, [{}])
            if not members:
                members.append({})
            members[0][input_id] = perturbation
        else:
            pert_inputs[input_id] = perturbation

        try:
            pert_payload = execute_real(
                program_yaml=program_path,
                rules_root=_config.root,
                user_inputs=pert_inputs,
                relations=pert_relations or None,
                queried_outputs=body.queried_outputs,
                period=period,
            )
        except Exception:
            return ("skipped", {"input_id": input_id})
        if pert_payload.get("warnings"):
            return ("skipped", {"input_id": input_id})

        pert_outputs = _outputs_map(pert_payload)
        moved: list[dict[str, Any]] = []
        for oid in body.queried_outputs:
            if pert_outputs.get(oid) != baseline_outputs.get(oid):
                moved.append({
                    "output": oid,
                    "before": baseline_outputs.get(oid),
                    "after": pert_outputs.get(oid),
                    "perturbation": perturbation,
                })
        if not moved:
            return ("no_effect", {"input_id": input_id})
        return ("moved", {"input_id": input_id, "effects": moved})

    # Phase 1: layer caller inputs over each fixture case and run all
    # baselines in parallel. Scenarios that crash or surface warnings
    # are dropped — we keep going as long as at least one survives.
    prepared = [
        (scenario, *_merge_scenario_payload(scenario, body.inputs, body.relations))
        for scenario in fixture_scenarios
    ]

    def run_baseline(
        scenario: Scenario,
        s_inputs: dict[str, Any],
        s_relations: dict[str, list[dict[str, Any]]],
    ) -> tuple[Scenario, dict[str, Any] | None, str | None]:
        try:
            payload = execute_real(
                program_yaml=program_path,
                rules_root=_config.root,
                user_inputs=s_inputs,
                relations=s_relations or None,
                queried_outputs=body.queried_outputs,
                period=period,
            )
        except Exception as exc:
            return scenario, None, f"engine error: {exc}"
        if payload.get("warnings"):
            return scenario, None, payload["warnings"][0]
        return scenario, payload, None

    surviving_scenarios: list[tuple[Scenario, dict[str, Any], dict[str, list[dict[str, Any]]], dict[str, Any]]] = []
    with ThreadPoolExecutor(max_workers=_SENSITIVITY_MAX_WORKERS) as executor:
        futures = {
            executor.submit(run_baseline, scenario, s_inputs, s_relations): (scenario, s_inputs, s_relations)
            for scenario, s_inputs, s_relations in prepared
        }
        for future in as_completed(futures):
            scenario, s_inputs, s_relations = futures[future]
            _, payload, reason = future.result()
            if payload is None:
                scenarios_skipped.append({"name": scenario.name, "reason": reason or "unknown"})
                continue
            if first_successful_baseline is None:
                first_successful_baseline = payload.get("outputs", [])
            scenarios_tested.append(scenario.name)
            surviving_scenarios.append((scenario, s_inputs, s_relations, _outputs_map(payload)))

    # Phase 2: cross-product of (surviving scenario × closure input) in
    # a single executor pool. Maximizes engine utilization compared to
    # iterating scenarios one at a time.
    with ThreadPoolExecutor(max_workers=_SENSITIVITY_MAX_WORKERS) as executor:
        futures = []
        for scenario, s_inputs, s_relations, baseline_outputs in surviving_scenarios:
            for input_id in closure_input_ids:
                futures.append(
                    executor.submit(
                        perturb_one, input_id, s_inputs, s_relations, baseline_outputs,
                    )
                )
        for future in as_completed(futures):
            status, payload = future.result()
            input_id = payload["input_id"]
            if status == "unsupported":
                perturbation_unsupported.add(input_id)
                continue
            if status == "skipped":
                continue
            tested_inputs.add(input_id)
            if status == "moved":
                aggregate_effects.setdefault(input_id, []).extend(payload["effects"])
                for effect in payload["effects"]:
                    aggregate_load_bearing[effect["output"]].add(input_id)

    load_bearing_inputs = set().union(*aggregate_load_bearing.values()) if aggregate_load_bearing else set()
    no_effect = sorted(tested_inputs - load_bearing_inputs)
    # An input is skipped if no scenario produced a perturbation result
    # AND we couldn't even build a perturbation for it (date/string/
    # unknown shape). Anything else is "tested and no effect".
    skipped = sorted(perturbation_unsupported - tested_inputs)
    # Inputs that crashed in every scenario also land here.
    unreached = sorted(set(closure_input_ids) - tested_inputs - perturbation_unsupported)
    skipped.extend(unreached)

    if not scenarios_tested:
        # Every scenario failed its baseline — surface a clear error so
        # the UI can show a helpful message instead of an empty list.
        raise HTTPException(
            status_code=502,
            detail=(
                "no scenario baseline ran cleanly; sensitivity would be "
                f"based on fallback values. Scenarios skipped: "
                f"{[s['name'] for s in scenarios_skipped]}"
            ),
        )

    response = SensitivityResponseBody(
        baseline=first_successful_baseline or [],
        load_bearing={oid: sorted(ids) for oid, ids in aggregate_load_bearing.items()},
        effects=aggregate_effects,
        no_effect=no_effect,
        skipped=skipped,
        scenarios_tested=scenarios_tested,
        scenarios_skipped=[s["name"] for s in scenarios_skipped],
        mode=_mode.name,
    )
    _sensitivity_cache[cache_key] = response.model_copy(deep=True)
    return response

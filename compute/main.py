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
from pathlib import Path
from typing import Any

import yaml
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Auto-load `.env` so `uvicorn main:app` picks up AXIOM_RULES_BIN and friends
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
_SENSITIVITY_MAX_WORKERS = 8


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


def _sensitivity_cache_key(body: SensitivityRequestBody, period: str) -> str:
    return json.dumps(
        {
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

    # ── Baseline ────────────────────────────────────────────────────
    try:
        baseline_payload = execute_real(
            program_yaml=program_path,
            rules_root=_config.root,
            user_inputs=dict(body.inputs),
            relations=dict(body.relations) if body.relations else None,
            queried_outputs=body.queried_outputs,
            period=period,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"baseline compute failed: {exc}",
        ) from exc
    if baseline_payload.get("warnings"):
        raise HTTPException(
            status_code=502,
            detail="baseline compute returned warnings; sensitivity would be based on fallback values",
        )
    baseline_outputs = _outputs_map(baseline_payload)

    def test_input(input_id: str) -> tuple[str, dict[str, Any]]:
        node = inputs_by_id.get(input_id)
        if not node:
            return ("skipped", {"input_id": input_id})

        perturbation = _pick_perturbation(node.name, node.sample)
        if perturbation is None:
            return ("skipped", {"input_id": input_id})

        # Build perturbed request: deep-copy baseline inputs/relations
        # then overwrite this one input.
        pert_inputs = dict(body.inputs)
        pert_relations: dict[str, list[dict[str, Any]]] = (
            {k: [dict(m) for m in v] for k, v in (body.relations or {}).items()}
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

    load_bearing: dict[str, list[str]] = {oid: [] for oid in body.queried_outputs}
    effects: dict[str, list[dict[str, Any]]] = {}
    no_effect: list[str] = []
    skipped: list[str] = []

    with ThreadPoolExecutor(max_workers=_SENSITIVITY_MAX_WORKERS) as executor:
        futures = [executor.submit(test_input, input_id) for input_id in closure_input_ids]
        for future in as_completed(futures):
            status, payload = future.result()
            input_id = payload["input_id"]
            if status == "skipped":
                skipped.append(input_id)
            elif status == "no_effect":
                no_effect.append(input_id)
            else:
                moved_effects = payload["effects"]
                effects[input_id] = moved_effects
                for effect in moved_effects:
                    load_bearing[effect["output"]].append(input_id)

    response = SensitivityResponseBody(
        baseline=baseline_payload.get("outputs", []),
        load_bearing=load_bearing,
        effects=effects,
        no_effect=no_effect,
        skipped=skipped,
        mode=_mode.name,
    )
    _sensitivity_cache[cache_key] = response.model_copy(deep=True)
    return response

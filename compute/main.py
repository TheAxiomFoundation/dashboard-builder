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

# dashboard-builder

Wizard-driven playground that composes Axiom-style benefit rule dashboards
from selected inputs and outputs.

## What this is

Pick any [Axiom RuleSpec](https://github.com/TheAxiomFoundation/axiom-rules)
program in any `rules-*` repo (e.g. Colorado SNAP), choose which inputs the
end-user fills in and which outputs the dashboard shows, and get a working
calculator with explain traces — without writing dashboard code.

The repo has three pieces:

| Path                 | What it is                                                                     |
| -------------------- | ------------------------------------------------------------------------------ |
| `packages/spec/`     | TypeScript types for `DashboardSpec` — the contract between builder & renderer |
| `apps/builder/`      | React wizard. Browse rule packs, pick I/O, edit metadata, export a spec        |
| `apps/renderer/`     | React app. Reads a `DashboardSpec`, renders the form, calls compute, shows results |
| `compute/`           | FastAPI service. Wraps `axiom-rules` so the renderer never touches Rust        |
| `examples/`          | Reference `co-snap.dashboard.yaml` — the canonical hand-written spec           |

## Quickstart (demo mode — works without a Rust toolchain)

```bash
# 1. Install JS deps
corepack pnpm install     # or: pnpm install

# 2. Boot the compute service (auto-clones rule packs as siblings of this repo)
cd compute
uv venv
uv pip install -e .
uv run uvicorn main:app --port 8787 --reload &
cd ..

# 3. Boot the renderer (CO SNAP example bundled in)
corepack pnpm dev:renderer    # http://127.0.0.1:5174

# 4. (Separate terminal) Boot the builder
corepack pnpm dev:builder     # http://127.0.0.1:5173
```

Open the renderer first — it ships the bundled CO SNAP example so you'll see a
working calculator immediately. Then open the builder, pick a different
program, and click **Preview in renderer** to round-trip your own spec.

In demo mode the compute service returns the expected outputs from each
program's `.test.yaml` fixture and clearly flags this in the UI. To run live
computation, see `compute/README.md`.

## Architecture

```
┌──────────────────┐  edit spec    ┌───────────────────┐
│  apps/builder    │ ────────────► │   DashboardSpec    │
│  (wizard)        │               │   (yaml/json)      │
└──────────────────┘               └─────────┬─────────┘
                                              │ load
                                              ▼
┌──────────────────┐  POST /compute  ┌──────────────────┐
│  apps/renderer   │ ──────────────► │  compute/        │
│  (form + result) │ ◄────────────── │  (FastAPI +      │
│                  │   outputs+trace │   axiom-rules)   │
└──────────────────┘                 └─────────┬────────┘
                                                │ shells out
                                                ▼
                                       ┌──────────────────┐
                                       │  axiom-rules     │
                                       │  (Rust engine)   │
                                       └──────────────────┘
```

The dashboard contract is `DashboardSpec` (see `packages/spec/src/index.ts`).
It references RuleSpec inputs/outputs by their durable legal IDs (e.g.
`us-co:policies/cdhs/snap/fy-2026-benefit-calculation#snap_eligible`), so
specs stay valid even when programs are reorganized — only renames need
fixups.

## Configuration

| Env var               | Default                | Notes                                              |
| --------------------- | ---------------------- | -------------------------------------------------- |
| `AXIOM_RULES_ROOT`    | parent of repo         | Where rule packs are cloned                        |
| `AXIOM_RULES_BIN`     | unset (demo mode)      | Path to compiled `axiom-rules` binary              |
| `VITE_COMPUTE_URL`    | `http://127.0.0.1:8787` | Compute service URL (renderer + builder)          |
| `VITE_RENDERER_URL`   | `http://127.0.0.1:5174` | Builder uses this for the "Preview" button        |

## Roadmap

The architecture is designed for foresight, not just the demo:

- **WASM compute** — once `axiom-rules` adds a `wasm32` target, the renderer
  can call the engine in-browser. The compute contract stays the same so
  nothing else changes.
- **Spec-as-code** — dashboards are versionable YAML. Specs can live alongside
  rule packs in the `rules-*` repos and ship as part of jurisdiction releases.
- **Conditional visibility & branching** — the spec already encodes
  `visibleWhen` over scalar inputs; the wizard UI for editing it is the next
  layer.

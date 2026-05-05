# compute

FastAPI service that the dashboard-builder renderer calls to run an Axiom
RuleSpec program against user-supplied inputs.

## Modes

The service auto-detects which mode to run in at startup:

- **real** — when `AXIOM_RULES_BIN` points to the compiled `axiom-rules`
  binary *and* the `axiom_rules` Python package is installed. Runs live
  computation, returns explain traces.
- **demo** — fallback. Returns the expected outputs from the program's
  `.test.yaml` fixture, clearly labeled in the response. Lets the dashboard
  run end-to-end without a Rust toolchain.

## Quickstart (demo mode)

```bash
cd compute
uv venv
uv pip install -e .
uv run uvicorn main:app --reload --port 8787
```

The first `/compute` call clones the relevant `rules-*` repo as a sibling of
`dashboard-builder/`. Set `AXIOM_RULES_ROOT` to override that location.

## Quickstart (real mode)

```bash
# 1. Clone and build axiom-rules as a sibling of dashboard-builder.
cd ..
git clone https://github.com/TheAxiomFoundation/axiom-rules.git
cd axiom-rules
cargo build --release

# 2. Install the python wrapper.
cd ../dashboard-builder/compute
uv venv
uv pip install -e .
uv pip install -e ../../axiom-rules/python

# 3. Point the service at the binary and run.
export AXIOM_RULES_BIN="$(pwd)/../../axiom-rules/target/release/axiom-rules"
uv run uvicorn main:app --reload --port 8787
```

`/healthz` reports which mode is active.

## Endpoints

```
GET  /healthz
GET  /repos
GET  /repos/{repo}/programs
GET  /repos/{repo}/programs/{path}
POST /compute
```

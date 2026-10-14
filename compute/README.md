# compute

FastAPI service that the dashboard-builder renderer calls to run an Axiom
RuleSpec program against user-supplied inputs.

## Modes

The service auto-detects which mode to run in at startup:

- **real** — when `AXIOM_RULES_ENGINE_BIN` points to the compiled `axiom-rules-engine`
  binary *and* the `axiom_rules_engine` Python package is installed. Runs live
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

The first `/compute` call clones the relevant `rulespec-*` repo as a sibling of
`dashboard-builder/`. Set `AXIOM_RULESPEC_ROOT` to override that location.
Only the rule packs in `registry.ALLOWED_REPOS` (`DEFAULT_REPOS` under their
`rules-*` and `rulespec-*` names) are ever read or cloned.

## Quickstart (real mode)

```bash
# 1. Clone and build axiom-rules-engine as a sibling of dashboard-builder.
cd ..
git clone https://github.com/TheAxiomFoundation/axiom-rules-engine.git
cd axiom-rules-engine
cargo build --release

# 2. Install the python wrapper.
cd ../dashboard-builder/compute
uv venv
uv pip install -e .
uv pip install -e ../../axiom-rules-engine/python

# 3. Point the service at the binary and run.
export AXIOM_RULES_ENGINE_BIN="$(pwd)/../../axiom-rules-engine/target/release/axiom-rules-engine"
uv run uvicorn main:app --reload --port 8787
```

`/healthz` reports which mode is active.

## Endpoints

```
GET  /healthz
GET  /repos
GET  /repos/{repo}/programs
GET  /repos/{repo}/programs/{path}
GET  /repos/{repo}/programs/{path}/graph
POST /repos/{repo}/programs/{path}/transitive
POST /compute
POST /sensitivity
```

The service is public, so `repo` and `path` (URL segments, or
`program.repo` / `program.path` in a request body) are untrusted. A `repo`
outside `ALLOWED_REPOS`, or a `path` that is absolute, has a `.`-prefixed
component such as `..`, is not a `.yaml` file, or resolves (after symlinks)
outside its rule pack, gets HTTP 400 before anything is read, cloned,
composed, or compiled. `compute/tests/test_input_confinement.py` checks this
with property-based tests.

## Tests

```bash
cd compute
uv run --group dev pytest -q
```

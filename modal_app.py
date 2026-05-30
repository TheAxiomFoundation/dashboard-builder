"""Modal deployment for the dashboard-builder compute service.

Hosts the FastAPI service from ``compute/main.py`` with the Rust
``axiom-rules-engine`` binary pre-built and the rule-pack repos cloned into
``/opt/rulespec-*`` (so ``AXIOM_RULESPEC_ROOT=/opt`` lets the service resolve
imports the same way it does locally).

Deploy with:
    modal deploy modal_app.py

Build cost: the first deploy compiles Rust (~3-4 min); subsequent deploys
reuse the cached layer unless ``ENGINE_VERSION`` is bumped.

The deployed URL prints as
``https://policyengine--dashboard-builder-compute-web.modal.run``
(or similar). Set that as ``VITE_COMPUTE_URL`` on the Vercel project.
"""

import modal

app = modal.App("dashboard-builder-compute")

# Bump when source repos change to bust the layer cache and re-build.
ENGINE_VERSION = "v10-composed-ca-ny-snap-rulespec-us-main"

# Pinned commit SHAs — keep these in sync with the local checkouts you
# develop against to avoid trace/spec drift. The CO rule pack uses the
# `reiteration` and namespaced data relations require recent engine/rulespec
# commits; older pins can compile locally but fail once deployed.
AXIOM_RULES_SHA = "8ad01030cc819e20fec9b4f1a85bb82ddd70810e"
RULES_US_SHA = "62c8dc7ade465b3d1c6666dc5fd4139fd07cef83"
RULES_US_CO_SHA = "65eadad2ff4b7027badb7005430083f26da15e1a"
RULES_US_CA_SHA = "057ba686e1410c6b661edec775cbc02ea429c898"
RULES_US_NY_SHA = "d25dcbe259a84d980bec7e6a4e5412e69c5c56b8"
AXIOM_PROGRAMS_SHA = "7de4cd0375e1132f746ee01f97a3753a1bc574c0"

image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install(
        "git",
        "curl",
        "build-essential",
        "pkg-config",
        "libssl-dev",
        "ca-certificates",
    )
    .run_commands(
        # Pinned Rust install — minimal profile, stable channel.
        "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs "
        "| sh -s -- -y --default-toolchain stable --profile minimal",
    )
    .run_commands(
        # Layer cache key for the source-repo + binary layer.
        f"echo 'engine: {ENGINE_VERSION}'",
        # Rule packs cloned at pinned SHAs. The compute service walks
        # these directly (registry.py / graph.py read YAML from disk).
        "git clone https://github.com/TheAxiomFoundation/axiom-rules-engine.git /opt/axiom-rules-engine",
        f"cd /opt/axiom-rules-engine && git checkout {AXIOM_RULES_SHA}",
        "git clone https://github.com/TheAxiomFoundation/rulespec-us.git /opt/rulespec-us",
        f"cd /opt/rulespec-us && git checkout {RULES_US_SHA}",
        "git clone https://github.com/TheAxiomFoundation/rulespec-us-co.git /opt/rulespec-us-co",
        f"cd /opt/rulespec-us-co && git checkout {RULES_US_CO_SHA}",
        "git clone https://github.com/TheAxiomFoundation/rulespec-us-ca.git /opt/rulespec-us-ca",
        f"cd /opt/rulespec-us-ca && git checkout {RULES_US_CA_SHA}",
        "git clone https://github.com/TheAxiomFoundation/rulespec-us-ny.git /opt/rulespec-us-ny",
        f"cd /opt/rulespec-us-ny && git checkout {RULES_US_NY_SHA}",
        "git clone https://github.com/TheAxiomFoundation/axiom-programs.git /opt/axiom-programs",
        f"cd /opt/axiom-programs && git checkout {AXIOM_PROGRAMS_SHA}",
        "ln -sfn /opt/rulespec-us /opt/rules-us",
        "ln -sfn /opt/rulespec-us-co /opt/rules-us-co",
        "ln -sfn /opt/rulespec-us-ca /opt/rules-us-ca",
        "ln -sfn /opt/rulespec-us-ny /opt/rules-us-ny",
        "mkdir -p /opt/_axiom",
        "ln -sfn /opt/rulespec-us /opt/_axiom/rulespec-us",
        "ln -sfn /opt/rulespec-us-co /opt/_axiom/rulespec-us-co",
        "ln -sfn /opt/rulespec-us-ca /opt/_axiom/rulespec-us-ca",
        "ln -sfn /opt/rulespec-us-ny /opt/_axiom/rulespec-us-ny",
        "ln -sfn /opt/rulespec-us /opt/_axiom/rules-us",
        "ln -sfn /opt/rulespec-us-co /opt/_axiom/rules-us-co",
        "ln -sfn /opt/rulespec-us-ca /opt/_axiom/rules-us-ca",
        "ln -sfn /opt/rulespec-us-ny /opt/_axiom/rules-us-ny",
        # Build the Rust engine. Release build for runtime perf.
        ". $HOME/.cargo/env && cd /opt/axiom-rules-engine && cargo build --release",
    )
    .pip_install(
        "fastapi>=0.109",
        "uvicorn>=0.27",
        "pydantic>=2.0",
        "pyyaml>=6.0",
        "python-dotenv>=1.0",
    )
    .env(
        {
            # engine.py reads this to invoke axiom-rules-engine; if unset the service
            # silently degrades to demo mode.
            "AXIOM_RULES_ENGINE_BIN": "/opt/axiom-rules-engine/target/release/axiom-rules-engine",
            # registry.py uses this as the parent dir to resolve `rulespec-*` clones.
            "AXIOM_RULESPEC_ROOT": "/opt",
            # axiom-rules-engine uses this when resolving cross-repo imports.
            "AXIOM_RULESPEC_REPO_ROOTS": "/opt",
            # registry.py resolves composed program sources and invokes compose.
            "AXIOM_PROGRAMS_ROOT": "/opt/axiom-programs",
            "AXIOM_COMPOSE_ROOT": "/opt/axiom-compose",
            # CORS for the Vercel-hosted builder. Tighten to a specific origin
            # if/when the project graduates beyond demo use.
            "ALLOW_ORIGINS": "*",
        }
    )
    # The FastAPI app's source code. Mounted into the container; we add to
    # sys.path inside the function so its sibling-imports
    # (`from registry import ...`) resolve.
    .add_local_dir(
        "compute",
        remote_path="/root/compute",
        copy=True,
        ignore=[
            "artifacts/**",
            ".cache/**",
            ".pytest_cache/**",
            ".venv/**",
            "__pycache__/**",
            "**/__pycache__/**",
            "dashboard_builder_compute.egg-info/**",
        ],
    )
    # Temporary federal RuleSpec overlays needed by the composed CA/NY SNAP
    # programs until these rule files are merged into rulespec-us main.
    .add_local_file(
        "../rulespec-us/regulations/7-cfr/273/10.yaml",
        remote_path="/opt/rulespec-us/regulations/7-cfr/273/10.yaml",
        copy=True,
    )
    .add_local_dir(
        "../rulespec-us/regulations/7-cfr/273/9/d/6",
        remote_path="/opt/rulespec-us/regulations/7-cfr/273/9/d/6",
        copy=True,
    )
    # The compose repo is private; upload the source module used by
    # registry.py instead of cloning it in the remote builder.
    .add_local_dir("../axiom-compose/src", remote_path="/opt/axiom-compose/src", copy=True)
)


@app.function(
    image=image,
    # Stay warm 5 min after the last request — first cold start is ~2-3 s,
    # warm requests are ~150 ms.
    scaledown_window=300,
    timeout=120,
)
@modal.concurrent(max_inputs=10)
@modal.asgi_app(label="dashboard-builder-compute")
def web():
    """Serve the compute FastAPI app from /root/compute."""
    import sys

    sys.path.insert(0, "/root/compute")
    from main import app as fastapi_app  # type: ignore[import-not-found]

    return fastapi_app

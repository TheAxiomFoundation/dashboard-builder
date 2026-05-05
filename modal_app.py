"""Modal deployment for the dashboard-builder compute service.

Hosts the FastAPI service from ``compute/main.py`` with the Rust
``axiom-rules`` binary pre-built and the rule-pack repos cloned into
``/opt/rules-*`` (so ``AXIOM_RULES_ROOT=/opt`` lets the service resolve
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
ENGINE_VERSION = "v1"

# Pinned commit SHAs — keep these in sync with the local checkouts you
# develop against to avoid trace/spec drift.
AXIOM_RULES_SHA = "9106f44e34ec3eae92a1adf2246560c5eac00094"
RULES_US_SHA = "2f3a30991e1f8279c2fa664e51f068a63d905591"
RULES_US_CO_SHA = "e3f7c374177d95debfd092061fedd99fb8e6dccb"

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
        "git clone https://github.com/TheAxiomFoundation/axiom-rules.git /opt/axiom-rules",
        f"cd /opt/axiom-rules && git checkout {AXIOM_RULES_SHA}",
        "git clone https://github.com/TheAxiomFoundation/rules-us.git /opt/rules-us",
        f"cd /opt/rules-us && git checkout {RULES_US_SHA}",
        "git clone https://github.com/TheAxiomFoundation/rules-us-co.git /opt/rules-us-co",
        f"cd /opt/rules-us-co && git checkout {RULES_US_CO_SHA}",
        # Build the Rust engine. Release build for runtime perf.
        ". $HOME/.cargo/env && cd /opt/axiom-rules && cargo build --release",
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
            # engine.py reads this to invoke axiom-rules; if unset the service
            # silently degrades to demo mode.
            "AXIOM_RULES_BIN": "/opt/axiom-rules/target/release/axiom-rules",
            # registry.py uses this as the parent dir to resolve `rules-*` clones.
            "AXIOM_RULES_ROOT": "/opt",
            # CORS for the Vercel-hosted builder. Tighten to a specific origin
            # if/when the project graduates beyond demo use.
            "ALLOW_ORIGINS": "*",
        }
    )
    # The FastAPI app's source code. Mounted into the container; we add to
    # sys.path inside the function so its sibling-imports
    # (`from registry import ...`) resolve.
    .add_local_dir("compute", remote_path="/root/compute")
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

# Deploy

Two services, both under PolicyEngine's accounts:

| Where | What | Why |
|---|---|---|
| **Modal** (`dashboard-builder-compute`) | The Rust `axiom-rules` binary, pinned rule-pack repos, and the `compute/` FastAPI service that wraps them. | Vercel can't run native binaries; Modal containers can. |
| **Vercel** (`dashboard-builder`) | The Vite + React wizard from `apps/builder`. | Standard static-SPA target. |

The Vite app calls the Modal endpoint through the `VITE_COMPUTE_URL` env
var (consumed in `apps/builder/src/api.ts`). Locally, when that var is
unset, the app talks to `http://127.0.0.1:8787` so dev still works
without Modal.

## 1. Deploy the compute service to Modal

```bash
# One-time: install + auth into PolicyEngine's Modal workspace.
pip install modal
modal token set --token-id <id> --token-secret <secret>

# Deploy. First build compiles Rust + clones the rule packs (~3-4 min);
# subsequent deploys reuse the cached layer unless ENGINE_VERSION in
# modal_app.py is bumped.
modal deploy modal_app.py
```

Modal prints a public URL like:

```
https://policyengine--dashboard-builder-compute-web.modal.run
```

Copy it. Verify it works:

```bash
curl https://policyengine--dashboard-builder-compute-web.modal.run/healthz
# → {"status":"ok","mode":"real",...}
```

To re-deploy after a rule-pack or `axiom-rules` change, bump the matching
SHA in `modal_app.py`, bump `ENGINE_VERSION` to bust the layer cache, and
run `modal deploy` again.

## 2. Deploy the builder to Vercel

```bash
# One-time: link this repo to a Vercel project under the PolicyEngine team.
npm i -g vercel
vercel login
vercel link --scope policyengine
```

Set the compute URL on the project (all environments):

```bash
vercel env add VITE_COMPUTE_URL
# paste the Modal URL from step 1, hit Enter for each environment prompt.
```

Deploy:

```bash
vercel deploy --prod
# → https://dashboard-builder.vercel.app  (or whatever PE chooses)
```

`vercel.json` at the repo root tells Vercel to install with pnpm, build
the `@dashboard-builder/builder` workspace, and serve `apps/builder/dist`
as the static output.

## 3. (Optional) Custom domain

In the Vercel dashboard for the project, **Settings → Domains**. PE's
pattern is `<app>.policyengine.org`; for axiom-flavored apps something
like `dashboards.axiom-foundation.org` may make more sense. Add the
CNAME record in the relevant DNS provider.

## Re-deploy cadence

- **Frontend changes** (anything under `apps/builder/`, `packages/render/`,
  `packages/spec/`): `vercel deploy --prod` — or push to `main` if you
  wire auto-deploy in the Vercel project settings (recommended).
- **Compute / engine changes** (anything under `compute/`, an
  `axiom-rules` upgrade, rule-pack content update): bump
  `ENGINE_VERSION` in `modal_app.py`, update the relevant SHA, then run
  `modal deploy modal_app.py`. The frontend doesn't need a Vercel
  redeploy unless its code also changed.

## Local dev

`compute/`: `bash scripts/setup-engine.sh && cd compute && uv run uvicorn main:app --port 8787`.
Front-end: `pnpm --filter @dashboard-builder/builder dev`.

If `VITE_COMPUTE_URL` is unset in the builder, the api client falls back
to `http://127.0.0.1:8787`.

## Troubleshooting

- **Builder shows "compute failed (500)"** → the Modal service errored on
  a specific request. Tail logs with `modal app logs dashboard-builder-compute`.
- **Builder shows "compute failed (network)"** → the Modal service is
  cold or unreachable. Hit `/healthz` directly to confirm.
- **`/healthz` reports `mode: demo`** → `AXIOM_RULES_BIN` isn't set
  inside the container. Re-check the `image.env(...)` call in
  `modal_app.py` and re-deploy.
- **Vercel build fails on `corepack pnpm`** → the project's Node version
  is too old. Set Node 20 in **Settings → Build & Development Settings →
  Node.js Version**.
- **Modal cold starts** → `scaledown_window=300` in `modal_app.py` keeps
  the container warm 5 min after the last request. Bump if you need
  longer-lived warmth.

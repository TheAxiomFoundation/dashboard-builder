"""Persisted dashboards — durable URL-addressable specs.

Storage is intentionally trivial: one JSON file per dashboard under
`compute/dashboards/`. Slug is derived from the dashboard title (or a uuid
fallback) and made unique by appending a counter on collision. The only
guarantee we make is "if you POST a spec, you get back a slug, and GET on
that slug returns what you POSTed."

Future home: real database. Today: filesystem so demos persist across compute
restarts and surveying the directory in finder is a fine debugging experience.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_DASHBOARDS_DIR = Path(__file__).parent / "dashboards"


def _ensure_dir() -> Path:
    _DASHBOARDS_DIR.mkdir(parents=True, exist_ok=True)
    return _DASHBOARDS_DIR


def _slugify(raw: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (raw or "").lower()).strip("-")
    return s[:48] or "dashboard"


def _unique_slug(base: str) -> str:
    directory = _ensure_dir()
    if not (directory / f"{base}.json").exists():
        return base
    suffix = 2
    while (directory / f"{base}-{suffix}.json").exists():
        suffix += 1
    return f"{base}-{suffix}"


def save_dashboard(spec: dict[str, Any], requested_slug: str | None = None) -> dict[str, Any]:
    """Persist a DashboardSpec. Returns the saved record (incl. slug + timestamps)."""
    directory = _ensure_dir()
    title = ""
    meta = spec.get("meta")
    if isinstance(meta, dict):
        title = str(meta.get("title") or "")

    base = _slugify(requested_slug or title or uuid.uuid4().hex[:8])
    slug = base if requested_slug else _unique_slug(base)

    now = datetime.now(timezone.utc).isoformat()
    path = directory / f"{slug}.json"
    existing_created = None
    if path.exists():
        try:
            prior = json.loads(path.read_text())
            existing_created = prior.get("createdAt")
        except Exception:
            pass

    record = {
        "slug": slug,
        "spec": spec,
        "createdAt": existing_created or now,
        "updatedAt": now,
    }
    path.write_text(json.dumps(record, indent=2))
    return record


def get_dashboard(slug: str) -> dict[str, Any] | None:
    path = _ensure_dir() / f"{slug}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def list_dashboards() -> list[dict[str, Any]]:
    directory = _ensure_dir()
    out: list[dict[str, Any]] = []
    for path in sorted(directory.glob("*.json")):
        try:
            record = json.loads(path.read_text())
        except Exception:
            continue
        spec = record.get("spec") or {}
        meta = spec.get("meta") or {}
        out.append({
            "slug": record.get("slug") or path.stem,
            "title": meta.get("title") or path.stem,
            "description": meta.get("description") or "",
            "createdAt": record.get("createdAt"),
            "updatedAt": record.get("updatedAt"),
            "program": spec.get("program"),
        })
    out.sort(key=lambda r: r.get("updatedAt") or "", reverse=True)
    return out


def delete_dashboard(slug: str) -> bool:
    path = _ensure_dir() / f"{slug}.json"
    if not path.exists():
        return False
    path.unlink()
    return True


_EXAMPLES_DIR = Path(__file__).parent.parent / "examples"


def seed_examples() -> list[dict[str, Any]]:
    """Publish every `examples/*.dashboard.yaml` under a stable slug if not already saved.

    Idempotent: existing dashboards are left alone so user edits aren't clobbered.
    Returns the list of slugs that ended up seeded (newly created or already present).
    """
    import yaml  # local import — pyyaml is already a runtime dep

    if not _EXAMPLES_DIR.exists():
        return []

    seeded: list[dict[str, Any]] = []
    for example_path in sorted(_EXAMPLES_DIR.glob("*.dashboard.yaml")):
        try:
            spec = yaml.safe_load(example_path.read_text())
        except Exception:
            continue
        if not isinstance(spec, dict):
            continue

        slug_base = example_path.stem.replace(".dashboard", "")
        existing = get_dashboard(slug_base)
        if existing:
            seeded.append({"slug": slug_base, "newly_created": False})
            continue

        record = save_dashboard(spec, requested_slug=slug_base)
        seeded.append({"slug": record["slug"], "newly_created": True})

    return seeded

"""Load DashboardSpec YAML and resolve references against rule-pack YAML.

Kept deliberately small: the spec is the source of truth for which inputs the
user sees and which outputs the dashboard queries. The rule pack is the source
of truth for what the program can compute. Runtime values come from the user
payload plus neutral dtype defaults for anything omitted.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable

import yaml


def load_yaml(path: str | Path) -> dict[str, Any]:
    return yaml.safe_load(Path(path).read_text())


def find_test_template(program_path: Path) -> Path | None:
    """Sibling .test.yaml file used as a default-value template."""
    candidate = program_path.with_name(f"{program_path.stem}.test.yaml")
    return candidate if candidate.exists() else None


def first_test_case(test_path: Path) -> dict[str, Any] | None:
    """Return the first test case from a .test.yaml file (used as default-value template)."""
    raw = yaml.safe_load(test_path.read_text())
    if isinstance(raw, list) and raw:
        return raw[0]
    if isinstance(raw, dict) and isinstance(raw.get("cases"), list) and raw["cases"]:
        return raw["cases"][0]
    return None


def split_id(legal_id: str) -> tuple[str, str]:
    """Split `us-co:regulations/.../4.207.3#input.household_size` into (`...4.207.3`, `input.household_size`)."""
    head, sep, tail = legal_id.partition("#")
    if not sep:
        raise ValueError(f"legal id missing '#' fragment: {legal_id}")
    return head, tail


def is_relation_id(legal_id: str) -> bool:
    return "#relation." in legal_id


def is_input_id(legal_id: str) -> bool:
    return "#input." in legal_id


def collect_required_input_keys(template: dict[str, Any]) -> set[str]:
    """All flat input keys appearing in a test case's `input` map (including under relations)."""
    inputs = template.get("input", {})
    keys: set[str] = set()
    for key, value in inputs.items():
        keys.add(key)
        if is_relation_id(key) and isinstance(value, list):
            for member in value:
                if isinstance(member, dict):
                    keys.update(member.keys())
    return keys


def merge_with_template(
    template: dict[str, Any] | None,
    user_inputs: dict[str, Any],
    relations: dict[str, list[dict[str, Any]]] | None,
) -> dict[str, Any]:
    """Return user-entered values in the flat shape the engine accepts.

    The `.test.yaml` fixture is for tests and demos, not runtime assumptions.
    Anything the renderer omits is filled later by the missing-input retry
    path using neutral dtype defaults, so "not provided" means zero/false.
    """
    base: dict[str, Any] = {}

    # Overlay scalar inputs.
    for legal_id, value in user_inputs.items():
        if is_relation_id(legal_id):
            continue  # handled below
        base[legal_id] = value

    # Overlay relations: each relation legal id maps to a list of per-member dicts.
    if relations:
        for relation_id, members in relations.items():
            base[relation_id] = list(members)

    return base


def template_period(template: dict[str, Any] | None, fallback: str = "2026-01") -> str:
    """Extract `period` from the test case (`2026-01`); fall back if missing."""
    if template and isinstance(template.get("period"), str):
        return template["period"]
    return fallback


def iter_outputs_in_template(template: dict[str, Any] | None) -> Iterable[tuple[str, Any]]:
    if not template:
        return ()
    out = template.get("output", {})
    if not isinstance(out, dict):
        return ()
    return out.items()

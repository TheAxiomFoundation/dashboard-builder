"""Rule-pack registry — keeps local clones of TheAxiomFoundation/rules-* repos.

Two reasons we clone instead of fetching individual files at request time:

1. RuleSpec programs `import:` other YAML files across the same repo and
   across federal/state repos. The compiler needs them all on disk.
2. axiom-rules resolves `<jurisdiction>:<path>` imports by walking sibling
   repos. We replicate that layout.
"""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

import yaml

DEFAULT_REPOS = [
    "rules-us",
    "rules-us-co",
    "rules-us-ca",
    "rules-us-ny",
    "rules-us-tx",
    "rules-us-fl",
    "rules-us-ga",
    "rules-us-md",
    "rules-us-nc",
    "rules-us-sc",
    "rules-us-tn",
    "rules-us-al",
    "rules-us-ar",
    "rules-uk",
    "rules-ca",
]


@dataclass
class RegistryConfig:
    """Where rule packs live on disk. By default sibling to dashboard-builder."""
    root: Path

    @classmethod
    def from_env(cls) -> "RegistryConfig":
        env_root = os.environ.get("AXIOM_RULES_ROOT")
        if env_root:
            return cls(root=Path(env_root).expanduser().resolve())
        # Sibling of dashboard-builder so jurisdiction:path imports resolve.
        here = Path(__file__).resolve()
        return cls(root=here.parents[2])


def repo_path(config: RegistryConfig, repo: str) -> Path:
    return config.root / repo


def ensure_repo(config: RegistryConfig, repo: str) -> Path:
    """Clone the repo if missing. Idempotent."""
    path = repo_path(config, repo)
    if path.exists():
        return path
    config.root.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/TheAxiomFoundation/{repo}.git"
    subprocess.run(
        ["git", "clone", "--depth", "1", url, str(path)],
        check=True,
        capture_output=True,
    )
    return path


def list_known_repos(config: RegistryConfig) -> list[str]:
    """Repos that exist on disk now. Falls back to DEFAULT_REPOS if none cloned yet."""
    if not config.root.exists():
        return list(DEFAULT_REPOS)
    found = sorted(
        p.name for p in config.root.iterdir()
        if p.is_dir() and p.name.startswith("rules-")
    )
    return found or list(DEFAULT_REPOS)


_summary_cache: dict[Path, tuple[float, str]] = {}


def _read_summary(yaml_path: Path) -> str:
    """First line of `module.summary`, truncated. Memoized by file mtime."""
    try:
        mtime = yaml_path.stat().st_mtime
    except OSError:
        return ""
    cached = _summary_cache.get(yaml_path)
    if cached and cached[0] == mtime:
        return cached[1]
    summary = ""
    try:
        parsed = yaml.safe_load(yaml_path.read_text())
        if isinstance(parsed, dict):
            mod = parsed.get("module")
            if isinstance(mod, dict):
                summary = (mod.get("summary") or "").strip()
    except Exception:
        summary = ""
    # First sentence-ish.
    first_line = summary.replace("\n", " ").strip()
    first_line = re.sub(r"\s+", " ", first_line)
    if len(first_line) > 160:
        first_line = first_line[:157].rstrip() + "…"
    _summary_cache[yaml_path] = (mtime, first_line)
    return first_line


def list_programs(config: RegistryConfig, repo: str) -> list[dict]:
    """All RuleSpec YAML files under policies/, regulations/, statutes/ in a repo.

    Returned programs include `summary` (first line of module.summary) so the
    UI can show "Colorado SNAP FY 2026 benefit calculation composition"
    instead of a raw section number like "4.207.3".

    Kinds are ordered policies → regulations → statutes — policies are the
    composed, calculator-shaped programs users typically want; regulations
    and statutes are the components those policies import.
    """
    path = ensure_repo(config, repo)
    programs: list[dict] = []
    for kind in ("policies", "regulations", "statutes"):
        kind_root = path / kind
        if not kind_root.exists():
            continue
        for yaml_path in sorted(kind_root.rglob("*.yaml")):
            if yaml_path.name.endswith(".test.yaml"):
                continue
            programs.append({
                "repo": repo,
                "path": str(yaml_path.relative_to(path)),
                "kind": kind,
                "name": yaml_path.stem,
                "summary": _read_summary(yaml_path),
            })
    return programs


def resolve_program(config: RegistryConfig, repo: str, path: str) -> Path:
    repo_dir = ensure_repo(config, repo)
    full = repo_dir / path
    if not full.exists():
        raise FileNotFoundError(f"program not found: {repo}/{path}")
    return full

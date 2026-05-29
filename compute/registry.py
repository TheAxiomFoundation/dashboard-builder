"""Rule-pack registry — keeps local clones of TheAxiomFoundation/rulespec-* repos.

Two reasons we clone instead of fetching individual files at request time:

1. RuleSpec programs `import:` other YAML files across the same repo and
   across federal/state repos. The compiler needs them all on disk.
2. axiom-rules-engine resolves `<jurisdiction>:<path>` imports by walking sibling
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

_COMPOSED_ARTIFACT_ROOT = Path(__file__).resolve().parent / "artifacts" / "composed"
_COMPOSED_KIND = "programs"


@dataclass
class RegistryConfig:
    """Where rule packs live on disk. By default sibling to dashboard-builder."""
    root: Path

    @classmethod
    def from_env(cls) -> "RegistryConfig":
        env_root = os.environ.get("AXIOM_RULESPEC_ROOT")
        if env_root:
            return cls(root=Path(env_root).expanduser().resolve())
        # Sibling of dashboard-builder so jurisdiction:path imports resolve.
        here = Path(__file__).resolve()
        return cls(root=here.parents[2])


def repo_path(config: RegistryConfig, repo: str) -> Path:
    primary = config.root / repo
    if primary.exists():
        return primary
    if repo.startswith("rules-"):
        canonical = config.root / f"rulespec-{repo[len('rules-'):]}"
        if canonical.exists():
            return canonical
    if repo.startswith("rulespec-"):
        alias = config.root / f"rules-{repo[len('rulespec-'):]}"
        if alias.exists():
            return alias
    return primary


def ensure_repo(config: RegistryConfig, repo: str) -> Path:
    """Clone the repo if missing. Idempotent."""
    path = repo_path(config, repo)
    if path.exists():
        return path
    config.root.mkdir(parents=True, exist_ok=True)
    clone_repo = f"rulespec-{repo[len('rules-'):]}" if repo.startswith("rules-") else repo
    url = f"https://github.com/TheAxiomFoundation/{clone_repo}.git"
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
    found: set[str] = set()
    for p in config.root.iterdir():
        if not p.is_dir():
            continue
        if p.name.startswith("rules-"):
            found.add(p.name)
        elif p.name.startswith("rulespec-"):
            found.add(f"rules-{p.name[len('rulespec-'):]}")
    return sorted(found) or list(DEFAULT_REPOS)


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
    programs.extend(_list_composed_programs(config, repo))
    return programs


def resolve_program(config: RegistryConfig, repo: str, path: str) -> Path:
    if path.startswith(f"{_COMPOSED_KIND}/"):
        composed = _resolve_composed_program(config, repo, path)
        if composed is not None:
            return composed
    repo_dir = ensure_repo(config, repo)
    full = repo_dir / path
    if not full.exists():
        raise FileNotFoundError(f"program not found: {repo}/{path}")
    return full


def _repo_jurisdiction(repo: str) -> str | None:
    if repo.startswith("rulespec-"):
        return repo[len("rulespec-"):]
    if repo.startswith("rules-"):
        return repo[len("rules-"):]
    return None


def _jurisdiction_label(jurisdiction: str) -> str:
    return {
        "us-ca": "California",
        "us-co": "Colorado",
        "us-ny": "New York",
    }.get(jurisdiction, jurisdiction)


def _programs_repo(config: RegistryConfig) -> Path:
    env_root = os.environ.get("AXIOM_PROGRAMS_ROOT")
    if env_root:
        return Path(env_root).expanduser().resolve()
    return config.root / "axiom-programs"


def _compose_repo(config: RegistryConfig) -> Path:
    env_root = os.environ.get("AXIOM_COMPOSE_ROOT")
    if env_root:
        return Path(env_root).expanduser().resolve()
    return config.root / "axiom-compose"


def _composed_source_for(config: RegistryConfig, repo: str, path: str) -> Path | None:
    jurisdiction = _repo_jurisdiction(repo)
    if not jurisdiction or not path.startswith(f"{_COMPOSED_KIND}/"):
        return None
    rel = Path(path).relative_to(_COMPOSED_KIND)
    source = _programs_repo(config) / jurisdiction / rel
    return source if source.exists() else None


def _composed_artifact_path(repo: str, path: str) -> Path:
    return _COMPOSED_ARTIFACT_ROOT / repo / path


def _list_composed_programs(config: RegistryConfig, repo: str) -> list[dict]:
    jurisdiction = _repo_jurisdiction(repo)
    if not jurisdiction:
        return []
    root = _programs_repo(config) / jurisdiction
    if not root.exists():
        return []

    programs: list[dict] = []
    for yaml_path in sorted(root.rglob("*.yaml")):
        if yaml_path.name.endswith(".test.yaml"):
            continue
        rel = yaml_path.relative_to(root)
        path = f"{_COMPOSED_KIND}/{rel.as_posix()}"
        summary = _read_composed_summary(yaml_path, jurisdiction)
        programs.append({
            "repo": repo,
            "path": path,
            "kind": _COMPOSED_KIND,
            "name": yaml_path.stem,
            "summary": summary,
        })
    return programs


def _read_composed_summary(yaml_path: Path, jurisdiction: str) -> str:
    try:
        parsed = yaml.safe_load(yaml_path.read_text())
    except Exception:
        parsed = None
    if not isinstance(parsed, dict):
        return ""
    program = str(parsed.get("program") or "")
    period = str(parsed.get("period") or "").strip()
    if program.endswith("/snap"):
        label = f"{_jurisdiction_label(jurisdiction)} SNAP"
    else:
        label = program.replace("/", " ").strip() or yaml_path.stem
    if period:
        return f"{label} program composition for {period}."
    return f"{label} program composition."


def _resolve_composed_program(
    config: RegistryConfig,
    repo: str,
    path: str,
) -> Path | None:
    source = _composed_source_for(config, repo, path)
    if source is None:
        return None

    artifact = _composed_artifact_path(repo, path)
    source_mtime = source.stat().st_mtime
    if artifact.exists() and artifact.stat().st_mtime >= source_mtime:
        _sanitize_composed_artifact(artifact)
        return artifact

    compose_root = _compose_repo(config)
    cli_src = compose_root / "src"
    if not cli_src.exists():
        raise FileNotFoundError(
            f"axiom-compose source not found; set AXIOM_COMPOSE_ROOT or clone it at {compose_root}"
        )

    artifact.parent.mkdir(parents=True, exist_ok=True)
    jurisdiction = _repo_jurisdiction(repo)
    rulespec_roots = [config.root / "rulespec-us"]
    if jurisdiction:
        rulespec_roots.append(config.root / f"rulespec-{jurisdiction}")
    existing_roots = [root for root in rulespec_roots if root.exists()]

    env = os.environ.copy()
    env["PYTHONPATH"] = (
        str(cli_src)
        if not env.get("PYTHONPATH")
        else f"{cli_src}{os.pathsep}{env['PYTHONPATH']}"
    )
    cmd = [
        "python",
        "-m",
        "axiom_compose.cli",
        str(source),
        "-o",
        str(artifact),
    ]
    for root in existing_roots:
        cmd.extend(["--rulespec-root", str(root)])
    proc = subprocess.run(
        cmd,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"axiom-compose failed for {source}: {proc.stderr.strip()}")
    _sanitize_composed_artifact(artifact)
    return artifact


def _sanitize_composed_artifact(artifact: Path) -> None:
    """Remove composed rule kinds the current runtime cannot compile.

    axiom-compose can emit ``derived_relation`` helper rules such as
    ``snap_unit``. The current axiom-rules-engine rejects that rule kind at
    compile time, and the CA/NY SNAP eligibility wrappers query the source
    ``member_of_household`` relation directly, so those helper rules are not
    needed for dashboard execution.
    """
    try:
        parsed = yaml.safe_load(artifact.read_text())
    except Exception:
        return
    if not isinstance(parsed, dict):
        return
    rules = parsed.get("rules")
    if not isinstance(rules, list):
        return
    filtered = [
        rule
        for rule in rules
        if not (isinstance(rule, dict) and rule.get("kind") == "derived_relation")
    ]
    if len(filtered) == len(rules):
        return
    parsed["rules"] = filtered
    artifact.write_text(yaml.safe_dump(parsed, sort_keys=False))

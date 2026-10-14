"""Request `repo` / `path` values must stay inside the allowlisted rule packs.

The compute service is public and unauthenticated. These tests pin the
invariant from d1458: no request value can make the service read, clone,
compose, or compile anything outside the allowlisted rule-pack directories.

Every test runs against a throwaway workspace (see `_build_workspace`) with
`subprocess.run` mocked, so nothing here touches the network or the real
sibling checkouts.
"""
from __future__ import annotations

import os
import string
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterator
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from hypothesis import given, settings
from hypothesis import strategies as st

COMPUTE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(COMPUTE_ROOT))

import main  # noqa: E402
import registry  # noqa: E402
from engine import ComputeMode  # noqa: E402
from registry import (  # noqa: E402
    ALLOWED_REPOS,
    DEFAULT_REPOS,
    InvalidProgramRef,
    RegistryConfig,
    _confine,
    ensure_repo,
    list_known_repos,
    list_programs,
    resolve_program,
    validate_program_path,
    validate_repo,
)

SECRET = "SECRET-SENTINEL-d1458"

PROGRAM_YAML = """\
format: rulespec/v1
module:
  summary: Test SNAP net income.
rules:
  - name: snap_net_income
    kind: derived
    entity: Household
    dtype: Money
    period: Month
    source: test
    versions:
      - effective_from: '2025-10-01'
        formula: snap_gross_income - snap_deductions
"""

PROGRAM_TEST_YAML = """\
- name: base_case
  period: 2026-01
  input:
    us:regulations/7-cfr/273/10#input.snap_gross_income: 1000
    us:regulations/7-cfr/273/10#input.snap_deductions: 200
  output:
    us:regulations/7-cfr/273/10#snap_net_income: 800
"""

SECRET_YAML = f"""\
module:
  summary: {SECRET}
rules:
  - name: {SECRET.replace('-', '_').lower()}
    kind: derived
"""

SECRET_TEST_YAML = f"""\
- name: {SECRET}
  input:
    secret#input.leak: 1
"""


@dataclass
class Workspace:
    base: Path
    root: Path
    secret_dir: Path
    programs_root: Path
    artifact_root: Path

    @property
    def config(self) -> RegistryConfig:
        return RegistryConfig(root=self.root)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def _build_workspace(base: Path) -> Workspace:
    """A rules root with real packs, an alias symlink, and escape bait.

    base/
      rules/                         <- RegistryConfig.root
        rulespec-us/                 real pack
          regulations/7-cfr/273/10.yaml (+ .test.yaml)
          policies/p.yaml
          inner_link.yaml -> regulations/7-cfr/273/10.yaml   (stays inside)
          escape_link.yaml -> ../../secret/secret.yaml        (leaves the pack)
          linkdir -> ../../secret                             (leaves the pack)
          sibling_link.yaml -> ../rulespec-us-co/policies/co.yaml (other pack)
          loop.yaml -> loop.yaml
          .git/config.yaml
        rules-us -> rulespec-us      alias symlink, as on Modal
        rulespec-us-co/policies/co.yaml
        rulespec-il/policies/il.yaml on disk but not allowlisted
        axiom-programs/us-co/snap.yaml (+ escape.yaml -> secret)
        axiom-compose/src/
      secret/secret.yaml (+ .test.yaml)
      artifacts/composed/
    """
    root = base / "rules"
    secret_dir = base / "secret"
    _write(secret_dir / "secret.yaml", SECRET_YAML)
    _write(secret_dir / "secret.test.yaml", SECRET_TEST_YAML)

    us = root / "rulespec-us"
    _write(us / "regulations/7-cfr/273/10.yaml", PROGRAM_YAML)
    _write(us / "regulations/7-cfr/273/10.test.yaml", PROGRAM_TEST_YAML)
    _write(us / "policies/p.yaml", PROGRAM_YAML)
    _write(us / ".git/config.yaml", SECRET_YAML)
    (us / "inner_link.yaml").symlink_to("regulations/7-cfr/273/10.yaml")
    (us / "escape_link.yaml").symlink_to("../../secret/secret.yaml")
    (us / "linkdir").symlink_to("../../secret", target_is_directory=True)
    (us / "sibling_link.yaml").symlink_to("../rulespec-us-co/policies/co.yaml")
    (us / "loop.yaml").symlink_to("loop.yaml")
    (root / "rules-us").symlink_to("rulespec-us", target_is_directory=True)

    _write(root / "rulespec-us-co/policies/co.yaml", PROGRAM_YAML)
    _write(root / "rulespec-il/policies/il.yaml", SECRET_YAML)

    programs_root = root / "axiom-programs"
    _write(programs_root / "us-co/snap.yaml", "program: us-co/snap\nperiod: 2026\n")
    (programs_root / "us-co/escape.yaml").symlink_to("../../../secret/secret.yaml")
    (root / "axiom-compose/src").mkdir(parents=True)

    artifact_root = base / "artifacts" / "composed"
    artifact_root.mkdir(parents=True)
    return Workspace(base, root, secret_dir, programs_root, artifact_root)


class SubprocessSpy:
    """Stands in for `registry.subprocess.run`; records every command.

    A clone does nothing, so the pack stays missing. A compose writes an
    empty artifact at its `-o` path so the caller can carry on.
    """

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def __call__(self, cmd, *args, **kwargs):
        cmd = [str(part) for part in cmd]
        self.calls.append(cmd)
        if cmd[:3] == ["python", "-m", "axiom_compose.cli"]:
            out = Path(cmd[cmd.index("-o") + 1])
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text("rules: []\n")
        result = MagicMock()
        result.returncode = 0
        result.stderr = ""
        return result

    @property
    def clones(self) -> list[list[str]]:
        return [c for c in self.calls if c[:2] == ["git", "clone"]]


@contextmanager
def _service(ws: Workspace) -> Iterator[SubprocessSpy]:
    """Point the registry and the FastAPI app at `ws`, with subprocess mocked."""
    spy = SubprocessSpy()
    env = {k: v for k, v in os.environ.items() if k not in {
        "AXIOM_PROGRAMS_ROOT", "AXIOM_COMPOSE_ROOT", "AXIOM_RULESPEC_ROOT",
        "AXIOM_RULESPEC_REPO_ROOTS",
    }}
    with patch.dict(os.environ, env, clear=True), \
            patch.object(registry.subprocess, "run", spy), \
            patch.object(registry, "_COMPOSED_ARTIFACT_ROOT", ws.artifact_root), \
            patch.object(main, "_config", ws.config), \
            patch.object(main, "_mode", ComputeMode("demo", "test")):
        yield spy


def _within(path: Path, base: Path) -> bool:
    return Path(os.path.realpath(path)).is_relative_to(os.path.realpath(base))


def _assert_confined(ws: Workspace, repo: str, result: Path | None, spy: SubprocessSpy) -> None:
    """The d1458 invariant for one call: every effect lands in an allowed root."""
    jurisdiction = repo.split("-", 1)[1]
    pack_roots = [ws.root / f"rulespec-{jurisdiction}", ws.root / f"rules-{jurisdiction}"]
    allowed_reads = [*pack_roots, ws.artifact_root / repo]
    if result is not None:
        assert any(_within(result, r) for r in allowed_reads), result
        assert not _within(result, ws.secret_dir)
    for cmd in spy.calls:
        if cmd[:2] == ["git", "clone"]:
            url, target = cmd[-2], Path(cmd[-1])
            assert url == f"https://github.com/TheAxiomFoundation/rulespec-{jurisdiction}.git"
            assert target.parent == ws.root
            assert target.name in ALLOWED_REPOS
        else:
            assert cmd[:3] == ["python", "-m", "axiom_compose.cli"], cmd
            source, artifact = Path(cmd[3]), Path(cmd[cmd.index("-o") + 1])
            assert _within(source, ws.programs_root / jurisdiction)
            assert _within(artifact, ws.artifact_root / repo)


@pytest.fixture()
def ws(tmp_path: Path) -> Workspace:
    return _build_workspace(tmp_path)


@pytest.fixture(scope="module")
def shared_ws(tmp_path_factory: pytest.TempPathFactory) -> Workspace:
    return _build_workspace(tmp_path_factory.mktemp("confinement"))


# --- repo allowlist -------------------------------------------------------

def test_allowlist_is_default_packs_and_their_canonical_names() -> None:
    assert len(ALLOWED_REPOS) == 2 * len(DEFAULT_REPOS)
    for repo in DEFAULT_REPOS:
        assert repo in ALLOWED_REPOS
        assert f"rulespec-{repo[len('rules-'):]}" in ALLOWED_REPOS


@pytest.mark.parametrize("repo", [
    "..", "../..", "/", "/etc", "../secret", "../TheAxiomFoundation/axiom-compose",
    "../evil-org/evil-repo", "rules-us/../../secret", "rules-us/", "rules-us\x00",
    "axiom-compose", "axiom-programs", "rulespec-il", "rules-il", "RULES-US", " rules-us",
    "rules-", "rulespec-", "", 7, None, ["rules-us"], {"repo": "rules-us"},
])
def test_unknown_repo_is_rejected_without_clone(ws: Workspace, repo: object) -> None:
    with _service(ws) as spy:
        with pytest.raises(InvalidProgramRef):
            resolve_program(ws.config, repo, "policies/p.yaml")  # type: ignore[arg-type]
        with pytest.raises(InvalidProgramRef):
            ensure_repo(ws.config, repo)  # type: ignore[arg-type]
        with pytest.raises(InvalidProgramRef):
            list_programs(ws.config, repo)  # type: ignore[arg-type]
    assert spy.calls == []


@given(repo=st.one_of(
    st.text(max_size=40),
    st.text(alphabet=string.ascii_lowercase + "-./_", max_size=24),
    st.builds(lambda r, tail: r + tail, st.sampled_from(sorted(ALLOWED_REPOS)),
              st.text(min_size=1, max_size=8)),
    st.integers(), st.none(), st.lists(st.text(max_size=5), max_size=2),
).filter(lambda r: not (isinstance(r, str) and r in ALLOWED_REPOS)))
@settings(max_examples=400, deadline=None)
def test_property_no_repo_outside_allowlist_is_cloned_or_read(shared_ws: Workspace, repo: object) -> None:
    before = sorted(p.name for p in shared_ws.root.iterdir())
    with _service(shared_ws) as spy:
        with pytest.raises(InvalidProgramRef):
            resolve_program(shared_ws.config, repo, "policies/p.yaml")  # type: ignore[arg-type]
        with pytest.raises(InvalidProgramRef):
            validate_repo(repo)
    assert spy.calls == []
    assert sorted(p.name for p in shared_ws.root.iterdir()) == before


def test_missing_allowlisted_repo_clones_only_its_canonical_url(ws: Workspace) -> None:
    with _service(ws) as spy:
        with pytest.raises(FileNotFoundError):
            resolve_program(ws.config, "rules-us-tx", "policies/x.yaml")
    assert spy.clones == [[
        "git", "clone", "--depth", "1",
        "https://github.com/TheAxiomFoundation/rulespec-us-tx.git",
        str(ws.root / "rules-us-tx"),
    ]]


def test_failed_clone_is_not_found(ws: Workspace) -> None:
    import subprocess

    def fail(cmd, *a, **k):
        raise subprocess.CalledProcessError(128, cmd)

    with _service(ws), patch.object(registry.subprocess, "run", fail):
        with pytest.raises(FileNotFoundError):
            ensure_repo(ws.config, "rules-uk")


def test_known_repos_lists_only_allowlisted_packs(ws: Workspace) -> None:
    repos = list_known_repos(ws.config)
    assert "rules-us" in repos and "rules-us-co" in repos
    assert "rules-il" not in repos
    assert set(repos) <= ALLOWED_REPOS


# --- path confinement -----------------------------------------------------

@pytest.mark.parametrize("path", [
    "regulations/7-cfr/273/10.yaml",
    "policies/p.yaml",
    "policies//p.yaml",
    "./policies/p.yaml",
    "inner_link.yaml",
    "policies/cdhs/snap/fy-2026-benefit-calculation.yaml",
    "programs/us-co/snap.yaml",
])
def test_well_formed_paths_pass_validation(path: str) -> None:
    rel = validate_program_path(path)
    assert not rel.is_absolute()
    assert ".." not in rel.parts


@pytest.mark.parametrize("path", [
    "",
    "/etc/passwd",
    "/etc/passwd.yaml",
    "//etc/passwd.yaml",
    "../secret/secret.yaml",
    "../../secret/secret.yaml",
    "policies/../../secret/secret.yaml",
    "policies/../p.yaml",
    "..",
    ".git/config.yaml",
    "policies/.hidden.yaml",
    "policies/p.yml",
    "policies/p",
    "policies/",
    "policies/p.yaml\x00.txt",
    "..\\..\\secret\\secret.yaml",
    "a" * 600 + ".yaml",
    7,
    None,
    ["policies/p.yaml"],
])
def test_malformed_paths_fail_validation(path: object) -> None:
    with pytest.raises(InvalidProgramRef):
        validate_program_path(path)


def test_legitimate_programs_still_resolve(ws: Workspace) -> None:
    with _service(ws) as spy:
        for repo in ("rules-us", "rulespec-us"):
            got = resolve_program(ws.config, repo, "regulations/7-cfr/273/10.yaml")
            assert got.read_text() == PROGRAM_YAML
            assert _within(got, ws.root / "rulespec-us")
        assert resolve_program(ws.config, "rules-us", "inner_link.yaml").read_text() == PROGRAM_YAML
        assert resolve_program(ws.config, "rules-us-co", "policies/co.yaml").is_file()
        # The alias root is kept, as before, so downstream repo inference is unchanged.
        assert resolve_program(ws.config, "rules-us", "policies/p.yaml") == ws.root / "rules-us" / "policies/p.yaml"
    assert spy.calls == []


@pytest.mark.parametrize("path", [
    "escape_link.yaml",
    "linkdir/secret.yaml",
    "sibling_link.yaml",
])
def test_symlink_escapes_are_rejected(ws: Workspace, path: str) -> None:
    with _service(ws):
        with pytest.raises(InvalidProgramRef):
            resolve_program(ws.config, "rules-us", path)


def test_symlink_loop_is_not_found(ws: Workspace) -> None:
    with _service(ws):
        with pytest.raises((FileNotFoundError, InvalidProgramRef)):
            resolve_program(ws.config, "rules-us", "loop.yaml")


@pytest.mark.parametrize("path", ["policies/nope.yaml", "programs//etc/passwd.yaml", "policies"])
def test_missing_program_is_not_found(ws: Workspace, path: str) -> None:
    # `programs//etc/passwd.yaml` is the relative path programs/etc/passwd.yaml:
    # well-formed and inside the pack, so it is simply absent.
    with _service(ws):
        with pytest.raises((FileNotFoundError, InvalidProgramRef)):
            resolve_program(ws.config, "rules-us", path)


# --- composed programs ----------------------------------------------------

def test_composed_program_resolves_inside_artifact_root(ws: Workspace) -> None:
    with _service(ws) as spy:
        listed = {p["path"] for p in list_programs(ws.config, "rules-us-co")}
        assert "programs/snap.yaml" in listed
        got = resolve_program(ws.config, "rules-us-co", "programs/snap.yaml")
    assert got == ws.artifact_root / "rules-us-co" / "programs/snap.yaml"
    (compose,) = spy.calls
    assert compose[3] == str(ws.programs_root / "us-co" / "snap.yaml")
    _assert_confined(ws, "rules-us-co", got, spy)


def test_composed_symlink_escape_is_rejected(ws: Workspace) -> None:
    with _service(ws) as spy:
        with pytest.raises(InvalidProgramRef):
            resolve_program(ws.config, "rules-us-co", "programs/escape.yaml")
    assert spy.calls == []


@pytest.mark.parametrize("path", [
    "programs/../../../secret/secret.yaml",
    "programs/../../rulespec-us/policies/p.yaml",
    "/programs/snap.yaml",
])
def test_composed_traversal_is_rejected(ws: Workspace, path: str) -> None:
    with _service(ws) as spy:
        with pytest.raises(InvalidProgramRef):
            resolve_program(ws.config, "rules-us-co", path)
    assert spy.calls == []
    assert list(ws.artifact_root.iterdir()) == []


# --- the invariant, for all inputs ----------------------------------------

_COMPONENTS = st.one_of(
    st.sampled_from([
        "..", ".", "", "~", "...", "regulations", "7-cfr", "273", "10.yaml",
        "10.test.yaml", "policies", "p.yaml", "co.yaml", "programs", "us-co",
        "snap.yaml", "escape.yaml", "linkdir", "escape_link.yaml",
        "inner_link.yaml", "sibling_link.yaml", "loop.yaml", "secret",
        "secret.yaml", "rules", "rulespec-us", "rules-us", "rulespec-us-co",
        "rulespec-il", "il.yaml", ".git", "config.yaml", "%2e%2e", "..%2f",
        "\x00", "a\\..\\b.yaml", "etc", "passwd", "artifacts", "composed",
    ]),
    st.text(max_size=10),
)
_PATHS = st.one_of(
    st.builds(
        lambda lead, parts: lead + "/".join(parts),
        st.sampled_from(["", "/", "//", "./", "../", "~/"]),
        st.lists(_COMPONENTS, max_size=8),
    ),
    st.text(max_size=80),
)


@given(repo=st.sampled_from(sorted(ALLOWED_REPOS)), path=_PATHS)
@settings(max_examples=1500, deadline=None)
def test_property_resolve_program_never_leaves_the_rule_pack(
    shared_ws: Workspace, repo: str, path: str,
) -> None:
    with _service(shared_ws) as spy:
        try:
            result = resolve_program(shared_ws.config, repo, path)
        except (InvalidProgramRef, FileNotFoundError):
            result = None
    _assert_confined(shared_ws, repo, result, spy)


@given(legal_id=st.one_of(
    st.text(max_size=60),
    st.builds(lambda head, rest: f"{head}:{rest}",
              st.sampled_from(["us", "us-co", "il", "..", "../..", "", "us/../..", "x"]),
              _PATHS),
))
@settings(max_examples=800, deadline=None)
def test_property_fixture_lookup_never_leaves_the_rule_packs(shared_ws: Workspace, legal_id: str) -> None:
    with _service(shared_ws) as spy:
        result = main._file_path_for_legal_id(legal_id)
    if result is not None:
        assert any(
            _within(result, shared_ws.root / name)
            for name in ALLOWED_REPOS
            if (shared_ws.root / name).exists()
        ) or any(_within(result, shared_ws.artifact_root / name) for name in ALLOWED_REPOS)
        assert not _within(result, shared_ws.secret_dir)
    for cmd in spy.clones:
        assert Path(cmd[-1]).name in ALLOWED_REPOS


def _reference_confined(base: Path, rel: str) -> bool:
    """Independent check of `_confine`: os.path.realpath + commonpath."""
    real_base = os.path.realpath(base)
    real = os.path.realpath(os.path.join(base, rel))
    return os.path.commonpath([real_base, real]) == real_base


@given(path=_PATHS)
@settings(max_examples=1000, deadline=None)
def test_property_confine_agrees_with_reference(shared_ws: Workspace, path: str) -> None:
    try:
        rel = validate_program_path(path)
    except InvalidProgramRef:
        return
    base = shared_ws.root / "rules-us"
    try:
        joined = _confine(base, rel)
    except InvalidProgramRef:
        assert not _reference_confined(base, str(rel))
    else:
        assert _reference_confined(base, str(rel))
        assert joined == base / rel


@given(path=_PATHS)
@settings(max_examples=1000, deadline=None)
def test_property_validated_paths_are_lexically_inside_any_base(path: str) -> None:
    try:
        rel = validate_program_path(path)
    except InvalidProgramRef:
        return
    base = PurePosixPath("/srv/pack")
    normalized = PurePosixPath(os.path.normpath(base / rel))
    assert normalized.is_relative_to(base)
    assert normalized != base
    assert rel.suffix == ".yaml"


# --- HTTP surface ---------------------------------------------------------

@pytest.fixture()
def client(ws: Workspace) -> Iterator[tuple[TestClient, SubprocessSpy, Workspace]]:
    with _service(ws) as spy:
        yield TestClient(main.app), spy, ws


def _body(repo: object, path: object, **extra: object) -> dict:
    body = {
        "program": {"repo": repo, "path": path},
        "period": {"start": "2026-01-01"},
        "inputs": {},
        "queried_outputs": ["us:regulations/7-cfr/273/10#snap_net_income"],
    }
    body.update(extra)
    return body


def test_http_allowed_requests_still_work(client) -> None:
    c, spy, _ = client
    assert c.get("/repos").json()["repos"] == ["rules-us", "rules-us-co"]
    programs = c.get("/repos/rules-us/programs").json()["programs"]
    assert {p["path"] for p in programs} >= {"regulations/7-cfr/273/10.yaml", "policies/p.yaml"}
    meta = c.get("/repos/rules-us/programs/regulations/7-cfr/273/10.yaml")
    assert meta.status_code == 200
    assert meta.json()["outputs"][0]["name"] == "snap_net_income"
    assert c.get("/repos/rules-us/programs/regulations/7-cfr/273/10.yaml/graph").status_code == 200
    computed = c.post("/compute", json=_body("rules-us", "regulations/7-cfr/273/10.yaml"))
    assert computed.status_code == 200
    assert computed.json()["outputs"] == [{
        "legalId": "us:regulations/7-cfr/273/10#snap_net_income",
        "value": 800,
        "dtype": "decimal",
    }]
    assert spy.calls == []


@pytest.mark.parametrize("url", [
    "/repos/%2E%2E/programs",
    "/repos/not-a-rule-pack/programs",
    "/repos/rulespec-il/programs",
    "/repos/%2E%2E/programs/policies/p.yaml",
    "/repos/rules-us/programs/%2E%2E/%2E%2E/secret/secret.yaml",
    "/repos/rules-us/programs/%2E%2E%2F%2E%2E%2Fsecret%2Fsecret.yaml",
    "/repos/rules-us/programs//etc/passwd.yaml",
    "/repos/rules-us/programs/%2Fetc%2Fpasswd.yaml",
    "/repos/rules-us/programs/escape_link.yaml",
    "/repos/rules-us/programs/linkdir/secret.yaml",
    "/repos/rules-us/programs/.git/config.yaml",
    "/repos/rules-us/programs/linkdir/secret.yaml/graph",
    "/repos/rules-us/programs/%2E%2E/%2E%2E/secret/secret.yaml/graph",
])
def test_http_escape_attempts_get_400(client, url: str) -> None:
    c, spy, _ = client
    resp = c.get(url)
    assert resp.status_code == 400, (url, resp.status_code, resp.text)
    assert SECRET not in resp.text
    assert spy.calls == []


def test_http_transitive_escape_gets_400(client) -> None:
    c, spy, _ = client
    resp = c.post("/repos/rules-us/programs/escape_link.yaml/transitive", json={"outputs": []})
    assert resp.status_code == 400
    assert spy.calls == []


@pytest.mark.parametrize("endpoint", ["/compute", "/sensitivity"])
@pytest.mark.parametrize("repo,path", [
    ("../secret", "secret.yaml"),
    ("../evil-org/evil-repo", "policies/p.yaml"),
    ("rules-us", "../../secret/secret.yaml"),
    ("rules-us", "/etc/passwd"),
    ("rules-us", "escape_link.yaml"),
    ("rules-us-co", "programs/escape.yaml"),
    ("rules-us-co", "programs/../../../secret/secret.yaml"),
    (["rules-us"], "policies/p.yaml"),
    ("rules-us", {"p": 1}),
])
def test_http_body_escape_attempts_get_400(client, endpoint: str, repo: object, path: object) -> None:
    c, spy, ws = client
    resp = c.post(endpoint, json=_body(repo, path))
    assert resp.status_code == 400, (endpoint, repo, path, resp.status_code, resp.text)
    assert SECRET not in resp.text
    assert spy.calls == []
    assert list(ws.artifact_root.iterdir()) == []


def test_sensitivity_queried_outputs_cannot_pull_fixtures_from_outside(ws: Workspace) -> None:
    with _service(ws) as spy:
        program = resolve_program(ws.config, "rules-us", "regulations/7-cfr/273/10.yaml")
        scenarios = main._load_fixture_scenarios(program, [
            "../../secret/secret#x",
            "us:../../secret/secret#x",
            "us:../../../secret/secret#x",
            "us:/" + str(ws.secret_dir / "secret") + "#x",
            "us:linkdir/secret#x",
            "il:policies/il#x",
            "evil/../../x:y#z",
        ])
    names = {s.name for s in scenarios}
    assert SECRET not in names
    assert names == {"base_case"}
    assert spy.calls == []

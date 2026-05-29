"""Build a rule dependency graph for a RuleSpec program.

The graph is the load-bearing data structure for the builder UI: when the user
picks an output, we walk this graph to find every input that output transitively
depends on. The user picks a thin user-facing surface from that list; every
unselected input falls back to its `.test.yaml` default at compute time.

Two design choices that keep this universal across rule packs:

1. **Imports are followed transitively.** A program YAML lists `imports:`
   pointing at sibling rule files (across federal/state repos). We load every
   one and union their rules into the index, so the graph doesn't stop at file
   boundaries.

2. **Formula-text parsing.** RuleSpec formulas are short Python-ish
   expressions referencing other rule and input names by bare identifier. We
   tokenize each formula, filter out language keywords/builtins, and resolve
   the rest against the rule and input indices. ~90% accurate; the long tail
   is fine because compute uses test-fixture defaults for any input the user
   doesn't expose.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from spec_loader import (
    collect_required_input_keys,
    find_test_template,
    first_test_case,
    is_input_id,
    is_relation_id,
    iter_outputs_in_template,
)

# RuleSpec language reserved words and builtins. Anything appearing in a formula
# that matches these is *not* a rule/input reference.
RESERVED = frozenset({
    # control flow
    "if", "else", "elif", "and", "or", "not", "in", "is", "true", "false", "none",
    # builtins
    "min", "max", "abs", "round", "floor", "ceil", "len",
    # axiom-rules-engine functions seen in CO SNAP formulas
    "count_where", "sum_where", "where", "count", "any", "all",
    # types occasionally referenced
    "money", "decimal", "integer", "boolean", "date",
})

# Bare identifiers — e.g. `snap_countable_earned_income`. We deliberately don't
# match attribute access (`a.b`), since RuleSpec doesn't use it.
_IDENT_RE = re.compile(r"\b[a-zA-Z_][a-zA-Z0-9_]*\b")


@dataclass
class RuleNode:
    """One rule in the index, keyed by its durable legal ID."""
    legal_id: str
    name: str
    file_legal_id: str
    kind: str | None = None
    entity: str | None = None
    dtype: str | None = None
    period: str | None = None
    unit: str | None = None
    source: str | None = None
    formula: str = ""
    indexed_by: str | None = None
    parameter_values: Any = None
    # Resolved legal IDs of rules/inputs/relations this rule depends on.
    rule_deps: list[str] = field(default_factory=list)
    input_deps: list[str] = field(default_factory=list)
    relation_deps: list[str] = field(default_factory=list)


@dataclass
class InputNode:
    legal_id: str
    name: str
    file_legal_id: str
    sample: Any = None
    dtype: str | None = None
    # Entity scope: "Person" if the input lives under a relation member dict
    # in the test fixture (or is referenced by a Person-scope rule),
    # "Household" otherwise. Drives whether the dashboard should ask the user
    # once or per-member.
    entity: str = "Household"
    # When entity == "Person", this is the relation legal ID it belongs to
    # (e.g. `us:statutes/7/2012/j#relation.member_of_household`). Lets the
    # builder auto-attach the input to the right relation's memberInputs.
    relation_legal_id: str | None = None


@dataclass
class RelationNode:
    legal_id: str
    name: str
    file_legal_id: str
    member_input_ids: list[str] = field(default_factory=list)


@dataclass
class ProgramGraph:
    """Everything the builder needs to drive an output-first selection flow."""
    rules: dict[str, RuleNode]
    inputs: dict[str, InputNode]
    relations: dict[str, RelationNode]
    # Outputs eligible to be queried — derived rules from the program's own file.
    own_outputs: list[str]
    # All terminal rules (no other rule depends on them) — float to top of UI.
    terminal_outputs: list[str]


def _file_legal_id(repo: str, path: str) -> str:
    """`rulespec-us-co` + `regulations/10-ccr-2506-1/4.207.3.yaml` → `us-co:regulations/10-ccr-2506-1/4.207.3`."""
    if repo.startswith("rulespec-"):
        jurisdiction = repo[len("rulespec-"):]
    elif repo.startswith("rules-"):
        jurisdiction = repo[len("rules-"):]
    else:
        jurisdiction = repo
    cleaned = path.removesuffix(".yaml")
    return f"{jurisdiction}:{cleaned}"


def _import_to_repo_path(import_id: str) -> tuple[str, str]:
    """`us-co:regulations/10-ccr-2506-1/4.207.3` → (`rulespec-us-co`, `regulations/10-ccr-2506-1/4.207.3.yaml`)."""
    jurisdiction, _, body = import_id.partition(":")
    return f"rulespec-{jurisdiction}", f"{body}.yaml"


def _repo_dir(parent: Path, repo: str, rel_path: str | None = None) -> Path:
    """Resolve a rule-pack repo, honoring the same alias roots as axiom-rules.

    Local development may have canonical aliases in `compute/_axiom` such as
    `rules-us -> /Users/.../rulespec-us`. Prefer those over stale sibling
    checkouts so the graph and engine inspect the same files.
    """
    candidates: list[Path] = []
    if env_roots := os.environ.get("AXIOM_RULESPEC_REPO_ROOTS"):
        for raw in env_roots.split(os.pathsep):
            if not raw:
                continue
            root = Path(raw).expanduser()
            candidates.append(root if root.name == repo else root / repo)
    candidates.append(parent / repo)
    # Generated composed programs live under compute/artifacts, whose parent
    # is not the sibling directory containing local rulespec-* checkouts.
    candidates.append(Path(__file__).resolve().parents[2] / repo)

    for candidate in candidates:
        if rel_path is None:
            if candidate.exists():
                return candidate
        elif (candidate / rel_path).exists():
            return candidate
    return candidates[0]


def _tokenize_formula(formula: str) -> set[str]:
    """All bare identifiers in a formula, lowercased — minus reserved words and pure numbers."""
    tokens = set(_IDENT_RE.findall(formula or ""))
    return {t for t in tokens if t.lower() not in RESERVED and not t.isdigit()}


def _add_file_to_index(
    repo_root: Path,
    repo: str,
    rel_path: str,
    rules: dict[str, RuleNode],
    rule_local_index: dict[str, list[RuleNode]],
    visited: set[str],
) -> None:
    """Load a YAML file and append its rules to the index. Recurse into imports."""
    file_id = _file_legal_id(repo, rel_path)
    if file_id in visited:
        return
    visited.add(file_id)

    yaml_path = _repo_dir(repo_root.parent, repo, rel_path) / rel_path
    if not yaml_path.exists():
        return  # missing rule pack — caller loaded only what's on disk

    parsed = yaml.safe_load(yaml_path.read_text())
    if not isinstance(parsed, dict):
        return

    for rule in parsed.get("rules", []) or []:
        if not isinstance(rule, dict):
            continue
        name = rule.get("name")
        if not name:
            continue
        formula = ""
        parameter_values = None
        versions = rule.get("versions")
        if isinstance(versions, list) and versions:
            latest = versions[-1]
            formula = latest.get("formula", "") or ""
            parameter_values = latest.get("values")
        node = RuleNode(
            legal_id=f"{file_id}#{name}",
            name=name,
            file_legal_id=file_id,
            kind=rule.get("kind"),
            entity=rule.get("entity"),
            dtype=rule.get("dtype"),
            period=rule.get("period"),
            unit=rule.get("unit"),
            source=rule.get("source"),
            formula=formula,
            indexed_by=rule.get("indexed_by"),
            parameter_values=parameter_values,
        )
        rules[node.legal_id] = node
        rule_local_index.setdefault(name, []).append(node)

    # Recurse into imports — they share the same `repo_root.parent` (sibling repos).
    for import_id in parsed.get("imports", []) or []:
        if not isinstance(import_id, str):
            continue
        sub_repo, sub_path = _import_to_repo_path(import_id)
        _add_file_to_index(repo_root, sub_repo, sub_path, rules, rule_local_index, visited)


def _resolve_dependencies(
    node: RuleNode,
    rule_local_index: dict[str, list[RuleNode]],
    input_local_index: dict[str, list[InputNode]],
    relation_index: dict[str, RelationNode],
) -> None:
    """Resolve the bare-identifier tokens in a rule's formula to legal IDs."""
    seen_rules: set[str] = set()
    seen_inputs: set[str] = set()
    seen_relations: set[str] = set()

    for token in _tokenize_formula(node.formula):
        # Relations: matched by relation name (the part after `relation.`).
        # Check these before rules because RuleSpec data_relation entries are
        # also indexed as rules with the same bare name.
        matched_relation = False
        for rel in relation_index.values():
            if rel.name == token:
                seen_relations.add(rel.legal_id)
                matched_relation = True
                break
        if matched_relation:
            continue

        # Other rules: prefer ones in the same file, fall back to first match.
        if token in rule_local_index:
            same_file = [r for r in rule_local_index[token] if r.file_legal_id == node.file_legal_id]
            chosen = same_file[0] if same_file else rule_local_index[token][0]
            if chosen.legal_id != node.legal_id:
                seen_rules.add(chosen.legal_id)
            continue

        # Inputs: same heuristic (same-file first, else first match).
        if token in input_local_index:
            same_file = [i for i in input_local_index[token] if i.file_legal_id == node.file_legal_id]
            chosen_input = same_file[0] if same_file else input_local_index[token][0]
            seen_inputs.add(chosen_input.legal_id)
            continue

    node.rule_deps = sorted(seen_rules)
    node.input_deps = sorted(seen_inputs)
    node.relation_deps = sorted(seen_relations)


def _terminal_outputs(rules: dict[str, RuleNode]) -> list[str]:
    """Rules nothing else in the index depends on — typically what users want to surface."""
    referenced: set[str] = set()
    for r in rules.values():
        referenced.update(r.rule_deps)
    return sorted(rid for rid in rules if rid not in referenced)


def _dtype_for_fixture_value(value: Any) -> str:
    """Best-effort dtype for fixture-only outputs synthesized into the graph."""
    if isinstance(value, bool):
        return "Boolean"
    if isinstance(value, int) and not isinstance(value, bool):
        return "Integer"
    if isinstance(value, float):
        return "Decimal"
    if isinstance(value, str):
        if value in {"holds", "not_holds", "undetermined"}:
            return "Judgment"
        if len(value) == 10 and value[4] == "-" and value[7] == "-":
            return "Date"
        return "String"
    return "Decimal"


def _dtype_for_input_sample(value: Any) -> str | None:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int) and not isinstance(value, bool):
        return "integer"
    if isinstance(value, float):
        return "decimal"
    if isinstance(value, str):
        if len(value) == 10 and value[4] == "-" and value[7] == "-":
            return "date"
        return "string"
    return None


def _token_has_numeric_context(token: str, formula: str) -> bool:
    escaped = re.escape(token)
    patterns = (
        rf"\b{escaped}\b\s*(?:[<>]=?|==|!=)",
        rf"(?:[<>]=?|==|!=)\s*\b{escaped}\b",
        rf"\b{escaped}\b\s*[-+*/]",
        rf"[-+*/]\s*\b{escaped}\b",
    )
    return any(re.search(pattern, formula or "") for pattern in patterns)


def _infer_input_dtype(name: str, sample: Any = None, formula: str = "", rule_dtype: str | None = None) -> str:
    sample_dtype = _dtype_for_input_sample(sample)
    if sample_dtype:
        return sample_dtype

    n = name.lower()
    if "date" in n:
        return "date"
    if n.endswith("_age") or n == "age" or n.endswith("_size") or n.endswith("_count"):
        return "integer"
    if re.search(r"(^|_)(days|months|years|hours|number|ordinal)($|_)", n):
        return "integer"

    boolean_starts = (
        "is_", "has_", "was_", "were_", "does_", "do_", "will_", "should_",
        "can_", "must_", "resident_", "member_is_", "member_has_",
        "household_is_", "household_has_", "household_lives_",
        "household_contains_", "household_pays_", "household_received_",
        "household_in_", "person_is_", "person_has_",
    )
    boolean_endings = (
        "_eligible", "_active", "_received", "_paid", "_applies",
        "_required", "_present", "_member", "_holds", "_passed",
        "_satisfied", "_met", "_complies", "_complying", "_provided",
        "_disqualified", "_disqualification", "_pending", "_excluded",
        "_exempt", "_owned", "_purchased", "_terminated", "_known",
        "_anticipated", "_assigned", "_referred", "_offered", "_allowed",
        "_verified", "_confirmed", "_separately",
    )
    boolean_contains = (
        "_entitled_to_", "_eligible_for_", "_subject_to_",
        "_responsible_for_", "_required_to_", "_exempt_from_",
        "_refused_or_failed_", "_failed_to_", "_is_", "_has_",
    )
    if (
        n.startswith(boolean_starts)
        or any(n.endswith(suffix) for suffix in boolean_endings)
        or any(piece in n for piece in boolean_contains)
    ):
        return "boolean"

    if (
        (rule_dtype or "").lower() == "judgment"
        and formula
        and not _token_has_numeric_context(name, formula)
    ):
        return "boolean"

    if re.search(r"income|wage|cost|expense|allotment|amount|deduction|payment|earnings|value", n):
        return "money"
    return "decimal"


def _add_fixture_outputs_to_index(
    template: dict[str, Any] | None,
    rules: dict[str, RuleNode],
    rule_local_index: dict[str, list[RuleNode]],
) -> None:
    """Index output values present only in the test fixture.

    Some composed programs bridge a generic statutory "input" with a concrete
    upstream output supplied by the program fixture. If the graph ignores that
    fixture-only output, formula parsing later synthesizes a fake #input node
    and the UI offers a computed intermediate as a user question.
    """
    if not template:
        return
    for legal_id, value in iter_outputs_in_template(template):
        if not isinstance(legal_id, str) or "#" not in legal_id:
            continue
        if is_input_id(legal_id) or is_relation_id(legal_id):
            continue
        if legal_id in rules:
            continue
        file_part, _, name = legal_id.partition("#")
        if not name:
            continue
        node = RuleNode(
            legal_id=legal_id,
            name=name,
            file_legal_id=file_part,
            kind="derived",
            entity="Household",
            dtype=_dtype_for_fixture_value(value),
            source="Fixture output",
            formula="",
        )
        rules[legal_id] = node
        rule_local_index.setdefault(name, []).append(node)


def build_graph(program_yaml: Path, repo: str) -> ProgramGraph:
    """Construct the full rule + input + relation graph for a program."""
    resolved_program = program_yaml.resolve()
    repo_root = resolved_program  # arbitrary path inside the repo
    # Walk up to the repo dir so we can resolve imports against the parent of the repo.
    while repo_root.name != repo and repo_root.parent != repo_root:
        repo_root = repo_root.parent
    if repo_root.name != repo:
        # `rules-us-co` is often a symlink to `rulespec-us-co`. Path.resolve()
        # follows that symlink, so the requested repo name may not exist in
        # the resolved ancestry. Fall back to the first resolved RuleSpec repo
        # ancestor so alias routes still build a real graph.
        for parent in resolved_program.parents:
            if parent.name.startswith(("rulespec-", "rules-")):
                repo_root = parent
                repo = parent.name
                break

    rules: dict[str, RuleNode] = {}
    rule_local_index: dict[str, list[RuleNode]] = {}
    visited: set[str] = set()

    program_rel = str(resolved_program.relative_to(repo_root))
    _add_file_to_index(repo_root, repo, program_rel, rules, rule_local_index, visited)

    own_file_id = _file_legal_id(repo, program_rel)
    own_outputs = sorted(rid for rid, r in rules.items() if r.file_legal_id == own_file_id)

    # Inputs and relations from the .test.yaml fixture — that's the canonical set
    # of facts the engine is configured to accept.
    inputs: dict[str, InputNode] = {}
    relations: dict[str, RelationNode] = {}
    # Map every per-member input legal ID → its parent relation, so we can
    # tag the InputNode with entity=Person and the relation it belongs to.
    person_input_to_relation: dict[str, str] = {}
    template = first_test_case(t) if (t := find_test_template(program_yaml)) else None
    if template:
        # First pass: walk relations, learn which inputs are per-member.
        for legal_id, value in template.get("input", {}).items():
            if is_relation_id(legal_id) and isinstance(value, list) and value:
                member_dict = value[0] if isinstance(value[0], dict) else {}
                for member_input_id in member_dict.keys():
                    person_input_to_relation[member_input_id] = legal_id

        for legal_id in collect_required_input_keys(template):
            file_part, _, name_part = legal_id.partition("#")
            if is_relation_id(legal_id):
                rel_value = template.get("input", {}).get(legal_id, [])
                member_inputs: list[str] = []
                if isinstance(rel_value, list) and rel_value and isinstance(rel_value[0], dict):
                    member_inputs = sorted(rel_value[0].keys())
                relations[legal_id] = RelationNode(
                    legal_id=legal_id,
                    name=name_part.removeprefix("relation."),
                    file_legal_id=file_part,
                    member_input_ids=member_inputs,
                )
            elif is_input_id(legal_id):
                # Sample value: prefer top-level, fall back to per-member.
                sample = template.get("input", {}).get(legal_id)
                if sample is None:
                    for member_dict in template.get("input", {}).values():
                        if isinstance(member_dict, list) and member_dict and isinstance(member_dict[0], dict):
                            if legal_id in member_dict[0]:
                                sample = member_dict[0][legal_id]
                                break
                relation_id = person_input_to_relation.get(legal_id)
                inputs[legal_id] = InputNode(
                    legal_id=legal_id,
                    name=name_part.removeprefix("input."),
                    file_legal_id=file_part,
                    sample=sample,
                    dtype=_infer_input_dtype(
                        name_part.removeprefix("input."),
                        sample,
                    ),
                    entity="Person" if relation_id else "Household",
                    relation_legal_id=relation_id,
                )

    _add_fixture_outputs_to_index(template, rules, rule_local_index)

    # Composed programs may not have a .test.yaml fixture yet. In that case
    # discover relation definitions from imported RuleSpec data_relation rules
    # so Person-scope inputs can still be routed through household members.
    for rule in rules.values():
        if rule.kind != "data_relation":
            continue
        relation_id = f"{rule.file_legal_id}#relation.{rule.name}"
        relations.setdefault(
            relation_id,
            RelationNode(
                legal_id=relation_id,
                name=rule.name,
                file_legal_id=rule.file_legal_id,
            ),
        )

    input_local_index: dict[str, list[InputNode]] = {}
    for inp in inputs.values():
        input_local_index.setdefault(inp.name, []).append(inp)

    # Discover inputs by parsing rule formulas. Each discovered input
    # inherits the entity scope of the rule that references it (Person rules
    # → Person input; Household rules → Household input) so per-member fields
    # route through the relation correctly.
    relation_names = {rel.name for rel in relations.values()}
    relation_id_by_name: dict[str, str] = {rel.name: rel.legal_id for rel in relations.values()}
    for rule in list(rules.values()):
        for token in _tokenize_formula(rule.formula):
            if token == rule.name:
                continue
            if token in rule_local_index:
                continue
            if token in input_local_index:
                continue
            if token in relation_names:
                continue
            synthesized_id = f"{rule.file_legal_id}#input.{token}"
            if synthesized_id in inputs:
                continue
            rule_entity = (rule.entity or "").strip()
            entity = "Person" if rule_entity == "Person" else "Household"
            # Best-effort relation guess for Person-scope inputs: pick the
            # first known household relation the rule's formula references.
            rel_id: str | None = None
            if entity == "Person":
                for rel_name in relation_names:
                    if rel_name in _tokenize_formula(rule.formula):
                        rel_id = relation_id_by_name.get(rel_name)
                        break
                if rel_id is None and len(relation_id_by_name) == 1:
                    rel_id = next(iter(relation_id_by_name.values()))
            node = InputNode(
                legal_id=synthesized_id,
                name=token,
                file_legal_id=rule.file_legal_id,
                sample=None,
                dtype=_infer_input_dtype(token, None, rule.formula, rule.dtype),
                entity=entity,
                relation_legal_id=rel_id,
            )
            inputs[synthesized_id] = node
            input_local_index.setdefault(token, []).append(node)
            if rel_id and rel_id in relations:
                relations[rel_id].member_input_ids.append(node.legal_id)

    for relation in relations.values():
        relation.member_input_ids = sorted(set(relation.member_input_ids))

    for node in rules.values():
        _resolve_dependencies(node, rule_local_index, input_local_index, relations)

    return ProgramGraph(
        rules=rules,
        inputs=inputs,
        relations=relations,
        own_outputs=own_outputs,
        terminal_outputs=_terminal_outputs(rules),
    )


def transitive_dependencies(
    graph: ProgramGraph, output_ids: list[str]
) -> dict[str, list[str]]:
    """For each requested output, walk dependencies → return {input/relation legal IDs : depth}.

    Depth counts edges from the output through `rule_deps` chains; direct
    inputs are depth 1. The UI sorts by depth so headline factors surface
    above plumbing.
    """
    seen_inputs: dict[str, int] = {}
    seen_relations: dict[str, int] = {}

    def walk(rule_id: str, depth: int) -> None:
        rule = graph.rules.get(rule_id)
        if not rule:
            return
        for inp in rule.input_deps:
            existing = seen_inputs.get(inp)
            if existing is None or depth < existing:
                seen_inputs[inp] = depth
        for rel in rule.relation_deps:
            existing = seen_relations.get(rel)
            if existing is None or depth < existing:
                seen_relations[rel] = depth
        for child_id in rule.rule_deps:
            walk(child_id, depth + 1)

    for oid in output_ids:
        walk(oid, 1)

    return {
        "inputs": dict(sorted(seen_inputs.items(), key=lambda kv: (kv[1], kv[0]))),
        "relations": dict(sorted(seen_relations.items(), key=lambda kv: (kv[1], kv[0]))),
    }


def resolve_input_legal_id(graph: ProgramGraph, bare_name: str) -> list[str]:
    """Find the legal ID(s) for a bare input name referenced by a rule.

    Used when the engine demands an input the test fixture doesn't enumerate.
    Strategy: walk every rule whose formula tokens include `bare_name`, pick
    the rule's file legal ID, and synthesize `<file>#input.<bare_name>`. Falls
    back to any input known by name from the test fixture.

    Returns candidates in preference order. The caller tries each until the
    engine accepts one (different files may declare same-named inputs).
    """
    candidates: list[str] = []

    # Strongest: same name already known to the graph (declared in test fixture).
    for inp in graph.inputs.values():
        if inp.name == bare_name:
            candidates.append(inp.legal_id)

    # Weaker: scan formulas for the token. Any rule referencing it has the
    # input in scope under its file's legal ID.
    for rule in graph.rules.values():
        if bare_name in _tokenize_formula(rule.formula):
            synthesized = f"{rule.file_legal_id}#input.{bare_name}"
            if synthesized not in candidates:
                candidates.append(synthesized)

    return candidates


def graph_to_dict(graph: ProgramGraph) -> dict[str, Any]:
    return {
        "rules": [
            {
                "legalId": r.legal_id,
                "name": r.name,
                "fileLegalId": r.file_legal_id,
                "kind": r.kind,
                "entity": r.entity,
                "dtype": r.dtype,
                "period": r.period,
                "unit": r.unit,
                "source": r.source,
                "ruleDeps": r.rule_deps,
                "inputDeps": r.input_deps,
                "relationDeps": r.relation_deps,
                # Latest-version formula text — for parameter rules this is
                # the constant value (e.g. "35"); for derived rules it's
                # the expression we already render in the graph.
                "formula": r.formula,
            }
            for r in graph.rules.values()
        ],
        "inputs": [
            {
                "legalId": i.legal_id,
                "name": i.name,
                "fileLegalId": i.file_legal_id,
                "sample": i.sample,
                "dtype": i.dtype,
                "entity": i.entity,
                "relationLegalId": i.relation_legal_id,
            }
            for i in graph.inputs.values()
        ],
        "relations": [
            {
                "legalId": r.legal_id,
                "name": r.name,
                "fileLegalId": r.file_legal_id,
                "memberInputIds": r.member_input_ids,
            }
            for r in graph.relations.values()
        ],
        "ownOutputs": graph.own_outputs,
        "terminalOutputs": graph.terminal_outputs,
    }

"""Tests for the `kind` field on trace input leaves.

`_input_leaf` distinguishes three input shapes the frontend renders
differently:

  • scalar   — single Household-level value (the default before this field
               existed)
  • relation — a `#relation.*` reference whose value is a list of member
               dicts; `memberCount` reports how many members were supplied
  • member   — an `#input.*` whose graph metadata marks it as Person-scope;
               the engine reads its value once per relation member, so the
               renderer should label it "per member" and source it from the
               relation rather than a top-level form field

These tests pin down the contract end-to-end (`_input_leaf` + integration
through `_build_trace_tree`) so a future engine refactor can't silently
drop the kind tagging.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

COMPUTE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(COMPUTE_ROOT))

from engine import _build_trace_tree, _input_leaf


class InputLeafKindTests(unittest.TestCase):
    def test_scalar_input_with_no_metadata_defaults_to_scalar_kind(self) -> None:
        leaf = _input_leaf(
            "a:foo#input.household_size",
            flat_inputs={"a:foo#input.household_size": 3},
            user_keys={"a:foo#input.household_size"},
            input_meta=None,
        )
        self.assertEqual(leaf["kind"], "scalar")
        self.assertEqual(leaf["value"], 3)
        self.assertEqual(leaf["inputSource"], "user")
        self.assertNotIn("memberCount", leaf)
        self.assertNotIn("relationLegalId", leaf)

    def test_household_entity_input_stays_scalar_kind(self) -> None:
        leaf = _input_leaf(
            "a:foo#input.household_size",
            flat_inputs={"a:foo#input.household_size": 3},
            user_keys=set(),
            input_meta={
                "a:foo#input.household_size": {
                    "entity": "Household",
                    "relation_legal_id": None,
                },
            },
        )
        self.assertEqual(leaf["kind"], "scalar")

    def test_relation_input_tags_kind_and_member_count(self) -> None:
        leaf = _input_leaf(
            "a:foo#relation.member_of_household",
            flat_inputs={
                "a:foo#relation.member_of_household": [
                    {"a:foo#input.member_age": 30},
                    {"a:foo#input.member_age": 35},
                    {"a:foo#input.member_age": 8},
                ],
            },
            user_keys={"a:foo#relation.member_of_household"},
            input_meta=None,
        )
        self.assertEqual(leaf["kind"], "relation")
        self.assertEqual(leaf["memberCount"], 3)
        self.assertEqual(leaf["value"], 3)
        self.assertEqual(leaf["inputSource"], "user")
        self.assertEqual(leaf["label"], "member_of_household")

    def test_relation_with_no_members_reports_zero(self) -> None:
        leaf = _input_leaf(
            "a:foo#relation.member_of_household",
            flat_inputs={},
            user_keys=set(),
            input_meta=None,
        )
        self.assertEqual(leaf["kind"], "relation")
        self.assertEqual(leaf["memberCount"], 0)
        self.assertEqual(leaf["inputSource"], "default")

    def test_person_scope_input_tags_member_kind_and_surfaces_relation(self) -> None:
        leaf = _input_leaf(
            "a:foo#input.member_age",
            flat_inputs={"a:foo#input.member_age": 0},
            user_keys=set(),
            input_meta={
                "a:foo#input.member_age": {
                    "entity": "Person",
                    "relation_legal_id": "a:foo#relation.member_of_household",
                },
            },
        )
        self.assertEqual(leaf["kind"], "member")
        self.assertEqual(
            leaf["relationLegalId"],
            "a:foo#relation.member_of_household",
        )
        self.assertEqual(leaf["label"], "member_age")
        # No memberCount on a per-member input — that lives on the relation.
        self.assertNotIn("memberCount", leaf)

    def test_person_scope_input_keeps_member_kind_even_when_supplied(self) -> None:
        # When the renderer plumbed values into the relation members,
        # `user_keys` picks up the inner input keys too. Kind shouldn't
        # flip just because the source flipped to "user".
        leaf = _input_leaf(
            "a:foo#input.member_age",
            flat_inputs={"a:foo#input.member_age": 30},
            user_keys={"a:foo#input.member_age"},
            input_meta={
                "a:foo#input.member_age": {
                    "entity": "Person",
                    "relation_legal_id": "a:foo#relation.member_of_household",
                },
            },
        )
        self.assertEqual(leaf["kind"], "member")
        self.assertEqual(leaf["inputSource"], "user")


class BuildTraceTreeIntegrationTests(unittest.TestCase):
    """`_input_leaf` is called from inside `_build_trace_tree` once per rule
    input dep. Make sure the kind tagging survives that path so the
    frontend always sees the right shape on the final TraceNode tree."""

    def test_relation_dep_lands_on_rule_as_kind_relation(self) -> None:
        traces = _build_trace_tree(
            ["a:foo#snap_eligible"],
            raw_trace={
                "a:foo#snap_eligible": {
                    "kind": "judgment",
                    "name": "snap_eligible",
                    "outcome": "holds",
                    "dependencies": [],
                },
            },
            flat_inputs={
                "a:foo#relation.member_of_household": [{}, {}],
                "a:foo#input.member_age": 30,
            },
            user_keys={"a:foo#relation.member_of_household"},
            rule_rule_deps={},
            rule_input_deps={
                "a:foo#snap_eligible": [
                    "a:foo#relation.member_of_household",
                    "a:foo#input.member_age",
                ],
            },
            rule_formulas={},
            fixture_outputs={},
            input_meta={
                "a:foo#input.member_age": {
                    "entity": "Person",
                    "relation_legal_id": "a:foo#relation.member_of_household",
                },
            },
        )
        children = traces["a:foo#snap_eligible"]["children"]
        by_id = {c["legalId"]: c for c in children}
        self.assertEqual(by_id["a:foo#relation.member_of_household"]["kind"], "relation")
        self.assertEqual(by_id["a:foo#relation.member_of_household"]["memberCount"], 2)
        self.assertEqual(by_id["a:foo#input.member_age"]["kind"], "member")
        self.assertEqual(
            by_id["a:foo#input.member_age"]["relationLegalId"],
            "a:foo#relation.member_of_household",
        )


class StaticStubFallbackTests(unittest.TestCase):
    """When the engine short-circuits an AND/OR or skips a branch, the
    static dep is missing from `raw_trace`. `_build_trace_tree` should
    still surface it — relations as relation-kind leaves with member
    counts, rules as `notEvaluated: True` stubs — so the formula tokens
    in the UI always resolve to something concrete.

    Without these fallbacks, the formula `a and b` would silently lose
    `b` from the trace whenever `a` was false, leaving the formula's
    pill for `b` in the graph as a generic "unknown" node.
    """

    def _build_short_circuited(self):
        return _build_trace_tree(
            ["a:foo#outer"],
            raw_trace={
                # Only `a` was evaluated; engine short-circuited before `b`
                # was reached.
                "a:foo#outer": {
                    "kind": "judgment",
                    "name": "outer",
                    "outcome": "not_holds",
                    "dependencies": ["a:foo#left"],
                },
                "a:foo#left": {
                    "kind": "judgment",
                    "name": "left",
                    "outcome": "not_holds",
                    "dependencies": [],
                },
            },
            flat_inputs={
                "a:foo#relation.members": [{}, {}, {}],
            },
            user_keys={"a:foo#relation.members"},
            rule_rule_deps={
                "a:foo#outer": [
                    "a:foo#left",
                    "a:foo#right_unevaluated",  # rule the engine skipped
                    "a:foo#members",  # bare-name relation reference
                ],
            },
            rule_input_deps={},
            rule_formulas={},
            fixture_outputs={},
            input_meta={},
            relation_meta={
                # Indexed by both canonical and bare-name forms (matches
                # what `_rule_metadata_for` produces).
                "a:foo#relation.members": {
                    "legal_id": "a:foo#relation.members",
                    "name": "members",
                    "file_legal_id": "a:foo",
                },
                "a:foo#members": {
                    "legal_id": "a:foo#relation.members",
                    "name": "members",
                    "file_legal_id": "a:foo",
                },
            },
            rule_meta={
                "a:foo#right_unevaluated": {
                    "name": "right_unevaluated",
                    "dtype": "judgment",
                    "source": "test source",
                },
            },
        )

    def test_short_circuit_surfaces_unevaluated_rule_as_stub(self) -> None:
        traces = self._build_short_circuited()
        children = traces["a:foo#outer"]["children"]
        by_id = {c["legalId"]: c for c in children}
        self.assertIn("a:foo#right_unevaluated", by_id)
        stub = by_id["a:foo#right_unevaluated"]
        self.assertTrue(stub["notEvaluated"])
        self.assertIsNone(stub["value"])
        self.assertEqual(stub["dtype"], "judgment")
        self.assertEqual(stub["label"], "right_unevaluated")

    def test_static_parameter_dep_surfaces_as_constant_not_unevaluated(self) -> None:
        traces = _build_trace_tree(
            ["a:foo#asset_limit"],
            raw_trace={
                "a:foo#asset_limit": {
                    "value": {"kind": "decimal", "value": "3000"},
                    "dtype": "money",
                    "name": "asset_limit",
                    "dependencies": [],
                },
            },
            flat_inputs={},
            user_keys=set(),
            rule_rule_deps={
                "a:foo#asset_limit": ["a:foo#asset_limit_elderly"],
            },
            rule_input_deps={},
            rule_formulas={
                "a:foo#asset_limit": "if elderly:\n    asset_limit_elderly\nelse: asset_limit_other",
            },
            fixture_outputs={},
            input_meta={},
            relation_meta={},
            rule_meta={
                "a:foo#asset_limit_elderly": {
                    "name": "asset_limit_elderly",
                    "kind": "parameter",
                    "dtype": "money",
                    "source": "test source",
                    "formula": "4500",
                },
            },
        )

        children = traces["a:foo#asset_limit"]["children"]
        by_id = {c["legalId"]: c for c in children}
        self.assertEqual(by_id["a:foo#asset_limit_elderly"]["value"], 4500)
        self.assertNotIn("notEvaluated", by_id["a:foo#asset_limit_elderly"])

    def test_unevaluated_rule_stub_includes_its_own_dependencies(self) -> None:
        traces = _build_trace_tree(
            ["a:foo#outer"],
            raw_trace={
                "a:foo#outer": {
                    "kind": "judgment",
                    "name": "outer",
                    "outcome": "holds",
                    "dependencies": [],
                },
            },
            flat_inputs={"a:foo#input.household_size": 1},
            user_keys=set(),
            rule_rule_deps={
                "a:foo#outer": ["a:foo#skipped_branch"],
            },
            rule_input_deps={
                "a:foo#skipped_branch": ["a:foo#input.household_size"],
            },
            rule_formulas={},
            fixture_outputs={},
            input_meta={
                "a:foo#input.household_size": {
                    "entity": "Household",
                    "file_legal_id": "a:foo",
                },
            },
            relation_meta={},
            rule_meta={
                "a:foo#skipped_branch": {
                    "name": "skipped_branch",
                    "kind": "derived",
                    "dtype": "judgment",
                    "source": "test source",
                    "formula": "household_size > 0",
                },
            },
        )

        outer_children = traces["a:foo#outer"]["children"]
        skipped = {c["legalId"]: c for c in outer_children}["a:foo#skipped_branch"]
        self.assertTrue(skipped["notEvaluated"])
        child_ids = {c["legalId"] for c in skipped["children"]}
        self.assertIn("a:foo#input.household_size", child_ids)

    def test_count_where_person_predicate_is_not_labeled_unevaluated(self) -> None:
        traces = _build_trace_tree(
            ["a:foo#outer"],
            raw_trace={
                "a:foo#outer": {
                    "kind": "judgment",
                    "name": "outer",
                    "outcome": "holds",
                    "dependencies": ["a:foo#relation.members"],
                },
            },
            flat_inputs={"a:foo#relation.members": [{}]},
            user_keys={"a:foo#relation.members"},
            rule_rule_deps={
                "a:foo#outer": [
                    "a:foo#relation.members",
                    "a:foo#member_eligible",
                ],
            },
            rule_input_deps={},
            rule_formulas={
                "a:foo#outer": "count_where(members, member_eligible) > 0",
            },
            fixture_outputs={},
            input_meta={},
            relation_meta={
                "a:foo#relation.members": {
                    "legal_id": "a:foo#relation.members",
                    "name": "members",
                    "file_legal_id": "a:foo",
                },
            },
            rule_meta={
                "a:foo#member_eligible": {
                    "name": "member_eligible",
                    "kind": "derived",
                    "entity": "Person",
                    "dtype": "judgment",
                    "source": "test source",
                    "formula": "member_is_eligible",
                },
            },
        )

        children = traces["a:foo#outer"]["children"]
        predicate = {c["legalId"]: c for c in children}["a:foo#member_eligible"]
        self.assertEqual(predicate["evaluationRole"], "relationPredicate")
        self.assertNotIn("notEvaluated", predicate)

    def test_person_dependencies_under_relation_predicate_keep_predicate_role(self) -> None:
        traces = _build_trace_tree(
            ["a:foo#outer"],
            raw_trace={
                "a:foo#outer": {
                    "kind": "judgment",
                    "name": "outer",
                    "outcome": "holds",
                    "dependencies": ["a:foo#relation.members"],
                },
            },
            flat_inputs={"a:foo#relation.members": [{}]},
            user_keys={"a:foo#relation.members"},
            rule_rule_deps={
                "a:foo#outer": [
                    "a:foo#relation.members",
                    "a:foo#member_eligible",
                ],
                "a:foo#member_eligible": ["a:foo#member_has_status"],
            },
            rule_input_deps={},
            rule_formulas={
                "a:foo#outer": "count_where(members, member_eligible) > 0",
            },
            fixture_outputs={},
            input_meta={},
            relation_meta={
                "a:foo#relation.members": {
                    "legal_id": "a:foo#relation.members",
                    "name": "members",
                    "file_legal_id": "a:foo",
                },
            },
            rule_meta={
                "a:foo#member_eligible": {
                    "name": "member_eligible",
                    "kind": "derived",
                    "entity": "Person",
                    "dtype": "judgment",
                    "source": "test source",
                    "formula": "member_has_status",
                },
                "a:foo#member_has_status": {
                    "name": "member_has_status",
                    "kind": "derived",
                    "entity": "Person",
                    "dtype": "judgment",
                    "source": "test source",
                    "formula": "true",
                },
            },
        )

        outer = traces["a:foo#outer"]
        member_eligible = {
            c["legalId"]: c for c in outer["children"]
        }["a:foo#member_eligible"]
        member_has_status = {
            c["legalId"]: c for c in member_eligible["children"]
        }["a:foo#member_has_status"]
        self.assertEqual(member_has_status["evaluationRole"], "relationPredicate")
        self.assertNotIn("notEvaluated", member_has_status)

    def test_member_input_leaf_includes_per_member_values(self) -> None:
        traces = _build_trace_tree(
            ["a:foo#member_check"],
            raw_trace={
                "a:foo#member_check": {
                    "kind": "judgment",
                    "name": "member_check",
                    "outcome": "holds",
                    "dependencies": [],
                },
            },
            flat_inputs={
                "a:foo#relation.members": [
                    {"a:foo#input.member_is_us_citizen": True},
                    {"a:foo#input.member_is_us_citizen": False},
                ],
            },
            user_keys={
                "a:foo#relation.members",
                "a:foo#input.member_is_us_citizen",
            },
            rule_rule_deps={},
            rule_input_deps={
                "a:foo#member_check": ["a:foo#input.member_is_us_citizen"],
            },
            rule_formulas={},
            fixture_outputs={},
            input_meta={
                "a:foo#input.member_is_us_citizen": {
                    "entity": "Person",
                    "relation_legal_id": "a:foo#relation.members",
                },
            },
            relation_meta={},
            rule_meta={},
        )

        child = traces["a:foo#member_check"]["children"][0]
        self.assertEqual(child["kind"], "member")
        self.assertEqual(child["memberCount"], 2)
        self.assertEqual(
            child["memberValues"],
            [
                {"index": 1, "value": True, "inputSource": "user"},
                {"index": 2, "value": False, "inputSource": "user"},
            ],
        )

    def test_bare_name_relation_dep_resolves_to_canonical_relation_leaf(self) -> None:
        traces = self._build_short_circuited()
        children = traces["a:foo#outer"]["children"]
        by_id = {c["legalId"]: c for c in children}
        # The bare-name dep id `a:foo#members` should resolve to a leaf
        # using the canonical `a:foo#relation.members` legal id (so the
        # frontend's tokenIndex strips `relation.` and matches the
        # formula's `members` token correctly).
        self.assertIn("a:foo#relation.members", by_id)
        rel = by_id["a:foo#relation.members"]
        self.assertEqual(rel["kind"], "relation")
        self.assertEqual(rel["memberCount"], 3)


if __name__ == "__main__":
    unittest.main()

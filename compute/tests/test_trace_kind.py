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


if __name__ == "__main__":
    unittest.main()

"""Unit tests for fixture-driven sensitivity scenarios. These don't
touch the engine — they verify that a .test.yaml fixture is parsed into
the expected Scenario objects and that caller inputs/relations override
fixture defaults during merging.
"""
from __future__ import annotations

import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

COMPUTE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(COMPUTE_ROOT))

import main
from spec_loader import iter_test_cases


def _write_program_pair(tmp: Path, fixture_yaml: str) -> Path:
    """Drop a stub program.yaml + program.test.yaml in tmp and return
    the program path so `find_test_template` will resolve the sibling."""
    program = tmp / "program.yaml"
    program.write_text("name: stub\nderived: []\n")
    (tmp / "program.test.yaml").write_text(fixture_yaml)
    return program


class IterTestCasesTests(unittest.TestCase):
    def test_list_format(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            fixture = textwrap.dedent("""
                - name: case_a
                  input:
                    a#input.x: 1
                - name: case_b
                  input:
                    a#input.x: 2
                """)
            test_path = Path(d) / "p.test.yaml"
            test_path.write_text(fixture)
            cases = list(iter_test_cases(test_path))
            self.assertEqual([c["name"] for c in cases], ["case_a", "case_b"])

    def test_dict_with_cases_key(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            fixture = textwrap.dedent("""
                cases:
                  - name: only
                    input: {}
                """)
            test_path = Path(d) / "p.test.yaml"
            test_path.write_text(fixture)
            cases = list(iter_test_cases(test_path))
            self.assertEqual(len(cases), 1)
            self.assertEqual(cases[0]["name"], "only")


class LoadFixtureScenariosTests(unittest.TestCase):
    def test_parses_inputs_and_relations(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            program = _write_program_pair(tmp, textwrap.dedent("""
                - name: working_adult
                  period: 2026-01
                  input:
                    a#input.household_size: 1
                    a#input.snap_gross_monthly_earned_income: 1000
                    a#relation.member_of_household:
                      - a#input.member_age: 30
                        a#input.is_disabled: false
                """))
            scenarios = main._load_cases_from_fixture(program)
            self.assertEqual(len(scenarios), 1)
            s = scenarios[0]
            self.assertEqual(s.name, "working_adult")
            self.assertEqual(s.inputs.get("a#input.household_size"), 1)
            self.assertEqual(s.inputs.get("a#input.snap_gross_monthly_earned_income"), 1000)
            self.assertIn("a#relation.member_of_household", s.relations)
            members = s.relations["a#relation.member_of_household"]
            self.assertEqual(members[0]["a#input.member_age"], 30)
            self.assertEqual(members[0]["a#input.is_disabled"], False)
            # Relations don't bleed into the input dict.
            self.assertNotIn("a#relation.member_of_household", s.inputs)

    def test_caps_at_max_scenarios(self) -> None:
        # Top-level loader caps at _MAX_FIXTURE_SCENARIOS even when the
        # underlying fixture has more cases. Cap lives on the public
        # entrypoint so the fixture parser stays simple and reusable.
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            cases_yaml = "\n".join(
                f"- name: case_{i}\n  input:\n    a#input.x: {i}"
                for i in range(main._MAX_FIXTURE_SCENARIOS + 3)
            )
            program = _write_program_pair(tmp, cases_yaml)
            scenarios = main._load_fixture_scenarios(program, queried_outputs=[])
            self.assertEqual(len(scenarios), main._MAX_FIXTURE_SCENARIOS)
            self.assertEqual(scenarios[0].name, "case_0")

    def test_returns_empty_when_no_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            program = Path(d) / "lonely.yaml"
            program.write_text("name: stub\n")
            self.assertEqual(main._load_cases_from_fixture(program), [])

    def test_assigns_default_name_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            program = _write_program_pair(tmp, textwrap.dedent("""
                - input:
                    a#input.x: 1
                """))
            scenarios = main._load_cases_from_fixture(program)
            self.assertEqual(scenarios[0].name, "case_0")


class SourceFileRoutingTests(unittest.TestCase):
    def test_load_fixture_scenarios_against_real_repos(self) -> None:
        # Real-data regression for the CO-imports-federal-output case.
        # Querying snap_excess_shelter_deduction_for_net_income from CO
        # SNAP should pull scenarios from 273/10.test.yaml (where the
        # rule is defined) rather than CO's own fixture (which doesn't
        # seed the federal aggregate inputs).
        from registry import resolve_program
        try:
            co_path = resolve_program(
                main._config,
                "rules-us-co",
                "policies/cdhs/snap/fy-2026-benefit-calculation.yaml",
            )
        except FileNotFoundError:
            self.skipTest("rules-us-co not checked out")
        scenarios = main._load_fixture_scenarios(
            co_path,
            ["us:regulations/7-cfr/273/10#snap_excess_shelter_deduction_for_net_income"],
        )
        self.assertTrue(scenarios, "expected federal fixture cases")
        first = scenarios[0]
        # The federal fixture is known to seed these aggregates; the CO
        # fixture is known not to.
        federal_aggregates = [
            "us:regulations/7-cfr/273/10#input.snap_total_allowable_shelter_expenses",
            "us:regulations/7-cfr/273/10#input.snap_gross_monthly_earned_income",
        ]
        for legal_id in federal_aggregates:
            self.assertIn(
                legal_id, first.inputs,
                f"{legal_id} should be set by the federal fixture",
            )


class MergeScenarioPayloadTests(unittest.TestCase):
    def test_caller_inputs_override_fixture(self) -> None:
        scenario = main.Scenario(
            name="t",
            inputs={"a#input.household_size": 1, "a#input.shelter": 500},
            relations={},
        )
        inputs, relations = main._merge_scenario_payload(
            scenario,
            {"a#input.household_size": 7},
            None,
        )
        self.assertEqual(inputs["a#input.household_size"], 7)  # caller wins
        self.assertEqual(inputs["a#input.shelter"], 500)       # fixture preserved
        self.assertEqual(relations, {})

    def test_caller_relations_override_fixture(self) -> None:
        scenario = main.Scenario(
            name="t",
            inputs={},
            relations={"a#relation.members": [{"a#input.age": 30}]},
        )
        inputs, relations = main._merge_scenario_payload(
            scenario,
            {},
            {"a#relation.members": [{"a#input.age": 70}]},
        )
        self.assertEqual(relations["a#relation.members"][0]["a#input.age"], 70)

    def test_returns_independent_copies(self) -> None:
        # Mutating the merged result shouldn't poison the scenario the
        # next perturbation pass reads from.
        scenario = main.Scenario(
            name="t",
            inputs={"a#input.x": 1},
            relations={"a#relation.r": [{"a#input.y": 2}]},
        )
        inputs, relations = main._merge_scenario_payload(scenario, {}, None)
        inputs["a#input.x"] = 99
        relations["a#relation.r"][0]["a#input.y"] = 99
        self.assertEqual(scenario.inputs["a#input.x"], 1)
        self.assertEqual(scenario.relations["a#relation.r"][0]["a#input.y"], 2)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import os
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dotenv import load_dotenv

COMPUTE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(COMPUTE_ROOT))

from engine import (
    _alternate_query_reference,
    _artifact_derived_id_cache,
    _build_trace_tree,
    _compile_cache,
    _dynamic_input_defaults,
    _filter_user_supplied_values,
    _query_reference,
    execute_real,
)
from graph import build_graph


SNAP_PROGRAM = Path("rules-us-co/policies/cdhs/snap/fy-2026-benefit-calculation.yaml")
SNAP_ELIGIBLE = "us-co:policies/cdhs/snap/fy-2026-benefit-calculation#snap_eligible"
SNAP_ALLOTMENT = "us-co:regulations/10-ccr-2506-1/4.207.2#snap_allotment"


class OutputQueryReferenceTest(unittest.TestCase):
    def setUp(self) -> None:
        _artifact_derived_id_cache.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.artifact = Path(self.tmp.name) / "compiled.json"

    def _write_artifact(self, derived: list[dict[str, object]]) -> None:
        self.artifact.write_text(json.dumps({"program": {"derived": derived}}))

    def test_uses_public_legal_id_when_compiled_artifact_has_one(self) -> None:
        self._write_artifact([
            {"id": SNAP_ALLOTMENT, "name": "snap_allotment"},
        ])

        self.assertEqual(_query_reference(SNAP_ALLOTMENT, self.artifact), SNAP_ALLOTMENT)

    def test_uses_bare_name_when_compiled_artifact_has_no_public_id(self) -> None:
        self._write_artifact([
            {"name": "snap_allotment"},
        ])

        self.assertEqual(_query_reference(SNAP_ALLOTMENT, self.artifact), "snap_allotment")

    def test_can_retry_between_bare_name_and_public_legal_id(self) -> None:
        self.assertEqual(
            _alternate_query_reference(SNAP_ALLOTMENT, "snap_allotment"),
            SNAP_ALLOTMENT,
        )
        self.assertEqual(
            _alternate_query_reference(SNAP_ALLOTMENT, SNAP_ALLOTMENT),
            "snap_allotment",
        )


class FixtureOutputGraphTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "rulespec-test"
        self.repo.mkdir()
        self.program = self.repo / "program.yaml"
        self.program.write_text(
            """
format: rulespec/v1
rules:
  - name: final_benefit
    kind: derived
    entity: Household
    dtype: Money
    period: Month
    unit: USD
    source: Test program
    versions:
      - effective_from: '2026-01-01'
        formula: max(0, base_amount - computed_deduction)
""".lstrip()
        )
        self.program.with_name("program.test.yaml").write_text(
            """
- name: fixture
  period: 2026-01
  input:
    test:program#input.base_amount: 100
  output:
    test:program#computed_deduction: 40
    test:program#final_benefit: 60
""".lstrip()
        )

    def test_fixture_only_output_is_rule_dependency_not_input(self) -> None:
        graph = build_graph(self.program, "rulespec-test")

        final = graph.rules["test:program#final_benefit"]
        self.assertIn("test:program#computed_deduction", final.rule_deps)
        self.assertNotIn("test:program#input.computed_deduction", final.input_deps)
        self.assertIn("test:program#computed_deduction", graph.rules)

    def test_trace_renders_fixture_only_output_as_non_input_child(self) -> None:
        traces = _build_trace_tree(
            ["test:program#final_benefit"],
            {
                "test:program#final_benefit": {
                    "name": "final_benefit",
                    "value": {"kind": "decimal", "value": "60"},
                    "dependencies": [],
                }
            },
            {"test:program#input.base_amount": 100},
            set(),
            {"test:program#final_benefit": ["test:program#computed_deduction"]},
            {"test:program#final_benefit": ["test:program#input.base_amount"]},
            {"test:program#final_benefit": "max(0, base_amount - computed_deduction)"},
            {"test:program#computed_deduction": 40},
        )

        children = traces["test:program#final_benefit"]["children"]
        by_id = {child["legalId"]: child for child in children}
        self.assertEqual(by_id["test:program#computed_deduction"]["dtype"], "integer")
        self.assertEqual(by_id["test:program#input.base_amount"]["dtype"], "input")

    def test_user_values_for_computed_outputs_are_dropped(self) -> None:
        inputs, relations = _filter_user_supplied_values(
            self.program,
            {
                "test:program#input.base_amount": 100,
                "test:program#input.computed_deduction": 999,
                "test:program#computed_deduction": 999,
            },
            None,
        )

        self.assertEqual(inputs, {"test:program#input.base_amount": 100})
        self.assertIsNone(relations)


class ColoradoSnapIncomeBridgeTest(unittest.TestCase):
    def test_employee_wages_drive_generic_federal_income_defaults(self) -> None:
        program = Path("/tmp/rules-us-co/policies/cdhs/snap/fy-2026-benefit-calculation.yaml")
        flat = {
            "us-co:regulations/10-ccr-2506-1/4.403#input.higher_education_state_work_study_or_work_requirement_fellowship_income": False,
            "us-co:regulations/10-ccr-2506-1/4.403#input.employee_wages_received": 1500,
            "us-co:regulations/10-ccr-2506-1/4.403#input.garnished_or_diverted_wages_for_household_expenses": 0,
            "us-co:regulations/10-ccr-2506-1/4.403#input.wages_held_at_employee_request_that_would_have_been_paid": 0,
            "us-co:regulations/10-ccr-2506-1/4.403#input.wages_previously_withheld_by_employer_general_practice_received": 0,
            "us-co:regulations/10-ccr-2506-1/4.403#input.reasonably_anticipated_wage_advances_received": 0,
            "us-co:regulations/10-ccr-2506-1/4.403#input.household_vista_or_title_i_domestic_volunteer_earned_income": 0,
            "us-co:regulations/10-ccr-2506-1/4.403#input.household_training_allowance_earned_income": 0,
            "us-co:regulations/10-ccr-2506-1/4.403#input.household_wioa_ojt_earned_income": 0,
            "us-co:regulations/10-ccr-2506-1/4.403#input.person_still_employed_when_sick_vacation_or_bonus_pay_received": False,
            "us-co:regulations/10-ccr-2506-1/4.403#input.sick_vacation_or_bonus_pay_received": 0,
            "us-co:regulations/10-ccr-2506-1/4.403#input.average_rental_property_management_hours_per_week": 0,
            "us-co:regulations/10-ccr-2506-1/4.403#input.rental_property_gross_income": 0,
            "us-co:regulations/10-ccr-2506-1/4.403#input.rental_property_business_costs": 0,
            "us-co:regulations/10-ccr-2506-1/4.403#input.household_llc_s_corporation_owner_earned_income": 0,
            "us-co:regulations/10-ccr-2506-1/4.403.2#input.boarder_payments_for_room_meals_and_shelter_contributions": 0,
            "us-co:regulations/10-ccr-2506-1/4.403.2#input.actual_documented_boarder_room_and_meal_costs": 0,
            "us-co:regulations/10-ccr-2506-1/4.403.2#input.boarder_income_is_foster_care_payment": False,
            "us-co:regulations/10-ccr-2506-1/4.403.11#input.self_employment_gross_income_for_period": 0,
            "us-co:regulations/10-ccr-2506-1/4.403.11#input.self_employment_capital_gains_for_period": 0,
            "us-co:regulations/10-ccr-2506-1/4.403.11#input.allowable_self_employment_business_costs_for_period": 0,
            "us-co:regulations/10-ccr-2506-1/4.403#input.capital_goods_services_or_property_sale_proceeds_connected_to_self_employment": 0,
        }

        defaults = _dynamic_input_defaults(program, flat)

        self.assertEqual(defaults["snap_gross_monthly_income"], 1500)
        self.assertEqual(defaults["snap_monthly_household_income"], 1500)
        self.assertEqual(
            defaults["us:regulations/7-cfr/273/9#input.snap_gross_monthly_income"],
            1500,
        )
        self.assertEqual(
            defaults["us:statutes/7/2014/e/6/A#input.snap_monthly_household_income"],
            1500,
        )

    def test_income_bridge_does_not_apply_to_other_programs(self) -> None:
        defaults = _dynamic_input_defaults(
            Path("/tmp/rules-us-co/policies/cdhs/snap/other.yaml"),
            {},
        )

        self.assertEqual(defaults, {})


class RealSnapEngineSmokeTest(unittest.TestCase):
    """Guard the configured real engine against rule-pack schema drift.

    These tests are intentionally skipped when the real engine is not installed.
    If `AXIOM_RULES_ENGINE_BIN` is configured, they fail on the errors that
    make the compute API fall back to test fixtures, including unsupported
    RuleSpec variants and unresolved `rulespec-*` imports.
    """

    def setUp(self) -> None:
        self.compute_root = COMPUTE_ROOT
        load_dotenv(self.compute_root / ".env")

        binary = os.environ.get("AXIOM_RULES_ENGINE_BIN")
        if not binary:
            self.skipTest("AXIOM_RULES_ENGINE_BIN is not configured")
        self.binary = Path(binary).expanduser().resolve()
        if not self.binary.exists():
            self.skipTest(f"AXIOM_RULES_ENGINE_BIN does not exist: {self.binary}")

        root = Path(os.environ.get("AXIOM_RULESPEC_ROOT", self.compute_root.parents[1]))
        self.rules_root = root.expanduser().resolve()
        self.program_yaml = self.rules_root / SNAP_PROGRAM
        if not self.program_yaml.exists():
            self.skipTest(f"SNAP rule program does not exist: {self.program_yaml}")

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.alias_root = Path(self.tmp.name)
        (self.alias_root / "_axiom").mkdir()
        self._alias("rulespec-us-co", self.rules_root / "rules-us-co")
        federal_rules = (
            self.rules_root / "rulespec-us"
            if (self.rules_root / "rulespec-us").exists()
            else self.rules_root / "rules-us"
        )
        self._alias("rulespec-us", federal_rules)
        self._alias("rules-us", federal_rules)
        import_roots = [str(self.alias_root), str(self.rules_root)]
        if existing_roots := os.environ.get("AXIOM_RULESPEC_REPO_ROOTS"):
            import_roots.append(existing_roots)
        self.engine_env = {
            **os.environ,
            "AXIOM_RULES_ENGINE_BIN": str(self.binary),
            "AXIOM_RULESPEC_ROOT": str(self.rules_root),
            "AXIOM_RULESPEC_REPO_ROOTS": os.pathsep.join(import_roots),
        }

    def _alias(self, alias: str, target: Path) -> None:
        if not target.exists():
            self.skipTest(f"RuleSpec import target does not exist: {target}")
        (self.alias_root / alias).symlink_to(target, target_is_directory=True)
        (self.alias_root / "_axiom" / alias).symlink_to(target, target_is_directory=True)

    def test_configured_engine_compiles_snap_program(self) -> None:
        artifact = self.alias_root / "snap.compiled.json"
        proc = subprocess.run(
            [
                str(self.binary),
                "compile",
                "--program",
                str(self.program_yaml),
                "--output",
                str(artifact),
            ],
            cwd=self.alias_root,
            env=self.engine_env,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(
            proc.returncode,
            0,
            "Configured axiom-rules binary could not compile the SNAP program.\n"
            f"stderr:\n{proc.stderr.strip()}",
        )

    def test_graph_builds_through_rules_repo_alias(self) -> None:
        graph = build_graph(self.program_yaml, "rules-us-co")

        rules_by_name = {rule.name: rule for rule in graph.rules.values()}
        self.assertIn("snap_eligible", rules_by_name)
        self.assertIn("snap_allotment", rules_by_name)
        self.assertEqual(
            rules_by_name["snap_eligible"].legal_id,
            SNAP_ELIGIBLE,
        )
        self.assertEqual(
            rules_by_name["snap_allotment"].legal_id,
            SNAP_ALLOTMENT,
        )

    def test_snap_baseline_compute_does_not_fall_back_to_fixture(self) -> None:
        _compile_cache.clear()
        _artifact_derived_id_cache.clear()

        old_cwd = Path.cwd()
        try:
            os.chdir(self.alias_root)
            with patch.dict(os.environ, self.engine_env, clear=False):
                payload = execute_real(
                    program_yaml=self.program_yaml,
                    rules_root=self.rules_root,
                    user_inputs={},
                    relations=None,
                    queried_outputs=[SNAP_ELIGIBLE, SNAP_ALLOTMENT],
                    period="2026-01",
                )
        finally:
            os.chdir(old_cwd)

        self.assertEqual(payload.get("warnings", []), [])
        outputs = {
            output.get("legalId"): output.get("value")
            for output in payload.get("outputs", [])
        }
        self.assertEqual(outputs.get(SNAP_ELIGIBLE), "holds")
        self.assertEqual(outputs.get(SNAP_ALLOTMENT), 298)

    def test_snap_allotment_user_inputs_compute_live(self) -> None:
        _compile_cache.clear()
        _artifact_derived_id_cache.clear()

        old_cwd = Path.cwd()
        try:
            os.chdir(self.alias_root)
            with patch.dict(os.environ, self.engine_env, clear=False):
                payload = execute_real(
                    program_yaml=self.program_yaml,
                    rules_root=self.rules_root,
                    user_inputs={
                        "us-co:regulations/10-ccr-2506-1/4.207.3#input.household_size": 3,
                        "us-co:regulations/10-ccr-2506-1/4.403#input.employee_wages_received": 1500,
                    },
                    relations=None,
                    queried_outputs=[SNAP_ALLOTMENT],
                    period="2026-01",
                )
        finally:
            os.chdir(old_cwd)

        self.assertEqual(payload.get("warnings", []), [])
        outputs = {
            output.get("legalId"): output.get("value")
            for output in payload.get("outputs", [])
        }
        self.assertEqual(outputs.get(SNAP_ALLOTMENT), 710)


if __name__ == "__main__":
    unittest.main()

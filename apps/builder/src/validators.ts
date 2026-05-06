/**
 * Static-analysis validators that run at picker time so the user can't
 * pick a rule the engine will reject. We only flag things the engine
 * deterministically can't compute given the current selection — runtime
 * branch-conditional issues stay out of scope (the engine swallows
 * those into per-output fixture fallback).
 *
 * Two failure modes detected:
 *
 *   1. **Person-scope rule with no relation exposed.** Person rules need
 *      the engine to know which members it's iterating over; without a
 *      relation in the draft (member_of_household, etc.) compute can't
 *      decide who to iterate.
 *
 *   2. **Cross-entity reference in a numeric/comparison context.** A
 *      Person-scope rule that compares against a Household-scope value
 *      directly (not via count_where / sum_where / where) makes the
 *      engine error with "right side of comparison is not numeric". We
 *      walk the formula AST and flag refs that sit *outside* an
 *      aggregation call.
 */

import { parseFormula, type AstNode } from "@dashboard-builder/render";
import type { InputGraphNode, RuleNode } from "./api";
import type { Draft } from "./draft";

export interface ValidationIssue {
  /** Short human-readable reason. Shown verbatim as the chip's tooltip. */
  reason: string;
}

/** Function names that aggregate a relation into a scalar. Identifiers
 *  referenced inside these calls are evaluated per-member (or per-row)
 *  and don't need to match the calling rule's entity. */
const AGGREGATION_CALLS = new Set(["count_where", "sum_where", "where", "any", "all"]);

/**
 * Build a name → RuleNode index for fast lookup. Same-file matches win
 * when the name is ambiguous (mirrors the heuristic in compute/graph.py's
 * `_resolve_dependencies`).
 */
export function indexRulesByName(
  rules: RuleNode[],
  scopeFile?: string,
): Map<string, RuleNode> {
  const byName = new Map<string, RuleNode[]>();
  for (const r of rules) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name)!.push(r);
  }
  const single = new Map<string, RuleNode>();
  for (const [name, candidates] of byName) {
    const sameFile = scopeFile
      ? candidates.find((c) => c.fileLegalId === scopeFile)
      : undefined;
    single.set(name, sameFile ?? candidates[0]!);
  }
  return single;
}

/**
 * Validate that an output rule can actually be added to the dashboard
 * given the current draft state. Returns a `ValidationIssue` when the
 * engine would reject the resulting compute, or `null` if it's safe.
 */
export function validateOutput(
  rule: RuleNode,
  draft: Draft,
  allRules: RuleNode[],
): ValidationIssue | null {
  // Person-scope rules need at least one relation so the engine knows
  // which entities to iterate over. The relation can be added later;
  // we just need to flag that doing so is required.
  if (rule.entity === "Person" && draft.relations.length === 0) {
    return {
      reason:
        "This rule is per-person — expose a household relation (e.g. members of household) before adding it.",
    };
  }
  // Cross-entity references inside a numeric / comparison context.
  const conflict = findCrossEntityConflict(rule, allRules);
  if (conflict) {
    return {
      reason: `Mixes ${rule.entity ?? "this"}-scope and ${conflict.otherEntity}-scope values in a comparison/arithmetic (refers to "${conflict.otherName}"). The engine rejects this; pick a different rule or expose the conflict via an aggregation.`,
    };
  }
  return null;
}

/**
 * Validate that an input can be exposed without breaking compute. Today
 * the only static check is that Person-scope inputs need a relation —
 * but `togglePersonInput` already auto-exposes the relation, so this is
 * a no-op in practice. Kept as a hook for future checks (dtype mismatch,
 * etc.).
 */
export function validateInput(
  _input: InputGraphNode,
  _draft: Draft,
  _allRules: RuleNode[],
): ValidationIssue | null {
  return null;
}

/**
 * Walk a rule's formula AST and look for an identifier that resolves to
 * a rule with a different entity, sitting *outside* an aggregation call.
 * Returns the first conflict found (we only need one to fail), or null
 * if everything composes cleanly.
 */
function findCrossEntityConflict(
  rule: RuleNode,
  allRules: RuleNode[],
): { otherEntity: string; otherName: string } | null {
  if (!rule.entity || !rule.formula) return null;
  const byName = indexRulesByName(allRules, rule.fileLegalId);
  let found: { otherEntity: string; otherName: string } | null = null;

  function walk(node: AstNode, inAggregation: boolean): void {
    if (found) return;
    switch (node.kind) {
      case "ident": {
        if (inAggregation) return;
        const dep = byName.get(node.name);
        if (!dep || !dep.entity) return;
        // Parameters are constants — they don't carry entity scope in a
        // way the engine cares about.
        if (dep.kind === "parameter") return;
        if (dep.entity !== rule.entity) {
          found = { otherEntity: dep.entity, otherName: dep.name };
        }
        return;
      }
      case "call": {
        const isAgg = AGGREGATION_CALLS.has(node.name);
        for (const arg of node.args) walk(arg, inAggregation || isAgg);
        return;
      }
      case "logical":
        walk(node.left, inAggregation);
        walk(node.right, inAggregation);
        return;
      case "comparison":
        walk(node.left, inAggregation);
        walk(node.right, inAggregation);
        return;
      case "arith":
        walk(node.left, inAggregation);
        walk(node.right, inAggregation);
        return;
      case "unary":
        walk(node.operand, inAggregation);
        return;
      case "ifElse":
        walk(node.cond, inAggregation);
        walk(node.then, inAggregation);
        walk(node.else_, inAggregation);
        return;
      case "index":
        walk(node.target, inAggregation);
        walk(node.index, inAggregation);
        return;
      case "number":
      case "bool":
      case "error":
        return;
    }
  }

  walk(parseFormula(rule.formula), false);
  return found;
}

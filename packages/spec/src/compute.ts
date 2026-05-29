/**
 * Compute API contract — the wire format the renderer sends to /compute and
 * the shape of the response. This is intentionally close to RuleSpec's
 * ExecutionRequest/Response so a future Rust or WASM backend can implement the
 * same endpoint without a translation layer.
 */

import type { DashboardSpec, LegalId } from "./index";

export interface ComputeRequest {
  /** Inline spec or just the resolvable program ref — server supports both. */
  spec: DashboardSpec;
  /** Flat map of input legalId → user-entered value. Booleans, numbers, strings. */
  inputs: Record<string, ComputeInputValue>;
  /** For relation members: the spec-local relation id → list of per-member input maps. */
  relations?: Record<string, Array<Record<string, ComputeInputValue>>>;
  /** Defaults to "explain" so we always return traces. */
  mode?: "explain" | "fast";
}

export type ComputeInputValue = string | number | boolean;

export interface OutputValue {
  legalId: LegalId;
  /** Typed value as returned by the engine. `null` if the rule did not fire for the queried period. */
  value: number | string | boolean | null;
  dtype: "money" | "decimal" | "integer" | "boolean" | "date" | "judgment" | "string";
}

export interface TraceNode {
  legalId: LegalId;
  /** Short human-friendly label inferred from the rule's `name`. */
  label?: string;
  value: number | string | boolean | null;
  dtype: OutputValue["dtype"] | "input";
  /**
   * Distinguishes scalar inputs from relations (lists of members) and
   * per-member inputs (Person-scope inputs read once per relation member).
   * Defaults to "scalar" when omitted for backward compatibility with old
   * traces. The renderer uses this to avoid showing relations as
   * default-grey when the caller actually populated members, and to label
   * per-member inputs with "per member" instead of treating them as a
   * top-level scalar form field.
   */
  kind?: "scalar" | "relation" | "member";
  /** For `kind: "relation"` only — how many members the caller supplied. */
  memberCount?: number;
  /** For `kind: "member"` only — the relation legal id this input belongs to. */
  relationLegalId?: LegalId;
  /** For `kind: "member"` only — one value per supplied relation member. */
  memberValues?: Array<{
    index: number;
    value: number | string | boolean | null;
    inputSource?: "user" | "default";
  }>;
  /** Source citation (statute / regulation reference). For inputs, this is a humanized form of the home-file legal ID. */
  source?: string;
  /** For rule nodes: the latest-version formula text from the YAML — the actual condition that produced this value. */
  formula?: string;
  /** For input-leaf nodes only: was this value supplied by the user (via the dashboard form) or pulled from the program's test-fixture default? */
  inputSource?: "user" | "default";
  /** For input-leaf nodes only: the file legal ID where the input lives (e.g. `us-co:regulations/10-ccr-2506-1/4.407.31`). */
  homeFile?: string;
  /**
   * True for rule nodes the formula references but that the engine did
   * not evaluate this run (other side of a short-circuited AND/OR, dead
   * branch of an IF, count_where predicate when the outer rule never
   * reached it). `value` is null in this case; the renderer should show
   * the node as muted/not-evaluated rather than as a missing dependency.
   */
  notEvaluated?: boolean;
  /**
   * Extra context for trace nodes that do not have a single scalar runtime
   * value but are still meaningful in the formula graph.
   */
  evaluationRole?: "relationPredicate";
  /** Children = sub-rules / inputs that fed into this one. */
  children?: TraceNode[];
}

/**
 * Coverage report — telling the user how much of the rule's input surface
 * their dashboard actually exposes. `defaultInputs` are inputs that came from
 * the program's `.test.yaml` fixture and would never change at runtime
 * unless the dashboard adds them. The builder uses this to flag dashboards
 * that can't possibly produce a different result than the demo case.
 */
export interface ComputeCoverage {
  userInputs: string[];
  defaultInputs: string[];
  userInputCount: number;
  defaultInputCount: number;
}

export interface ComputeResponse {
  outputs: OutputValue[];
  /** Trace per top-level queried output, keyed by legalId. */
  traces: Record<string, TraceNode>;
  /** Optional coverage report; absent if compute couldn't determine the dataset. */
  coverage?: ComputeCoverage;
  /** Engine errors that didn't abort the whole call (e.g. one queried output undefined). */
  warnings?: string[];
}

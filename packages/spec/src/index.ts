/**
 * DashboardSpec is the contract that flows from the builder to the renderer.
 *
 * The spec selects a slice of an Axiom RuleSpec program — which inputs the
 * dashboard collects from the user, and which outputs it presents — plus the
 * presentation metadata that RuleSpec itself does not encode (labels, help
 * copy, grouping, conditional visibility, output formatting).
 *
 * Stable forwards-compatibility: every consumer must check `specVersion` and
 * fail loudly on unrecognized values rather than silently rendering a partial
 * dashboard.
 */

export const SPEC_VERSION = "0.1" as const;

/** A durable Axiom legal ID, e.g. `us-co:policies/cdhs/snap/fy-2026-benefit-calculation#snap_eligible`. */
export type LegalId = string;

/** Input legal ID (always contains `#input.`), e.g. `us-co:regulations/10-ccr-2506-1/4.207.3#input.household_size`. */
export type InputLegalId = string;

/** Relation legal ID (always contains `#relation.`). */
export type RelationLegalId = string;

/** Output legal ID (no `input.` segment). */
export type OutputLegalId = string;

/**
 * The repo + path that resolves to a RuleSpec program YAML. `repo` matches a
 * folder under TheAxiomFoundation (e.g. `rulespec-us-co`); `path` is repo-relative
 * (e.g. `policies/cdhs/snap/fy-2026-benefit-calculation.yaml`).
 */
export interface ProgramRef {
  repo: string;
  path: string;
  /** Convenience: human-readable name for the program, copied at build time. */
  displayName?: string;
}

/** Period to query the program for. Today we support whole-month queries only. */
export interface PeriodRef {
  kind: "month";
  /** ISO date `YYYY-MM-DD` of the first day of the month. */
  start: string;
}

export type InputDtype =
  | "money"
  | "decimal"
  | "integer"
  | "boolean"
  | "date"
  | "string";

/**
 * Selectable widget for a scalar input. The renderer chooses the default
 * widget from the dtype but the builder can override it.
 */
export type InputWidget =
  | "number"
  | "currency"
  | "checkbox"
  | "switch"
  | "select"
  | "date"
  | "text";

/** A single condition over another input's value. Conjoined within a binding. */
export interface VisibilityCondition {
  /** Another input's `id` from the same DashboardSpec. */
  inputId: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "truthy" | "falsy";
  value?: string | number | boolean;
}

export interface BaseInputBinding {
  /** Stable spec-local id, used by visibility conditions. Auto-derived from legalId by the builder. */
  id: string;
  legalId: InputLegalId;
  dtype: InputDtype;
  /** Human-friendly label shown above the field. */
  label: string;
  /** Optional helper copy under the field. Markdown allowed. */
  help?: string;
  /** Group key — inputs sharing a group render together as a section. */
  group?: string;
  /** Display order within the group. Lower first. */
  order?: number;
  /** Default value if the user hasn't touched the field. */
  default?: string | number | boolean;
  /** Hide the input unless every condition holds. */
  visibleWhen?: VisibilityCondition[];
  /** Selectable enumeration for `select` widgets. */
  options?: Array<{ value: string | number | boolean; label: string }>;
  widget?: InputWidget;
}

/**
 * A relation binding lets the dashboard collect a list of related entities
 * (e.g. household members) and the per-member inputs the rule needs.
 */
export interface RelationBinding {
  id: string;
  legalId: RelationLegalId;
  /** Plural label, e.g. "Household members". */
  label: string;
  help?: string;
  group?: string;
  order?: number;
  /** Minimum/maximum number of entities. */
  minCount?: number;
  maxCount?: number;
  /** Per-member inputs. Each is a normal input binding scoped to the relation. */
  memberInputs: BaseInputBinding[];
}

export type InputBinding = BaseInputBinding | RelationBinding;

export type OutputPresentation =
  | { kind: "currency"; currency?: string; /** decimals, default 2 */ decimals?: number }
  | { kind: "number"; decimals?: number; suffix?: string }
  | { kind: "eligibility"; positiveLabel?: string; negativeLabel?: string }
  | { kind: "raw" };

export interface OutputBinding {
  id: string;
  legalId: OutputLegalId;
  label: string;
  help?: string;
  /** Visual emphasis: `headline` shown large, `secondary` shown smaller. */
  emphasis?: "headline" | "secondary";
  /** Display order on the results panel. Lower first. */
  order?: number;
  presentation: OutputPresentation;
  /** Show explain trace for this output by default. User can always toggle. */
  showExplain?: boolean;
}

/** Logical input groups; the renderer renders them as sections in this order. */
export interface InputGroup {
  key: string;
  label: string;
  description?: string;
  order?: number;
}

export interface DashboardMeta {
  title: string;
  description?: string;
  /** Brand/theming hint — defaults to "axiom". */
  theme?: "axiom" | "neutral";
}

export interface DashboardSpec {
  specVersion: typeof SPEC_VERSION;
  meta: DashboardMeta;
  program: ProgramRef;
  period: PeriodRef;
  /** Optional ordered list of input groups. If omitted, all inputs render as a single section. */
  groups?: InputGroup[];
  inputs: InputBinding[];
  outputs: OutputBinding[];
}

export function isRelationBinding(b: InputBinding): b is RelationBinding {
  return "memberInputs" in b;
}

export * from "./compute";

/**
 * The builder's working state. Only "selected" outputs and "exposed" inputs
 * cross over into the exported DashboardSpec; everything else falls back to
 * the program's `.test.yaml` defaults at compute time.
 *
 * Every UI field — labels, presentation, defaults — is *inferred* from
 * RuleSpec metadata (dtype, unit, name, source). The user can override per
 * row but never has to.
 */

import type {
  DashboardSpec,
  InputDtype,
  OutputBinding,
  OutputPresentation,
} from "@dashboard-builder/spec";
import { SPEC_VERSION } from "@dashboard-builder/spec";
import type {
  InputGraphNode,
  ProgramGraph,
  RelationGraphNode,
  RuleNode,
} from "./api";

export interface OutputSelection {
  legalId: string;
  /** User-editable label; defaults to a humanized rule name. */
  label: string;
  /** Inferred from rule dtype + unit; user can override. */
  presentation: OutputPresentation;
  emphasis: "headline" | "secondary";
  showExplain: boolean;
}

export interface InputExposure {
  legalId: string;
  label: string;
  /** Refers to a draft.relationExposures entry when this input is per-member. */
  relationLegalId?: string;
  dtype: InputDtype;
  default: string | number | boolean;
  widget?: "number" | "currency" | "checkbox" | "switch" | "select" | "date" | "text";
}

export interface RelationExposure {
  legalId: string;
  label: string;
  minCount: number;
  maxCount: number;
  /** Per-member input legal IDs that the user has exposed. */
  memberInputs: InputExposure[];
}

export interface ProgramTarget {
  repo: string;
  path: string;
  displayName: string;
}

export interface Draft {
  meta: { title: string; description: string };
  program: ProgramTarget | null;
  graph: ProgramGraph | null;
  /** Cached compute service URL, used by render package. */
  outputs: OutputSelection[];
  inputs: InputExposure[];
  relations: RelationExposure[];
  /** Default period; user can edit. */
  periodStart: string;
  /** True once the user has accepted the curated program's
   * recommended starter inputs. We auto-apply once on the first
   * main-result pick (provided the user hasn't manually started
   * picking inputs); the flag prevents re-applying and tells Step
   * III to render the "started with the recommended setup" notice. */
  usedRecommendedSetup?: boolean;
}

export function emptyDraft(): Draft {
  return {
    meta: { title: "Untitled dashboard", description: "" },
    program: null,
    graph: null,
    outputs: [],
    inputs: [],
    relations: [],
    periodStart: "2026-01-01",
  };
}

// ---------- inference helpers (purely metadata-driven, no name heuristics) ----------

export function humanize(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Humanize a snake_case name and strip a leading program prefix
 * (e.g. `snap_eligible` → `Eligible` when prefix = "snap"). The prefix
 * comes from CuratedProgram.labelPrefix and only applies at the start
 * of the name, so things like `is_snap_household` are left alone. */
export function humanizeWithoutPrefix(
  name: string,
  prefix: string | undefined,
): string {
  let base = name;
  if (prefix) {
    const lead = `${prefix.toLowerCase()}_`;
    if (base.toLowerCase().startsWith(lead) && base.length > lead.length) {
      base = base.slice(lead.length);
    }
  }
  return humanize(base);
}

/**
 * Walk the rule graph from each selected output through `ruleDeps`,
 * collecting every input/relation that any remaining output transitively
 * reaches. Used to prune exposed inputs/relations the user no longer
 * needs after they remove an output — otherwise the InputStep keeps
 * "ghost" picks that don't connect to anything.
 */
function reachableFromOutputs(draft: Draft): {
  inputs: Set<string>;
  relations: Set<string>;
} {
  const inputs = new Set<string>();
  const relations = new Set<string>();
  if (!draft.graph) return { inputs, relations };
  const ruleById = new Map(draft.graph.rules.map((r) => [r.legalId, r]));
  const seen = new Set<string>();
  const queue = draft.outputs.map((o) => o.legalId);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const rule = ruleById.get(id);
    if (!rule) continue;
    for (const inp of rule.inputDeps) inputs.add(inp);
    for (const rel of rule.relationDeps) relations.add(rel);
    for (const dep of rule.ruleDeps) queue.push(dep);
  }
  return { inputs, relations };
}

/**
 * Drop exposed inputs / relations / member-inputs that no remaining
 * output transitively depends on. Call this whenever an output is
 * removed from the draft. Idempotent — already-clean drafts return
 * the same state.
 */
export function pruneUnreachable(draft: Draft): Draft {
  if (!draft.graph) return draft;
  const { inputs: reachableInputs, relations: reachableRelations } =
    reachableFromOutputs(draft);

  const nextInputs = draft.inputs.filter((i) => reachableInputs.has(i.legalId));
  const nextRelations = draft.relations
    .filter((r) => reachableRelations.has(r.legalId))
    .map((r) => ({
      ...r,
      memberInputs: r.memberInputs.filter((m) => reachableInputs.has(m.legalId)),
    }));

  // Avoid creating new arrays when nothing changed — keeps React's
  // referential equality happy and avoids unnecessary re-renders.
  const sameInputs =
    nextInputs.length === draft.inputs.length &&
    nextInputs.every((v, i) => v === draft.inputs[i]);
  const sameRelations =
    nextRelations.length === draft.relations.length &&
    nextRelations.every((v, i) => {
      const orig = draft.relations[i];
      return (
        v === orig ||
        (v.legalId === orig?.legalId &&
          v.memberInputs.length === orig.memberInputs.length)
      );
    });
  if (sameInputs && sameRelations) return draft;
  return { ...draft, inputs: nextInputs, relations: nextRelations };
}

export function presentationFor(rule: RuleNode): OutputPresentation {
  const dtype = (rule.dtype ?? "").toLowerCase();
  if (dtype === "judgment") return { kind: "eligibility" };
  if (dtype === "money") {
    return { kind: "currency", currency: rule.unit ?? "USD", decimals: 2 };
  }
  if (dtype === "decimal" || dtype === "integer") {
    return { kind: "number", decimals: dtype === "integer" ? 0 : 2 };
  }
  return { kind: "raw" };
}

export function dtypeFor(input: InputGraphNode): InputDtype {
  const sample = input.sample;
  if (typeof sample === "boolean") return "boolean";
  if (typeof sample === "number") return Number.isInteger(sample) ? "integer" : "decimal";
  if (typeof sample === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(sample)) return "date";
    return "string";
  }
  return "decimal";
}

export function widgetFor(dtype: InputDtype, legalId: string): InputExposure["widget"] {
  if (dtype === "boolean") return "checkbox";
  if (dtype === "date") return "date";
  if (dtype === "money") return "currency";
  // Heuristic for currency-shaped inputs that lost the `money` dtype because the
  // sample was a literal int — only used when sample is unhelpful.
  if (/income|wage|cost|expense|allotment|amount|deduction|payment|earnings|value/i.test(legalId)) {
    return "currency";
  }
  return "number";
}

export function defaultFor(input: InputGraphNode, dtype: InputDtype): string | number | boolean {
  // Neutral zero state by default — the test-fixture sample is intentionally
  // ignored so the deployed dashboard never shows numbers the end user never
  // entered.
  //
  // One narrow exception: integer inputs whose name ends in `_size`. A
  // household/unit/group of *zero* people isn't a meaningful default for any
  // rule we've seen, and it triggers table-lookup failures (e.g. CO SNAP's
  // standard-deduction table only has entries for sizes 1–8). Defaulting
  // these to 1 keeps the dashboard computing while remaining honest about
  // the intent (one entity).
  if (dtype === "integer" && /_size$/i.test(input.name)) return 1;
  switch (dtype) {
    case "boolean": return false;
    case "date": return "2026-01-01";
    case "string": return "";
    default: return 0;
  }
}

// ---------- output / input selection helpers ----------

export function selectOutput(rule: RuleNode): OutputSelection {
  return {
    legalId: rule.legalId,
    label: humanize(rule.name),
    presentation: presentationFor(rule),
    emphasis: "headline",
    showExplain: true,
  };
}

export function exposeInput(node: InputGraphNode): InputExposure {
  const dtype = dtypeFor(node);
  return {
    legalId: node.legalId,
    label: humanize(node.name),
    dtype,
    default: defaultFor(node, dtype),
    widget: widgetFor(dtype, node.legalId),
  };
}

export function exposeRelation(node: RelationGraphNode): RelationExposure {
  return {
    legalId: node.legalId,
    label: humanize(node.name),
    minCount: 1,
    maxCount: 12,
    memberInputs: [],
  };
}

/** Apply a curated program's recommendedInputs to a draft in one shot.
 * Person-scope inputs auto-route into their relation (auto-creating
 * the relation if needed). Household-scope inputs go into draft.inputs.
 * No-op for inputs that don't exist in the graph (the curated list
 * may name a legal ID that's been renamed). */
export function applyRecommendedSetup(
  draft: Draft,
  graph: ProgramGraph,
  recommended: Array<{
    legalId: string;
    label?: string;
    default?: string | number | boolean;
  }>,
  memberCount = 3,
): Draft {
  let nextInputs: InputExposure[] = [...draft.inputs];
  let nextRelations: RelationExposure[] = [...draft.relations];
  const inputById = new Map(graph.inputs.map((i) => [i.legalId, i] as const));
  const relationById = new Map(
    graph.relations.map((r) => [r.legalId, r] as const),
  );

  for (const rec of recommended) {
    const node = inputById.get(rec.legalId);
    if (!node) continue;
    const dtype = dtypeFor(node);
    // Default-value precedence:
    //   1. Explicit override on the recommended record (curated config).
    //   2. The test-fixture sample value, if the program ships one — gives
    //      the form a realistic pre-populated value so the calculator
    //      returns a meaningful answer out of the box.
    //   3. Neutral zero from defaultFor (what the deployed dashboard
    //      would show if nothing else were known).
    let starting: string | number | boolean;
    if (rec.default !== undefined) {
      starting = rec.default;
    } else if (
      node.sample !== null &&
      node.sample !== undefined &&
      typeof node.sample !== "object"
    ) {
      starting = node.sample as string | number | boolean;
    } else {
      starting = defaultFor(node, dtype);
    }
    const exposure: InputExposure = {
      legalId: node.legalId,
      label: rec.label ?? humanize(node.name),
      dtype,
      default: starting,
      widget: widgetFor(dtype, node.legalId),
    };

    if (node.entity === "Person" && node.relationLegalId) {
      const relId = node.relationLegalId;
      exposure.relationLegalId = relId;
      const existing = nextRelations.find((r) => r.legalId === relId);
      if (existing) {
        if (!existing.memberInputs.some((m) => m.legalId === node.legalId)) {
          nextRelations = nextRelations.map((r) =>
            r.legalId === relId
              ? { ...r, memberInputs: [...r.memberInputs, exposure] }
              : r,
          );
        }
      } else {
        const relNode = relationById.get(relId);
        if (relNode) {
          nextRelations = [
            ...nextRelations,
            {
              ...exposeRelation(relNode),
              minCount: memberCount,
              memberInputs: [exposure],
            },
          ];
        }
      }
    } else {
      if (!nextInputs.some((i) => i.legalId === node.legalId)) {
        nextInputs = [...nextInputs, exposure];
      }
    }
  }

  return {
    ...draft,
    inputs: nextInputs,
    relations: nextRelations,
    usedRecommendedSetup: true,
  };
}

/** Reverse of applyRecommendedSetup: clear all exposed inputs/relations
 * back to the empty state. The `usedRecommendedSetup` flag is reset
 * too, so future first-pick picks will re-apply if the user wants. */
export function clearRecommendedSetup(draft: Draft): Draft {
  return {
    ...draft,
    inputs: [],
    relations: [],
    usedRecommendedSetup: false,
  };
}

// ---------- export to canonical DashboardSpec ----------

export function exportSpec(draft: Draft): DashboardSpec | null {
  if (!draft.program) return null;

  return {
    specVersion: SPEC_VERSION,
    meta: {
      title: draft.meta.title,
      description: draft.meta.description,
      theme: "axiom",
    },
    program: {
      repo: draft.program.repo,
      path: draft.program.path,
      displayName: draft.program.displayName,
    },
    period: { kind: "month", start: draft.periodStart },
    inputs: [
      ...draft.inputs.map((i, idx) => ({
        id: localId(i.legalId),
        legalId: i.legalId,
        dtype: i.dtype,
        label: i.label,
        default: i.default,
        widget: i.widget,
        group: "questions",
        order: idx,
      })),
      ...draft.relations.map((r, idx) => ({
        id: localId(r.legalId),
        legalId: r.legalId,
        label: r.label,
        minCount: r.minCount,
        maxCount: r.maxCount,
        group: "questions",
        order: 1000 + idx,
        memberInputs: r.memberInputs.map((m) => ({
          id: localId(m.legalId),
          legalId: m.legalId,
          dtype: m.dtype,
          label: m.label,
          default: m.default,
          widget: m.widget,
        })),
      })),
    ],
    outputs: draft.outputs.map((o, idx) => ({
      id: localId(o.legalId),
      legalId: o.legalId,
      label: o.label,
      emphasis: o.emphasis,
      order: idx,
      presentation: o.presentation,
      showExplain: o.showExplain,
    })),
  };
}

let counter = 0;
const idMap = new Map<string, string>();
function localId(legalId: string): string {
  if (idMap.has(legalId)) return idMap.get(legalId)!;
  const base = (legalId.split("#").pop() ?? legalId)
    .replace(/^input\./, "")
    .replace(/^relation\./, "")
    .replace(/[^a-z0-9_]/gi, "_")
    .toLowerCase();
  const id = `${base}_${counter++}`;
  idMap.set(legalId, id);
  return id;
}

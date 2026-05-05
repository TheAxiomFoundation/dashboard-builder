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
      ...draft.inputs.map((i) => ({
        id: localId(i.legalId),
        legalId: i.legalId,
        dtype: i.dtype,
        label: i.label,
        default: i.default,
        widget: i.widget,
        group: "inputs",
      })),
      ...draft.relations.map((r) => ({
        id: localId(r.legalId),
        legalId: r.legalId,
        label: r.label,
        minCount: r.minCount,
        maxCount: r.maxCount,
        group: "inputs",
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

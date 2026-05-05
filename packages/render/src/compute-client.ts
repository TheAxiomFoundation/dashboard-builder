import type {
  ComputeResponse,
  DashboardSpec,
  TraceNode,
} from "@dashboard-builder/spec";
import { isRelationBinding } from "@dashboard-builder/spec";

function resolveComputeUrl(override?: string): string {
  if (override) return override;
  // Vite injects import.meta.env at build; gate it so the package can also be
  // consumed in non-Vite environments without crashing.
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_COMPUTE_URL ?? "http://127.0.0.1:8787";
}

export interface FormState {
  /** Scalar inputs keyed by spec-local input id. */
  scalars: Record<string, string | number | boolean>;
  /** Relation members keyed by spec-local relation id. */
  relations: Record<string, Array<Record<string, string | number | boolean>>>;
}

/** Translate FormState (spec-local ids) into the legalId-keyed maps the compute service expects. */
export function buildComputeRequest(spec: DashboardSpec, state: FormState) {
  const scalarInputs: Record<string, string | number | boolean> = {};
  const relations: Record<string, Array<Record<string, string | number | boolean>>> = {};

  let exposedRelationMemberCount: number | null = null;

  for (const binding of spec.inputs) {
    if (isRelationBinding(binding)) {
      const members = state.relations[binding.id] ?? [];
      // Track the first relation's member count so we can auto-couple a
      // `household_size`-shaped scalar to it. (Most rule packs name the
      // primary household relation `member_of_household`; we don't depend on
      // the specific name — any first exposed relation works for the
      // size-derivation heuristic.)
      if (exposedRelationMemberCount === null) {
        exposedRelationMemberCount = members.length;
      }
      relations[binding.legalId] = members.map((member) => {
        const out: Record<string, string | number | boolean> = {};
        for (const memberBinding of binding.memberInputs) {
          const value = member[memberBinding.id];
          if (value === undefined) continue;
          out[memberBinding.legalId] = value;
        }
        return out;
      });
      continue;
    }
    const value = state.scalars[binding.id];
    if (value === undefined) continue;
    scalarInputs[binding.legalId] = value;
  }

  // Couple `household_size` (or any `*_size` integer scalar with `household`
  // in its name) to the relation's member count when a relation is exposed.
  // Keeps the deployed dashboard from showing two redundant fields that
  // could fall out of sync.
  if (exposedRelationMemberCount !== null) {
    for (const legalId of Object.keys(scalarInputs)) {
      const fragment = legalId.split("#")[1] ?? "";
      if (/household.*_size$/i.test(fragment)) {
        scalarInputs[legalId] = exposedRelationMemberCount;
      }
    }
  }

  return {
    program: spec.program,
    period: spec.period,
    inputs: scalarInputs,
    relations,
    queried_outputs: spec.outputs.map((o) => o.legalId),
  };
}

export interface ComputeResult extends ComputeResponse {
  mode: string;
}

export async function callCompute(
  spec: DashboardSpec,
  state: FormState,
  computeUrl?: string,
): Promise<ComputeResult> {
  const body = buildComputeRequest(spec, state);
  const url = `${resolveComputeUrl(computeUrl)}/compute`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`compute failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as ComputeResult;
}

export type { TraceNode };

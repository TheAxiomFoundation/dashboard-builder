import type {
  BaseInputBinding,
  DashboardSpec,
  RelationBinding,
  VisibilityCondition,
} from "@dashboard-builder/spec";
import { isRelationBinding } from "@dashboard-builder/spec";
import type { FormState } from "./compute-client";

export function initialState(spec: DashboardSpec): FormState {
  const scalars: FormState["scalars"] = {};
  const relations: FormState["relations"] = {};

  for (const binding of spec.inputs) {
    if (isRelationBinding(binding)) {
      const minCount = Math.max(1, binding.minCount ?? 1);
      relations[binding.id] = Array.from({ length: minCount }, () =>
        defaultMemberValues(binding),
      );
      continue;
    }
    if (binding.default !== undefined) scalars[binding.id] = binding.default;
  }
  return { scalars, relations };
}

export function defaultMemberValues(
  binding: RelationBinding,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const m of binding.memberInputs) {
    if (m.default !== undefined) out[m.id] = m.default;
  }
  return out;
}

export function isVisible(
  binding: BaseInputBinding,
  state: FormState["scalars"],
): boolean {
  if (!binding.visibleWhen?.length) return true;
  return binding.visibleWhen.every((c) => evalCondition(c, state));
}

function evalCondition(
  c: VisibilityCondition,
  state: FormState["scalars"],
): boolean {
  const lhs = state[c.inputId];
  switch (c.op) {
    case "eq": return lhs === c.value;
    case "neq": return lhs !== c.value;
    case "gt": return typeof lhs === "number" && typeof c.value === "number" && lhs > c.value;
    case "gte": return typeof lhs === "number" && typeof c.value === "number" && lhs >= c.value;
    case "lt": return typeof lhs === "number" && typeof c.value === "number" && lhs < c.value;
    case "lte": return typeof lhs === "number" && typeof c.value === "number" && lhs <= c.value;
    case "truthy": return Boolean(lhs);
    case "falsy": return !lhs;
  }
}

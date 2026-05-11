/**
 * Step III's guided Q&A — one stage at a time, the user fills in
 * sample values for the load-bearing questions, and the calculator's
 * live answer updates at the bottom of each screen.
 *
 * Stages bucket the user's exposed inputs by category (Household,
 * Income, Housing, Resources). Each stage:
 *   - Renders one Field per scalar input in the bucket.
 *   - For per-Person inputs, renders a stack of "Member 1 / 2 / …"
 *     cards, each containing the per-member fields for this bucket.
 *   - Pins a live calculator-answer strip to the bottom that
 *     updates (debounced) as the user edits.
 *
 * Editing a value updates the matching `InputExposure.default` (or
 * the per-member exposure's default) in the draft. The deployed
 * calculator uses those defaults as its starting form values, so the
 * builder is essentially "configuring by example" — answer for a
 * sample household, those answers become the calculator's defaults.
 *
 * The "Customize the questions" link drops the user into the legacy
 * full input picker (advanced stage) without losing context.
 */

import { useMemo } from "react";
import { Field } from "@dashboard-builder/render";
import type {
  BaseInputBinding,
  InputDtype,
  InputWidget,
} from "@dashboard-builder/spec";
import type { Draft, InputExposure, RelationExposure } from "../draft";

export type GuidedStage = "household" | "income" | "housing" | "resources";

const STAGE_LABELS: Record<GuidedStage, string> = {
  household: "Household",
  income: "Income",
  housing: "Housing",
  resources: "Resources & other",
};

const STAGE_ORDER: GuidedStage[] = [
  "household",
  "income",
  "housing",
  "resources",
];

interface Props {
  draft: Draft;
  setDraft: (d: Draft) => void;
  stage: GuidedStage;
  onOpenAdvanced: () => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Categorization — which guided stage does each input belong to?
// ─────────────────────────────────────────────────────────────────────────

/** Map an input's name (+ dtype) to one of the 4 guided stages.
 * Same patterns as InputStep's categorizeInput, collapsed into 4
 * buckets. Eligibility-shaped per-Person inputs (citizenship, etc.)
 * fold into Household; deductions into Housing; "other" into
 * Resources. */
export function stageFor(name: string, dtype: string | undefined): GuidedStage {
  const n = name.toLowerCase();
  const d = (dtype ?? "").toLowerCase();
  if (
    /_eligible|_qualif|_disqualif|_eligibility|_denied|_passes/.test(n) ||
    (d === "boolean" && /eligible|qualif/.test(n))
  ) {
    return "household";
  }
  if (/_income|_earnings|_earned|_wages|_pay\b|_amount\b/.test(n)) {
    return "income";
  }
  if (
    /_deduction|_expense|_costs?\b|_allowance|_shelter|_medical|_rent|_mortgage|_utility|_heating|_cooling/.test(
      n,
    )
  ) {
    return "housing";
  }
  if (/_resource|_asset|_limit\b|_threshold|_lump_sum|_value\b/.test(n)) {
    return "resources";
  }
  if (
    /_household|_member|_size|_relation|_person|_age|_disability|_veteran|_residency|_residence|_state|_citizen|_pregnant|_student|_dependent|_immigration/.test(
      n,
    )
  ) {
    return "household";
  }
  return "resources"; // catch-all
}

// ─────────────────────────────────────────────────────────────────────────
// Stage-progress dots
// ─────────────────────────────────────────────────────────────────────────

function StageProgress({ current }: { current: GuidedStage }) {
  return (
    <ol className="qa-stage-progress" aria-label="Step III progress">
      {STAGE_ORDER.map((s, i) => {
        const isActive = s === current;
        const isDone = STAGE_ORDER.indexOf(current) > i;
        return (
          <li
            key={s}
            className={`qa-stage-dot ${isActive ? "is-active" : ""} ${
              isDone ? "is-done" : ""
            }`}
          >
            <span className="qa-stage-dot-num">{i + 1}</span>
            <span className="qa-stage-dot-label">{STAGE_LABELS[s]}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// GuidedQA — the main component
// ─────────────────────────────────────────────────────────────────────────

export function GuidedQA({ draft, setDraft, stage, onOpenAdvanced }: Props) {
  // Filter exposed inputs to those belonging to this stage.
  const stageInputs = useMemo(
    () =>
      draft.inputs.filter((inp) => stageFor(nameFromLegalId(inp.legalId), inp.dtype) === stage),
    [draft.inputs, stage],
  );

  // Per-Person inputs live inside relations. Each relation that has
  // any per-member input in this stage gets rendered as a member-count
  // stepper plus per-member field cards.
  const stageRelations = useMemo(
    () =>
      draft.relations
        .map((rel) => ({
          rel,
          memberInputs: rel.memberInputs.filter(
            (m) => stageFor(nameFromLegalId(m.legalId), m.dtype) === stage,
          ),
        }))
        .filter((r) => r.memberInputs.length > 0),
    [draft.relations, stage],
  );

  function patchInputDefault(legalId: string, value: string | number | boolean) {
    setDraft({
      ...draft,
      inputs: draft.inputs.map((i) =>
        i.legalId === legalId ? { ...i, default: value } : i,
      ),
    });
  }

  function patchMemberDefault(
    relationId: string,
    legalId: string,
    value: string | number | boolean,
  ) {
    setDraft({
      ...draft,
      relations: draft.relations.map((r) =>
        r.legalId === relationId
          ? {
              ...r,
              memberInputs: r.memberInputs.map((m) =>
                m.legalId === legalId ? { ...m, default: value } : m,
              ),
            }
          : r,
      ),
    });
  }

  function setMemberCount(relationId: string, count: number) {
    setDraft({
      ...draft,
      relations: draft.relations.map((r) =>
        r.legalId === relationId
          ? { ...r, minCount: Math.max(1, Math.min(r.maxCount, count)) }
          : r,
      ),
    });
  }

  const empty = stageInputs.length === 0 && stageRelations.length === 0;

  return (
    <div className="step-body qa-step">
      <StageProgress current={stage} />

      {empty ? (
        <div className="qa-empty">
          <p>
            Nothing to ask about <strong>{STAGE_LABELS[stage].toLowerCase()}</strong> for the questions you've picked.
          </p>
          <button
            type="button"
            className="qa-empty-action"
            onClick={onOpenAdvanced}
          >
            Want to add a question? →
          </button>
        </div>
      ) : (
        <>
          <div className="qa-fields">
            {stage === "household" &&
              stageRelations.map(({ rel }) => (
                <MemberCountField
                  key={`count:${rel.legalId}`}
                  relation={rel}
                  onChange={(n) => setMemberCount(rel.legalId, n)}
                />
              ))}

            {stageInputs.map((inp) => (
              <Field
                key={inp.legalId}
                binding={asBinding(inp)}
                value={inp.default}
                onChange={(v) => patchInputDefault(inp.legalId, v)}
              />
            ))}

            {stageRelations.map(({ rel, memberInputs }) =>
              Array.from({ length: rel.minCount }, (_, idx) => (
                <MemberCard
                  key={`${rel.legalId}:${idx}`}
                  index={idx}
                  total={rel.minCount}
                  relation={rel}
                  memberInputs={memberInputs}
                  onChange={(legalId, value) =>
                    patchMemberDefault(rel.legalId, legalId, value)
                  }
                />
              )),
            )}
          </div>
        </>
      )}

      <div className="qa-footer">
        <button
          type="button"
          className="qa-advanced-link"
          onClick={onOpenAdvanced}
        >
          Customize the questions →
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────

function MemberCountField({
  relation,
  onChange,
}: {
  relation: RelationExposure;
  onChange: (n: number) => void;
}) {
  return (
    <div className="field qa-member-count">
      <div className="field-head">
        <label>How many people are in the household?</label>
      </div>
      <div className="qa-member-count-controls">
        <button
          type="button"
          className="qa-stepper-btn"
          onClick={() => onChange(relation.minCount - 1)}
          disabled={relation.minCount <= 1}
          aria-label="One fewer"
        >
          −
        </button>
        <span className="qa-stepper-value">{relation.minCount}</span>
        <button
          type="button"
          className="qa-stepper-btn"
          onClick={() => onChange(relation.minCount + 1)}
          disabled={relation.minCount >= relation.maxCount}
          aria-label="One more"
        >
          +
        </button>
      </div>
    </div>
  );
}

function MemberCard({
  index,
  total,
  relation,
  memberInputs,
  onChange,
}: {
  index: number;
  total: number;
  relation: RelationExposure;
  memberInputs: InputExposure[];
  onChange: (legalId: string, value: string | number | boolean) => void;
}) {
  return (
    <section className="qa-member-card">
      <header className="qa-member-card-head">
        <span className="qa-member-card-eyebrow">
          Member {index + 1} of {total}
        </span>
      </header>
      <div className="qa-member-card-fields">
        {memberInputs.map((m) => (
          <Field
            key={`${relation.legalId}:${m.legalId}:${index}`}
            binding={asBinding(m)}
            value={m.default}
            onChange={(v) => onChange(m.legalId, v)}
          />
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function asBinding(inp: InputExposure): BaseInputBinding {
  return {
    id: `input_${inp.legalId}`,
    legalId: inp.legalId,
    dtype: inp.dtype as InputDtype,
    label: inp.label,
    default: inp.default,
    widget: inp.widget as InputWidget | undefined,
  };
}

function nameFromLegalId(legalId: string): string {
  return legalId.split("#").pop()?.replace(/^input\./, "") ?? "";
}

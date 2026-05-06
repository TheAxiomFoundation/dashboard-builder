import { useEffect, useMemo, useState } from "react";
import { fetchProgramGraph } from "./api";
import { emptyDraft, type Draft } from "./draft";
import { STEPS, StepHeader, StepIndicator, StepNav, type StepId } from "./Wizard";
import { ProgramStep } from "./steps/ProgramStep";
import { OutputStep } from "./steps/OutputStep";
import { InputStep } from "./steps/InputStep";
import { GraphStep } from "./steps/GraphStep";
import { PublishStep } from "./steps/PublishStep";
import {
  defaultFor,
  dtypeFor,
  exposeInput,
  exposeRelation,
  humanize,
  selectOutput,
  widgetFor,
} from "./draft";
import { validateOutput } from "./validators";

const DRAFT_STORAGE_KEY = "dashboard-builder.draft";
const STEP_STORAGE_KEY = "dashboard-builder.step";

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return emptyDraft();
    return JSON.parse(raw) as Draft;
  } catch {
    return emptyDraft();
  }
}

function loadStep(): StepId {
  const raw = localStorage.getItem(STEP_STORAGE_KEY);
  if (
    raw === "program" ||
    raw === "outputs" ||
    raw === "inputs" ||
    raw === "graph" ||
    raw === "publish"
  )
    return raw;
  return "program";
}

export function App() {
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [stepId, setStepId] = useState<StepId>(loadStep);

  // Persist draft + step across refreshes.
  useEffect(() => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  }, [draft]);
  useEffect(() => {
    localStorage.setItem(STEP_STORAGE_KEY, stepId);
  }, [stepId]);

  // On mount, if the persisted draft already has a program selected, re-fetch
  // the graph from compute. The graph schema can evolve between sessions
  // (newer compute may surface synthesized inputs the previous run missed),
  // and we'd rather refresh once on load than ship stale catalog data.
  useEffect(() => {
    const program = draft.program;
    if (!program) return;
    let cancelled = false;
    fetchProgramGraph(program.repo, program.path)
      .then((graph) => {
        if (cancelled) return;
        setDraft((d) => (d.program ? { ...d, graph } : d));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = useMemo(
    () => STEPS.find((s) => s.id === stepId) ?? STEPS[0]!,
    [stepId],
  );

  function jumpTo(id: StepId) {
    const target = STEPS.find((s) => s.id === id);
    if (!target) return;
    // allow free movement to any step that has been reached (including current)
    const targetIndex = target.index;
    const reachable =
      targetIndex === 1 ||
      STEPS.slice(0, targetIndex - 1).every((s) => s.canContinue(draft)) ||
      target.id === stepId;
    if (reachable) setStepId(id);
  }

  function next() {
    const idx = step.index;
    if (idx < STEPS.length) setStepId(STEPS[idx]!.id);
  }
  function back() {
    const idx = step.index;
    if (idx > 1) setStepId(STEPS[idx - 2]!.id);
  }

  /**
   * Builder hook for "+ Expose" buttons in the graph and input picker.
   * Mirrors InputStep's Person-scope routing — per-member inputs attach
   * to their relation's memberInputs; Household-scope inputs land in
   * draft.inputs as a single top-level field. Without this, exposing a
   * per-member input would silently produce wrong-scope values at
   * compute time.
   */
  function handleExposeInput(legalId: string) {
    if (!draft.graph) return;
    // Toggle behaviour — clicking an already-exposed input removes it,
    // matching the InputStep's checkbox semantics. Lets the user
    // uncheck inputs directly from the graph too.
    const alreadyScalar = draft.inputs.some((i) => i.legalId === legalId);
    const alreadyRelation = draft.relations.some((r) => r.legalId === legalId);
    const alreadyMember = draft.relations.some((r) =>
      r.memberInputs.some((m) => m.legalId === legalId),
    );
    if (alreadyScalar) {
      setDraft({ ...draft, inputs: draft.inputs.filter((i) => i.legalId !== legalId) });
      return;
    }
    if (alreadyMember) {
      setDraft({
        ...draft,
        relations: draft.relations.map((r) => ({
          ...r,
          memberInputs: r.memberInputs.filter((m) => m.legalId !== legalId),
        })),
      });
      return;
    }
    if (alreadyRelation) {
      setDraft({ ...draft, relations: draft.relations.filter((r) => r.legalId !== legalId) });
      return;
    }

    const input = draft.graph.inputs.find((i) => i.legalId === legalId);
    if (input) {
      // Person-scope → attach to the relation's memberInputs; auto-expose
      // the relation if needed.
      if (input.entity === "Person" && input.relationLegalId) {
        const relationNode = draft.graph.relations.find(
          (r) => r.legalId === input.relationLegalId,
        );
        if (!relationNode) return;
        const dtype = dtypeFor(input);
        const memberInput = {
          legalId: input.legalId,
          label: humanize(input.name),
          dtype,
          default: defaultFor(input, dtype),
          widget: widgetFor(dtype, input.legalId),
          relationLegalId: input.relationLegalId,
        };
        const existing = draft.relations.find((r) => r.legalId === input.relationLegalId);
        const nextRelations = existing
          ? draft.relations.map((r) =>
              r.legalId === input.relationLegalId
                ? { ...r, memberInputs: [...r.memberInputs, memberInput] }
                : r,
            )
          : [
              ...draft.relations,
              { ...exposeRelation(relationNode), memberInputs: [memberInput] },
            ];
        setDraft({ ...draft, relations: nextRelations });
        return;
      }
      // Household-scope: simple scalar exposure.
      setDraft({ ...draft, inputs: [...draft.inputs, exposeInput(input)] });
      return;
    }

    // Bare relation reference (no member input).
    const relation = draft.graph.relations.find((r) => r.legalId === legalId);
    if (relation) {
      setDraft({ ...draft, relations: [...draft.relations, exposeRelation(relation)] });
    }
  }

  const exposedInputIds = new Set([
    ...draft.inputs.map((i) => i.legalId),
    ...draft.relations.map((r) => r.legalId),
    // Per-member inputs nested inside relations — without this entry the
    // graph would still show a Person-scope input as "NOT SELECTED" after
    // the user exposes it from the graph (since handleExposeInput routes
    // those into relation.memberInputs, not draft.inputs).
    ...draft.relations.flatMap((r) => r.memberInputs.map((m) => m.legalId)),
  ]);

  const selectedOutputIds = new Set(draft.outputs.map((o) => o.legalId));

  /** Toggle whether a rule is a dashboard output. Wired into the Step IV
   *  graph's "+ output" / "− output" affordance on rule nodes — same
   *  semantics as the OutputStep picker but reachable from the graph. */
  function handleAddOutput(legalId: string) {
    if (!draft.graph) return;
    if (selectedOutputIds.has(legalId)) {
      setDraft({ ...draft, outputs: draft.outputs.filter((o) => o.legalId !== legalId) });
      return;
    }
    const rule = draft.graph.rules.find((r) => r.legalId === legalId);
    if (!rule) return;
    if (validateOutput(rule, draft, draft.graph.rules)) return;
    setDraft({ ...draft, outputs: [...draft.outputs, selectOutput(rule)] });
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <img
            className="brand-mark-logo"
            src="/favicon.svg"
            alt=""
            aria-hidden="true"
          />
          <span className="brand-title">
            Axiom · <strong>Dashboard Builder</strong>
          </span>
        </div>
        <StepIndicator current={stepId} draft={draft} onJump={jumpTo} />
        <div className="app-actions">
          <button
            className="btn ghost"
            onClick={() => {
              if (!confirm("Reset the builder? This clears your current draft.")) return;
              setDraft(emptyDraft());
              setStepId("program");
            }}
            title="Clear the saved draft and start over"
          >
            Reset
          </button>
        </div>
      </header>

      <div
        className={`workspace ${stepId === "program" ? "wizard-centered" : ""}`}
      >
        <main className="wizard-pane">
          <StepHeader step={step} />

          <div className="step-content">
            {stepId === "program" && <ProgramStep draft={draft} setDraft={setDraft} />}
            {stepId === "outputs" && <OutputStep draft={draft} setDraft={setDraft} />}
            {stepId === "inputs" && <InputStep draft={draft} setDraft={setDraft} />}
            {stepId === "graph" && (
              <GraphStep
                draft={draft}
                exposedInputIds={exposedInputIds}
                selectedOutputIds={selectedOutputIds}
                onExposeInput={handleExposeInput}
                onAddOutput={handleAddOutput}
                parameterRules={(draft.graph?.rules ?? [])
                  .filter((r) => r.kind === "parameter")
                  .map((r) => ({
                    legalId: r.legalId,
                    name: r.name,
                    fileLegalId: r.fileLegalId,
                    source: r.source,
                    unit: r.unit,
                    dtype: r.dtype,
                    formula: r.formula,
                  }))}
              />
            )}
            {stepId === "publish" && (
              <PublishStep
                draft={draft}
                setDraft={setDraft}
                onExposeInput={handleExposeInput}
                exposedInputIds={exposedInputIds}
              />
            )}
          </div>

          <StepNav
            step={step}
            draft={draft}
            onBack={back}
            onNext={next}
            isLast={step.index === STEPS.length}
          />
        </main>
      </div>
    </div>
  );
}

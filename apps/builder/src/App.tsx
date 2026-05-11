import { useEffect, useMemo, useRef, useState } from "react";
import { fetchProgramGraph, fetchSensitivity, type SensitivityResult } from "./api";
import { emptyDraft, type Draft } from "./draft";
import { STEPS, StepHeader, StepIndicator, StepNav, type StepId } from "./Wizard";
import { ProgramStep, curatedForDraft } from "./steps/ProgramStep";
import { OutputStep } from "./steps/OutputStep";
import { InputStep } from "./steps/InputStep";
import { GraphStep } from "./steps/GraphStep";
import { PublishStep } from "./steps/PublishStep";
import {
  applyRecommendedSetup,
  defaultFor,
  dtypeFor,
  exposeInput,
  exposeRelation,
  humanize,
  pruneUnreachable,
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
    raw === "review" ||
    raw === "publish"
  )
    return raw;
  // Backward-compat for the old id from before the rename.
  if (raw === "graph") return "review";
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

  const baseStep = useMemo(
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

  // Step II ("outputs") is split into THREE sub-stages:
  //   "main"         — cards-first picker for the curated top-level
  //                    results (Eligibility, Benefit amount, Custom).
  //   "decide"       — yes/no interstitial: do you want to surface
  //                    intermediate calculation steps too?
  //   "intermediates"— the full rule picker, only reached if the user
  //                    picked "yes" on "decide" or "Custom" on "main".
  // Picking "no" on "decide" advances straight to Step III.
  const [outputStage, setOutputStage] = useState<
    "main" | "decide" | "intermediates"
  >("main");
  // Reset the sub-stage whenever we leave Step II so re-entering
  // always starts with the cards.
  useEffect(() => {
    if (stepId !== "outputs") setOutputStage("main");
  }, [stepId]);

  // Step III ("inputs") starts with a defaults review, then becomes a
  // guided 4-screen Q&A — Household / Income / Housing / Resources —
  // so the user explicitly accepts the suggested questions before
  // answering them. The "advanced" stage is the legacy full picker,
  // kept accessible behind a "Customize the questions" link for
  // power-user edits (rename labels, swap widgets, expose more).
  type InputStage =
    | "defaults"
    | "household"
    | "income"
    | "housing"
    | "resources"
    | "advanced";
  const INPUT_STAGES: InputStage[] = ["household", "income", "housing", "resources"];
  const [inputStage, setInputStage] = useState<InputStage>("defaults");
  // When the user clicks "Customize the questions" we remember which
  // guided stage they came from so Continue from "advanced" returns
  // them to the right place instead of jumping to Step IV.
  const [advancedReturnTo, setAdvancedReturnTo] = useState<InputStage>(
    "defaults",
  );
  useEffect(() => {
    if (stepId !== "inputs") setInputStage("defaults");
  }, [stepId]);

  // Per-sub-stage lede + heading overrides. The wizard pane reads
  // baseStep statically; we layer overrides on top so each sub-stage
  // (Step II intermediates, Step III household/income/etc.) reads
  // like its own focused question.
  const step = useMemo(() => {
    if (baseStep.id === "outputs" && outputStage === "decide") {
      return {
        ...baseStep,
        title: <>Show the <em>calculation steps</em>?</>,
        lede: (
          <>
            End-users can see the intermediate values that go into the
            final answer — or you can keep the calculator focused on just
            the main result.
          </>
        ),
      };
    }
    if (baseStep.id === "outputs" && outputStage === "intermediates") {
      return {
        ...baseStep,
        lede: (
          <>
            Surface any intermediate steps too — gross income, deductions,
            etc. — if you want users to see how the result was derived. Skip
            if not.
          </>
        ),
      };
    }
    if (baseStep.id === "inputs") {
      const stageHeadings: Record<InputStage, { title: React.ReactNode; lede: React.ReactNode }> = {
        defaults: {
          title: <>Use the <em>default questions</em>?</>,
          lede: <>Start with the questions this program normally needs, or customize them before moving into the guided setup.</>,
        },
        household: {
          title: <>Tell us about the <em>household</em></>,
          lede: <>Who's in the household? We'll use this to figure out who counts and what each person brings to the calculation.</>,
        },
        income: {
          title: <>What does the household <em>earn or receive</em>?</>,
          lede: <>Wages, benefits, gifts, side income — anything that counts. Skip the kinds the household doesn't have.</>,
        },
        housing: {
          title: <>What does <em>housing</em> cost?</>,
          lede: <>Rent or mortgage, plus utilities. The bigger these are relative to income, the larger the benefit usually is.</>,
        },
        resources: {
          title: <>Anything <em>else</em>?</>,
          lede: <>Assets the household owns, special situations, and edge cases. Most households leave this blank.</>,
        },
        advanced: {
          title: baseStep.title,
          lede: <>Pick which questions appear in the deployed calculator. Anything you skip falls back to a sensible default.</>,
        },
      };
      const override = stageHeadings[inputStage];
      return { ...baseStep, ...override };
    }
    return baseStep;
  }, [baseStep, outputStage, inputStage]);

  function next() {
    if (stepId === "outputs" && outputStage === "main") {
      // After picking the curated main(s) the user gets a yes/no on
      // whether to dive into intermediate calculation steps.
      setOutputStage("decide");
      return;
    }
    if (stepId === "outputs" && outputStage === "decide") {
      // Default Continue = "no, just the main result" → straight to
      // Step III. The yes-card on the decide screen calls a different
      // handler that drops the user into intermediates.
      setStepId("inputs");
      return;
    }
    if (stepId === "inputs" && inputStage === "advanced") {
      // Coming back from the advanced picker — return to the guided
      // stage the user was on when they opened it.
      setInputStage(advancedReturnTo);
      return;
    }
    if (stepId === "inputs" && inputStage === "defaults") {
      setInputStage("household");
      return;
    }
    if (stepId === "inputs") {
      const i = INPUT_STAGES.indexOf(inputStage as Exclude<InputStage, "advanced">);
      if (i >= 0 && i < INPUT_STAGES.length - 1) {
        setInputStage(INPUT_STAGES[i + 1]!);
        return;
      }
    }
    const idx = step.index;
    if (idx < STEPS.length) setStepId(STEPS[idx]!.id);
  }
  function back() {
    if (stepId === "outputs" && outputStage === "intermediates") {
      // If the user has any curated main picked, "decide" made sense
      // going forward — show it going back too. If they took the
      // Custom path (no curated main), skip decide on the way back
      // to mirror the forward flow (Custom card bypasses decide).
      const curated = curatedForDraft(draft.program);
      const curatedIds = new Set(
        curated?.mainOutputs?.map((m) => m.legalId) ?? [],
      );
      const hasCuratedMain = draft.outputs.some((o) =>
        curatedIds.has(o.legalId),
      );
      setOutputStage(hasCuratedMain ? "decide" : "main");
      return;
    }
    if (stepId === "outputs" && outputStage === "decide") {
      setOutputStage("main");
      return;
    }
    if (stepId === "inputs" && inputStage === "advanced") {
      setInputStage(advancedReturnTo);
      return;
    }
    if (stepId === "inputs" && inputStage === "defaults") {
      const idx = step.index;
      if (idx > 1) setStepId(STEPS[idx - 2]!.id);
      return;
    }
    if (stepId === "inputs") {
      const i = INPUT_STAGES.indexOf(inputStage as Exclude<InputStage, "advanced">);
      if (i > 0) {
        setInputStage(INPUT_STAGES[i - 1]!);
        return;
      }
      if (i === 0) {
        setInputStage("defaults");
        return;
      }
    }
    const idx = step.index;
    if (idx > 1) setStepId(STEPS[idx - 2]!.id);
  }

  // ── Sensitivity analysis ────────────────────────────────────────────
  // Once the user has picked main outputs we kick off /sensitivity in
  // the background — figures out which inputs in the dependency closure
  // actually move those outputs vs. which the engine will silently
  // default to "no effect on the answer." Step III renders badges +
  // auto-exposes the load-bearing set when the result lands.
  //
  // Cached per output set so flipping back to Step II and adding more
  // doesn't redundantly recompute. Re-fetches when the picked output
  // legal IDs change.
  const [sensitivity, setSensitivity] = useState<SensitivityResult | null>(null);
  const [sensitivityStatus, setSensitivityStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const sensitivityCacheKey = useMemo(() => {
    if (!draft.program) return null;
    if (draft.outputs.length === 0) return null;
    const outs = [...draft.outputs.map((o) => o.legalId)].sort().join("|");
    return `${draft.program.repo}::${draft.program.path}::${outs}`;
  }, [draft.program, draft.outputs]);
  const lastFetchedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!draft.program || !sensitivityCacheKey) {
      setSensitivity(null);
      setSensitivityStatus("idle");
      return;
    }
    if (sensitivityCacheKey === lastFetchedKey.current) return;
    lastFetchedKey.current = sensitivityCacheKey;
    setSensitivityStatus("loading");
    let cancelled = false;
    fetchSensitivity(
      { repo: draft.program.repo, path: draft.program.path },
      draft.outputs.map((o) => o.legalId),
    )
      .then((res) => {
        if (cancelled) return;
        setSensitivity(res);
        setSensitivityStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setSensitivityStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [sensitivityCacheKey, draft.program, draft.outputs]);

  // Belt-and-suspenders auto-apply: if the user lands on Step III with
  // a picked output but no inputs/relations exposed (e.g. they have a
  // persisted draft from before the auto-apply existed, or their pick
  // happened via a flow that bypassed OutputStep.toggle), seed the
  // recommended defaults so the "Use the default questions?" screen
  // actually has questions to show.
  useEffect(() => {
    if (stepId !== "inputs") return;
    if (!draft.graph || !draft.program) return;
    if (draft.outputs.length === 0) return;
    if (draft.inputs.length > 0 || draft.relations.length > 0) return;
    const curated = curatedForDraft(draft.program);
    if (!curated?.recommendedInputs?.length) return;
    setDraft(
      applyRecommendedSetup(
        draft,
        draft.graph,
        curated.recommendedInputs,
        curated.recommendedMemberCount ?? 3,
      ),
    );
  }, [stepId, draft]);

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
      // Drop the output and any exposed input/relation that no longer
      // has another output reaching it (mirrors OutputStep's toggle).
      setDraft(
        pruneUnreachable({
          ...draft,
          outputs: draft.outputs.filter((o) => o.legalId !== legalId),
        }),
      );
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
            {stepId === "outputs" && (
              <OutputStep
                draft={draft}
                setDraft={setDraft}
                stage={outputStage}
                onAdvanceToIntermediates={() => setOutputStage("intermediates")}
                onSkipIntermediates={() => setStepId("inputs")}
              />
            )}
            {stepId === "inputs" && (
              <InputStep
                draft={draft}
                setDraft={setDraft}
                sensitivity={sensitivity}
                sensitivityStatus={sensitivityStatus}
                stage={inputStage}
                onAcceptDefaults={() => setInputStage("household")}
                onOpenAdvanced={() => {
                  if (inputStage !== "advanced") {
                    setAdvancedReturnTo(inputStage);
                  }
                  setInputStage("advanced");
                }}
              />
            )}
            {stepId === "review" && (
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

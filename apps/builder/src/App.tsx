import { useEffect, useMemo, useRef, useState } from "react";
import { fetchProgramGraph, fetchSensitivity, type SensitivityResult } from "./api";
import { emptyDraft, type Draft } from "./draft";
import { STEPS, StepHeader, StepIndicator, StepNav, type StepId } from "./Wizard";
import {
  ProgramStep,
  curatedCoreQuestionIdsForOutputs,
  curatedForDraft,
} from "./steps/ProgramStep";
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
const SENSITIVITY_CACHE_PREFIX = "dashboard-builder.sensitivity";
const SENSITIVITY_CACHE_VERSION = "v5-capped-core-baseline";
const SENSITIVITY_TIMEOUT_MS = 120000;

interface SensitivityBaseline {
  inputs: Record<string, string | number | boolean>;
  relations: Record<string, Array<Record<string, string | number | boolean>>>;
}

function loadCachedSensitivity(key: string): SensitivityResult | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as SensitivityResult) : null;
  } catch {
    return null;
  }
}

function saveCachedSensitivity(key: string, value: SensitivityResult) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Cache writes are best-effort; the builder should keep working if
    // storage is full or disabled.
  }
}

function hasSensitivityCoreQuestions(value: SensitivityResult): boolean {
  return Object.values(value.load_bearing).some((ids) => ids.length > 0);
}

function curatedSensitivityForOutputs(draft: Draft): SensitivityResult | null {
  const outputIds = draft.outputs.map((output) => output.legalId);
  const coreIds = curatedCoreQuestionIdsForOutputs(draft.program, outputIds);
  if (!coreIds) return null;
  return {
    baseline: [],
    load_bearing: Object.fromEntries(
      outputIds.map((outputId) => [outputId, coreIds]),
    ),
    effects: {},
    no_effect: [],
    skipped: [],
    mode: "curated",
  };
}

function buildSensitivityBaseline(draft: Draft): SensitivityBaseline {
  const inputs: SensitivityBaseline["inputs"] = {};
  const relations: SensitivityBaseline["relations"] = {};
  let firstRelationMemberCount: number | null = null;

  for (const input of draft.inputs) {
    inputs[input.legalId] = input.default;
  }

  for (const relation of draft.relations) {
    const memberCount = Math.max(1, relation.minCount);
    if (firstRelationMemberCount === null) firstRelationMemberCount = memberCount;
    relations[relation.legalId] = Array.from({ length: memberCount }, () => {
      const member: Record<string, string | number | boolean> = {};
      for (const input of relation.memberInputs) {
        member[input.legalId] = input.default;
      }
      return member;
    });
  }

  if (firstRelationMemberCount !== null) {
    for (const legalId of Object.keys(inputs)) {
      const fragment = legalId.split("#")[1] ?? "";
      if (/household.*_size$/i.test(fragment)) {
        inputs[legalId] = firstRelationMemberCount;
      }
    }
  }

  return { inputs, relations };
}

function baselineCacheToken(baseline: SensitivityBaseline): string {
  return stableStringify(baseline);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function loadDraft(): Draft {
  return emptyDraft();
}

function loadStep(): StepId {
  return "program";
}

export function App() {
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [stepId, setStepId] = useState<StepId>(loadStep);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  // Persist draft + step across refreshes.
  useEffect(() => {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  }, [draft]);
  useEffect(() => {
    localStorage.removeItem(STEP_STORAGE_KEY);
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
    if (reachable) {
      if (id === "outputs" && stepId !== "outputs") setOutputStage("main");
      if (id === "inputs" && stepId !== "inputs") {
        setInputStage("depth");
        setDefaultsBackTarget("sections");
      }
      setStepId(id);
    }
  }

  // Step II ("outputs") is split into two sub-stages:
  //   "main"         — cards-first picker for the curated top-level
  //                    results (Eligibility, Amount, Custom).
  //   "intermediates"— the full rule picker, reached from Custom.
  // Picking Eligibility or Amount advances straight to Step III.
  const [outputStage, setOutputStage] = useState<
    "main" | "intermediates"
  >("main");

  // Step III ("inputs") is now about designing the client-facing form.
  // The guided path walks: choose service depth → choose form sections →
  // set starting values. The full browser is an optional detour from the
  // section screen.
  type InputStage =
    | "depth"
    | "sections"
    | "browse"
    | "defaults";
  const INPUT_STAGES: InputStage[] = [
    "depth",
    "sections",
    "defaults",
  ];
  const [inputStage, setInputStage] = useState<InputStage>("depth");
  const [defaultsBackTarget, setDefaultsBackTarget] = useState<
    "sections" | "browse"
  >("sections");

  // Per-sub-stage lede + heading overrides. The wizard pane reads
  // baseStep statically; we layer overrides on top so each sub-stage
  // (Step II intermediates, Step III household/income/etc.) reads
  // like its own focused question.
  const step = useMemo(() => {
    if (baseStep.id === "outputs" && outputStage === "intermediates") {
      return {
        ...baseStep,
        lede: (
          <>
            Choose the exact output this workflow should produce. You can use
            a standard result or a more specific rule-pack value.
          </>
        ),
      };
    }
    if (baseStep.id === "inputs") {
      const stageHeadings: Record<InputStage, { title: React.ReactNode; lede: React.ReactNode }> = {
        depth: {
          title: <>How complete should the <em>form</em> be?</>,
          lede: <>Choose the level of support this client-facing form should provide. You can add detail section by section.</>,
        },
        sections: {
          title: <>Choose form <em>sections</em></>,
          lede: <>Review where the selected questions came from, then add or remove categories of client-facing questions.</>,
        },
        browse: {
          title: <>Refine the <em>questions</em></>,
          lede: <>Open any section to add more precision. The form can stay short, or reveal more rule detail where the client workflow needs it.</>,
        },
        defaults: {
          title: <>Choose starting <em>values</em></>,
          lede: <>Decide whether the deployed calculator opens blank, with a typical example, or with custom default answers.</>,
        },
      };
      const override = stageHeadings[inputStage];
      return { ...baseStep, ...override };
    }
    return baseStep;
  }, [baseStep, outputStage, inputStage]);

  function next() {
    if (stepId === "program") {
      setOutputStage("main");
      setStepId("outputs");
      return;
    }
    if (stepId === "outputs" && outputStage === "main") {
      setInputStage("depth");
      setDefaultsBackTarget("sections");
      setStepId("inputs");
      return;
    }
    if (stepId === "outputs" && outputStage === "intermediates") {
      setInputStage("depth");
      setDefaultsBackTarget("sections");
      setStepId("inputs");
      return;
    }
    if (stepId === "inputs" && inputStage === "browse") {
      setDefaultsBackTarget("browse");
      setInputStage("defaults");
      return;
    }
    if (stepId === "inputs" && inputStage === "sections") {
      setDefaultsBackTarget("sections");
      setInputStage("defaults");
      return;
    }
    if (stepId === "inputs") {
      const i = INPUT_STAGES.indexOf(inputStage);
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
      setOutputStage("main");
      return;
    }
    if (stepId === "inputs" && inputStage === "depth") {
      setStepId("outputs");
      return;
    }
    if (stepId === "inputs" && inputStage === "browse") {
      setInputStage("sections");
      return;
    }
    if (stepId === "inputs" && inputStage === "defaults") {
      setInputStage(defaultsBackTarget);
      return;
    }
    if (stepId === "review") {
      setStepId("inputs");
      return;
    }
    if (stepId === "inputs") {
      const i = INPUT_STAGES.indexOf(inputStage);
      if (i > 0) {
        setInputStage(INPUT_STAGES[i - 1]!);
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
  const sensitivityBaseline = useMemo(
    () => buildSensitivityBaseline(draft),
    [draft.inputs, draft.relations],
  );
  const sensitivityCacheKey = useMemo(() => {
    if (!draft.program) return null;
    if (draft.outputs.length === 0) return null;
    const outs = [...draft.outputs.map((o) => o.legalId)].sort().join("|");
    const baseline = baselineCacheToken(sensitivityBaseline);
    return [
      SENSITIVITY_CACHE_PREFIX,
      SENSITIVITY_CACHE_VERSION,
      draft.program.repo,
      draft.program.path,
      outs,
      baseline,
    ].join("::");
  }, [draft.program, draft.outputs, sensitivityBaseline]);
  const lastFetchedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!draft.program || draft.outputs.length === 0) {
      setSensitivity(null);
      setSensitivityStatus("idle");
      return;
    }

    const curatedSensitivity = curatedSensitivityForOutputs(draft);
    if (curatedSensitivity) {
      lastFetchedKey.current = sensitivityCacheKey;
      setSensitivity(curatedSensitivity);
      setSensitivityStatus("ready");
      return;
    }

    if (!sensitivityCacheKey) {
      setSensitivity(null);
      setSensitivityStatus("idle");
      return;
    }

    const cached = loadCachedSensitivity(sensitivityCacheKey);
    if (cached) {
      lastFetchedKey.current = sensitivityCacheKey;
      setSensitivity(cached);
      setSensitivityStatus("ready");
      return;
    }

    if (sensitivityCacheKey === lastFetchedKey.current) return;
    lastFetchedKey.current = sensitivityCacheKey;
    setSensitivityStatus("loading");
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      controller.abort();
    }, SENSITIVITY_TIMEOUT_MS);
    fetchSensitivity(
      { repo: draft.program.repo, path: draft.program.path },
      draft.outputs.map((o) => o.legalId),
      sensitivityBaseline,
      controller.signal,
    )
      .then((res) => {
        if (cancelled) return;
        window.clearTimeout(timeout);
        if (res.mode === "real" && hasSensitivityCoreQuestions(res)) {
          saveCachedSensitivity(sensitivityCacheKey, res);
        }
        setSensitivity(res);
        setSensitivityStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        window.clearTimeout(timeout);
        setSensitivityStatus("error");
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [sensitivityCacheKey, draft.program, draft.outputs, sensitivityBaseline]);

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

  function resetBuilder() {
    setDraft(emptyDraft());
    setStepId("program");
    setOutputStage("main");
    setInputStage("depth");
    setDefaultsBackTarget("sections");
    setResetConfirmOpen(false);
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
            Axiom · <strong>Form Builder</strong>
          </span>
        </div>
        <StepIndicator current={stepId} draft={draft} onJump={jumpTo} />
        <div className="app-actions">
          <button
            className="btn ghost"
            onClick={() => setResetConfirmOpen(true)}
            title="Clear the saved draft and start over"
          >
            Reset
          </button>
        </div>
      </header>

      {resetConfirmOpen && (
        <div
          className="reset-confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setResetConfirmOpen(false);
          }}
        >
          <section
            className="reset-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-confirm-title"
          >
            <div className="reset-confirm-kicker">Reset builder</div>
            <h2 id="reset-confirm-title">Start over?</h2>
            <p>
              This clears the current draft and returns you to Step I. The next
              time you open the builder, it will start fresh.
            </p>
            <div className="reset-confirm-actions">
              <button
                type="button"
                className="btn secondary"
                onClick={() => setResetConfirmOpen(false)}
              >
                Cancel
              </button>
              <button type="button" className="btn" onClick={resetBuilder}>
                Reset builder
              </button>
            </div>
          </section>
        </div>
      )}

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
              />
            )}
            {stepId === "inputs" && (
              <InputStep
                draft={draft}
                setDraft={setDraft}
                sensitivity={sensitivity}
                sensitivityStatus={sensitivityStatus}
                stage={inputStage}
                onOpenAdvanced={() => setInputStage("browse")}
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

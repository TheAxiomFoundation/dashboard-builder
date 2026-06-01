import { useEffect, useMemo, useState } from "react";
import type { Draft, InputExposure, RelationExposure } from "../draft";
import {
  applyRecommendedSetup,
  clearRecommendedSetup,
  defaultFor,
  dtypeFor,
  exposeInput,
  exposeRelation,
  humanize,
  humanizeWithoutPrefix,
  widgetFor,
} from "../draft";
import type { InputGraphNode, RelationGraphNode, SensitivityResult } from "../api";
import { fetchTransitive } from "../api";
import { humanizeCitation } from "../citations";
import { curatedForDraft } from "./ProgramStep";

const CORE_QUESTION_LIMIT = 10;

interface Props {
  draft: Draft;
  setDraft: (d: Draft) => void;
  /** Sensitivity-analysis result for the picked outputs — which
   * inputs actually move them. Drives load-bearing badges and the
   * auto-suggest banner. */
  sensitivity?: SensitivityResult | null;
  sensitivityStatus?: "idle" | "loading" | "ready" | "error";
  /** Sub-stage within Step III. The guided path helps the builder
   * choose the question set before thinking about default/example
   * values. "advanced" is kept as an alias for the full browser. */
  stage?:
    | "depth"
    | "sections"
    | "browse"
    | "defaults"
    | "advanced";
  /** Open the full available-question browser. */
  onOpenAdvanced?: () => void;
}

interface DepEntry<T> {
  node: T;
  depth: number;
}

/**
 * Step III — pick which inputs the end-user fills in.
 *
 * Inputs are auto-derived from the transitive closure of selected outputs.
 * The picker leads with a "Direct factors" pseudo-group (depth 1–2 across
 * all source files — what's most relevant to the end-user) and then groups
 * deeper plumbing by the input's source file. Search bypasses grouping and
 * returns a single flat list.
 *
 * Per-row visual reduced to: checkbox · dtype glyph · name · edit. Depth and
 * legal ID surface only in the inline edit panel.
 */
export function InputStep({
  draft,
  setDraft,
  sensitivity,
  sensitivityStatus,
  stage = "browse",
  onOpenAdvanced,
}: Props) {
  // Thin dispatcher: each branch is its own component so React's
  // hook-order rules hold (the advanced picker owns a dozen useState/
  // useMemo/useEffect calls that would otherwise be conditional). The
  // sub-components are defined below in the same file.
  if (stage === "depth") {
    return (
      <QuestionDepthStep
        draft={draft}
        setDraft={setDraft}
        sensitivity={sensitivity}
        sensitivityStatus={sensitivityStatus}
        onOpenAdvanced={() => onOpenAdvanced?.()}
      />
    );
  }
  if (stage === "sections") {
    return (
      <FormSectionsStep
        draft={draft}
        setDraft={setDraft}
        sensitivity={sensitivity}
        onOpenAdvanced={() => onOpenAdvanced?.()}
      />
    );
  }
  if (stage === "defaults") {
    return <StartingValuesStep draft={draft} setDraft={setDraft} />;
  }
  return (
    <AdvancedInputPicker
      draft={draft}
      setDraft={setDraft}
      sensitivity={sensitivity}
    />
  );
}

function QuestionDepthStep({
  draft,
  setDraft,
  sensitivity,
  sensitivityStatus,
  onOpenAdvanced,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  sensitivity?: SensitivityResult | null;
  sensitivityStatus?: "idle" | "loading" | "ready" | "error";
  onOpenAdvanced: () => void;
}) {
  const curated = curatedForDraft(draft.program);
  const [fastDeps, setFastDeps] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!draft.program || draft.outputs.length === 0) {
      setFastDeps({});
      return;
    }
    let cancelled = false;
    fetchTransitive(
      draft.program.repo,
      draft.program.path,
      draft.outputs.map((output) => output.legalId),
    )
      .then((res) => {
        if (!cancelled) setFastDeps(res.inputs);
      })
      .catch(() => {
        if (!cancelled) setFastDeps({});
      });
    return () => {
      cancelled = true;
    };
  }, [draft.program, draft.outputs]);

  const analyzedCoreQuestions = useMemo(() => {
    return selectCoreQuestions(draft, sensitivity, CORE_QUESTION_LIMIT);
  }, [draft.graph, sensitivity]);
  const fastCoreQuestions = useMemo(() => {
    return selectFastCoreQuestions(draft, fastDeps, CORE_QUESTION_LIMIT);
  }, [draft.graph, draft.program, draft.outputs, fastDeps]);
  const preloadedCoreQuestions = useMemo(
    () => selectedQuestionsFromDraft(draft, CORE_QUESTION_LIMIT),
    [draft.graph, draft.inputs, draft.relations],
  );
  const coreQuestions = uniqueInputs([
    ...analyzedCoreQuestions,
    ...fastCoreQuestions,
    ...preloadedCoreQuestions,
  ]).slice(0, CORE_QUESTION_LIMIT);
  const coreQuestionCount = coreQuestions.length;
  const hasPreloadedQuestions = preloadedCoreQuestions.length > 0;
  const hasFastQuestions = fastCoreQuestions.length > 0;
  const showBlockingAnalysis =
    sensitivityStatus === "loading" && !hasPreloadedQuestions && !hasFastQuestions;
  const recommendationMode =
    analyzedCoreQuestions.length > 0 && fastCoreQuestions.length > 0
      ? "engine-and-graph"
      : analyzedCoreQuestions.length > 0
      ? "engine-tested"
      : hasFastQuestions
        ? "fast"
        : "pending";

  function applyCoreQuestions() {
    if (!draft.graph || coreQuestions.length === 0) return;
    const curatedById = curatedInputDefaultsById(draft);
    setDraft(
      applyRecommendedSetup(
        clearRecommendedSetup(draft),
        draft.graph,
        coreQuestions.map((input) => ({
          legalId: input.legalId,
          label: curatedById.get(input.legalId)?.label,
          default: curatedById.get(input.legalId)?.default,
        })),
        curated?.recommendedMemberCount ?? 1,
      ),
    );
  }

  return (
    <div className="step-body input-guide-step">
      <div className="input-guide-kicker">
        Start with the core questions for the selected results, or build a
        custom form from the full rule-pack catalog.
      </div>

      {showBlockingAnalysis && (
        <div className="analysis-loading-card" role="status" aria-live="polite">
          <span className="analysis-spinner" aria-hidden />
          <span className="analysis-loading-text">
            Analyzing the computation tree for the selected results…
          </span>
        </div>
      )}

      {sensitivityStatus === "error" && !hasFastQuestions && (
        <div className="input-guide-note">
          The computation-tree analysis did not finish. Use custom questions
          while we inspect the engine result.
        </div>
      )}
      {sensitivityStatus === "error" && hasFastQuestions && (
        <div className="input-guide-note">
          Engine testing did not finish, so we are showing fast recommendations
          from the dependency graph.
        </div>
      )}

      <div className="output-headline-cards input-depth-cards">
        <button
          type="button"
          className={`output-headline-card ${coreQuestions.length > 0 && selectedMatchesIds(draft, coreQuestions.map((q) => q.legalId)) ? "is-selected" : ""}`}
          onClick={applyCoreQuestions}
          disabled={coreQuestions.length === 0}
        >
          <span className="output-headline-card-title">Core questions</span>
          <span className="output-headline-card-source">
            {recommendationMode === "engine-tested"
              ? "Use the questions confirmed to change the selected result in engine testing."
              : recommendationMode === "engine-and-graph"
                ? "Use engine-tested questions, filled out with nearby graph dependencies."
              : "Use the closest questions from the selected results' dependency graph."}
          </span>
          <span className="output-headline-card-state">
            {showBlockingAnalysis
              ? "Analyzing…"
              : `${coreQuestionCount} question${coreQuestionCount === 1 ? "" : "s"}`}
          </span>
        </button>

        <button
          type="button"
          className="output-headline-card output-headline-card-custom"
          onClick={onOpenAdvanced}
        >
          <span className="output-headline-card-title">Custom questions</span>
          <span className="output-headline-card-source">
            Browse the full computation tree and decide exactly which inputs to
            ask.
          </span>
          <span className="output-headline-card-state">
            Open question picker →
          </span>
        </button>
      </div>

      {sensitivityStatus !== "loading" && sensitivityStatus !== "error" && coreQuestions.length === 0 && (
        <div className="input-guide-note">
          {sensitivity
            ? "The analysis did not return core questions for this output. Use custom questions while we inspect the computation tree."
            : "Waiting for sensitivity analysis before recommending core questions."}
        </div>
      )}
    </div>
  );
}

function FormSectionsStep({
  draft,
  setDraft,
  sensitivity,
  onOpenAdvanced,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  sensitivity?: SensitivityResult | null;
  onOpenAdvanced: () => void;
}) {
  const sections = formSections(draft, sensitivity);

  return (
    <div className="step-body input-guide-step">
      <div className="form-section-grid">
        {sections.map((section) => (
          <button
            key={section.key}
            type="button"
            className={`form-section-card ${section.selectedCount > 0 ? "is-selected" : ""}`}
            onClick={() =>
              setDraft(
                section.selectedCount > 0
                  ? removeQuestions(draft, section.selectedIds)
                  : addRecommendedQuestions(draft, section.recommendedIds),
              )
            }
          >
            <span className="form-section-card-head">
              <span className="form-section-card-title">{section.label}</span>
              <span className="form-section-card-count">
                <strong>{section.selectedCount}</strong>
                <span>selected</span>
              </span>
            </span>
            <span className="form-section-card-copy">{section.copy}</span>
            {section.selectedLabels.length > 0 ? (
              <span className="form-section-card-selected-list">
                {section.selectedLabels.slice(0, 4).map((label) => (
                  <span key={label} className="form-section-card-question">
                    {label}
                  </span>
                ))}
                {section.selectedLabels.length > 4 && (
                  <span className="form-section-card-more">
                    +{section.selectedLabels.length - 4} more selected
                  </span>
                )}
              </span>
            ) : (
              <span className="form-section-card-meta">{section.tradeoff}</span>
            )}
            <span className="form-section-card-catalog">
              {section.availableCount} available in catalog
            </span>
            <span className="form-section-card-action">
              {section.selectedCount > 0 ? "Remove selected" : "Add suggested"}
            </span>
          </button>
        ))}
      </div>

      <div className="input-guide-actions">
        <button
          type="button"
          className="setup-notice-action is-primary"
          onClick={onOpenAdvanced}
        >
          Browse available questions
        </button>
      </div>
    </div>
  );
}

function SkippedAssumptionsStep({
  draft,
  sensitivity,
  onOpenAdvanced,
}: {
  draft: Draft;
  sensitivity?: SensitivityResult | null;
  onOpenAdvanced: () => void;
}) {
  const selected = selectedQuestionIds(draft);
  const skippedByCategory = useMemo(() => {
    if (!draft.graph) return [];
    const cats = new Map<
      string,
      { key: string; label: string; order: number; count: number; examples: string[] }
    >();
    for (const node of draft.graph.inputs) {
      if (selected.has(node.legalId)) continue;
      const c = categorizeInput(node.name, inferDtype(node));
      const entry = cats.get(c.key) ?? { ...c, count: 0, examples: [] };
      entry.count += 1;
      if (entry.examples.length < 3) entry.examples.push(humanize(node.name));
      cats.set(c.key, entry);
    }
    return [...cats.values()].sort(
      (a, b) => a.order - b.order || a.label.localeCompare(b.label),
    );
  }, [draft.graph, selected]);

  const noEffectCount = sensitivity?.no_effect.length ?? 0;
  const defaultedCount = skippedByCategory.reduce((sum, c) => sum + c.count, 0);

  return (
    <div className="step-body input-guide-step">
      <div className="input-guide-kicker">
        Most rule inputs are internal details, not client-facing form fields.
        This screen shows the categories that will stay behind the scenes
        unless you decide to add more detail.
      </div>

      <div className="input-assumption-grid">
        <div className="input-assumption-stat">
          <span className="input-defaults-count">{selected.size}</span>
          <span className="input-defaults-label">client questions</span>
        </div>
        <div className="input-assumption-stat">
          <span className="input-defaults-count">{skippedByCategory.length}</span>
          <span className="input-defaults-label">default categories</span>
        </div>
      </div>

      {noEffectCount > 0 && (
        <div className="setup-notice setup-notice-prompt">
          <span className="setup-notice-text">
            {noEffectCount} tested question{noEffectCount === 1 ? "" : "s"} did
            not move the selected result with the current defaults.
          </span>
        </div>
      )}

      <div className="setup-notice setup-notice-prompt">
        <span className="setup-notice-text">
          {defaultedCount} available rule inputs are staying out of the form.
          They are still handled by defaults or rule-pack assumptions.
        </span>
      </div>

      <div className="input-assumption-cards">
        {skippedByCategory.map((cat) => (
          <section key={cat.key} className="input-assumption-card">
            <header className="input-review-group-head">
              <span className="input-review-group-title">{cat.label}</span>
              <span className="input-defaults-group-meta">
                {cat.count} defaulted
              </span>
            </header>
            <div className="input-assumption-examples" aria-label={`Examples in ${cat.label}`}>
              {cat.examples.map((example) => (
                <span key={example} className="input-assumption-chip">
                  {example}
                </span>
              ))}
              {cat.count > cat.examples.length && (
                <span className="input-assumption-chip is-more">
                  +{cat.count - cat.examples.length} more
                </span>
              )}
            </div>
          </section>
        ))}
      </div>

      <div className="input-guide-actions">
        <button
          type="button"
          className="setup-notice-action"
          onClick={onOpenAdvanced}
        >
          Add a skipped question
        </button>
      </div>
    </div>
  );
}

function StartingValuesStep({
  draft,
  setDraft,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
}) {
  const [editing, setEditing] = useState(false);
  const total = questionCount(draft);

  function applyBlankDefaults() {
    if (!draft.graph) return;
    setDraft(mapSelectedQuestionDefaults(draft, (input) => {
      const node = draft.graph!.inputs.find((i) => i.legalId === input.legalId);
      return node ? defaultFor(node, input.dtype) : input.default;
    }));
    setEditing(false);
  }

  function patchInputDefault(legalId: string, value: string | number | boolean) {
    setDraft({
      ...draft,
      inputs: draft.inputs.map((i) =>
        i.legalId === legalId ? { ...i, default: value } : i,
      ),
      relations: draft.relations.map((r) => ({
        ...r,
        memberInputs: r.memberInputs.map((m) =>
          m.legalId === legalId ? { ...m, default: value } : m,
        ),
      })),
    });
  }

  return (
    <div className="step-body input-guide-step">
      <div className="input-guide-kicker">
        Starting values control what the deployed calculator shows before a
        user changes anything. They do not change which questions appear.
      </div>

      <div className="output-headline-cards">
        <button
          type="button"
          className={`output-headline-card output-headline-card-decide ${!editing ? "is-selected" : ""}`}
          onClick={applyBlankDefaults}
        >
          <span className="output-headline-card-title">Blank form</span>
          <span className="output-headline-card-source">
            Start most numeric fields at zero, booleans off, and dates at the
            period start.
          </span>
          <span className="output-headline-card-state">
            {!editing ? "Selected" : "Select blank"}
          </span>
        </button>
        <button
          type="button"
          className={`output-headline-card output-headline-card-custom ${editing ? "is-selected" : ""}`}
          onClick={() => setEditing(true)}
        >
          <span className="output-headline-card-title">Custom starting values</span>
          <span className="output-headline-card-source">
            Edit the defaults for the {total} selected question
            {total === 1 ? "" : "s"} directly.
          </span>
          <span className="output-headline-card-state">
            {editing ? "Selected" : "Edit defaults →"}
          </span>
        </button>
      </div>

      {editing && (
        <div className="input-values-editor">
          {draft.inputs.map((input) => (
            <DefaultValueField
              key={input.legalId}
              input={input}
              onChange={(value) => patchInputDefault(input.legalId, value)}
            />
          ))}
          {draft.relations.map((rel) => (
            <section key={rel.legalId} className="input-values-relation">
              <header className="input-review-group-head">
                <span className="input-review-group-title">{rel.label}</span>
                <span className="input-defaults-group-meta">
                  per-member defaults
                </span>
              </header>
              {rel.memberInputs.map((input) => (
                <DefaultValueField
                  key={input.legalId}
                  input={input}
                  onChange={(value) => patchInputDefault(input.legalId, value)}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function DefaultValueField({
  input,
  onChange,
}: {
  input: InputExposure;
  onChange: (value: string | number | boolean) => void;
}) {
  if (input.dtype === "boolean") {
    return (
      <label className="input-value-field input-value-field-checkbox">
        <input
          type="checkbox"
          checked={Boolean(input.default)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{input.label}</span>
      </label>
    );
  }

  const type = input.dtype === "date" ? "date" : input.dtype === "string" ? "text" : "number";
  return (
    <label className="input-value-field">
      <span>{input.label}</span>
      <input
        type={type}
        value={String(input.default)}
        onChange={(e) => onChange(parseDefault(input.dtype, e.target.value))}
      />
    </label>
  );
}

interface AdvancedProps {
  draft: Draft;
  setDraft: (d: Draft) => void;
  sensitivity?: SensitivityResult | null;
}

function AdvancedInputPicker({
  draft,
  setDraft,
  sensitivity,
}: AdvancedProps) {
  const [inputDeps, setInputDeps] = useState<Record<string, number>>({});
  const [relationDeps, setRelationDeps] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!draft.program || draft.outputs.length === 0) {
      setInputDeps({});
      setRelationDeps({});
      return;
    }
    setLoading(true);
    fetchTransitive(
      draft.program.repo,
      draft.program.path,
      draft.outputs.map((o) => o.legalId),
    )
      .then((res) => {
        setInputDeps(res.inputs);
        setRelationDeps(res.relations);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [draft.outputs, draft.program]);

  const inputCatalog: DepEntry<InputGraphNode>[] = useMemo(() => {
    if (!draft.graph) return [];
    return draft.graph.inputs
      .map((i) => ({ node: i, depth: inputDeps[i.legalId] ?? Infinity }))
      .filter((e) => Number.isFinite(e.depth))
      .sort((a, b) => a.depth - b.depth || a.node.name.localeCompare(b.node.name));
  }, [draft.graph, inputDeps]);

  const relationCatalog: DepEntry<RelationGraphNode>[] = useMemo(() => {
    if (!draft.graph) return [];
    return draft.graph.relations
      .map((r) => ({ node: r, depth: relationDeps[r.legalId] ?? Infinity }))
      .filter((e) => Number.isFinite(e.depth))
      .sort((a, b) => a.depth - b.depth);
  }, [draft.graph, relationDeps]);

  // Snapshots of what the user has already exposed. The bottom picker hides
  // these entries — they're shown in the "Exposed inputs" panel above the
  // search instead, so we don't render the same row twice.
  const exposedInputIdsArr = useMemo(
    () => draft.inputs.map((i) => i.legalId),
    [draft.inputs],
  );
  const exposedRelationIdsArr = useMemo(
    () => draft.relations.map((r) => r.legalId),
    [draft.relations],
  );
  const exposedMemberInputIdsArr = useMemo(
    () => draft.relations.flatMap((r) => r.memberInputs.map((m) => m.legalId)),
    [draft.relations],
  );

  const availableInputCatalog = useMemo(() => {
    const exposed = new Set([...exposedInputIdsArr, ...exposedMemberInputIdsArr]);
    return inputCatalog.filter((e) => !exposed.has(e.node.legalId));
  }, [inputCatalog, exposedInputIdsArr, exposedMemberInputIdsArr]);

  const availableRelationCatalog = useMemo(() => {
    const exposed = new Set(exposedRelationIdsArr);
    return relationCatalog.filter((e) => !exposed.has(e.node.legalId));
  }, [relationCatalog, exposedRelationIdsArr]);

  const q = query.trim().toLowerCase();
  const matchedInputs = useMemo(() => {
    if (!q) return availableInputCatalog;
    return availableInputCatalog.filter(
      (e) =>
        e.node.name.toLowerCase().includes(q) ||
        e.node.legalId.toLowerCase().includes(q),
    );
  }, [availableInputCatalog, q]);

  const matchedRelations = useMemo(() => {
    if (!q) return availableRelationCatalog;
    return availableRelationCatalog.filter(
      (e) =>
        e.node.name.toLowerCase().includes(q) ||
        e.node.legalId.toLowerCase().includes(q),
    );
  }, [availableRelationCatalog, q]);

  // Direct factors: depth 1–2 across the whole catalog. These are the
  // factors most directly tied to the user's chosen outputs.
  const directInputs = useMemo(
    () => availableInputCatalog.filter((e) => e.depth <= 2),
    [availableInputCatalog],
  );
  const directRelations = useMemo(
    () => availableRelationCatalog.filter((e) => e.depth <= 2),
    [availableRelationCatalog],
  );
  const deeperInputs = useMemo(
    () => availableInputCatalog.filter((e) => e.depth > 2),
    [availableInputCatalog],
  );
  const deeperRelations = useMemo(
    () => availableRelationCatalog.filter((e) => e.depth > 2),
    [availableRelationCatalog],
  );

  // Group the deeper inputs by category — Income / Resources /
  // Eligibility / Household / etc. — same taxonomy as OutputStep so
  // the picker stays cognitively consistent across steps.
  const labelPrefix = curatedForDraft(draft.program)?.labelPrefix;

  // Map each input to the picked outputs it actually moves (per
  // sensitivity analysis). Used to render "moves Eligibility" badges
  // on rule rows and to drive the load-bearing auto-suggest.
  const loadBearingMap = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!sensitivity) return m;
    for (const [outputId, ids] of Object.entries(sensitivity.load_bearing)) {
      for (const id of ids) {
        if (!m.has(id)) m.set(id, []);
        m.get(id)!.push(outputId);
      }
    }
    return m;
  }, [sensitivity]);
  const noEffectSet = useMemo(
    () => new Set(sensitivity?.no_effect ?? []),
    [sensitivity],
  );
  // Short labels for the picked outputs so the badge can read
  // "moves Eligibility" instead of a 60-character legal ID.
  const outputLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of draft.outputs) m.set(o.legalId, o.label);
    return m;
  }, [draft.outputs]);

  function lbFor(legalId: string): string[] | null {
    if (!sensitivity) return null;
    const outIds = loadBearingMap.get(legalId);
    if (!outIds) return [];
    return outIds.map((id) => outputLabelById.get(id) ?? id.split("#").pop() ?? id);
  }
  function ne(legalId: string): boolean {
    return !!sensitivity && noEffectSet.has(legalId);
  }
  interface InputCategory {
    key: string;
    label: string;
    order: number;
    items: DepEntry<InputGraphNode>[];
  }
  const inputCategories = useMemo<InputCategory[]>(() => {
    const cats = new Map<string, InputCategory>();
    for (const entry of deeperInputs) {
      const c = categorizeInput(entry.node.name, inferDtype(entry.node));
      if (!cats.has(c.key)) {
        cats.set(c.key, { ...c, items: [] });
      }
      cats.get(c.key)!.items.push(entry);
    }
    return [...cats.values()]
      .map((c) => ({
        ...c,
        items: c.items.sort((a, b) =>
          a.node.name.localeCompare(b.node.name),
        ),
      }))
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }, [deeperInputs]);

  const exposedInputIds = new Set(draft.inputs.map((i) => i.legalId));
  const exposedRelationIds = new Set(draft.relations.map((r) => r.legalId));
  // Per-member input legal IDs already attached to a relation's memberInputs.
  const exposedMemberInputIds = new Set(
    draft.relations.flatMap((r) => r.memberInputs.map((m) => m.legalId)),
  );

  /**
   * Toggle an input. Person-scope inputs auto-route into their relation's
   * memberInputs so the form renders one field per member; Household-scope
   * inputs go into draft.inputs as a single top-level field.
   */
  function toggleInput(node: InputGraphNode) {
    if (node.entity === "Person" && node.relationLegalId) {
      togglePersonInput(node);
      return;
    }
    if (exposedInputIds.has(node.legalId)) {
      setDraft({ ...draft, inputs: draft.inputs.filter((i) => i.legalId !== node.legalId) });
    } else {
      setDraft({ ...draft, inputs: [...draft.inputs, exposeInput(node)] });
    }
  }

  function togglePersonInput(node: InputGraphNode) {
    if (!draft.graph) return;
    const relationId = node.relationLegalId!;
    const relationNode = draft.graph.relations.find((r) => r.legalId === relationId);
    if (!relationNode) return;

    // Already attached → detach.
    if (exposedMemberInputIds.has(node.legalId)) {
      const nextRelations = draft.relations.map((r) =>
        r.legalId === relationId
          ? { ...r, memberInputs: r.memberInputs.filter((m) => m.legalId !== node.legalId) }
          : r,
      );
      setDraft({ ...draft, relations: nextRelations });
      return;
    }

    // Auto-expose the relation if it isn't yet, and append this input to its memberInputs.
    const dtype = dtypeFor(node);
    const memberInput: InputExposure = {
      legalId: node.legalId,
      label: humanize(node.name),
      dtype,
      default: defaultFor(node, dtype),
      widget: widgetFor(dtype, node.legalId),
      relationLegalId: relationId,
    };

    const existing = draft.relations.find((r) => r.legalId === relationId);
    let nextRelations: RelationExposure[];
    if (existing) {
      nextRelations = draft.relations.map((r) =>
        r.legalId === relationId ? { ...r, memberInputs: [...r.memberInputs, memberInput] } : r,
      );
    } else {
      nextRelations = [
        ...draft.relations,
        { ...exposeRelation(relationNode), memberInputs: [memberInput] },
      ];
    }
    setDraft({ ...draft, relations: nextRelations });
  }

  function toggleRelation(node: RelationGraphNode) {
    if (exposedRelationIds.has(node.legalId)) {
      setDraft({ ...draft, relations: draft.relations.filter((r) => r.legalId !== node.legalId) });
    } else {
      setDraft({ ...draft, relations: [...draft.relations, exposeRelation(node)] });
    }
  }

  function patchInput(legalId: string, patch: Partial<InputExposure>) {
    setDraft({
      ...draft,
      inputs: draft.inputs.map((i) => (i.legalId === legalId ? { ...i, ...patch } : i)),
    });
  }

  function toggleGroupOpen(key: string, defaultOpen: boolean) {
    const explicitOpen = openGroups.has(key);
    const explicitClosed = openGroups.has(`__closed:${key}`);
    const isOpen = explicitOpen || (!explicitClosed && defaultOpen);
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (isOpen) {
        next.delete(key);
        next.add(`__closed:${key}`);
      } else {
        next.add(key);
        next.delete(`__closed:${key}`);
      }
      return next;
    });
  }
  function isGroupOpen(key: string, defaultOpen: boolean) {
    if (openGroups.has(key)) return true;
    if (openGroups.has(`__closed:${key}`)) return false;
    return defaultOpen;
  }

  if (draft.outputs.length === 0) {
    return <div className="empty-hint">Pick at least one output first.</div>;
  }
  if (loading) return <div className="empty-hint">Computing dependencies…</div>;

  const totalRelevant = inputCatalog.length + relationCatalog.length;
  const exposedCount = exposedInputIds.size + exposedRelationIds.size;

  if (totalRelevant === 0) {
    return (
      <div className="empty-hint">
        These outputs have no inputs in the dependency graph — they may be parameter-only or computed
        purely from other rules.
      </div>
    );
  }

  const hasPicks = exposedCount > 0;
  return (
    <div className="step-body step-narrow advanced-input-picker">
      {hasPicks && (
        <section className="picked-strip" aria-label="Picked questions">
          <div className="picked-strip-head">
            <span className="picked-strip-label">
              Picked questions · <strong>{exposedCount}</strong>
            </span>
          </div>
          <div className="picked-strip-pills">
            {draft.relations.map((rel) => (
              <span key={`rel:${rel.legalId}`} className="selected-pill">
                <span className="label" title={rel.label}>{rel.label}</span>
                <span className="meta">
                  · {rel.memberInputs.length} per-member field
                  {rel.memberInputs.length === 1 ? "" : "s"}
                </span>
                <button
                  className="selected-pill-remove"
                  title="Remove"
                  aria-label="Remove"
                  onClick={() => {
                    const node = draft.graph?.relations.find(
                      (r) => r.legalId === rel.legalId,
                    );
                    if (node) toggleRelation(node);
                  }}
                >
                  ×
                </button>
              </span>
            ))}
            {draft.relations.flatMap((rel) =>
              rel.memberInputs.map((member) => (
                <span
                  key={`mem:${member.legalId}`}
                  className="selected-pill selected-pill-indent"
                >
                  <span className="label" title={member.label}>{member.label}</span>
                  <span className="meta">· per member</span>
                  <button
                    className="selected-pill-remove"
                    title="Remove"
                    aria-label="Remove"
                    onClick={() => {
                      const node = draft.graph?.inputs.find(
                        (i) => i.legalId === member.legalId,
                      );
                      if (node) toggleInput(node);
                    }}
                  >
                    ×
                  </button>
                </span>
              )),
            )}
            {draft.inputs.map((inp) => (
              <span key={`inp:${inp.legalId}`} className="selected-pill">
                <span className="label" title={inp.label}>{inp.label}</span>
                <button
                  className="selected-pill-remove"
                  title="Remove"
                  aria-label="Remove"
                  onClick={() => {
                    const node = draft.graph?.inputs.find(
                      (i) => i.legalId === inp.legalId,
                    );
                    if (node) toggleInput(node);
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Hide the search bar entirely once every reachable input is
          exposed — nothing left to find. */}
      {availableInputCatalog.length + availableRelationCatalog.length > 0 && (
        <section className="additional-inputs-panel">
          <header className="additional-inputs-head">
            <span className="additional-inputs-eyebrow">Additional inputs</span>
            <h3>Available questions</h3>
          </header>
          <div className="inline-search">
            <input
              type="search"
              className="inline-search-input"
              placeholder={`Search ${totalRelevant} available questions…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </section>
      )}

      {q ? (
        // Search results — flat.
        <div className="rule-list rule-list-grouped">
          {matchedRelations.map(({ node, depth }) => (
            <RelationRow
              key={node.legalId}
              node={node}
              depth={depth}
              exposed={exposedRelationIds.has(node.legalId)}
              exposure={draft.relations.find((r) => r.legalId === node.legalId)}
              labelPrefix={labelPrefix}
              loadBearingFor={lbFor(node.legalId)}
              noEffect={ne(node.legalId)}
              onToggle={() => toggleRelation(node)}
            />
          ))}
          {matchedInputs.map(({ node, depth }) => (
            <InputRow
              key={node.legalId}
              node={node}
              depth={depth}
              exposed={
                node.entity === "Person"
                  ? exposedMemberInputIds.has(node.legalId)
                  : exposedInputIds.has(node.legalId)
              }
              exposure={draft.inputs.find((i) => i.legalId === node.legalId)}
              labelPrefix={labelPrefix}
              loadBearingFor={lbFor(node.legalId)}
              noEffect={ne(node.legalId)}
              onToggle={() => toggleInput(node)}
              onPatch={(p) => patchInput(node.legalId, p)}
              isEditing={editingId === node.legalId}
              onEditToggle={() =>
                setEditingId(editingId === node.legalId ? null : node.legalId)
              }
            />
          ))}
          {matchedInputs.length + matchedRelations.length === 0 && (
            <div className="empty-hint">No inputs match "{query}".</div>
          )}
        </div>
      ) : (
        <>
          {/* Direct factors — pinned at the top, shown open by default
              since these are the highest-leverage questions. */}
          {(directInputs.length > 0 || directRelations.length > 0) && (
            <section className="rule-doc rule-doc-headlines">
              <div className="rule-doc-head rule-doc-head-static">
                <span className="rule-doc-label">Most-relevant questions</span>
                <span className="rule-doc-meta">
                  {directInputs.length + directRelations.length} closest to
                  your results
                </span>
              </div>
              <div className="rule-list rule-list-grouped">
                {directRelations.map(({ node, depth }) => (
                  <RelationRow
                    key={node.legalId}
                    node={node}
                    depth={depth}
                    exposed={exposedRelationIds.has(node.legalId)}
                    exposure={draft.relations.find(
                      (r) => r.legalId === node.legalId,
                    )}
                    labelPrefix={labelPrefix}
                    loadBearingFor={lbFor(node.legalId)}
                    noEffect={ne(node.legalId)}
                    onToggle={() => toggleRelation(node)}
                  />
                ))}
                {directInputs.map(({ node, depth }) => (
                  <InputRow
                    key={node.legalId}
                    node={node}
                    depth={depth}
                    exposed={
                      node.entity === "Person"
                        ? exposedMemberInputIds.has(node.legalId)
                        : exposedInputIds.has(node.legalId)
                    }
                    exposure={draft.inputs.find(
                      (i) => i.legalId === node.legalId,
                    )}
                    labelPrefix={labelPrefix}
                    loadBearingFor={lbFor(node.legalId)}
                    noEffect={ne(node.legalId)}
                    onToggle={() => toggleInput(node)}
                    onPatch={(p) => patchInput(node.legalId, p)}
                    isEditing={editingId === node.legalId}
                    onEditToggle={() =>
                      setEditingId(
                        editingId === node.legalId ? null : node.legalId,
                      )
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {/* Deeper inputs — collapsibles, one per category. Same
              treatment as Step II's intermediates picker. */}
          {inputCategories.map((cat) => {
            const open = isGroupOpen(cat.key, false);
            return (
              <section key={cat.key} className="rule-doc">
                <button
                  type="button"
                  className="rule-doc-head"
                  onClick={() => toggleGroupOpen(cat.key, false)}
                  aria-expanded={open}
                >
                  <span className="rule-group-chevron">
                    {open ? "▾" : "▸"}
                  </span>
                  <span className="rule-doc-label">{cat.label}</span>
                  <span className="rule-doc-meta">
                    {cat.items.length} question
                    {cat.items.length === 1 ? "" : "s"}
                  </span>
                </button>
                {open && (
                  <div className="rule-list rule-list-grouped">
                    {cat.items.map(({ node, depth }) => (
                      <InputRow
                        key={node.legalId}
                        node={node}
                        depth={depth}
                        exposed={
                          node.entity === "Person"
                            ? exposedMemberInputIds.has(node.legalId)
                            : exposedInputIds.has(node.legalId)
                        }
                        exposure={draft.inputs.find(
                          (i) => i.legalId === node.legalId,
                        )}
                        labelPrefix={labelPrefix}
                        loadBearingFor={lbFor(node.legalId)}
                        noEffect={ne(node.legalId)}
                        onToggle={() => toggleInput(node)}
                        onPatch={(p) => patchInput(node.legalId, p)}
                        isEditing={editingId === node.legalId}
                        onEditToggle={() =>
                          setEditingId(
                            editingId === node.legalId ? null : node.legalId,
                          )
                        }
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}

          {/* Relations & per-member inputs — separate at the end
              because they're a different shape (one switch exposes a
              whole repeating block). */}
          {deeperRelations.length > 0 && (
            <section className="rule-doc">
              <button
                type="button"
                className="rule-doc-head"
                onClick={() => toggleGroupOpen("__relations", false)}
                aria-expanded={isGroupOpen("__relations", false)}
              >
                <span className="rule-group-chevron">
                  {isGroupOpen("__relations", false) ? "▾" : "▸"}
                </span>
                <span className="rule-doc-label">
                  Relations & per-member inputs
                </span>
                <span className="rule-doc-meta">
                  {deeperRelations.length} relation
                  {deeperRelations.length === 1 ? "" : "s"}
                </span>
              </button>
              {isGroupOpen("__relations", false) && (
                <div className="rule-list rule-list-grouped">
                  {deeperRelations.map(({ node, depth }) => (
                    <RelationRow
                      key={node.legalId}
                      node={node}
                      depth={depth}
                      exposed={exposedRelationIds.has(node.legalId)}
                      exposure={draft.relations.find(
                        (r) => r.legalId === node.legalId,
                      )}
                      labelPrefix={labelPrefix}
                      loadBearingFor={lbFor(node.legalId)}
                      noEffect={ne(node.legalId)}
                      onToggle={() => toggleRelation(node)}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function InputRow({
  node,
  depth,
  exposed,
  exposure,
  labelPrefix,
  loadBearingFor,
  noEffect,
  onToggle,
  onPatch,
  isEditing,
  onEditToggle,
}: {
  node: InputGraphNode;
  depth: number;
  exposed: boolean;
  exposure: InputExposure | undefined;
  labelPrefix: string | undefined;
  /** Picked-output labels this input is known to move (sensitivity).
   * Empty means tested-and-no-effect; null means not yet tested. */
  loadBearingFor?: string[] | null;
  /** Whether sensitivity tested this input and found it moved nothing. */
  noEffect?: boolean;
  onToggle: () => void;
  onPatch: (p: Partial<InputExposure>) => void;
  isEditing: boolean;
  onEditToggle: () => void;
}) {
  const isPerson = node.entity === "Person";
  const label =
    exposure?.label ?? humanizeWithoutPrefix(node.name, labelPrefix);
  const loadBearing = (loadBearingFor?.length ?? 0) > 0;
  const rowClass = [
    "rule-toggle",
    exposed ? "is-selected" : "",
    loadBearing ? "is-load-bearing" : "",
    !loadBearing && noEffect ? "is-no-effect" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // Outer container is non-button so we can nest the Edit button without
  // an invalid <button> inside <button>. role="checkbox" preserves
  // accessibility; keyboard users get Space/Enter to toggle.
  return (
    <div>
      <div
        role="checkbox"
        tabIndex={0}
        aria-checked={exposed}
        className={rowClass}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="rule-toggle-label" title={label}>
          {label}
          {isPerson && (
            <span
              className="per-member-tag"
              title="Per household member — the form will show one field per member"
            >
              per member
            </span>
          )}
          {loadBearing && (
            <span
              className="load-bearing-tag"
              title={`This input changes the calculator's answer for ${loadBearingFor!.join(", ")}.`}
            >
              moves {loadBearingFor!.length === 1 ? loadBearingFor![0] : `${loadBearingFor!.length} results`}
            </span>
          )}
          {!loadBearing && noEffect && (
            <span
              className="no-effect-tag"
              title="Tested — changing this input doesn't move any of your picked results given the current defaults."
            >
              no effect
            </span>
          )}
        </span>
        {exposed && !isPerson && (
          <button
            type="button"
            className="rule-toggle-action"
            onClick={(e) => {
              e.stopPropagation();
              onEditToggle();
            }}
          >
            {isEditing ? "Done" : "Edit"}
          </button>
        )}
        <span
          className={`rule-toggle-mark ${exposed ? "is-on" : ""}`}
          aria-hidden="true"
        >
          {exposed ? "✓" : "+"}
        </span>
      </div>
      {exposed && isEditing && exposure && (
        <div className="inline-edit">
          <div className="inline-edit-legalid">{node.legalId}</div>
          <div className="inline-edit-meta">
            depth {depth} · declared in {humanizeCitation(node.fileLegalId)}
          </div>
          <label>
            Label
            <input
              type="text"
              value={exposure.label}
              onChange={(e) => onPatch({ label: e.target.value })}
            />
          </label>
          <label>
            Default value
            <input
              type="text"
              value={String(exposure.default)}
              onChange={(e) =>
                onPatch({ default: parseDefault(exposure.dtype, e.target.value) })
              }
            />
          </label>
        </div>
      )}
    </div>
  );
}

function RelationRow({
  node,
  exposed,
  exposure,
  labelPrefix,
  loadBearingFor,
  noEffect,
  onToggle,
}: {
  node: RelationGraphNode;
  depth: number;
  exposed: boolean;
  exposure: RelationExposure | undefined;
  labelPrefix: string | undefined;
  loadBearingFor?: string[] | null;
  noEffect?: boolean;
  onToggle: () => void;
}) {
  const label =
    exposure?.label ?? humanizeWithoutPrefix(node.name, labelPrefix);
  const loadBearing = (loadBearingFor?.length ?? 0) > 0;
  const rowClass = [
    "rule-toggle",
    exposed ? "is-selected" : "",
    loadBearing ? "is-load-bearing" : "",
    !loadBearing && noEffect ? "is-no-effect" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={exposed}
      className={rowClass}
      onClick={onToggle}
    >
      <span className="rule-toggle-label" title={label}>
        {label}
        <span className="per-member-tag" title="Repeating block — exposing this puts a list-of-members section in the form">
          relation
        </span>
        {loadBearing && (
          <span
            className="load-bearing-tag"
            title={`This relation moves ${loadBearingFor!.join(", ")}.`}
          >
            moves {loadBearingFor!.length === 1 ? loadBearingFor![0] : `${loadBearingFor!.length} results`}
          </span>
        )}
      </span>
      <span
        className={`rule-toggle-mark ${exposed ? "is-on" : ""}`}
        aria-hidden="true"
      >
        {exposed ? "✓" : "+"}
      </span>
    </button>
  );
}

function selectedMatchesIds(draft: Draft, legalIds: string[]): boolean {
  const selected = selectedQuestionIds(draft);
  if (selected.size !== legalIds.length) return false;
  return legalIds.every((id) => selected.has(id));
}

type FormSectionKey =
  | "household"
  | "income"
  | "housing"
  | "members"
  | "resources"
  | "special";

const FORM_SECTION_DEFS: Array<{
  key: FormSectionKey;
  label: string;
  copy: string;
  tradeoff: string;
}> = [
  {
    key: "household",
    label: "Household",
    copy: "Who is applying and how large the household is.",
    tradeoff: "Essential for almost every SNAP workflow.",
  },
  {
    key: "income",
    label: "Income",
    copy: "What the household earns or receives each month.",
    tradeoff: "Usually needed for eligibility, verification, and amount estimates.",
  },
  {
    key: "housing",
    label: "Housing and utilities",
    copy: "Rent, mortgage, shelter costs, and utility responsibility.",
    tradeoff: "Adds a few questions and can improve benefit amount accuracy.",
  },
  {
    key: "members",
    label: "Member details",
    copy: "Age, citizenship, disability, and other per-person facts.",
    tradeoff: "Adds repeating questions, but supports more precise screening.",
  },
  {
    key: "resources",
    label: "Resources and assets",
    copy: "Assets, limits, values, and resource-related rules.",
    tradeoff: "Often optional for a quick screen; useful for edge cases.",
  },
  {
    key: "special",
    label: "Special situations",
    copy: "Disqualifications, student/work situations, and other exceptions.",
    tradeoff: "Best when the form is for detailed application support.",
  },
];

function formSections(
  draft: Draft,
  sensitivity?: SensitivityResult | null,
): Array<{
  key: FormSectionKey;
  label: string;
  copy: string;
  tradeoff: string;
  availableCount: number;
  selectedCount: number;
  selectedIds: string[];
  selectedLabels: string[];
  recommendedIds: string[];
}> {
  const graphInputs = draft.graph?.inputs ?? [];
  const selected = selectedQuestionIds(draft);
  const curated = curatedForDraft(draft.program);
  const graphIds = new Set(graphInputs.map((i) => i.legalId));
  const sensitivityIds = new Set(
    sensitivity ? Object.values(sensitivity.load_bearing).flat() : [],
  );

  return FORM_SECTION_DEFS.map((def) => {
    const available = graphInputs.filter(
      (input) => sectionForInput(input.name) === def.key,
    );
    const availableIds = available.map((input) => input.legalId);
    const selectedIds = availableIds.filter((id) => selected.has(id));
    const selectedLabels = available
      .filter((input) => selected.has(input.legalId))
      .map((input) => selectedLabelForDraft(draft, input));

    const curatedIds =
      curated?.recommendedInputs
        ?.filter(
          (rec) =>
            graphIds.has(rec.legalId) &&
            sectionForInput(nameFromLegalId(rec.legalId)) === def.key,
        )
        .map((rec) => rec.legalId) ?? [];
    const loadBearingIds = availableIds.filter((id) => sensitivityIds.has(id));
    const fallbackIds = available
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 3)
      .map((input) => input.legalId);

    const recommendedIds = uniqueIds([
      ...curatedIds,
      ...loadBearingIds,
      ...(curatedIds.length || loadBearingIds.length ? [] : fallbackIds),
    ]);

    return {
      ...def,
      availableCount: availableIds.length,
      selectedCount: selectedIds.length,
      selectedIds,
      selectedLabels,
      recommendedIds,
    };
  });
}

function selectedLabelForDraft(draft: Draft, input: InputGraphNode): string {
  const scalar = draft.inputs.find((i) => i.legalId === input.legalId);
  if (scalar) return scalar.label;
  const member = draft.relations
    .flatMap((rel) => rel.memberInputs)
    .find((i) => i.legalId === input.legalId);
  return member?.label ?? humanize(input.name);
}

function sectionForInput(name: string): FormSectionKey {
  const n = name.toLowerCase();
  if (/income|earnings|earned|wages|pay\b|amount\b/.test(n)) return "income";
  if (
    /shelter|rent|mortgage|utility|heating|cooling|electric|medical|expense|deduction|cost/.test(
      n,
    )
  ) return "housing";
  if (
    /member|age|citizen|elderly|disabled|disability|student|immigration|pregnant|veteran|dependent/.test(
      n,
    )
  ) return "members";
  if (/resource|asset|vehicle|limit\b|threshold|lump_sum|value\b/.test(n)) {
    return "resources";
  }
  if (
    /eligible|qualif|disqualif|sanction|work|employment|excluded|exempt|verification|verified/.test(
      n,
    )
  ) return "special";
  return "household";
}

function addRecommendedQuestions(draft: Draft, legalIds: string[]): Draft {
  if (!draft.graph || legalIds.length === 0) return draft;
  const curated = curatedForDraft(draft.program);
  const curatedById = curatedInputDefaultsById(draft);
  const recommended = uniqueIds(legalIds).map((legalId) => ({
    legalId,
    label: curatedById.get(legalId)?.label,
    default: curatedById.get(legalId)?.default,
  }));
  return applyRecommendedSetup(
    draft,
    draft.graph,
    recommended,
    curated?.recommendedMemberCount ?? 1,
  );
}

function curatedInputDefaultsById(draft: Draft) {
  const curated = curatedForDraft(draft.program);
  return new Map(
    [
      ...(curated?.recommendedInputs ?? []),
      ...(curated?.inputDefaults ?? []),
    ].map((rec) => [rec.legalId, rec] as const),
  );
}

function selectCoreQuestions(
  draft: Draft,
  sensitivity: SensitivityResult | null | undefined,
  limit: number,
): InputGraphNode[] {
  if (!draft.graph || !sensitivity) return [];
  const ids = new Set(Object.values(sensitivity.load_bearing).flat());
  const inputsById = new Map(
    draft.graph.inputs.map((input) => [input.legalId, input] as const),
  );
  const curated = curatedForDraft(draft.program);
  const curatedOrder = new Map(
    (curated?.recommendedInputs ?? []).map((rec, index) => [
      rec.legalId,
      index,
    ] as const),
  );
  const defaultOrder = new Map(
    (curated?.inputDefaults ?? []).map((rec, index) => [
      rec.legalId,
      index,
    ] as const),
  );
  const outputCountByInput = new Map<string, number>();
  for (const [outputId, inputIds] of Object.entries(sensitivity.load_bearing)) {
    for (const inputId of inputIds) {
      outputCountByInput.set(
        inputId,
        (outputCountByInput.get(inputId) ?? 0) + (outputId ? 1 : 0),
      );
    }
  }

  return [...ids]
    .map((legalId) => inputsById.get(legalId))
    .filter((input): input is InputGraphNode => !!input)
    .sort((a, b) => {
      const curatedA = curatedOrder.get(a.legalId) ?? Number.POSITIVE_INFINITY;
      const curatedB = curatedOrder.get(b.legalId) ?? Number.POSITIVE_INFINITY;
      if (curatedA !== curatedB) return curatedA - curatedB;

      const movedA = outputCountByInput.get(a.legalId) ?? 0;
      const movedB = outputCountByInput.get(b.legalId) ?? 0;
      if (movedA !== movedB) return movedB - movedA;

      const defaultA = defaultOrder.get(a.legalId) ?? Number.POSITIVE_INFINITY;
      const defaultB = defaultOrder.get(b.legalId) ?? Number.POSITIVE_INFINITY;
      if (defaultA !== defaultB) return defaultA - defaultB;

      const sectionA = sectionOrder(sectionForInput(a.name));
      const sectionB = sectionOrder(sectionForInput(b.name));
      if (sectionA !== sectionB) return sectionA - sectionB;

      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

function selectFastCoreQuestions(
  draft: Draft,
  inputDeps: Record<string, number>,
  limit: number,
): InputGraphNode[] {
  if (!draft.graph) return [];
  const curated = curatedForDraft(draft.program);
  const curatedOrder = new Map(
    (curated?.recommendedInputs ?? []).map((rec, index) => [
      rec.legalId,
      index,
    ] as const),
  );
  const defaultOrder = new Map(
    (curated?.inputDefaults ?? []).map((rec, index) => [
      rec.legalId,
      index,
    ] as const),
  );
  const priorityIds = new Set([
    ...(curated?.recommendedInputs ?? []).map((rec) => rec.legalId),
    ...(curated?.inputDefaults ?? []).map((rec) => rec.legalId),
  ]);

  const graphInputs = draft.graph.inputs;
  const dependencyCandidates = graphInputs.filter((input) =>
    Number.isFinite(inputDeps[input.legalId]),
  );
  const curatedCandidates = graphInputs.filter((input) =>
    priorityIds.has(input.legalId),
  );
  const candidates = uniqueInputs(
    dependencyCandidates.length > 0
      ? [...curatedCandidates, ...dependencyCandidates]
      : curatedCandidates,
  );

  return candidates
    .sort((a, b) => {
      const curatedA = curatedOrder.get(a.legalId) ?? Number.POSITIVE_INFINITY;
      const curatedB = curatedOrder.get(b.legalId) ?? Number.POSITIVE_INFINITY;
      if (curatedA !== curatedB) return curatedA - curatedB;

      const defaultA = defaultOrder.get(a.legalId) ?? Number.POSITIVE_INFINITY;
      const defaultB = defaultOrder.get(b.legalId) ?? Number.POSITIVE_INFINITY;
      if (defaultA !== defaultB) return defaultA - defaultB;

      const depthA = inputDeps[a.legalId] ?? Number.POSITIVE_INFINITY;
      const depthB = inputDeps[b.legalId] ?? Number.POSITIVE_INFINITY;
      if (depthA !== depthB) return depthA - depthB;

      const sectionA = sectionOrder(sectionForInput(a.name));
      const sectionB = sectionOrder(sectionForInput(b.name));
      if (sectionA !== sectionB) return sectionA - sectionB;

      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

function uniqueInputs(inputs: InputGraphNode[]): InputGraphNode[] {
  const seen = new Set<string>();
  const out: InputGraphNode[] = [];
  for (const input of inputs) {
    if (seen.has(input.legalId)) continue;
    seen.add(input.legalId);
    out.push(input);
  }
  return out;
}

function selectedQuestionsFromDraft(draft: Draft, limit: number): InputGraphNode[] {
  if (!draft.graph) return [];
  const selected = selectedQuestionIds(draft);
  const byId = new Map(draft.graph.inputs.map((input) => [input.legalId, input]));
  return [...selected]
    .map((legalId) => byId.get(legalId))
    .filter((input): input is InputGraphNode => !!input)
    .slice(0, limit);
}

function removeQuestions(draft: Draft, legalIds: string[]): Draft {
  const remove = new Set(legalIds);
  return {
    ...draft,
    inputs: draft.inputs.filter((i) => !remove.has(i.legalId)),
    relations: draft.relations
      .map((r) => ({
        ...r,
        memberInputs: r.memberInputs.filter((m) => !remove.has(m.legalId)),
      }))
      .filter((r) => r.memberInputs.length > 0),
  };
}

function sectionOrder(key: FormSectionKey): number {
  const index = FORM_SECTION_DEFS.findIndex((def) => def.key === key);
  return index < 0 ? FORM_SECTION_DEFS.length : index;
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function questionCount(draft: Draft): number {
  return (
    draft.inputs.length +
    draft.relations.reduce((n, r) => n + r.memberInputs.length, 0)
  );
}

function selectedQuestionIds(draft: Draft): Set<string> {
  return new Set([
    ...draft.inputs.map((i) => i.legalId),
    ...draft.relations.flatMap((r) => r.memberInputs.map((m) => m.legalId)),
  ]);
}

function mapSelectedQuestionDefaults(
  draft: Draft,
  pickDefault: (input: InputExposure) => string | number | boolean,
): Draft {
  return {
    ...draft,
    inputs: draft.inputs.map((input) => ({
      ...input,
      default: pickDefault(input),
    })),
    relations: draft.relations.map((rel) => ({
      ...rel,
      memberInputs: rel.memberInputs.map((input) => ({
        ...input,
        default: pickDefault(input),
      })),
    })),
  };
}

function nameFromLegalId(legalId: string): string {
  return legalId.split("#").pop()?.replace(/^input\./, "") ?? legalId;
}

/**
 * Bucket an input by name pattern + dtype — same taxonomy as
 * OutputStep so the picker's grouping reads consistently across
 * Steps II and III.
 */
function categorizeInput(
  name: string,
  dtype: string,
): { key: string; label: string; order: number } {
  const n = name.toLowerCase();
  const d = dtype.toLowerCase();
  if (
    /_eligible|_qualif|_disqualif|_eligibility|_denied|_passes/.test(n) ||
    (d === "boolean" && /eligible|qualif/.test(n))
  ) {
    return { key: "eligibility", label: "Eligibility checks", order: 2 };
  }
  if (/_income|_earnings|_earned|_wages|_pay\b|_amount\b/.test(n)) {
    return { key: "income", label: "Income", order: 3 };
  }
  if (
    /_deduction|_expense|_costs?\b|_allowance|_shelter|_medical|_rent|_mortgage|_utility|_heating|_cooling/.test(
      n,
    )
  ) {
    return { key: "deductions", label: "Deductions & expenses", order: 4 };
  }
  if (/_resource|_asset|_limit\b|_threshold|_lump_sum|_value\b/.test(n)) {
    return { key: "resources", label: "Resources & limits", order: 5 };
  }
  if (
    /_household|_member|_size|_relation|_person|_age|_disability|_veteran|_residency|_residence|_state|_citizen|_pregnant|_student|_dependent|_immigration/.test(
      n,
    )
  ) {
    return { key: "household", label: "Household structure", order: 6 };
  }
  return { key: "other", label: "Other", order: 99 };
}

function inferDtype(node: InputGraphNode): string {
  if (node.dtype) return node.dtype;
  const sample = node.sample;
  if (typeof sample === "boolean") return "boolean";
  if (typeof sample === "number") return Number.isInteger(sample) ? "integer" : "decimal";
  if (typeof sample === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sample)) return "date";
  return "decimal";
}

function parseDefault(dtype: string, raw: string): string | number | boolean {
  if (dtype === "boolean") return raw === "true";
  if (dtype === "integer") return parseInt(raw, 10) || 0;
  if (dtype === "decimal" || dtype === "money") return Number(raw) || 0;
  return raw;
}

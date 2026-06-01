import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  ComputeCoverage,
  DashboardSpec,
  InputBinding,
  InputGroup,
  OutputBinding,
  OutputPresentation,
  OutputValue,
  TraceNode,
} from "@dashboard-builder/spec";
import { isRelationBinding } from "@dashboard-builder/spec";
import { callCompute, type FormState } from "./compute-client";
import { defaultMemberValues, initialState, isVisible } from "./form-state";
import { Field } from "./Field";
import { Results } from "./Results";
import { InteractiveRuleGraph } from "./InteractiveRuleGraph";

/**
 * Minimal projection of a parameter rule from the program graph — enough
 * for the InteractiveRuleGraph to surface citation, value and an Axiom
 * app deep-link in the hover popover when the formula references the
 * parameter by bare name.
 */
export interface ParameterRule {
  legalId: string;
  name: string;
  fileLegalId: string;
  source?: string | null;
  unit?: string | null;
  dtype?: string | null;
  /** Latest-version formula text — the parameter's constant value (e.g. "35"). */
  formula?: string | null;
}

interface DashboardProps {
  spec: DashboardSpec;
  computeUrl?: string;
  variant?: "page" | "embedded";
  autoCompute?: boolean;
  /**
   * Builder-only: parameter rules (kind="parameter") from the program
   * graph. When set, the graph hover popover on parameter nodes shows
   * the citation, current value and a link to the Axiom app entry.
   */
  parameterRules?: ParameterRule[];
  /**
   * Builder-only hook. When provided, default-sourced input leaves in the
   * trace render with a "+ Expose" button that calls this with the input's
   * legal ID. The builder uses it to add the input to the draft so the user
   * can drive its value from the dashboard form.
   */
  onExposeInput?: (legalId: string) => void;
  /** Builder-only: legal IDs the dashboard already exposes (for live UI feedback). */
  exposedInputIds?: Set<string>;
  /**
   * Builder-only hook. When provided, rule nodes in the trace (intermediate
   * computation steps) render with a "+ Add output" button. Used in Step II
   * so the user can promote a step they just discovered into an explicit
   * dashboard output without leaving the preview.
   */
  onAddOutput?: (legalId: string) => void;
  /** Builder-only: legal IDs already selected as outputs (drives button enable/disable). */
  selectedOutputIds?: Set<string>;
  /**
   * "values" — full runtime view: form on the left, hero + ledger + trace on
   *   the right, current values everywhere. Use for the deployed dashboard
   *   and the publish step's preview.
   * "structure" — author-facing view: drops the form and the values panel,
   *   renders each selected output as a section with its computation graph
   *   in structure mode inline. Use while the user is still constructing
   *   the dashboard (Steps I–III) — values would only show fixture defaults
   *   and read as misleading.
   */
  previewMode?: "values" | "structure";
}

/**
 * The dashboard runtime — paint your inputs, calls /compute on change, shows
 * a hero result with secondary metrics and a trace explainer.
 *
 * Layout: a compact outcome bar above a two-column workspace on wide screens
 * (inputs ⟶ results), stacked on narrow ones. Embedded variant (used inside
 * the builder's preview pane) collapses to one column with tighter spacing.
 */
export function Dashboard({
  spec,
  computeUrl,
  variant = "page",
  autoCompute = true,
  onExposeInput,
  exposedInputIds,
  onAddOutput,
  selectedOutputIds,
  previewMode = "values",
  parameterRules,
}: DashboardProps) {
  const [state, setState] = useState<FormState>(() => initialState(spec));
  const [outputs, setOutputs] = useState<OutputValue[]>([]);
  const [traces, setTraces] = useState<Record<string, TraceNode>>({});
  const [coverage, setCoverage] = useState<ComputeCoverage | undefined>(undefined);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [mode, setMode] = useState<string>("");
  const [computeQueued, setComputeQueued] = useState(false);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const computeSeq = useRef(0);

  const groups = useMemo(() => orderedGroups(spec), [spec]);
  const computeBusy = computeQueued || computing;
  const outcomeBindings = useMemo(() => {
    const orderedOutputs = [...spec.outputs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const eligibility = findEligibilityOutput(orderedOutputs);
    const amount = findAmountOutput(orderedOutputs);
    return { eligibility, amount };
  }, [spec]);
  const hasOutcomeSummary = !!outcomeBindings.eligibility || !!outcomeBindings.amount;
  const hiddenSummaryOutputIds = useMemo(
    () =>
      hasOutcomeSummary
        ? [
            ...new Set(
              [
                outcomeBindings.eligibility?.legalId,
                outcomeBindings.amount?.legalId,
              ].filter(Boolean) as string[],
            ),
          ]
        : [],
    [hasOutcomeSummary, outcomeBindings],
  );

  useEffect(() => {
    setState(initialState(spec));
  }, [spec]);

  useEffect(() => {
    if (!autoCompute) return;
    const runId = computeSeq.current + 1;
    computeSeq.current = runId;
    setComputeQueued(true);
    const handle = window.setTimeout(() => {
      setComputeQueued(false);
      void runCompute(runId);
    }, 250);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, spec]);

  async function runCompute(runId = computeSeq.current + 1) {
    computeSeq.current = runId;
    setComputeQueued(false);
    setComputing(true);
    setError(null);
    try {
      const res = await callCompute(spec, state, computeUrl);
      if (runId !== computeSeq.current) return;
      setOutputs(res.outputs);
      setTraces(res.traces);
      setCoverage(res.coverage);
      setWarnings(res.warnings ?? []);
      setMode(res.mode);
    } catch (e) {
      if (runId !== computeSeq.current) return;
      setError(String(e));
    } finally {
      if (runId === computeSeq.current) setComputing(false);
    }
  }

  function setScalar(id: string, value: string | number | boolean) {
    setState((s) => ({ ...s, scalars: { ...s.scalars, [id]: value } }));
  }
  function setRelationMember(
    relationId: string,
    index: number,
    memberId: string,
    value: string | number | boolean,
  ) {
    setState((s) => {
      const next = [...(s.relations[relationId] ?? [])];
      next[index] = { ...(next[index] ?? {}), [memberId]: value };
      return { ...s, relations: { ...s.relations, [relationId]: next } };
    });
  }
  function addRelationMember(relationId: string) {
    const binding = spec.inputs.find((b) => b.id === relationId);
    if (!binding || !isRelationBinding(binding)) return;
    setState((s) => {
      const current = s.relations[relationId] ?? [];
      if (binding.maxCount && current.length >= binding.maxCount) return s;
      return {
        ...s,
        relations: {
          ...s.relations,
          [relationId]: [...current, defaultMemberValues(binding)],
        },
      };
    });
  }
  function removeRelationMember(relationId: string, index: number) {
    setState((s) => {
      const current = s.relations[relationId] ?? [];
      const next = current.filter((_, i) => i !== index);
      return { ...s, relations: { ...s.relations, [relationId]: next } };
    });
  }

  // Structure-only preview: drop the form and the values panel; instead show
  // each selected output as a section with its computation graph inline. We
  // still call /compute (or wait for it) to get formulas + dependency
  // metadata; the trace's `formula` field on each rule is what the graph
  // needs to render.
  if (previewMode === "structure") {
    return (
      <div className={variant === "embedded" ? "dashboard embedded" : "dashboard"}>
        {computeBusy && <ComputeStatus />}
        {error && <div className="warning">{error}</div>}
        {warnings
          .filter((w) => !w.toLowerCase().includes("demo mode"))
          .map((w) => (
            <div className="warning" key={w}>{w}</div>
          ))}
        {spec.outputs.length === 0 ? (
          <div className="preview-empty">
            Pick at least one output to see its structure.
          </div>
        ) : (
          <InteractiveRuleGraph
            spec={spec}
            traces={traces}
            onExposeInput={onExposeInput}
            exposedInputIds={exposedInputIds}
            onAddOutput={onAddOutput}
            selectedOutputIds={selectedOutputIds}
            showValues={false}
            parameterRules={parameterRules}
          />
        )}
      </div>
    );
  }

  return (
    <div className={variant === "embedded" ? "dashboard embedded" : "dashboard"}>
      <div className="dashboard-grid">
        <div className="dashboard-form">
          <div className="input-workspace-head">
            <div>
              <span className="input-workspace-eyebrow">Inputs</span>
              <h2>Household details</h2>
            </div>
          </div>

          {error && <div className="warning">{error}</div>}

          {groups.map((group, groupIndex) => {
            const inputs = spec.inputs
              .filter(
                (b) => (("group" in b ? b.group : undefined) ?? "_") === group.key,
              )
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            const visibleInputs = inputs.filter((binding) =>
              shouldShowBinding(binding, spec, state),
            );
            if (visibleInputs.length === 0) return null;

            return (
              <InputSection
                key={group.key}
                group={group}
                initialOpen={groupIndex < 2}
              >
                <div className="form-section-body">
                  <div className="field-stack">
                    {visibleInputs.map((binding) => {
                      if (isRelationBinding(binding)) {
                        const members = state.relations[binding.id] ?? [];
                        return (
                          <div key={binding.id} className="relation-block">
                            <div className="relation-head">
                              <div className="field-head">
                                <label>{binding.label}</label>
                                {binding.help && <span className="help">{binding.help}</span>}
                              </div>
                              {(!binding.maxCount || members.length < binding.maxCount) && (
                                <button
                                  type="button"
                                  className="btn secondary relation-add-member"
                                  onClick={() => addRelationMember(binding.id)}
                                >
                                  + Add household member
                                </button>
                              )}
                            </div>
                            {members.map((member, idx) => (
                              <div className="member-card" key={idx}>
                                <div className="member-card-header">
                                  <strong>Member {idx + 1}</strong>
                                  {(binding.minCount ?? 1) < members.length && (
                                    <button
                                      className="btn ghost"
                                      onClick={() => removeRelationMember(binding.id, idx)}
                                    >
                                      Remove
                                    </button>
                                  )}
                                </div>
                                <div className="field-stack">
                                  {binding.memberInputs.map((mb) => (
                                    <Field
                                      key={mb.id}
                                      binding={mb}
                                      value={member[mb.id]}
                                      onChange={(v) =>
                                        setRelationMember(binding.id, idx, mb.id, v)
                                      }
                                    />
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      }

                      return (
                        <Field
                          key={binding.id}
                          binding={binding}
                          value={state.scalars[binding.id]}
                          onChange={(v) => setScalar(binding.id, v)}
                        />
                      );
                    })}
                  </div>
                </div>
              </InputSection>
            );
          })}

          {!autoCompute && (
            <div style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={() => void runCompute()} disabled={computing}>
                {computing ? "Computing…" : "Compute"}
              </button>
            </div>
          )}
        </div>

        <div className="dashboard-results-col">
          <div className="output-workspace-head">
            <span className="output-workspace-eyebrow">Outputs</span>
            <h2>{hasOutcomeSummary ? "Estimated result" : "Selected results"}</h2>
          </div>
          {hasOutcomeSummary && (
            <OutcomeBar
              eligibility={outcomeBindings.eligibility}
              amount={outcomeBindings.amount}
              outputs={outputs}
              warnings={warnings}
              mode={mode}
              busy={computeBusy}
              error={error}
            />
          )}
          <Results
            spec={spec}
            outputs={outputs}
            traces={traces}
            coverage={coverage}
            warnings={warnings}
            mode={mode}
            showCoverage={variant === "embedded"}
            hiddenSummaryOutputIds={hiddenSummaryOutputIds}
            onExposeInput={onExposeInput}
            exposedInputIds={exposedInputIds}
            onAddOutput={onAddOutput}
            selectedOutputIds={selectedOutputIds}
          />
        </div>
      </div>
    </div>
  );
}

function InputSection({
  group,
  initialOpen,
  children,
}: {
  group: InputGroup;
  initialOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <details
      className="form-section"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="form-section-summary">
        <span className="section-title-wrap">
          <span className="section-title">{group.label}</span>
          {group.description && (
            <span className="section-description">{group.description}</span>
          )}
        </span>
      </summary>
      {children}
    </details>
  );
}

function OutcomeBar({
  eligibility,
  amount,
  outputs,
  warnings,
  mode,
  busy,
  error,
}: {
  eligibility: OutputBinding | undefined;
  amount: OutputBinding | undefined;
  outputs: OutputValue[];
  warnings: string[];
  mode: string;
  busy: boolean;
  error: string | null;
}) {
  const byLegalId = new Map(outputs.map((o) => [o.legalId, o]));
  const amountOutput = amount ? byLegalId.get(amount.legalId) : undefined;
  const eligibilityOutput = eligibility ? byLegalId.get(eligibility.legalId) : undefined;
  const verdict = eligibilityOutput ? verdictForValue(eligibilityOutput.value) : "unknown";
  const realWarnings = warnings.filter((w) => !w.toLowerCase().includes("demo mode"));
  const metaItems = [
    ...(mode === "demo" ? ["Test-fixture values"] : []),
    ...(error ? ["Compute error"] : []),
    ...(!error && realWarnings.length > 0
      ? [`${realWarnings.length} warning${realWarnings.length === 1 ? "" : "s"}`]
      : []),
  ];

  return (
    <section
      className={`outcome-bar ${busy || metaItems.length > 0 ? "has-meta" : ""}`}
      aria-label="Current outcome"
    >
      <div className={`outcome-panel-body ${!eligibility || !amount ? "single" : ""}`}>
        {eligibility && (
          <div className={`outcome-verdict ${verdict}`}>
            <span className="outcome-label">Eligibility</span>
            <strong>{formatVerdict(eligibility, eligibilityOutput?.value)}</strong>
          </div>
        )}
        {amount && (
          <div className="outcome-main">
            <span className="outcome-label">{amount.label}</span>
            <strong>{formatOutcomeValue(amountOutput, amount.presentation)}</strong>
          </div>
        )}
      </div>
      {(busy || metaItems.length > 0) && (
        <div className="outcome-meta">
          {busy && (
            <span className="outcome-spinner" role="status" aria-label="Calculating" />
          )}
          {metaItems.map((item) => (
            <span key={item} className={item === "Compute error" ? "outcome-error" : undefined}>
              {item}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function ComputeStatus() {
  return (
    <div className="compute-status" role="status" aria-live="polite">
      <span className="compute-spinner" aria-hidden="true" />
      <span>Calculating</span>
    </div>
  );
}

function hasExposedRelation(spec: DashboardSpec): boolean {
  return spec.inputs.some((b) => isRelationBinding(b));
}

function shouldShowBinding(
  binding: InputBinding,
  spec: DashboardSpec,
  state: FormState,
): boolean {
  if (isRelationBinding(binding)) return true;
  if (hasExposedRelation(spec) && isHouseholdSizeBinding(binding)) return false;
  return isVisible(binding, state.scalars);
}

function findEligibilityOutput(outputs: OutputBinding[]): OutputBinding | undefined {
  return outputs.find((o) => o.presentation.kind === "eligibility")
    ?? outputs.find((o) => outputText(o).includes("eligible"));
}

function findAmountOutput(outputs: OutputBinding[]): OutputBinding | undefined {
  return outputs.find((o) => {
      const text = outputText(o);
      return text.includes("benefit") || text.includes("allotment") || text.includes("amount");
    });
}

function outputText(output: OutputBinding): string {
  return `${output.id} ${output.legalId} ${output.label}`.toLowerCase();
}

function verdictForValue(value: OutputValue["value"] | undefined) {
  if (value === "holds" || value === true) return "holds";
  if (value === "not_holds" || value === false) return "not_holds";
  return "unknown";
}

function formatVerdict(binding: OutputBinding | undefined, value: OutputValue["value"] | undefined): string {
  if (value === "holds" || value === true) {
    return binding?.presentation.kind === "eligibility"
      ? binding.presentation.positiveLabel ?? "Eligible"
      : "Eligible";
  }
  if (value === "not_holds" || value === false) {
    return binding?.presentation.kind === "eligibility"
      ? binding.presentation.negativeLabel ?? "Not eligible"
      : "Not eligible";
  }
  return "Unknown";
}

function formatOutcomeValue(
  output: OutputValue | undefined,
  presentation: OutputPresentation,
): string {
  if (!output || output.value === null || output.value === undefined) return "Pending";
  const value = output.value;
  if (presentation.kind === "currency" && typeof value === "number") {
    const decimals = presentation.decimals ?? 2;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: presentation.currency ?? "USD",
      maximumFractionDigits: decimals,
      minimumFractionDigits: decimals,
    }).format(value);
  }
  if (presentation.kind === "number" && typeof value === "number") {
    const decimals = presentation.decimals ?? 2;
    return value.toLocaleString("en-US", {
      maximumFractionDigits: decimals,
      minimumFractionDigits: decimals,
    }) + (presentation.suffix ?? "");
  }
  if (presentation.kind === "eligibility") return formatVerdict(undefined, value);
  if (typeof value === "number") return value.toLocaleString("en-US");
  return String(value);
}

function isHouseholdSizeBinding(binding: { legalId: string }): boolean {
  const fragment = binding.legalId.split("#")[1] ?? "";
  return /household.*_size$/i.test(fragment);
}

/**
 * Structure-mode preview rendered inside the builder while the user is still
 * picking outputs/inputs. No form, no hero, no values — just one section per
 * selected output showing its computation graph in structure mode. Lets the
 * author read "what does this output depend on?" without misleading
 * fixture-default numbers.
 */
function StructurePreview({
  spec,
  traces,
  coverage,
  warnings,
  mode,
  onExposeInput,
  exposedInputIds,
  onAddOutput,
  selectedOutputIds,
}: {
  spec: DashboardSpec;
  traces: Record<string, TraceNode>;
  coverage: ComputeCoverage | undefined;
  warnings: string[];
  mode: string;
  onExposeInput?: (legalId: string) => void;
  exposedInputIds?: Set<string>;
  onAddOutput?: (legalId: string) => void;
  selectedOutputIds?: Set<string>;
}) {
  void coverage;
  void mode;
  const ordered: OutputBinding[] = [...spec.outputs].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );

  const realWarnings = warnings.filter((w) => !w.toLowerCase().includes("demo mode"));

  return (
    <section className="structure-preview">
      {realWarnings.map((w) => (
        <div className="warning" key={w}>
          {w}
        </div>
      ))}

      {ordered.length === 0 && (
        <div className="preview-empty">Pick at least one output to see its structure.</div>
      )}

      {ordered.map((binding) => {
        const trace = traces[binding.legalId];
        return (
          <article key={binding.id} className="structure-output">
            <header className="structure-output-head">
              <span className="structure-output-eyebrow">Output</span>
              <h3 className="structure-output-name">{binding.label}</h3>
              {trace?.source && (
                <p className="structure-output-source">{trace.source}</p>
              )}
            </header>
            {trace?.formula ? (
              <Results
                spec={{ ...spec, outputs: [binding] }}
                outputs={[]}
                traces={{ [binding.legalId]: trace }}
                coverage={undefined}
                warnings={[]}
                mode={mode}
                showCoverage={false}
                onExposeInput={onExposeInput}
                exposedInputIds={exposedInputIds}
                onAddOutput={onAddOutput}
                selectedOutputIds={selectedOutputIds}
              />
            ) : (
              <div className="empty-hint">
                {trace
                  ? "This output is an atomic value — it has no formula."
                  : "Loading rule structure…"}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

function orderedGroups(spec: DashboardSpec): InputGroup[] {
  if (spec.groups && spec.groups.length > 0) {
    return [...spec.groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  const seen = new Map<string, InputGroup>();
  for (const b of spec.inputs) {
    const key = ("group" in b ? b.group : undefined) ?? "_";
    if (!seen.has(key)) {
      seen.set(key, { key, label: fallbackGroupLabel(key) });
    }
  }
  return [...seen.values()];
}

function fallbackGroupLabel(key: string): string {
  if (key === "_" || key === "inputs" || key === "questions") return "Questions";
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

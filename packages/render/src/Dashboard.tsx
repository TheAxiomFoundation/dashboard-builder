import { useEffect, useMemo, useState } from "react";
import type {
  ComputeCoverage,
  DashboardSpec,
  InputGroup,
  OutputBinding,
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
 * Layout: two columns on wide screens (form ⟶ results, results sticky), a
 * single column stacked on narrow ones. Embedded variant (used inside the
 * builder's preview pane) collapses to one column with tighter spacing.
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
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => orderedGroups(spec), [spec]);

  useEffect(() => {
    setState(initialState(spec));
  }, [spec]);

  useEffect(() => {
    if (!autoCompute) return;
    const handle = window.setTimeout(() => {
      void runCompute();
    }, 250);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, spec]);

  async function runCompute() {
    setComputing(true);
    setError(null);
    try {
      const res = await callCompute(spec, state, computeUrl);
      setOutputs(res.outputs);
      setTraces(res.traces);
      setCoverage(res.coverage);
      setWarnings(res.warnings ?? []);
      setMode(res.mode);
    } catch (e) {
      setError(String(e));
    } finally {
      setComputing(false);
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
          {error && <div className="warning">{error}</div>}

          {groups.map((group) => {
            const inputs = spec.inputs
              .filter(
                (b) => (("group" in b ? b.group : undefined) ?? "_") === group.key,
              )
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            if (inputs.length === 0) return null;

            return (
              <section className="form-section" key={group.key}>
                <h2 className="section-title">{group.label}</h2>
                {group.description && <p className="section-description">{group.description}</p>}

                <div className="field-stack">
                  {inputs.map((binding) => {
                    // When a relation is exposed, hide the household-size
                    // scalar — its value is automatically derived from the
                    // member count at compute time. Showing both would let
                    // them disagree.
                    if (
                      !isRelationBinding(binding) &&
                      hasExposedRelation(spec) &&
                      isHouseholdSizeBinding(binding)
                    ) {
                      return null;
                    }
                    if (isRelationBinding(binding)) {
                      const members = state.relations[binding.id] ?? [];
                      return (
                        <div key={binding.id} className="relation-block">
                          <div className="field-head">
                            <label>{binding.label}</label>
                            {binding.help && <span className="help">{binding.help}</span>}
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
                          {(!binding.maxCount || members.length < binding.maxCount) && (
                            <button
                              className="btn secondary"
                              onClick={() => addRelationMember(binding.id)}
                            >
                              + Add member
                            </button>
                          )}
                        </div>
                      );
                    }

                    if (!isVisible(binding, state.scalars)) return null;
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
              </section>
            );
          })}

          {!autoCompute && (
            <div style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={runCompute} disabled={computing}>
                {computing ? "Computing…" : "Compute"}
              </button>
            </div>
          )}
        </div>

        <Results
          spec={spec}
          outputs={outputs}
          traces={traces}
          coverage={coverage}
          warnings={warnings}
          mode={mode}
          showCoverage={variant === "embedded"}
          onExposeInput={onExposeInput}
          exposedInputIds={exposedInputIds}
          onAddOutput={onAddOutput}
          selectedOutputIds={selectedOutputIds}
        />
      </div>
    </div>
  );
}

function hasExposedRelation(spec: DashboardSpec): boolean {
  return spec.inputs.some((b) => isRelationBinding(b));
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

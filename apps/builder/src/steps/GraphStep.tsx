import { useMemo, useState } from "react";
import { Dashboard, type ParameterRule } from "@dashboard-builder/render";
import { computeUrl } from "../api";
import type { Draft } from "../draft";
import { exportSpec } from "../draft";
import { curatedForDraft } from "./ProgramStep";

/** Strip a leading "Snap " (Title-Case version of the program prefix)
 * from a stored label so the review screen reads cleanly. We don't
 * mutate the underlying label — the user might have customized it,
 * and stripping at display time leaves their edits intact. */
function displayLabel(label: string, prefix: string | undefined): string {
  if (!prefix) return label;
  const lead =
    prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase() + " ";
  return label.startsWith(lead) ? label.slice(lead.length) : label;
}

interface Props {
  draft: Draft;
  /** Set of currently-exposed input legal IDs (so the graph labels them correctly). */
  exposedInputIds?: Set<string>;
  /** Set of currently-selected output rule legal IDs. */
  selectedOutputIds?: Set<string>;
  /** Toggle exposure of a default input directly from the graph. */
  onExposeInput?: (legalId: string) => void;
  /** Toggle whether a rule is a dashboard output directly from the graph. */
  onAddOutput?: (legalId: string) => void;
  /** Parameter rules surfaced to the graph view's hover popover. */
  parameterRules?: ParameterRule[];
}

type ReviewView = "overview" | "graph";

/**
 * Step IV — Review.
 *
 * Default: a structured plain-language overview of everything the user
 * picked — main results, intermediate steps, questions to ask, source
 * documents drawn from. Optional disclosure flips to the interactive
 * computation graph for users who want to see the structure.
 */
export function GraphStep({
  draft,
  exposedInputIds,
  selectedOutputIds,
  onExposeInput,
  onAddOutput,
  parameterRules,
}: Props) {
  const spec = exportSpec(draft);
  const ready = !!spec && spec.outputs.length > 0;
  const [view, setView] = useState<ReviewView>("overview");
  const labelPrefix = curatedForDraft(draft.program)?.labelPrefix;

  // Decompose draft.outputs into per-main buckets. Each picked main
  // result gets its own group containing the intermediate rules that
  // feed it (BFS through rule_deps). An intermediate that feeds both
  // mains appears under both — same picked rule, just shown in each
  // bucket so the user reads "for Eligibility we use X" and "for
  // Benefit amount we also use X".
  const overview = useMemo(() => {
    const curated = curatedForDraft(draft.program);
    const mainDefs = curated?.mainOutputs ?? [];
    const mainLegalIds = new Set(mainDefs.map((m) => m.legalId));
    const ruleById = draft.graph
      ? new Map(draft.graph.rules.map((r) => [r.legalId, r] as const))
      : new Map();

    // Reachable rule legalIds per picked main.
    function reachableFrom(mainLegalId: string): Set<string> {
      const seen = new Set<string>();
      const reachable = new Set<string>();
      const queue: string[] = [mainLegalId];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const r = ruleById.get(id);
        if (!r) continue;
        for (const dep of r.ruleDeps) {
          if (!reachable.has(dep)) {
            reachable.add(dep);
            queue.push(dep);
          }
        }
      }
      return reachable;
    }

    interface Bucket {
      main: typeof draft.outputs[number] | null;
      label: string;
      intermediates: typeof draft.outputs;
    }
    const buckets: Bucket[] = [];
    const allIntermediates = draft.outputs.filter(
      (o) => !mainLegalIds.has(o.legalId),
    );
    for (const def of mainDefs) {
      const main = draft.outputs.find((o) => o.legalId === def.legalId);
      if (!main) continue;
      const reachable = reachableFrom(def.legalId);
      const intermediates = allIntermediates.filter((o) =>
        reachable.has(o.legalId),
      );
      buckets.push({ main, label: def.label, intermediates });
    }

    // Intermediates that don't feed any picked main (or no curated
    // mains exist) — show under "Other".
    const orphanedIntermediates = allIntermediates.filter(
      (o) =>
        !buckets.some((b) =>
          b.intermediates.some((i) => i.legalId === o.legalId),
        ),
    );

    return { buckets, orphanedIntermediates };
  }, [draft]);

  if (!ready || !spec) {
    return (
      <div className="empty-hint">
        Pick at least one result (step II) before reviewing.
      </div>
    );
  }

  return (
    <div
      className={`step-body review-step ${view === "graph" ? "review-step-wide" : ""}`}
    >
      <div className="review-view-toggle" role="tablist" aria-label="Review view">
        <button
          type="button"
          role="tab"
          aria-selected={view === "overview"}
          className={`review-view-tab ${view === "overview" ? "is-active" : ""}`}
          onClick={() => setView("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "graph"}
          className={`review-view-tab ${view === "graph" ? "is-active" : ""}`}
          onClick={() => setView("graph")}
        >
          Computation graph
        </button>
      </div>

      {view === "overview" ? (
        <div className="review-overview review-overview-split">
          <ReviewSection
            label="Picked results"
            count={draft.outputs.length}
            empty="No results picked yet."
          >
            {overview.buckets.map((b) => (
              <div
                key={b.main?.legalId ?? b.label}
                className="review-subsection"
              >
                <div className="review-subsection-label">{b.label}</div>
                <ul className="review-list">
                  {b.main && (
                    <li className="review-item">
                      <span className="review-item-label">{b.label}</span>
                      <span className="review-item-tag is-main">main</span>
                    </li>
                  )}
                  {b.intermediates.map((o) => (
                    <li
                      key={o.legalId}
                      className="review-item review-item-indent"
                    >
                      <span className="review-item-label">
                        {displayLabel(o.label, labelPrefix)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {overview.orphanedIntermediates.length > 0 && (
              <div className="review-subsection">
                <div className="review-subsection-label">
                  {overview.buckets.length === 0 ? "Picked" : "Other"}
                </div>
                <ul className="review-list">
                  {overview.orphanedIntermediates.map((o) => (
                    <li key={o.legalId} className="review-item">
                      <span className="review-item-label">
                        {displayLabel(o.label, labelPrefix)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </ReviewSection>

          <ReviewSection
            label="Questions you'll ask"
            count={
              draft.inputs.length +
              draft.relations.reduce((n, r) => n + r.memberInputs.length, 0)
            }
            empty="The user won't fill anything in — every value falls back to a default."
          >
            {draft.inputs.length > 0 && (
              <ul className="review-list">
                {draft.inputs.map((inp) => (
                  <li key={inp.legalId} className="review-item">
                    <span className="review-item-label">
                      {displayLabel(inp.label, labelPrefix)}
                    </span>
                    <span className="review-item-tag">{inp.dtype}</span>
                  </li>
                ))}
              </ul>
            )}
            {draft.relations.map((rel) =>
              rel.memberInputs.length > 0 ? (
                <div
                  key={rel.legalId}
                  className="review-subsection review-subsection-relation"
                >
                  <div className="review-subsection-label">
                    {displayLabel(rel.label, labelPrefix)} · per member
                  </div>
                  <ul className="review-list">
                    {rel.memberInputs.map((m) => (
                      <li key={m.legalId} className="review-item">
                        <span className="review-item-label">
                          {displayLabel(m.label, labelPrefix)}
                        </span>
                        <span className="review-item-tag">{m.dtype}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
          </ReviewSection>
        </div>
      ) : (
        <div className="publish-preview publish-preview-graph">
          <Dashboard
            spec={spec}
            variant="page"
            computeUrl={computeUrl}
            autoCompute
            previewMode="structure"
            onExposeInput={onExposeInput}
            exposedInputIds={exposedInputIds}
            onAddOutput={onAddOutput}
            selectedOutputIds={selectedOutputIds}
            parameterRules={parameterRules}
          />
        </div>
      )}
    </div>
  );
}

interface ReviewSectionProps {
  label: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}
function ReviewSection({ label, count, empty, children }: ReviewSectionProps) {
  return (
    <section className="review-section">
      <header className="review-section-head">
        <span className="review-section-label">{label}</span>
        <span className="review-section-count">
          {count}
        </span>
      </header>
      {count === 0 && empty ? (
        <p className="review-empty">{empty}</p>
      ) : (
        children
      )}
    </section>
  );
}


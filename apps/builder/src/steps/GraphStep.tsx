import { Dashboard, type ParameterRule } from "@dashboard-builder/render";
import { computeUrl } from "../api";
import type { Draft } from "../draft";
import { exportSpec } from "../draft";

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

/**
 * Step IV — interactive computation graph.
 *
 * Same affordances as the picker steps, just shown through the structural
 * view: rule nodes get a "+ output" / "− output" toggle, default inputs
 * get "+ expose" / "− remove". Useful for users who'd rather discover by
 * tracing the structure than scrolling the chip pickers.
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

  if (!ready || !spec) {
    return (
      <div className="empty-hint">
        Pick at least one output (step II) before viewing the graph.
      </div>
    );
  }

  return (
    <div className="step-body publish-step">
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
    </div>
  );
}

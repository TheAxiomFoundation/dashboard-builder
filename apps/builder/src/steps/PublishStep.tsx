import yaml from "js-yaml";
import { useState } from "react";
import { Dashboard } from "@dashboard-builder/render";
import { computeUrl } from "../api";
import type { Draft } from "../draft";
import { exportSpec } from "../draft";

interface Props {
  draft: Draft;
  /** Builder hook for the live "+ Expose" buttons inside the dashboard preview. */
  onExposeInput?: (legalId: string) => void;
  /** Set of currently-exposed input legal IDs (so the preview labels them correctly). */
  exposedInputIds?: Set<string>;
}

/**
 * Step IV — demo + export.
 *
 * Renders the dashboard the way an end-user will see it (full-width, page
 * variant) so the builder can sanity-check input wiring and presentation.
 * Underneath the meta editor, the user can copy or download the spec as
 * YAML or JSON — there's no server-side publish flow; this step is purely
 * a preview + handoff of the artefact.
 */
export function PublishStep({
  draft,
  onExposeInput,
  exposedInputIds,
}: Props) {
  const spec = exportSpec(draft);
  const ready = !!spec && spec.outputs.length > 0;
  const [copied, setCopied] = useState<"yaml" | "json" | null>(null);

  const yamlText = spec ? yaml.dump(spec, { lineWidth: 100 }) : "";
  const jsonText = spec ? JSON.stringify(spec, null, 2) : "";

  function downloadFile(content: string, ext: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(draft.meta.title)}.dashboard.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copy(format: "yaml" | "json") {
    const text = format === "yaml" ? yamlText : jsonText;
    await navigator.clipboard.writeText(text);
    setCopied(format);
    window.setTimeout(() => setCopied((c) => (c === format ? null : c)), 1400);
  }

  return (
    <div className="step-body publish-step">
      <div className="publish-divider">
        <span>Preview · what your users will see</span>
      </div>

      {ready && spec ? (
        <div className="publish-preview">
          <Dashboard
            spec={spec}
            variant="page"
            computeUrl={computeUrl}
            autoCompute
            previewMode="values"
            onExposeInput={onExposeInput}
            exposedInputIds={exposedInputIds}
          />
        </div>
      ) : (
        <div className="empty-hint">
          Pick at least one output (step II) before previewing.
        </div>
      )}

      <div className="publish-divider">
        <span>Export · grab the spec</span>
      </div>

      <div className="publish-bar">
        <div className="export-grid">
          <div className="export-format">
            <div className="export-format-label">YAML</div>
            <div className="export-format-actions">
              <button
                className="btn secondary"
                disabled={!ready}
                onClick={() => downloadFile(yamlText, "yaml", "application/yaml")}
              >
                Download
              </button>
              <button
                className="btn secondary"
                disabled={!ready}
                onClick={() => copy("yaml")}
              >
                {copied === "yaml" ? "Copied ✓" : "Copy"}
              </button>
            </div>
          </div>
          <div className="export-format">
            <div className="export-format-label">JSON</div>
            <div className="export-format-actions">
              <button
                className="btn secondary"
                disabled={!ready}
                onClick={() => downloadFile(jsonText, "json", "application/json")}
              >
                Download
              </button>
              <button
                className="btn secondary"
                disabled={!ready}
                onClick={() => copy("json")}
              >
                {copied === "json" ? "Copied ✓" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "dashboard";
}

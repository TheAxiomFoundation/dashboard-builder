import { useEffect, useState } from "react";
import type { DashboardSpec } from "@dashboard-builder/spec";
import { Dashboard } from "@dashboard-builder/render";
import { loadSpec } from "./spec-source";

export function App() {
  const [spec, setSpec] = useState<DashboardSpec | null>(null);
  const [source, setSource] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSpec()
      .then(({ spec, source }) => {
        setSpec(spec);
        setSource(source);
        if (spec.meta.title) {
          document.title = `${spec.meta.title} · Axiom`;
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) {
    return (
      <div className="shell">
        <div className="warning">{error}</div>
      </div>
    );
  }
  if (!spec) {
    return (
      <div className="shell">
        <p className="muted">Loading spec…</p>
      </div>
    );
  }

  const builderUrl =
    (import.meta.env.VITE_BUILDER_URL as string | undefined) ?? "http://127.0.0.1:5173";

  return (
    <div className="shell">
      <header className="shell-header">
        {/* Outlined-path ∀ mark (settled brand lockup, w350) — never a live-font glyph. */}
        <span className="shell-mark" aria-hidden="true">
          <svg viewBox="0 0 659 710" focusable="false">
            <path
              fill="currentColor"
              d="M21 0L278 710L381 710L638 0L554 0L481 207L178 207L105 0ZM204 283L455 283L329 642Z"
            />
          </svg>
        </span>
        <div className="shell-meta">
          <span className="eyebrow">Axiom form</span>
          <span className="source">source: <code>{source}</code></span>
        </div>
        <div className="shell-actions">
          <a className="btn secondary" href={builderUrl} title="Open the form builder">
            ← Form Builder
          </a>
        </div>
      </header>

      <h1>{spec.meta.title}</h1>
      {spec.meta.description && <p className="description">{spec.meta.description}</p>}

      <Dashboard spec={spec} variant="page" />
    </div>
  );
}

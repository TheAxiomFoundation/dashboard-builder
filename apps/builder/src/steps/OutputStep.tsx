import { useMemo, useState } from "react";
import type { Draft, OutputSelection } from "../draft";
import { humanize, selectOutput } from "../draft";
import type { RuleNode } from "../api";
import { axiomAppUrl, documentInfo, humanizeCitation } from "../citations";
import { validateOutput } from "../validators";

interface Props {
  draft: Draft;
  setDraft: (d: Draft) => void;
}

/**
 * Step II — pick outputs.
 *
 * Rules grouped by their source citation (e.g. "10 CCR 2506-1 § 4.401",
 * "Colorado SNAP FY 2026 benefit calculation composition") so the user
 * browses the legal structure of the program rather than a flat 168-row
 * list. Each group is collapsible. Search bypasses grouping and returns a
 * single ranked list.
 *
 * Per-row visual is reduced to: checkbox · dtype glyph · name · edit/×.
 * Legal IDs only appear in the inline edit panel (when the user clicks Edit).
 */
export function OutputStep({ draft, setDraft }: Props) {
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const graph = draft.graph;
  if (!graph) return <div className="empty-hint">Pick a program first.</div>;

  const selectedIds = new Set(draft.outputs.map((o) => o.legalId));
  const allRules = graph.rules.filter((r) => r.kind === "derived");
  // Bottom-list view shows rules the user can pick *right now* — drop
  // anything already selected (lives in the top panel) and anything
  // that the engine would reject given the current draft state (entity
  // mismatch etc). Hiding the incompatible ones is cleaner than the
  // dimmed-with-tag treatment we used previously: the picker only
  // surfaces choices that will actually work.
  const availableRules = useMemo(
    () =>
      allRules.filter(
        (r) =>
          !selectedIds.has(r.legalId) &&
          !validateOutput(r, draft, graph.rules),
      ),
    [allRules, selectedIds, draft, graph.rules],
  );
  const terminal = new Set(graph.terminalOutputs);

  // ---------- search-driven flat view ----------

  const q = query.trim().toLowerCase();
  const flatRanked = useMemo(() => {
    if (!q) return [];
    return availableRules
      .map((r) => ({ r, score: scoreRule(r, q) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ r }) => r);
  }, [availableRules, q]);

  // ---------- two-level grouped view (document → section → rules) ----------
  //
  // 116 sibling sections is too much to scan. We collapse them into ~4
  // documents (10 CCR 2506-1, 7 CFR, 7 USC, USDA policy, …) and surface
  // a "Headlines" tray at the very top with terminal outputs lifted out
  // of their docs — those are the rules most users actually want to
  // pick first. Terminals don't render twice (excluded from doc groups).

  const ownFileLegalId = draft.program
    ? `${draft.program.repo.replace(/^rules-/, "")}:${draft.program.path.replace(/\.yaml$/, "")}`
    : "";

  const headlineRules = useMemo(
    () => availableRules.filter((r) => terminal.has(r.legalId)),
    [availableRules, terminal],
  );

  const documents = useMemo(() => {
    // Bucket non-headline rules by document, then by section within.
    interface Section { key: string; rules: RuleNode[] }
    interface Document {
      key: string;
      label: string;
      isOwnFile: boolean;
      sections: Section[];
      totalRules: number;
    }
    const headlineIds = new Set(headlineRules.map((r) => r.legalId));
    const byDoc = new Map<string, { label: string; isOwnFile: boolean; sections: Map<string, RuleNode[]> }>();
    for (const rule of availableRules) {
      if (headlineIds.has(rule.legalId)) continue; // surfaced separately
      const { key, label } = documentInfo(rule.fileLegalId, ownFileLegalId);
      if (!byDoc.has(key)) {
        byDoc.set(key, {
          label,
          isOwnFile: rule.fileLegalId === ownFileLegalId,
          sections: new Map(),
        });
      }
      const doc = byDoc.get(key)!;
      const sectionKey = groupKeyFor(rule);
      if (!doc.sections.has(sectionKey)) doc.sections.set(sectionKey, []);
      doc.sections.get(sectionKey)!.push(rule);
    }
    const docs: Document[] = [...byDoc.entries()].map(([key, v]) => ({
      key,
      label: v.label,
      isOwnFile: v.isOwnFile,
      sections: [...v.sections.entries()]
        .map(([sk, rules]) => ({ key: sk, rules }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      totalRules: [...v.sections.values()].reduce((n, rs) => n + rs.length, 0),
    }));
    docs.sort((a, b) => {
      if (a.isOwnFile !== b.isOwnFile) return a.isOwnFile ? -1 : 1;
      return b.totalRules - a.totalRules;
    });
    return docs;
  }, [availableRules, headlineRules, ownFileLegalId]);


  // ---------- selection mutations ----------

  function toggle(legalId: string) {
    if (!graph) return;
    if (selectedIds.has(legalId)) {
      setDraft({ ...draft, outputs: draft.outputs.filter((o) => o.legalId !== legalId) });
      return;
    }
    const rule = graph.rules.find((r) => r.legalId === legalId);
    if (!rule) return;
    // Block adds that would break compute. (Removals always allowed —
    // we never want the user trapped in a broken state.)
    const issue = validateOutput(rule, draft, graph.rules);
    if (issue) return;
    setDraft({ ...draft, outputs: [...draft.outputs, selectOutput(rule)] });
  }

  function toggleGroupOpen(key: string, defaultOpen: boolean) {
    const isOpen = openGroups.has(key) || (defaultOpen && !openGroups.has(`__closed:${key}`));
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

  const hasSidebar = draft.outputs.length > 0;
  return (
    <div className={`step-body ${hasSidebar ? "step-with-sidebar" : ""}`}>
      <div className="step-main">
      {/* Hide the search once every compatible rule is selected — no
          point typing into a list that's empty. */}
      {availableRules.length > 0 && (
        <div className="inline-search">
          <input
            type="search"
            className="inline-search-input"
            placeholder={`Search ${availableRules.length} available rules…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="summary-stats">
            <span><strong>{draft.outputs.length}</strong> selected</span>
            {q ? (
              <span>{flatRanked.length} matching</span>
            ) : (
              <span>
                {documents.length} document{documents.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
      )}

      {q ? (
        // Search results — flat list, no grouping.
        <div className="rule-list">
          {flatRanked.length === 0 && <div className="empty-hint">No rules match "{query}".</div>}
          {flatRanked.map((rule) => (
            <RuleRow
              key={rule.legalId}
              rule={rule}
              isSelected={selectedIds.has(rule.legalId)}
              isTerminal={terminal.has(rule.legalId)}
              selection={draft.outputs.find((o) => o.legalId === rule.legalId)}
              onToggle={() => toggle(rule.legalId)}
            />
          ))}
        </div>
      ) : (
        <>
          {/* Headlines tray — terminal outputs lifted to the top so the
              user gets to "what should this calculator answer" without
              browsing 116 sections of plumbing first. Collapsed by
              default to keep the page light at first glance; the
              section count + chevron in the header is enough of a
              signal to invite a click. */}
          {headlineRules.length > 0 && (
            <section className="rule-doc rule-doc-headlines">
              <button
                type="button"
                className="rule-doc-head"
                onClick={() => toggleGroupOpen("__headlines", false)}
                aria-expanded={isGroupOpen("__headlines", false)}
              >
                <span className="rule-group-chevron">
                  {isGroupOpen("__headlines", false) ? "▾" : "▸"}
                </span>
                <span className="rule-doc-label">Headlines</span>
                <span className="rule-doc-meta">
                  {headlineRules.length} terminal output{headlineRules.length === 1 ? "" : "s"}
                </span>
              </button>
              {isGroupOpen("__headlines", false) && (
                <div className="rule-list rule-list-grouped">
                  {headlineRules.map((rule) => (
                    <RuleRow
                      key={rule.legalId}
                      rule={rule}
                      isSelected={selectedIds.has(rule.legalId)}
                              isTerminal={true}
                      selection={draft.outputs.find(
                        (o) => o.legalId === rule.legalId,
                      )}
                      onToggle={() => toggle(rule.legalId)}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Document-level groups — one entry per source document
              (10 CCR 2506-1, 7 CFR, …). Sections live as sub-headers
              inside, so the legal hierarchy is preserved without
              flattening 116 siblings into the top scroll. */}
          {documents.map((doc) => {
            // Every document group, including "Composition (this program)",
            // starts collapsed. The user is more likely to scan first via
            // the Headlines tray; the heavier doc rollups stay folded
            // until clicked.
            const defaultOpen = false;
            const open = isGroupOpen(doc.key, defaultOpen);
            return (
              <section key={doc.key} className="rule-doc">
                <button
                  type="button"
                  className="rule-doc-head"
                  onClick={() => toggleGroupOpen(doc.key, defaultOpen)}
                  aria-expanded={open}
                >
                  <span className="rule-group-chevron">{open ? "▾" : "▸"}</span>
                  <span className="rule-doc-label">{doc.label}</span>
                  <span className="rule-doc-meta">
                    {doc.totalRules} rule{doc.totalRules === 1 ? "" : "s"}
                    {" · "}
                    {doc.sections.length} section{doc.sections.length === 1 ? "" : "s"}
                  </span>
                </button>
                {open && (
                  <div className="rule-doc-body">
                    {doc.sections.map((sec) => {
                      const fileLegalId = sec.rules[0]?.fileLegalId;
                      const appUrl = fileLegalId ? axiomAppUrl(fileLegalId) : null;
                      return (
                        <div key={sec.key} className="rule-section">
                          <div className="rule-section-head">
                            <span className="rule-section-label">{sec.key}</span>
                            <span className="rule-section-meta">
                              {sec.rules.length}
                            </span>
                            {appUrl && (
                              <a
                                className="rule-group-source-link"
                                href={appUrl}
                                target="_blank"
                                rel="noreferrer"
                                title="Open this section in the Axiom app"
                                aria-label="Open in Axiom app"
                              >
                                ↗
                              </a>
                            )}
                          </div>
                          <div className="rule-list rule-list-grouped">
                            {sec.rules.map((rule) => (
                              <RuleRow
                                key={rule.legalId}
                                rule={rule}
                                isSelected={selectedIds.has(rule.legalId)}
                                                  isTerminal={terminal.has(rule.legalId)}
                                                  selection={draft.outputs.find((o) => o.legalId === rule.legalId)}
                                onToggle={() => toggle(rule.legalId)}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}
      </div>
      {hasSidebar && (
        <aside className="step-sidebar">
          <section className="selected-panel">
            <header className="selected-panel-head">
              <span className="selected-panel-eyebrow">
                Selected outputs · <strong>{draft.outputs.length}</strong>
              </span>
            </header>
            <div className="selected-pills">
              {draft.outputs.map((selection) => (
                <span key={selection.legalId} className="selected-pill">
                  <span className="label" title={selection.label}>
                    {selection.label}
                  </span>
                  <button
                    className="selected-pill-remove"
                    onClick={() => toggle(selection.legalId)}
                    title="Remove"
                    aria-label="Remove"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </section>
        </aside>
      )}
    </div>
  );
}

function RuleRow({
  rule,
  isSelected,
  isTerminal,
  selection,
  onToggle,
}: {
  rule: RuleNode;
  isSelected: boolean;
  isTerminal: boolean;
  selection: OutputSelection | undefined;
  onToggle: () => void;
}) {
  return (
    <div>
      <div className={`chip ${isSelected ? "chip-selected" : ""}`}>
        <label>
          <input type="checkbox" checked={isSelected} onChange={onToggle} />
          <span className="label">
            {selection?.label ?? humanize(rule.name)}
          </span>
        </label>
        <div className="chip-actions">
          {isTerminal && !isSelected && (
            <span className="terminal-tag">headline</span>
          )}
        </div>
      </div>
    </div>
  );
}

function groupKeyFor(rule: RuleNode): string {
  // Prefer the rule's declared `source` citation (already human-readable).
  // Fall back to humanizing the file legal ID if source is missing.
  if (rule.source && rule.source.trim()) return rule.source.trim();
  return humanizeCitation(rule.fileLegalId);
}


function scoreRule(rule: RuleNode, q: string): number {
  const haystack = `${rule.name} ${rule.source ?? ""}`.toLowerCase();
  if (!haystack.includes(q)) return 0;
  let s = 1;
  if (rule.name.toLowerCase().startsWith(q)) s += 100;
  if (rule.name.toLowerCase().includes(q)) s += 50;
  if ((rule.source ?? "").toLowerCase().includes(q)) s += 10;
  return s;
}


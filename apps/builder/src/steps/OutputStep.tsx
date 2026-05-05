import { useMemo, useState } from "react";
import type { Draft, OutputSelection } from "../draft";
import { humanize, selectOutput } from "../draft";
import type { RuleNode } from "../api";
import { axiomAppUrl, humanizeCitation } from "../citations";

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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [showAllGroups, setShowAllGroups] = useState(false);

  const graph = draft.graph;
  if (!graph) return <div className="empty-hint">Pick a program first.</div>;

  const selectedIds = new Set(draft.outputs.map((o) => o.legalId));
  const allRules = graph.rules.filter((r) => r.kind === "derived");
  // Bottom-list view only shows what is *not* selected — selected rules
  // surface in the top panel and would otherwise be duplicated.
  const availableRules = useMemo(
    () => allRules.filter((r) => !selectedIds.has(r.legalId)),
    [allRules, selectedIds],
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

  // ---------- grouped view ----------

  const groups = useMemo(() => {
    const map = new Map<string, RuleNode[]>();
    for (const rule of availableRules) {
      const key = groupKeyFor(rule);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(rule);
    }
    // Sort groups: program's own file first (it'll usually be a `policies/...`
    // entry whose rules include terminal outputs), then groups whose rules
    // contain selected outputs (so you can spot what you've picked), then
    // alphabetic.
    const ownFile = draft.program
      ? `${draft.program.repo.replace(/^rules-/, "")}:${draft.program.path.replace(/\.yaml$/, "")}`
      : "";
    return [...map.entries()]
      .map(([key, rules]) => {
        const containsTerminal = rules.some((r) => terminal.has(r.legalId));
        const isOwnFile = rules.some((r) => r.fileLegalId === ownFile);
        return { key, rules, containsTerminal, isOwnFile };
      })
      .sort((a, b) => {
        if (a.isOwnFile !== b.isOwnFile) return a.isOwnFile ? -1 : 1;
        if (a.containsTerminal !== b.containsTerminal) return a.containsTerminal ? -1 : 1;
        return a.key.localeCompare(b.key);
      });
  }, [availableRules, terminal, draft.program]);

  const visibleGroups = showAllGroups || q ? groups : groups.slice(0, 4);

  // ---------- selection mutations ----------

  function toggle(legalId: string) {
    if (!graph) return;
    if (selectedIds.has(legalId)) {
      setDraft({ ...draft, outputs: draft.outputs.filter((o) => o.legalId !== legalId) });
      if (editingId === legalId) setEditingId(null);
      return;
    }
    const rule = graph.rules.find((r) => r.legalId === legalId);
    if (!rule) return;
    setDraft({ ...draft, outputs: [...draft.outputs, selectOutput(rule)] });
  }

  function patchOutput(legalId: string, patch: Partial<OutputSelection>) {
    setDraft({
      ...draft,
      outputs: draft.outputs.map((o) =>
        o.legalId === legalId ? { ...o, ...patch } : o,
      ),
    });
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

  return (
    <div className="step-body">
      {draft.outputs.length > 0 && (
        <section className="selected-panel">
          <header className="selected-panel-head">
            <span className="selected-panel-eyebrow">
              Selected outputs · <strong>{draft.outputs.length}</strong>
            </span>
          </header>
          <div className="rule-list">
            {draft.outputs.map((selection) => {
              const rule = graph.rules.find((r) => r.legalId === selection.legalId);
              const isEditing = editingId === selection.legalId;
              return (
                <div key={selection.legalId}>
                  <div className="chip chip-selected">
                    <label>
                      <input
                        type="checkbox"
                        checked
                        onChange={() => toggle(selection.legalId)}
                      />
                      <span className="label">{selection.label}</span>
                    </label>
                    <div className="chip-actions">
                      <button
                        className="btn ghost"
                        onClick={() =>
                          setEditingId(isEditing ? null : selection.legalId)
                        }
                      >
                        {isEditing ? "Done" : "Edit"}
                      </button>
                      <button
                        className="btn ghost"
                        onClick={() => toggle(selection.legalId)}
                        title="Remove from dashboard"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  {isEditing && rule && (
                    <div className="inline-edit">
                      <div className="inline-edit-legalid">{rule.legalId}</div>
                      <label>
                        Label
                        <input
                          type="text"
                          value={selection.label}
                          onChange={(e) => patchOutput(rule.legalId, { label: e.target.value })}
                        />
                      </label>
                      <label>
                        Presentation
                        <select
                          value={selection.presentation.kind}
                          onChange={(e) => {
                            const kind = e.target.value as "currency" | "number" | "eligibility" | "raw";
                            patchOutput(rule.legalId, {
                              presentation: defaultPresentationFor(kind, rule.unit),
                            });
                          }}
                        >
                          <option value="currency">Currency</option>
                          <option value="number">Number</option>
                          <option value="eligibility">Eligibility</option>
                          <option value="raw">Raw</option>
                        </select>
                      </label>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={selection.emphasis === "headline"}
                          onChange={(e) =>
                            patchOutput(rule.legalId, {
                              emphasis: e.target.checked ? "headline" : "secondary",
                            })
                          }
                        />
                        Headline result
                      </label>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={selection.showExplain}
                          onChange={(e) =>
                            patchOutput(rule.legalId, { showExplain: e.target.checked })
                          }
                        />
                        Show explain trace
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

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
            <span>{groups.length} legal sections</span>
          )}
        </div>
      </div>

      {q ? (
        // Search results — flat list, no grouping.
        <div className="rule-list">
          {flatRanked.length === 0 && <div className="empty-hint">No rules match "{query}".</div>}
          {flatRanked.map((rule) => (
            <RuleRow
              key={rule.legalId}
              rule={rule}
              isSelected={selectedIds.has(rule.legalId)}
              isEditing={editingId === rule.legalId}
              isTerminal={terminal.has(rule.legalId)}
              selection={draft.outputs.find((o) => o.legalId === rule.legalId)}
              onToggle={() => toggle(rule.legalId)}
              onEditToggle={() =>
                setEditingId(editingId === rule.legalId ? null : rule.legalId)
              }
              onPatch={(p) => patchOutput(rule.legalId, p)}
            />
          ))}
        </div>
      ) : (
        // Grouped view — collapsible by source citation.
        <>
          {visibleGroups.map((group, idx) => {
            const defaultOpen = idx === 0;
            const open = isGroupOpen(group.key, defaultOpen);
            // All rules in a group come from the same file, so we can derive
            // a single Axiom app link for the section.
            const fileLegalId = group.rules[0]?.fileLegalId;
            const appUrl = fileLegalId ? axiomAppUrl(fileLegalId) : null;
            return (
              <section key={group.key} className="rule-group">
                <div className="rule-group-head-row">
                  <button
                    type="button"
                    className="rule-group-head"
                    onClick={() => toggleGroupOpen(group.key, defaultOpen)}
                    aria-expanded={open}
                  >
                    <span className="rule-group-chevron">{open ? "▾" : "▸"}</span>
                    <span className="rule-group-text">
                      <span className="rule-group-label">{group.key}</span>
                      <span className="rule-group-preview">{previewFor(group.rules, terminal)}</span>
                    </span>
                    <span className="rule-group-meta">
                      <span className="group-rule-count">{group.rules.length} rules</span>
                    </span>
                  </button>
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
                {open && (
                  <div className="rule-list rule-list-grouped">
                    {group.rules.map((rule) => (
                      <RuleRow
                        key={rule.legalId}
                        rule={rule}
                        isSelected={selectedIds.has(rule.legalId)}
                        isEditing={editingId === rule.legalId}
                        isTerminal={terminal.has(rule.legalId)}
                        selection={draft.outputs.find((o) => o.legalId === rule.legalId)}
                        onToggle={() => toggle(rule.legalId)}
                        onEditToggle={() =>
                          setEditingId(editingId === rule.legalId ? null : rule.legalId)
                        }
                        onPatch={(p) => patchOutput(rule.legalId, p)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
          {!showAllGroups && groups.length > visibleGroups.length && (
            <button className="toggle-show-all" onClick={() => setShowAllGroups(true)}>
              + Show {groups.length - visibleGroups.length} more legal sections
            </button>
          )}
          {showAllGroups && (
            <button className="toggle-show-all" onClick={() => setShowAllGroups(false)}>
              Show fewer
            </button>
          )}
        </>
      )}
    </div>
  );
}

function RuleRow({
  rule,
  isSelected,
  isEditing,
  isTerminal,
  selection,
  onToggle,
  onEditToggle,
  onPatch,
}: {
  rule: RuleNode;
  isSelected: boolean;
  isEditing: boolean;
  isTerminal: boolean;
  selection: OutputSelection | undefined;
  onToggle: () => void;
  onEditToggle: () => void;
  onPatch: (p: Partial<OutputSelection>) => void;
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
          {isSelected && (
            <button className="btn ghost" onClick={onEditToggle}>
              {isEditing ? "Done" : "Edit"}
            </button>
          )}
        </div>
      </div>
      {isSelected && isEditing && selection && (
        <div className="inline-edit">
          <div className="inline-edit-legalid">{rule.legalId}</div>
          <label>
            Label
            <input
              type="text"
              value={selection.label}
              onChange={(e) => onPatch({ label: e.target.value })}
            />
          </label>
          <label>
            Presentation
            <select
              value={selection.presentation.kind}
              onChange={(e) => {
                const kind = e.target.value as "currency" | "number" | "eligibility" | "raw";
                onPatch({ presentation: defaultPresentationFor(kind, rule.unit) });
              }}
            >
              <option value="currency">Currency</option>
              <option value="number">Number</option>
              <option value="eligibility">Eligibility</option>
              <option value="raw">Raw</option>
            </select>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={selection.emphasis === "headline"}
              onChange={(e) =>
                onPatch({ emphasis: e.target.checked ? "headline" : "secondary" })
              }
            />
            Headline result
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={selection.showExplain}
              onChange={(e) => onPatch({ showExplain: e.target.checked })}
            />
            Show explain trace
          </label>
        </div>
      )}
    </div>
  );
}

function groupKeyFor(rule: RuleNode): string {
  // Prefer the rule's declared `source` citation (already human-readable).
  // Fall back to humanizing the file legal ID if source is missing.
  if (rule.source && rule.source.trim()) return rule.source.trim();
  return humanizeCitation(rule.fileLegalId);
}

/**
 * One-line preview of a group's contents using the rule names we already
 * have. Terminal rules float to the front (they're the "punchline" of the
 * section); we show up to three names, then "+N more".
 */
function previewFor(rules: RuleNode[], terminal: Set<string>): string {
  const sorted = [...rules].sort((a, b) => {
    const at = terminal.has(a.legalId);
    const bt = terminal.has(b.legalId);
    if (at !== bt) return at ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const sample = sorted.slice(0, 3).map((r) => humanize(r.name));
  const overflow = sorted.length - sample.length;
  const tail = overflow > 0 ? ` · +${overflow} more` : "";
  return sample.join(" · ") + tail;
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

function defaultPresentationFor(
  kind: "currency" | "number" | "eligibility" | "raw",
  unit?: string | null,
) {
  switch (kind) {
    case "currency":
      return { kind: "currency" as const, currency: unit ?? "USD", decimals: 2 };
    case "number":
      return { kind: "number" as const, decimals: 0 };
    case "eligibility":
      return { kind: "eligibility" as const };
    case "raw":
      return { kind: "raw" as const };
  }
}


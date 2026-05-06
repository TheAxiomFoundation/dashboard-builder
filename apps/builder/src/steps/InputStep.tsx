import { useEffect, useMemo, useState } from "react";
import type { Draft, InputExposure, RelationExposure } from "../draft";
import { dtypeFor, exposeInput, exposeRelation, humanize, widgetFor, defaultFor } from "../draft";
import type { InputGraphNode, RelationGraphNode } from "../api";
import { fetchTransitive } from "../api";
import { axiomAppUrl, documentInfo, humanizeCitation } from "../citations";

interface Props {
  draft: Draft;
  setDraft: (d: Draft) => void;
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
export function InputStep({ draft, setDraft }: Props) {
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

  // Two-level rollup of deeper inputs: document → section → entries.
  // Mirrors the OutputStep treatment so the user sees ~4 documents
  // (10 CCR 2506-1, 7 CFR, 7 USC, USDA policy …) instead of 100+
  // sibling sections. The user's chosen program file lands in
  // "Composition (this program)" so it stays distinct from regs.
  const ownFileLegalId = draft.program
    ? `${draft.program.repo.replace(/^rules-/, "")}:${draft.program.path.replace(/\.yaml$/, "")}`
    : "";

  interface InputSection {
    key: string;
    items: DepEntry<InputGraphNode>[];
  }
  interface InputDocument {
    key: string;
    label: string;
    sections: InputSection[];
    totalItems: number;
  }
  const deeperDocuments = useMemo<InputDocument[]>(() => {
    const byDoc = new Map<
      string,
      { label: string; sections: Map<string, DepEntry<InputGraphNode>[]> }
    >();
    for (const entry of deeperInputs) {
      const { key, label } = documentInfo(entry.node.fileLegalId, ownFileLegalId);
      if (!byDoc.has(key)) byDoc.set(key, { label, sections: new Map() });
      const doc = byDoc.get(key)!;
      const sectionKey = humanizeCitation(entry.node.fileLegalId);
      if (!doc.sections.has(sectionKey)) doc.sections.set(sectionKey, []);
      doc.sections.get(sectionKey)!.push(entry);
    }
    const docs: InputDocument[] = [...byDoc.entries()].map(([key, v]) => ({
      key,
      label: v.label,
      sections: [...v.sections.entries()]
        .map(([sk, items]) => ({ key: sk, items }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      totalItems: [...v.sections.values()].reduce((n, items) => n + items.length, 0),
    }));
    docs.sort((a, b) => b.totalItems - a.totalItems);
    return docs;
  }, [deeperInputs, ownFileLegalId]);

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

  const hasSidebar = exposedCount > 0;
  return (
    <div className={`step-body ${hasSidebar ? "step-with-sidebar" : ""}`}>
      <div className="step-main">
      {/* Hide the search bar entirely once every reachable input is
          exposed — there's nothing left to find, and the empty
          "0 reachable" caption is just visual noise at that point. */}
      {availableInputCatalog.length + availableRelationCatalog.length > 0 && (
        <div className="inline-search">
          <input
            type="search"
            className="inline-search-input"
            placeholder={`Search ${totalRelevant} reachable inputs…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="summary-stats">
            <span><strong>{exposedCount}</strong> exposed</span>
            {q ? (
              <span>{matchedInputs.length + matchedRelations.length} matching</span>
            ) : (
              <span>{totalRelevant} reachable</span>
            )}
          </div>
        </div>
      )}

      {q ? (
        // Search results — flat.
        <div className="rule-list">
          {matchedRelations.map(({ node, depth }) => (
            <RelationRow
              key={node.legalId}
              node={node}
              depth={depth}
              exposed={exposedRelationIds.has(node.legalId)}
              exposure={draft.relations.find((r) => r.legalId === node.legalId)}
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
          {/* Direct factors — featured at the top. */}
          {(directInputs.length > 0 || directRelations.length > 0) && (
            <section className="rule-group">
              <div className="rule-group-head rule-group-head-static">
                <span className="rule-group-label rule-group-featured">Direct factors</span>
                <span className="rule-group-meta">
                  <span className="group-rule-count">
                    {directInputs.length + directRelations.length} most-direct inputs
                  </span>
                </span>
              </div>
              <div className="rule-list rule-list-grouped">
                {directRelations.map(({ node, depth }) => (
                  <RelationRow
                    key={node.legalId}
                    node={node}
                    depth={depth}
                    exposed={exposedRelationIds.has(node.legalId)}
                    exposure={draft.relations.find((r) => r.legalId === node.legalId)}
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
                    exposure={draft.inputs.find((i) => i.legalId === node.legalId)}
                    onToggle={() => toggleInput(node)}
                    onPatch={(p) => patchInput(node.legalId, p)}
                    isEditing={editingId === node.legalId}
                    onEditToggle={() =>
                      setEditingId(editingId === node.legalId ? null : node.legalId)
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {/* Deeper plumbing — grouped by source file. */}
          {deeperRelations.length > 0 && (
            <section className="rule-group">
              <button
                type="button"
                className="rule-group-head"
                onClick={() => toggleGroupOpen("__relations", false)}
                aria-expanded={isGroupOpen("__relations", false)}
              >
                <span className="rule-group-chevron">
                  {isGroupOpen("__relations", false) ? "▾" : "▸"}
                </span>
                <span className="rule-group-label">Relations & per-member inputs</span>
                <span className="rule-group-meta">
                  <span className="group-rule-count">{deeperRelations.length}</span>
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
                      exposure={draft.relations.find((r) => r.legalId === node.legalId)}
                      onToggle={() => toggleRelation(node)}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Document-level rollups for the deeper plumbing — one
              entry per source document (10 CCR 2506-1, 7 CFR, …) with
              sections nested as sub-headers. */}
          {deeperDocuments.map((doc) => {
            const open = isGroupOpen(doc.key, false);
            return (
              <section key={doc.key} className="rule-doc">
                <button
                  type="button"
                  className="rule-doc-head"
                  onClick={() => toggleGroupOpen(doc.key, false)}
                  aria-expanded={open}
                >
                  <span className="rule-group-chevron">{open ? "▾" : "▸"}</span>
                  <span className="rule-doc-label">{doc.label}</span>
                  <span className="rule-doc-meta">
                    {doc.totalItems} input{doc.totalItems === 1 ? "" : "s"}
                    {" · "}
                    {doc.sections.length} section{doc.sections.length === 1 ? "" : "s"}
                  </span>
                </button>
                {open && (
                  <div className="rule-doc-body">
                    {doc.sections.map((sec) => {
                      const fileLegalId = sec.items[0]?.node.fileLegalId;
                      const appUrl = fileLegalId ? axiomAppUrl(fileLegalId) : null;
                      return (
                        <div key={sec.key} className="rule-section">
                          <div className="rule-section-head">
                            <span className="rule-section-label">{sec.key}</span>
                            <span className="rule-section-meta">{sec.items.length}</span>
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
                            {sec.items.map(({ node, depth }) => (
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
                                onToggle={() => toggleInput(node)}
                                onPatch={(p) => patchInput(node.legalId, p)}
                                isEditing={editingId === node.legalId}
                                onEditToggle={() =>
                                  setEditingId(editingId === node.legalId ? null : node.legalId)
                                }
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
                Exposed inputs · <strong>{exposedCount}</strong>
              </span>
            </header>
            <div className="selected-pills">
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
        </aside>
      )}
    </div>
  );
}

function InputRow({
  node,
  depth,
  exposed,
  exposure,
  onToggle,
  onPatch,
  isEditing,
  onEditToggle,
}: {
  node: InputGraphNode;
  depth: number;
  exposed: boolean;
  exposure: InputExposure | undefined;
  onToggle: () => void;
  onPatch: (p: Partial<InputExposure>) => void;
  isEditing: boolean;
  onEditToggle: () => void;
}) {
  const dtypeText = exposure?.dtype ?? inferDtype(node);
  const isPerson = node.entity === "Person";
  return (
    <div>
      <div className={`chip ${exposed ? "chip-selected" : ""}`}>
        <label>
          <input type="checkbox" checked={exposed} onChange={onToggle} />
          <span className="label">
            {exposure?.label ?? humanize(node.name)}
            {isPerson && (
              <span
                className="per-member-tag"
                title="Per household member — the form will show one field per member"
              >
                per member
              </span>
            )}
          </span>
        </label>
        <div className="chip-actions">
          {exposed && !isPerson && (
            <button className="btn ghost" onClick={onEditToggle}>
              {isEditing ? "Done" : "Edit"}
            </button>
          )}
        </div>
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
  depth,
  exposed,
  exposure,
  onToggle,
}: {
  node: RelationGraphNode;
  depth: number;
  exposed: boolean;
  exposure: RelationExposure | undefined;
  onToggle: () => void;
}) {
  return (
    <div className={`chip ${exposed ? "chip-selected" : ""}`}>
      <label>
        <input type="checkbox" checked={exposed} onChange={onToggle} />
        <span className="label">
          {exposure?.label ?? humanize(node.name)}
          <span style={{
            fontFamily: "var(--f-serif)",
            fontStyle: "italic",
            color: "var(--color-ink-muted)",
            fontWeight: 400,
            marginLeft: 6,
            fontSize: 12,
          }}>
            relation · depth {depth}
          </span>
        </span>
      </label>
    </div>
  );
}

function inferDtype(node: InputGraphNode): string {
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

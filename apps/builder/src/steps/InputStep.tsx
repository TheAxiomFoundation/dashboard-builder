import { useEffect, useMemo, useState } from "react";
import type { Draft, InputExposure, RelationExposure } from "../draft";
import {
  dtypeFor,
  exposeInput,
  exposeRelation,
  humanize,
  humanizeWithoutPrefix,
  widgetFor,
  defaultFor,
} from "../draft";
import type { InputGraphNode, RelationGraphNode } from "../api";
import { fetchTransitive } from "../api";
import { humanizeCitation } from "../citations";
import { curatedForDraft } from "./ProgramStep";

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

  // Group the deeper inputs by category — Income / Resources /
  // Eligibility / Household / etc. — same taxonomy as OutputStep so
  // the picker stays cognitively consistent across steps.
  const labelPrefix = curatedForDraft(draft.program)?.labelPrefix;
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
    <div className="step-body step-narrow">
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
        <div className="inline-search">
          <input
            type="search"
            className="inline-search-input"
            placeholder={`Search ${totalRelevant} available questions…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
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
  onToggle: () => void;
  onPatch: (p: Partial<InputExposure>) => void;
  isEditing: boolean;
  onEditToggle: () => void;
}) {
  const isPerson = node.entity === "Person";
  const label =
    exposure?.label ?? humanizeWithoutPrefix(node.name, labelPrefix);
  // Outer container is non-button so we can nest the Edit button without
  // an invalid <button> inside <button>. role="checkbox" preserves
  // accessibility; keyboard users get Space/Enter to toggle.
  return (
    <div>
      <div
        role="checkbox"
        tabIndex={0}
        aria-checked={exposed}
        className={`rule-toggle ${exposed ? "is-selected" : ""}`}
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
  onToggle,
}: {
  node: RelationGraphNode;
  depth: number;
  exposed: boolean;
  exposure: RelationExposure | undefined;
  labelPrefix: string | undefined;
  onToggle: () => void;
}) {
  const label =
    exposure?.label ?? humanizeWithoutPrefix(node.name, labelPrefix);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={exposed}
      className={`rule-toggle ${exposed ? "is-selected" : ""}`}
      onClick={onToggle}
    >
      <span className="rule-toggle-label" title={label}>
        {label}
        <span className="per-member-tag" title="Repeating block — exposing this puts a list-of-members section in the form">
          relation
        </span>
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

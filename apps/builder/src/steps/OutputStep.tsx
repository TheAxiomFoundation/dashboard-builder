import { useMemo, useState } from "react";
import type { Draft, OutputSelection } from "../draft";
import {
  applyRecommendedSetup,
  humanize,
  humanizeWithoutPrefix,
  pruneUnreachable,
  selectOutput,
} from "../draft";
import type { RuleNode } from "../api";
import { axiomAppUrl, documentInfo, humanizeCitation } from "../citations";
import { validateOutput } from "../validators";
import { curatedForDraft } from "./ProgramStep";

interface Props {
  draft: Draft;
  setDraft: (d: Draft) => void;
  /**
   * Sub-stage within Step II.
   *   - "main"          — curated cards (Eligibility / Amount / Custom).
   *   - "intermediates" — full output picker, reached via Custom.
   */
  stage: "main" | "intermediates";
  /** Advance from the curated goal cards into the full output picker. */
  onAdvanceToIntermediates?: () => void;
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
export function OutputStep({
  draft,
  setDraft,
  stage,
  onAdvanceToIntermediates,
}: Props) {
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const graph = draft.graph;
  if (!graph) return <div className="empty-hint">Pick a program first.</div>;

  const labelPrefix = curatedForDraft(draft.program)?.labelPrefix;

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

  // Curated programs (currently CO SNAP) override the auto-derived
  // headlines with a hand-picked 1-3 "main results" — Eligibility /
  // Benefit amount / etc. — so the cards-first treatment kicks in even
  // when the program technically has dozens of terminal rules.
  const curated = curatedForDraft(draft.program);
  const mainOutputs = useMemo<
    Array<{ rule: RuleNode; label: string; blurb?: string }> | null
  >(() => {
    if (!curated?.mainOutputs?.length) return null;
    const items: Array<{ rule: RuleNode; label: string; blurb?: string }> = [];
    for (const m of curated.mainOutputs) {
      const expectedName = m.legalId.split("#").pop();
      const rule = graph.rules.find(
        (r) => r.legalId === m.legalId || r.name === expectedName,
      );
      if (rule) items.push({ rule, label: m.label, blurb: m.blurb });
    }
    return items;
  }, [curated, graph.rules]);

  // Which main outputs has the user actually picked? Drives the
  // partitioning of intermediates in stage 2 — each picked main gets
  // its own bucket of "rules feeding this result".
  const pickedMains = useMemo(() => {
    if (!mainOutputs) return [] as typeof mainOutputs extends null ? never[] : NonNullable<typeof mainOutputs>;
    return mainOutputs.filter((m) => selectedIds.has(m.rule.legalId));
  }, [mainOutputs, selectedIds]);

  // For each picked main output, BFS through rule_deps to find every
  // intermediate rule that feeds it. Results in a map: mainLegalId →
  // Set<reachable rule legalId>. Used to bucket the document picker
  // by which top-level result each rule contributes to.
  const reachableByMain = useMemo(() => {
    const ruleById = new Map(graph.rules.map((r) => [r.legalId, r]));
    const result = new Map<string, Set<string>>();
    for (const m of pickedMains) {
      const reachable = new Set<string>();
      const queue: string[] = [m.rule.legalId];
      const seen = new Set<string>();
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
      result.set(m.rule.legalId, reachable);
    }
    return result;
  }, [graph.rules, pickedMains]);

  // Category grouping for intermediate rules: replaces the document-
  // level rollups (10 CCR 2506-1, 7 CFR, …) with a function-shaped
  // taxonomy (Income / Deductions / Eligibility checks / …) so the
  // user thinks "what kind of calculation is this?" rather than
  // "what regulation does this come from?". Auto-derived from rule
  // name patterns + dtype; falls back to "Other" for anything that
  // doesn't match.
  const categories = useMemo(() => {
    interface Category {
      key: string;
      label: string;
      order: number;
      rules: RuleNode[];
    }
    const cats = new Map<string, Category>();
    for (const rule of availableRules) {
      const c = categorize(rule);
      if (!cats.has(c.key)) {
        cats.set(c.key, { key: c.key, label: c.label, order: c.order, rules: [] });
      }
      cats.get(c.key)!.rules.push(rule);
    }
    return [...cats.values()]
      .map((c) => ({
        ...c,
        rules: c.rules.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }, [availableRules]);

  const documents = useMemo(() => {
    // Bucket non-headline rules by document, then by section within.
    interface Section { key: string; rules: RuleNode[] }
    interface Document {
      key: string;
      label: string;
      sublabel?: string;
      isOwnFile: boolean;
      sections: Section[];
      totalRules: number;
    }
    const headlineIds = new Set(headlineRules.map((r) => r.legalId));
    const byDoc = new Map<
      string,
      { label: string; sublabel?: string; isOwnFile: boolean; sections: Map<string, RuleNode[]> }
    >();
    for (const rule of availableRules) {
      if (headlineIds.has(rule.legalId)) continue; // surfaced separately
      const { key, label, sublabel } = documentInfo(rule.fileLegalId, ownFileLegalId);
      if (!byDoc.has(key)) {
        byDoc.set(key, {
          label,
          sublabel,
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
      sublabel: v.sublabel,
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
      // Drop the output AND any exposed input/relation that no other
      // remaining output transitively depends on. Otherwise the user
      // ends up with "ghost" inputs in step III that don't connect to
      // anything they're computing.
      setDraft(
        pruneUnreachable({
          ...draft,
          outputs: draft.outputs.filter((o) => o.legalId !== legalId),
        }),
      );
      return;
    }
    const rule = graph.rules.find((r) => r.legalId === legalId);
    if (!rule) return;
    // Block adds that would break compute. (Removals always allowed —
    // we never want the user trapped in a broken state.)
    const issue = validateOutput(rule, draft, graph.rules);
    if (issue) return;
    let next: Draft = {
      ...draft,
      outputs: [...draft.outputs, selectOutput(rule)],
    };
    // Auto-apply the curated program's recommended starter inputs
    // whenever the user picks their first main result AND nothing's
    // exposed yet. We deliberately don't gate on the persisted
    // `usedRecommendedSetup` flag — that bit gets stuck across
    // sessions and would prevent re-applying after the user clears
    // their picks and starts fresh. The empty-inputs check already
    // guarantees we don't double-apply on top of existing exposures,
    // and applyRecommendedSetup dedupes per-input regardless.
    const curated = curatedForDraft(draft.program);
    if (
      next.outputs.length === 1 &&
      next.inputs.length === 0 &&
      next.relations.length === 0 &&
      curated?.recommendedInputs?.length
    ) {
      next = applyRecommendedSetup(
        next,
        graph,
        curated.recommendedInputs,
        curated.recommendedMemberCount ?? 3,
      );
    }
    setDraft(next);
  }

  function toggleServiceGoal(legalIds: string[]) {
    if (!graph) return;
    const allSelected = legalIds.every((id) => selectedIds.has(id));
    if (allSelected) {
      setDraft(
        pruneUnreachable({
          ...draft,
          outputs: draft.outputs.filter((o) => !legalIds.includes(o.legalId)),
        }),
      );
      return;
    }
    const rules = legalIds
      .filter((id) => !selectedIds.has(id))
      .map((id) => graph.rules.find((r) => r.legalId === id))
      .filter((r): r is RuleNode => !!r && !validateOutput(r, draft, graph.rules));
    if (rules.length === 0) return;
    let next: Draft = {
      ...draft,
      outputs: [...draft.outputs, ...rules.map((rule) => {
        const curatedLabel = mainOutputs?.find(
          (m) => m.rule.legalId === rule.legalId,
        )?.label;
        const selected = selectOutput(rule);
        return curatedLabel ? { ...selected, label: curatedLabel } : selected;
      })],
    };
    const curated = curatedForDraft(draft.program);
    if (
      draft.outputs.length === 0 &&
      next.inputs.length === 0 &&
      next.relations.length === 0 &&
      curated?.recommendedInputs?.length
    ) {
      next = applyRecommendedSetup(
        next,
        graph,
        curated.recommendedInputs,
        curated.recommendedMemberCount ?? 3,
      );
    }
    setDraft(next);
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

  // ---------- stage "main": cards-first picker, no sidebar ----------
  if (stage === "main") {
    const cardItems =
      mainOutputs && mainOutputs.length > 0
        ? mainOutputs
        : headlineRules.map((rule) => ({
            rule,
            label: humanize(rule.name),
            blurb: rule.source ?? undefined,
          }));
    const eligibility = cardItems.find((item) =>
      /eligib/i.test(item.label) || /eligible/i.test(item.rule.name),
    );
    const amount = cardItems.find((item) =>
      /benefit|amount|allotment/i.test(item.label) ||
      /allotment|benefit|amount/i.test(item.rule.name),
    );
    const goalCards =
      eligibility && amount
        ? [
            {
              key: "eligibility",
              title: "Check eligibility",
              copy: "Answer whether the household appears eligible for SNAP.",
              state: "Eligibility result",
              ids: [eligibility.rule.legalId],
            },
            {
              key: "amount",
              title: "Estimate benefit amount",
              copy: "Estimate the monthly SNAP amount the household may receive.",
              state: "Amount result",
              ids: [amount.rule.legalId],
            },
          ]
        : null;
    return (
      <div className="step-body output-stage-main">
        <div className="output-headline-cards">
          {goalCards
            ? goalCards.map((goal) => {
            const isSelected = goal.ids.every((id) => selectedIds.has(id));
            return (
              <button
                key={goal.key}
                type="button"
                className={`output-headline-card ${isSelected ? "is-selected" : ""}`}
                onClick={() => toggleServiceGoal(goal.ids)}
                aria-pressed={isSelected}
              >
                <span className="output-headline-card-title">{goal.title}</span>
                <span className="output-headline-card-source">{goal.copy}</span>
                <span className="output-headline-card-state">
                  {isSelected ? "Selected ✓" : goal.state}
                </span>
              </button>
            );
          })
            : cardItems.map(({ rule, label, blurb }) => {
                const isSelected = selectedIds.has(rule.legalId);
                return (
                  <button
                    key={rule.legalId}
                    type="button"
                    className={`output-headline-card ${isSelected ? "is-selected" : ""}`}
                    onClick={() => toggle(rule.legalId)}
                    aria-pressed={isSelected}
                  >
                    <span className="output-headline-card-title">{label}</span>
                    {blurb && (
                      <span className="output-headline-card-source">{blurb}</span>
                    )}
                    <span className="output-headline-card-state">
                      {isSelected ? "Picked ✓" : "Pick"}
                    </span>
                  </button>
                );
              })}

          {onAdvanceToIntermediates && cardItems.length > 0 && (
            <button
              type="button"
              className="output-headline-card output-headline-card-custom"
              onClick={onAdvanceToIntermediates}
            >
              <span className="output-headline-card-title">Custom output</span>
              <span className="output-headline-card-source">
                Pick a different result, eligibility check, or calculation
                value from the rule pack.
              </span>
              <span className="output-headline-card-state">
                Browse outputs →
              </span>
            </button>
          )}
        </div>
        {cardItems.length === 0 && (
          <div className="empty-hint">
            This program has no obvious top-level results. Continue to pick
            from intermediate rules.
          </div>
        )}
      </div>
    );
  }

  // ---------- stage "intermediates": category-grouped picker + sidebar ----------
  // Reusable render of one category collapsible. Takes an explicit
  // openKey so the same category can appear in multiple per-main
  // buckets without their open/closed states stomping on each other.
  const renderCategorySection = (
    cat: { key: string; label: string; rules: RuleNode[] },
    openKey: string,
  ) => {
    const open = isGroupOpen(openKey, false);
    return (
      <section key={openKey} className="rule-doc">
        <button
          type="button"
          className="rule-doc-head"
          onClick={() => toggleGroupOpen(openKey, false)}
          aria-expanded={open}
        >
          <span className="rule-group-chevron">{open ? "▾" : "▸"}</span>
          <span className="rule-doc-text">
            <span className="rule-doc-label">{cat.label}</span>
          </span>
          <span className="rule-doc-meta">
            {cat.rules.length} rule{cat.rules.length === 1 ? "" : "s"}
          </span>
        </button>
        {open && (
          <div className="rule-list rule-list-grouped">
            {cat.rules.map((rule) => (
              <RuleRow
                key={rule.legalId}
                rule={rule}
                isSelected={selectedIds.has(rule.legalId)}
                isTerminal={terminal.has(rule.legalId)}
                selection={draft.outputs.find(
                  (o) => o.legalId === rule.legalId,
                )}
                labelPrefix={labelPrefix}
                onToggle={() => toggle(rule.legalId)}
              />
            ))}
          </div>
        )}
      </section>
    );
  };

  const hasPicks = draft.outputs.length > 0;
  return (
    <div className="step-body step-narrow">
      {hasPicks && (
        <section className="picked-strip" aria-label="Picked results">
          <div className="picked-strip-head">
            <span className="picked-strip-label">
              Picked results · <strong>{draft.outputs.length}</strong>
            </span>
          </div>
          <div className="picked-strip-pills">
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
      )}

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
              labelPrefix={labelPrefix}
              onToggle={() => toggle(rule.legalId)}
            />
          ))}
        </div>
      ) : pickedMains.length > 0 ? (
        // Partition the picker by which main result each intermediate
        // rule feeds, then group those rules by function (Income,
        // Deductions, Eligibility, …). The user reads "for Eligibility
        // we use these income / eligibility rules" instead of "we draw
        // from 10 CCR § 4.401 and 7 CFR".
        <>
          {pickedMains.map((m) => {
            const reachable =
              reachableByMain.get(m.rule.legalId) ?? new Set<string>();
            const filteredCats = categories
              .map((cat) => ({
                ...cat,
                rules: cat.rules.filter((r) => reachable.has(r.legalId)),
              }))
              .filter((cat) => cat.rules.length > 0);
            const totalIntermediates = filteredCats.reduce(
              (n, c) => n + c.rules.length,
              0,
            );
            return (
              <section
                key={m.rule.legalId}
                className="output-main-bucket"
              >
                <header className="output-main-bucket-head">
                  <span className="output-main-bucket-label">
                    {m.label} breakdown
                  </span>
                </header>
                {totalIntermediates === 0 ? (
                  <div className="empty-hint">
                    No intermediate rules to surface for this result.
                  </div>
                ) : (
                  filteredCats.map((cat) =>
                    renderCategorySection(cat, `${m.rule.legalId}::${cat.key}`),
                  )
                )}
              </section>
            );
          })}
        </>
      ) : (
        // No curated mains picked — flat list of category rollups.
        <>{categories.map((cat) => renderCategorySection(cat, cat.key))}</>
      )}
    </div>
  );
}

function RuleRow({
  rule,
  isSelected,
  isTerminal,
  selection,
  labelPrefix,
  onToggle,
}: {
  rule: RuleNode;
  isSelected: boolean;
  isTerminal: boolean;
  selection: OutputSelection | undefined;
  labelPrefix: string | undefined;
  onToggle: () => void;
}) {
  const label =
    selection?.label ?? humanizeWithoutPrefix(rule.name, labelPrefix);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={isSelected}
      className={`rule-toggle ${isSelected ? "is-selected" : ""}`}
      onClick={onToggle}
    >
      <span className="rule-toggle-label" title={label}>
        {label}
      </span>
      {isTerminal && !isSelected && (
        <span className="terminal-tag">headline</span>
      )}
      <span
        className={`rule-toggle-mark ${isSelected ? "is-on" : ""}`}
        aria-hidden="true"
      >
        {isSelected ? "✓" : "+"}
      </span>
    </button>
  );
}

/**
 * Bucket a derived rule into a function-shaped category — Income,
 * Deductions, Eligibility checks, etc. — purely from name patterns
 * and declared dtype. Heuristic; covers ~90% of CO SNAP cleanly,
 * everything else falls into "Other".
 */
function categorize(
  rule: RuleNode,
): { key: string; label: string; order: number } {
  const name = rule.name.toLowerCase();
  const dtype = (rule.dtype ?? "").toLowerCase();
  if (/_allotment|_benefit_amount|_total_benefit|_payment_amount|allotment/.test(name)) {
    return { key: "amount", label: "Benefit amount", order: 1 };
  }
  if (/_eligible|_qualif|_disqualif|_eligibility|_denied/.test(name) || dtype === "judgment") {
    return { key: "eligibility", label: "Eligibility checks", order: 2 };
  }
  if (/_income|_earnings|_earned|_wages|_pay\b|_resource_transfer/.test(name)) {
    return { key: "income", label: "Income", order: 3 };
  }
  if (/_deduction|_expense|_costs?\b|_allowance|_shelter|_medical/.test(name)) {
    return { key: "deductions", label: "Deductions & expenses", order: 4 };
  }
  if (/_resource|_asset|_limit\b|_threshold|_lump_sum/.test(name)) {
    return { key: "resources", label: "Resources & limits", order: 5 };
  }
  if (/_household|_member|_size|_relation/.test(name)) {
    return { key: "household", label: "Household structure", order: 6 };
  }
  return { key: "other", label: "Other", order: 99 };
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

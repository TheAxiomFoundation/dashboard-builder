import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ComputeCoverage,
  DashboardSpec,
  OutputBinding,
  OutputPresentation,
  OutputValue,
  TraceNode,
} from "@dashboard-builder/spec";
import { RuleGraph } from "./RuleGraph";

interface Props {
  spec: DashboardSpec;
  outputs: OutputValue[];
  traces: Record<string, TraceNode>;
  coverage?: ComputeCoverage;
  warnings: string[];
  mode: string;
  /** When true (set by the builder's preview pane), show coverage signal aimed at dashboard authors. */
  showCoverage?: boolean;
  /** Builder-only: handle "expose this input" clicks on default trace leaves. */
  onExposeInput?: (legalId: string) => void;
  /** Builder-only: legal IDs already exposed in the dashboard (used to label leaves correctly across re-renders). */
  exposedInputIds?: Set<string>;
  /** Builder-only: handle "add as output" clicks on derived-rule trace nodes. */
  onAddOutput?: (legalId: string) => void;
  /** Builder-only: legal IDs already selected as outputs. */
  selectedOutputIds?: Set<string>;
}

/**
 * Results panel — three layers of hierarchy:
 *
 *   1. Hero: the single most prominent output (first headline by spec order).
 *      Big display value, eligibility verdict styled distinctively.
 *   2. Ledger: every other headline + secondary output as a clean two-column
 *      ledger of label → value, separated by hairline rules.
 *   3. Trace: a collapsible "How was this calculated?" section built as an
 *      inline narrative — each headline output's dependency tree presented
 *      with its source citation, not a deep-nested toggle.
 */
export function Results({
  spec,
  outputs,
  traces,
  coverage,
  warnings,
  mode,
  showCoverage = false,
  onExposeInput,
  exposedInputIds,
  onAddOutput,
  selectedOutputIds,
}: Props) {
  const byLegalId = new Map(outputs.map((o) => [o.legalId, o]));
  const ordered = [...spec.outputs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const headlineList = ordered.filter((o) => o.emphasis !== "secondary");
  const secondary = ordered.filter((o) => o.emphasis === "secondary");
  const hero = headlineList[0];
  const otherHeadlines = headlineList.slice(1);

  const tracedHeadlines = headlineList.filter((o) => o.showExplain);
  const realWarnings = warnings.filter((w) => !w.toLowerCase().includes("demo mode"));

  return (
    <section className="results">
      <div className="results-summary">
        {mode === "demo" && (
          <span
            className="info-pill"
            title="Set AXIOM_RULES_ENGINE_BIN and install the axiom_rules_engine Python package for live computation. See compute/README.md."
          >
            Test-fixture values · engine not connected
          </span>
        )}

        {showCoverage && coverage && <CoverageStrip coverage={coverage} />}

        {realWarnings.map((w) => (
          <div className="warning" key={w}>
            {w}
          </div>
        ))}

        {hero && (
          <Hero binding={hero} output={byLegalId.get(hero.legalId)} />
        )}

        {(otherHeadlines.length > 0 || secondary.length > 0) && (
          <div className="ledger">
            {otherHeadlines.map((b) => (
              <LedgerRow
                key={b.id}
                binding={b}
                output={byLegalId.get(b.legalId)}
                emphasis="strong"
              />
            ))}
            {secondary.map((b) => (
              <LedgerRow
                key={b.id}
                binding={b}
                output={byLegalId.get(b.legalId)}
                emphasis="muted"
              />
            ))}
          </div>
        )}
      </div>

      {tracedHeadlines.length > 0 && (
        <Explanation
          headlines={tracedHeadlines}
          traces={traces}
          byLegalId={byLegalId}
          onExposeInput={onExposeInput}
          exposedInputIds={exposedInputIds}
          onAddOutput={onAddOutput}
          selectedOutputIds={selectedOutputIds}
        />
      )}
    </section>
  );
}

function Hero({
  binding,
  output,
}: {
  binding: OutputBinding;
  output: OutputValue | undefined;
}) {
  const formatted = formatValue(output, binding.presentation);
  return (
    <div className="hero-result">
      <span className="hero-label">{binding.label}</span>
      <div className="hero-value">{formatted}</div>
    </div>
  );
}

function LedgerRow({
  binding,
  output,
  emphasis,
}: {
  binding: OutputBinding;
  output: OutputValue | undefined;
  emphasis: "strong" | "muted";
}) {
  return (
    <div className={`ledger-row ${emphasis}`}>
      <span className="ledger-label">{binding.label}</span>
      <span className="ledger-value">{formatValue(output, binding.presentation)}</span>
    </div>
  );
}

function Explanation({
  headlines,
  traces,
  byLegalId,
  onExposeInput,
  exposedInputIds,
  onAddOutput,
  selectedOutputIds,
}: {
  headlines: OutputBinding[];
  traces: Record<string, TraceNode>;
  byLegalId: Map<string, OutputValue>;
  onExposeInput?: (legalId: string) => void;
  exposedInputIds?: Set<string>;
  onAddOutput?: (legalId: string) => void;
  selectedOutputIds?: Set<string>;
}) {
  // Hint state for child <TraceList> nodes: "expand-all" / "collapse-all"
  // forces every node to follow; "default" lets each node use its own
  // depth-based default. Rolling counter so a click always re-applies.
  const [expandHint, setExpandHint] = useState<{
    mode: "default" | "all" | "none";
    nonce: number;
  }>({ mode: "default", nonce: 0 });

  return (
    <details className="explanation">
      <summary>
        <span className="explanation-eyebrow">How this is computed</span>
        <span className="explanation-controls" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="btn ghost"
            onClick={(e) => {
              e.preventDefault();
              setExpandHint((s) => ({ mode: "all", nonce: s.nonce + 1 }));
            }}
          >
            Expand all
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={(e) => {
              e.preventDefault();
              setExpandHint((s) => ({ mode: "none", nonce: s.nonce + 1 }));
            }}
          >
            Collapse all
          </button>
        </span>
      </summary>

      {headlines.map((binding) => {
        const trace = traces[binding.legalId];
        if (!trace) return null;
        return (
          <div key={binding.id} className="explanation-block">
            <div className="explanation-head">
              <span className="explanation-name">{binding.label}</span>
              <span className="explanation-result">{formatValue(byLegalId.get(binding.legalId), binding.presentation)}</span>
            </div>
            <TraceList
              node={trace}
              depth={0}
              onExposeInput={onExposeInput}
              exposedInputIds={exposedInputIds}
              onAddOutput={onAddOutput}
              selectedOutputIds={selectedOutputIds}
              expandHint={expandHint}
            />
          </div>
        );
      })}
    </details>
  );
}

interface ExpandHint {
  mode: "default" | "all" | "none";
  /** Increments on each click so children re-apply the hint (replaces stale state). */
  nonce: number;
}

function TraceList({
  node,
  depth,
  onExposeInput,
  exposedInputIds,
  onAddOutput,
  selectedOutputIds,
  expandHint,
}: {
  node: TraceNode;
  depth: number;
  onExposeInput?: (legalId: string) => void;
  exposedInputIds?: Set<string>;
  onAddOutput?: (legalId: string) => void;
  selectedOutputIds?: Set<string>;
  expandHint?: ExpandHint;
}) {
  const isInput = node.dtype === "input";
  const isJudgment = node.dtype === "judgment";
  const showFormula = !isInput && Boolean(node.formula);

  const liveSource: "user" | "default" | undefined = isInput
    ? exposedInputIds?.has(node.legalId)
      ? "user"
      : (node.inputSource ?? undefined)
    : undefined;

  const canExpose = isInput && liveSource === "default" && !!onExposeInput;
  const canAddOutput =
    !isInput && !!onAddOutput && !selectedOutputIds?.has(node.legalId);

  // Per-node expand state. Default: depth ≤ 2 open, deeper nodes folded.
  // Apply hints from parent on a fresh nonce so "Expand all" / "Collapse all"
  // override the current state without permanently locking it.
  const [expanded, setExpanded] = useState<boolean>(() => depth <= 2);
  useEffect(() => {
    if (!expandHint) return;
    if (expandHint.mode === "all") setExpanded(true);
    else if (expandHint.mode === "none") setExpanded(false);
    // mode === "default" → leave as-is
  }, [expandHint?.nonce, expandHint?.mode]);

  // Pick a short two/three-letter type tag and a colored left rail color so
  // rules and inputs are immediately distinguishable in the trace tree.
  const kindTag = isInput
    ? "IN"
    : isJudgment
      ? node.value === "holds"
        ? "✓"
        : node.value === "not_holds"
          ? "✗"
          : "?"
      : "ƒx";
  const rowKindClass = isInput
    ? "kind-input"
    : isJudgment
      ? node.value === "holds"
        ? "kind-judgment-holds"
        : node.value === "not_holds"
          ? "kind-judgment-fails"
          : "kind-judgment-undet"
      : "kind-rule";

  // Group children: derived rules first (computation steps), input leaves
  // last. Within each group, preserve the original order returned by the
  // engine.
  const childRules = (node.children ?? []).filter((c) => c.dtype !== "input");
  const childInputs = (node.children ?? []).filter((c) => c.dtype === "input");

  // Map child labels → values, used by the formula display to annotate each
  // clause with its actual verdict.
  const childVerdicts = new Map<string, TraceNode>();
  for (const c of node.children ?? []) {
    if (c.label) childVerdicts.set(c.label, c);
  }

  const hasChildren = Boolean(node.children?.length);

  return (
    <div className={`trace-list ${rowKindClass}`}>
      <div className="trace-line">
        {hasChildren && !isInput ? (
          <button
            type="button"
            className="trace-chevron"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Collapse" : "Expand"}
            aria-expanded={expanded}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="trace-chevron-spacer" aria-hidden />
        )}
        <span className="trace-kind" aria-hidden>
          {kindTag}
        </span>
        <span className="trace-name">
          {node.label || node.legalId.split("#")[1] || node.legalId}
        </span>
        <span className="trace-equals">=</span>
        <span className="trace-value">{formatTraceValue(node)}</span>
        {isInput && liveSource && (
          <span className={`trace-source-badge ${liveSource}`}>
            {liveSource === "user" ? "user" : "default"}
          </span>
        )}
        {canExpose && (
          <button
            type="button"
            className="expose-btn"
            onClick={() => onExposeInput?.(node.legalId)}
          >
            + Expose
          </button>
        )}
        {canAddOutput && (
          <button
            type="button"
            className="add-output-btn"
            onClick={() => onAddOutput?.(node.legalId)}
          >
            + Add output
          </button>
        )}
      </div>
      {node.source && !isInput && <div className="trace-source">{node.source}</div>}
      {showFormula && (
        <Formula
          node={node}
          negated={isJudgment && node.value === "not_holds"}
          childVerdicts={childVerdicts}
          onExposeInput={onExposeInput}
          exposedInputIds={exposedInputIds}
          onAddOutput={onAddOutput}
          selectedOutputIds={selectedOutputIds}
        />
      )}
      {isInput && node.source && (
        <div className="trace-source trace-input-source">
          declared in {node.source}
        </div>
      )}
      {expanded && (childRules.length > 0 || childInputs.length > 0) && (
        <div className="trace-children">
          {childRules.length > 0 && (
            <>
              {depth === 0 && childInputs.length > 0 && (
                <div className="trace-group-label">Computation steps</div>
              )}
              {childRules.map((child, i) => (
                <TraceList
                  key={`${child.legalId}-rule-${i}`}
                  node={child}
                  depth={depth + 1}
                  onExposeInput={onExposeInput}
                  exposedInputIds={exposedInputIds}
                  onAddOutput={onAddOutput}
                  selectedOutputIds={selectedOutputIds}
                  expandHint={expandHint}
                />
              ))}
            </>
          )}
          {childInputs.length > 0 && (
            <>
              {(depth === 0 || childRules.length > 0) && (
                <div className="trace-group-label">Inputs</div>
              )}
              {childInputs.map((child, i) => (
                <TraceList
                  key={`${child.legalId}-input-${i}`}
                  node={child}
                  depth={depth + 1}
                  onExposeInput={onExposeInput}
                  exposedInputIds={exposedInputIds}
                  onAddOutput={onAddOutput}
                  selectedOutputIds={selectedOutputIds}
                  expandHint={expandHint}
                />
              ))}
            </>
          )}
        </div>
      )}
      {!expanded && hasChildren && (
        <div className="trace-collapsed-hint">
          {childRules.length} sub-rule{childRules.length === 1 ? "" : "s"} ·{" "}
          {childInputs.length} input{childInputs.length === 1 ? "" : "s"} hidden
        </div>
      )}
    </div>
  );
}

/**
 * Renders a rule's formula as a small annotated code block.
 *
 * Each token gets a class via React (no dangerouslySetInnerHTML), and any
 * identifier that matches a child rule of the current trace node gets a
 * verdict glyph (✓ / ✗) prefixed. That lets you scan AND-conjunctions and
 * spot the failing clause immediately — no parsing needed.
 */
function Formula({
  node,
  negated,
  childVerdicts,
  onExposeInput,
  exposedInputIds,
  onAddOutput,
  selectedOutputIds,
}: {
  node: TraceNode;
  negated: boolean;
  childVerdicts: Map<string, TraceNode>;
  onExposeInput?: (legalId: string) => void;
  exposedInputIds?: Set<string>;
  onAddOutput?: (legalId: string) => void;
  selectedOutputIds?: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="formula-trigger"
        onClick={() => setOpen(true)}
      >
        <span className="formula-trigger-glyph" aria-hidden>›</span>
        {negated ? "Why this fails" : "Condition"}
      </button>
      {open && (
        <RuleModal
          rootNode={node}
          childVerdicts={childVerdicts}
          onClose={() => setOpen(false)}
          onExposeInput={onExposeInput}
          exposedInputIds={exposedInputIds}
          onAddOutput={onAddOutput}
          selectedOutputIds={selectedOutputIds}
        />
      )}
    </>
  );
}

/**
 * Focused view of a single rule's evaluation — formula on top, inputs the
 * formula consumes (with user/default flags) below, sub-rule references
 * clickable to drill in. Maintains a breadcrumb stack so you can rabbit-hole
 * into a sub-rule and walk back without losing context.
 */
function RuleModal({
  rootNode,
  childVerdicts: rootChildVerdicts,
  onClose,
  onExposeInput,
  exposedInputIds,
  onAddOutput,
  selectedOutputIds,
}: {
  rootNode: TraceNode;
  childVerdicts: Map<string, TraceNode>;
  onClose: () => void;
  onExposeInput?: (legalId: string) => void;
  exposedInputIds?: Set<string>;
  onAddOutput?: (legalId: string) => void;
  selectedOutputIds?: Set<string>;
}) {
  // Breadcrumb stack — root is the rule the user clicked into; pushing a
  // sub-rule lets them walk into it without losing the trail back.
  const [stack, setStack] = useState<TraceNode[]>([rootNode]);
  const [view, setView] = useState<"graph" | "code">("graph");
  // Default to structure mode when the modal is opened from a builder step
  // that's still being constructed (the "+ Add output" / "+ Expose" hooks
  // are wired) — values would just be fixture defaults and read as noise.
  // Default to values mode otherwise (deployed dashboard, publish preview).
  const isBuildingContext = !!onAddOutput || !!onExposeInput;
  const [graphMode, setGraphMode] = useState<"structure" | "values">(
    isBuildingContext ? "structure" : "values",
  );
  const current = stack[stack.length - 1] ?? rootNode;
  // Build verdict map from current's children so the formula's sub-rule
  // identifiers light up with their values at this depth.
  const verdicts = useMemo(() => {
    const m = new Map<string, TraceNode>();
    for (const c of current.children ?? []) {
      if (c.label) m.set(c.label, c);
    }
    return m;
  }, [current]);

  function pushNode(child: TraceNode) {
    setStack((s) => [...s, child]);
  }
  function popTo(index: number) {
    setStack((s) => s.slice(0, index + 1));
  }

  // Esc closes; click outside closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isInput = current.dtype === "input";
  const isJudgment = current.dtype === "judgment";

  // Build a fast lookup: token (formula identifier) → child trace node.
  // Used to enrich the formula tokens inline so we don't need a separate
  // "sub-rules" or "inputs" list — the formula is the explanation.
  //
  // Strip BOTH `input.` and `relation.` prefixes from the legal-id tail.
  // Formulas reference inputs and relations by their bare name (the part
  // after the prefix), but legal IDs carry the prefix to distinguish
  // them. Without stripping `relation.`, a formula token like
  // `member_of_household` would fail to find its trace child (legal id
  // `…#relation.member_of_household`), and RuleGraph would fall through
  // to the "unknown" branch — rendering the relation as a generic grey
  // dashed box instead of a green relation node with its member count.
  const tokenIndex = useMemo(() => {
    const m = new Map<string, TraceNode>();
    for (const c of current.children ?? []) {
      if (c.dtype === "input") {
        const bare = c.legalId
          .split("#")
          .pop()
          ?.replace(/^(?:input|relation)\./, "");
        if (bare) m.set(bare, c);
      } else if (c.label) {
        m.set(c.label, c);
      }
    }
    return m;
  }, [current]);

  // Glyph (✓/✗/?) is rendered separately via `rule-modal-verdict-glyph`,
  // so the text label should be plain words — otherwise the pill ends up
  // with double check marks ("✓ ✓ holds").
  const verdictLabel = isJudgment
    ? current.evaluationRole === "relationPredicate"
      ? "evaluated per member"
      : current.notEvaluated
      ? "skipped in this run"
      : current.value === "holds"
      ? "holds"
      : current.value === "not_holds"
        ? "does not hold"
        : "undetermined"
    : formatTraceValue(current);

  const verdictClass = isJudgment
    ? current.value === "holds"
      ? "verdict-holds"
      : current.value === "not_holds"
        ? "verdict-fails"
        : "verdict-undet"
    : "verdict-numeric";

  // Portal to body so the modal escapes any ancestor stacking context.
  // The app shell renders a sticky header at z-index 10 inside an `.app`
  // wrapper that creates its own stacking context (`position: relative;
  // z-index: 1`). When the modal is rendered inline inside the preview
  // pane, its z-index resolves *within* `.app`'s context and the header
  // ends up painting on top of the modal's title bar. Portal-to-body
  // makes the modal a sibling of `.app`, so its z-index is global.
  const modalRoot = typeof document !== "undefined" ? document.body : null;
  if (!modalRoot) return null;
  return createPortal(
    <div className="rule-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="rule-modal" onClick={(e) => e.stopPropagation()}>
        <header className="rule-modal-head">
          <div className="rule-modal-eyebrow">
            <div className="rule-modal-eyebrow-text">
              {stack.length > 1 && (
                <nav className="rule-modal-crumbs" aria-label="Drill path">
                  {stack.slice(0, -1).map((n, idx) => (
                    <button
                      key={`${n.legalId}-${idx}`}
                      type="button"
                      className="crumb-btn"
                      onClick={() => popTo(idx)}
                    >
                      {n.label || n.legalId.split("#")[1]}
                    </button>
                  ))}
                  <span className="crumb-sep" aria-hidden>/</span>
                </nav>
              )}
              {current.source && (
                <span className="rule-modal-citation">§ {current.source}</span>
              )}
            </div>
            <button
              type="button"
              className="rule-modal-close"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="rule-modal-headline">
            <h2 className="rule-modal-name">
              {current.label || current.legalId.split("#")[1] || current.legalId}
            </h2>
            <span className={`rule-modal-verdict ${verdictClass}`}>
              <span className="rule-modal-verdict-glyph">{glyphFor(current)}</span>
              <span className="rule-modal-verdict-text">{verdictLabel}</span>
            </span>
          </div>
        </header>

        <div className="rule-modal-body">
          {!isInput && current.formula && (
            <section>
              <div className="rule-modal-view-toggle">
                <h3 className="rule-modal-section-eyebrow">
                  {graphMode === "structure" ? "Structure" : "Live evaluation"}
                </h3>
                <div className="rule-modal-view-controls">
                  {view === "graph" && (
                    <ModeToggle current={graphMode} onChange={setGraphMode} />
                  )}
                  <ViewToggle current={view} onChange={setView} />
                </div>
              </div>
              {view === "graph" ? (
                <RuleGraph
                  formula={current.formula}
                  lookup={(name) => tokenIndex.get(name)}
                  onDrillInto={pushNode}
                  onExposeInput={onExposeInput}
                  exposedInputIds={exposedInputIds}
                  mode={graphMode}
                />
              ) : (
                <FormulaCode formula={current.formula} />
              )}
            </section>
          )}

          {isInput && (
            <section>
              <h3 className="rule-modal-section-eyebrow">Current state</h3>
              <div className="rule-modal-input-summary">
                <div className="rule-modal-summary-row">
                  <span className="rule-modal-summary-label">Value</span>
                  <span className="rule-modal-summary-value">
                    {formatTraceValue(current)}
                  </span>
                </div>
                <div className="rule-modal-summary-row">
                  <span className="rule-modal-summary-label">Source</span>
                  <span
                    className={`rule-modal-source-pill ${
                      exposedInputIds?.has(current.legalId)
                        ? "user"
                        : current.inputSource ?? "default"
                    }`}
                  >
                    {exposedInputIds?.has(current.legalId)
                      ? "user · driven by your dashboard"
                      : "default · frozen at fixture value"}
                  </span>
                </div>
              </div>
            </section>
          )}

          {!isInput && !current.formula && (
            <section>
              <h3 className="rule-modal-section-eyebrow">Current state</h3>
              <div className="rule-modal-input-summary">
                <div className="rule-modal-summary-row">
                  <span className="rule-modal-summary-label">Value</span>
                  <span className="rule-modal-summary-value">
                    {formatTraceValue(current)}
                  </span>
                </div>
                {current.source && (
                  <div className="rule-modal-summary-row">
                    <span className="rule-modal-summary-label">Source</span>
                    <span className="rule-modal-summary-value">
                      § {current.source}
                    </span>
                  </div>
                )}
                <div className="rule-modal-summary-row">
                  <span className="rule-modal-summary-label">Trace</span>
                  <span className="rule-modal-summary-value">
                    {current.notEvaluated
                      ? "Skipped branch in this run"
                      : current.value !== null && current.value !== undefined
                        ? "Static reference data"
                        : "No formula or dependencies returned"}
                  </span>
                </div>
              </div>
            </section>
          )}
        </div>

        {!isInput && (
          <div className="rule-modal-footer">
            {onAddOutput && !selectedOutputIds?.has(current.legalId) && (
              <button
                type="button"
                className="add-output-btn"
                onClick={() => {
                  onAddOutput(current.legalId);
                  onClose();
                }}
              >
                + Add as output
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    modalRoot,
  );
}

/**
 * Renders a rule's formula such that each identifier is replaced inline by a
 * pill carrying name + current value + source state + action. The formula
 * structure (and / or / if / else / operators / literals) stays as
 * lightweight markup. This collapses the previous "formula text + sub-rules
 * list + inputs list" into one place — the formula IS the explanation.
 *
 * For readability of long AND/OR/IF chains, the formula is split into
 * vertical lines at top-level operators and `if`/`then`/`else` keywords.
 * Indentation reflects nesting via simple parenthesis depth.
 */
function AnnotatedFormula({
  text,
  tokenIndex,
  onDrillInto,
  onExposeInput,
  exposedInputIds,
}: {
  text: string;
  tokenIndex: Map<string, TraceNode>;
  onDrillInto: (node: TraceNode) => void;
  onExposeInput?: (legalId: string) => void;
  exposedInputIds?: Set<string>;
}) {
  const tokens = tokenizeFormula(text);

  return (
    <div className="annotated-formula">
      {tokens.map((t, i) => {
        if (t.kind === "ident" && tokenIndex.has(t.text)) {
          const node = tokenIndex.get(t.text)!;
          if (node.dtype === "input") {
            return (
              <InputPill
                key={i}
                node={node}
                onExposeInput={onExposeInput}
                isExposed={exposedInputIds?.has(node.legalId) ?? node.inputSource === "user"}
              />
            );
          }
          return <RulePill key={i} node={node} onClick={() => onDrillInto(node)} />;
        }
        if (t.kind === "ident") {
          // Identifier the engine didn't surface (rare — maybe a parameter).
          return (
            <span key={i} className="formula-token formula-ident-unknown">
              {t.text}
            </span>
          );
        }
        if (t.kind === "kw") {
          return (
            <span key={i} className="formula-token formula-kw">
              {t.text}
            </span>
          );
        }
        if (t.kind === "fn") {
          return (
            <span key={i} className="formula-token formula-fn">
              {t.text}
            </span>
          );
        }
        if (t.kind === "op") {
          return (
            <span key={i} className="formula-token formula-op">
              {t.text}
            </span>
          );
        }
        if (t.kind === "num" || t.kind === "lit") {
          return (
            <span key={i} className="formula-token formula-lit">
              {t.text}
            </span>
          );
        }
        // Whitespace / punctuation — preserve newlines but render them as <br/>
        if (t.text === "\n") return <br key={i} />;
        return <span key={i}>{t.text}</span>;
      })}
    </div>
  );
}

function RulePill({ node, onClick }: { node: TraceNode; onClick: () => void }) {
  const verdictCls = verdictClassFor(node);
  const glyph = glyphFor(node);
  return (
    <button
      type="button"
      className={`pill rule-pill ${verdictCls}`}
      onClick={onClick}
      title="Click to drill into this rule"
    >
      <span className="pill-glyph">{glyph}</span>
      <span className="pill-name">{node.label}</span>
      <span className="pill-value">{formatTraceValue(node)}</span>
      <span className="pill-arrow">›</span>
    </button>
  );
}

function InputPill({
  node,
  isExposed,
  onExposeInput,
}: {
  node: TraceNode;
  isExposed: boolean;
  onExposeInput?: (legalId: string) => void;
}) {
  const source = isExposed ? "user" : "default";
  return (
    <span className={`pill input-pill input-pill-${source}`}>
      <span className="pill-glyph">IN</span>
      <span className="pill-name">{node.label}</span>
      <span className="pill-value">{formatTraceValue(node)}</span>
      {!isExposed && onExposeInput && (
        <button
          type="button"
          className="pill-action"
          onClick={() => onExposeInput(node.legalId)}
          title="Expose this input in your dashboard"
        >
          + expose
        </button>
      )}
    </span>
  );
}

function ModeToggle({
  current,
  onChange,
}: {
  current: "structure" | "values";
  onChange: (v: "structure" | "values") => void;
}) {
  return (
    <div className="view-toggle" role="tablist" aria-label="Graph mode">
      <button
        type="button"
        className={`view-toggle-btn ${current === "structure" ? "is-active" : ""}`}
        onClick={() => onChange("structure")}
        role="tab"
        aria-selected={current === "structure"}
        title="Show only the rule's structure — what it depends on"
      >
        Structure
      </button>
      <button
        type="button"
        className={`view-toggle-btn ${current === "values" ? "is-active" : ""}`}
        onClick={() => onChange("values")}
        role="tab"
        aria-selected={current === "values"}
        title="Show current values + which branches are active"
      >
        Values
      </button>
    </div>
  );
}

function ViewToggle({
  current,
  onChange,
}: {
  current: "graph" | "code";
  onChange: (v: "graph" | "code") => void;
}) {
  return (
    <div className="view-toggle" role="tablist">
      <button
        type="button"
        className={`view-toggle-btn ${current === "graph" ? "is-active" : ""}`}
        onClick={() => onChange("graph")}
        role="tab"
        aria-selected={current === "graph"}
      >
        Graph
      </button>
      <button
        type="button"
        className={`view-toggle-btn ${current === "code" ? "is-active" : ""}`}
        onClick={() => onChange("code")}
        role="tab"
        aria-selected={current === "code"}
      >
        Code
      </button>
    </div>
  );
}

/**
 * Verbatim formula source with light syntax highlighting using the same
 * tokenizer the parser uses. Useful for users who want to see the actual
 * RuleSpec encoding (and copy it elsewhere).
 */
function FormulaCode({ formula }: { formula: string }) {
  const tokens = tokenizeFormula(formula);
  return (
    <pre className="rule-modal-code">
      {tokens.map((t, i) => {
        if (t.kind === "text") return <span key={i}>{t.text}</span>;
        return (
          <span key={i} className={`code-tok-${t.kind}`}>
            {t.text}
          </span>
        );
      })}
    </pre>
  );
}

function glyphFor(node: TraceNode): string {
  if (node.dtype === "judgment") {
    if (node.value === "holds") return "✓";
    if (node.value === "not_holds") return "✗";
    return "?";
  }
  return "ƒx";
}

function verdictClassFor(node: TraceNode): string {
  if (node.dtype === "judgment") {
    if (node.value === "holds") return "verdict-holds";
    if (node.value === "not_holds") return "verdict-fails";
    return "verdict-undet";
  }
  return "verdict-numeric";
}

function IdentWithVerdict({ name, verdict }: { name: string; verdict: TraceNode }) {
  // Identifier that matches a child rule. Show the verdict inline so users
  // don't need a tooltip to know what each clause evaluated to:
  //   judgment  →  ✓ name  /  ✗ name
  //   numeric   →  name(= 1433)
  let glyph: string | null = null;
  let cls = "tok-ident-rule";
  let inlineValue: string | null = null;
  if (verdict.dtype === "judgment") {
    if (verdict.value === "holds") {
      glyph = "✓";
      cls += " holds";
    } else if (verdict.value === "not_holds") {
      glyph = "✗";
      cls += " fails";
    }
  } else if (typeof verdict.value === "number") {
    cls += " numeric";
    inlineValue = formatTraceValue(verdict);
  }
  return (
    <span className={cls}>
      {glyph && <span className="ident-glyph">{glyph} </span>}
      {name}
      {inlineValue && <span className="ident-value">(={inlineValue})</span>}
    </span>
  );
}

interface FormulaToken {
  kind: "kw" | "fn" | "lit" | "num" | "op" | "ident" | "text";
  text: string;
}

const KEYWORDS = new Set(["and", "or", "not", "in", "is", "if", "else", "elif", "true", "false", "True", "False"]);
const FUNCTIONS = new Set([
  "count_where", "sum_where", "where", "count", "min", "max",
  "abs", "round", "floor", "ceil", "any", "all", "len",
]);

/**
 * Tokenizer with broad strokes — enough for RuleSpec formulas. We split on
 * identifier-vs-non-identifier boundaries and classify each chunk.
 */
function tokenizeFormula(raw: string): FormulaToken[] {
  const out: FormulaToken[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)|(\d+(?:\.\d+)?)|(==|!=|<=|>=|<|>|\+|-|\*|\/)|(\s+)|(.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const [_, ident, num, op, ws, other] = m;
    if (ident !== undefined) {
      if (KEYWORDS.has(ident)) out.push({ kind: "kw", text: ident });
      else if (FUNCTIONS.has(ident)) out.push({ kind: "fn", text: ident });
      else if (ident === "true" || ident === "false" || ident === "True" || ident === "False")
        out.push({ kind: "lit", text: ident });
      else out.push({ kind: "ident", text: ident });
    } else if (num !== undefined) {
      out.push({ kind: "num", text: num });
    } else if (op !== undefined) {
      out.push({ kind: "op", text: op });
    } else if (ws !== undefined) {
      out.push({ kind: "text", text: ws });
    } else if (other !== undefined) {
      out.push({ kind: "text", text: other });
    }
  }
  return out;
}

/**
 * Coverage strip — the "is my dashboard actually doing anything?" signal.
 * Only renders inside the builder's preview pane (showCoverage=true).
 */
function CoverageStrip({ coverage }: { coverage: ComputeCoverage }) {
  const total = coverage.userInputCount + coverage.defaultInputCount;
  if (total === 0) return null;
  const pct = total === 0 ? 0 : Math.round((coverage.userInputCount / total) * 100);
  const status =
    coverage.userInputCount === 0
      ? "frozen"
      : pct < 15
        ? "thin"
        : "ok";

  return (
    <div className={`coverage-strip ${status}`}>
      <div className="coverage-bar" aria-hidden>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="coverage-meta">
        <strong>{coverage.userInputCount}</strong> user-driven{" "}
        <span className="muted">/ {coverage.defaultInputCount} locked to defaults</span>
        {status === "frozen" && (
          <span className="coverage-warning">
            · Outcome can't change. Expose at least one input.
          </span>
        )}
        {status === "thin" && (
          <span className="coverage-warning">
            · Most factors come from defaults. Trace badges show which.
          </span>
        )}
      </div>
    </div>
  );
}

function formatValue(
  output: OutputValue | undefined,
  presentation: OutputPresentation,
): React.ReactNode {
  if (!output || output.value === null || output.value === undefined) return <span className="muted">—</span>;
  const v = output.value;

  switch (presentation.kind) {
    case "currency": {
      if (typeof v !== "number") return String(v);
      const decimals = presentation.decimals ?? 2;
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: presentation.currency ?? "USD",
        maximumFractionDigits: decimals,
        minimumFractionDigits: decimals,
      }).format(v);
    }
    case "number": {
      if (typeof v !== "number") return String(v);
      const dec = presentation.decimals ?? 2;
      return v.toLocaleString("en-US", {
        maximumFractionDigits: dec,
        minimumFractionDigits: dec,
      }) + (presentation.suffix ?? "");
    }
    case "eligibility": {
      const holds = v === "holds" || v === true;
      const undet = v === "undetermined";
      const className = `eligibility-pill ${undet ? "undetermined" : holds ? "holds" : "not_holds"}`;
      return (
        <span className={className}>
          {undet
            ? "Undetermined"
            : holds
              ? presentation.positiveLabel ?? "Eligible"
              : presentation.negativeLabel ?? "Not eligible"}
        </span>
      );
    }
    case "raw":
    default:
      return String(v);
  }
}

function formatTraceValue(node: TraceNode): string {
  if (node.evaluationRole === "relationPredicate") return "Evaluated per member";
  if (node.notEvaluated) return "Skipped in this run";
  const v = node.value;
  if (v === null || v === undefined) return "—";
  if (v === "holds") return "✓ holds";
  if (v === "not_holds") return "✗ does not hold";
  if (typeof v === "number") return v.toLocaleString();
  return String(v);
}

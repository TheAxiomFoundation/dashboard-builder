import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import type { DashboardSpec, TraceNode } from "@dashboard-builder/spec";
import {
  evalAst,
  parseFormula,
  toBool,
  type AstNode,
  type EvalValue,
} from "./formula";
import { axiomAppUrl, fileLegalIdOf, humanizeCitation } from "./citations";
import type { ParameterRule } from "./Dashboard";

interface Props {
  spec: DashboardSpec;
  /** legalId → trace node for every output (and recursively its dependencies). */
  traces: Record<string, TraceNode>;
  /** Builder hook to toggle exposure of an input from inside the graph.
   *  Click on an exposed input removes it; click on a default input
   *  exposes it. App.tsx's handleExposeInput implements both directions. */
  onExposeInput?: (legalId: string) => void;
  /** Builder feedback: which inputs are already user-driven. */
  exposedInputIds?: Set<string>;
  /** Builder hook to toggle whether a rule is a dashboard output.
   *  Click on a rule that's already an output demotes it; click on one
   *  that isn't promotes it. */
  onAddOutput?: (legalId: string) => void;
  /** Builder feedback: which rules are already exposed as outputs. */
  selectedOutputIds?: Set<string>;
  /** When true, show evaluated values + verdict colors. False = pure structure. */
  showValues?: boolean;
  /**
   * Parameter rules from the program graph. When a formula references a
   * bare name that resolves to one of these, the resulting node renders
   * with a hover popover showing the parameter's citation, current value
   * and a link to the Axiom app entry.
   */
  parameterRules?: ParameterRule[];
}

/**
 * Pan/zoom interactive DAG of every selected output's computation. Powered
 * by React Flow.
 *
 * Design:
 *   - Atomic inputs and sub-rules dedupe across outputs, so a shared input
 *     like `household_size` appears once and connects to every output that
 *     uses it. The graph naturally encodes the dashboard's full structure.
 *   - Sub-rule pills start *collapsed* — clicking expands them inline by
 *     replacing the pill with its formula's AST (recursive). Clicking
 *     again collapses. This makes huge programs explorable without
 *     overwhelming the user up front.
 *   - Layout via dagre; React Flow handles pan/zoom/drag, minimap, and
 *     fit-to-view controls.
 */
export function InteractiveRuleGraph({
  spec,
  traces,
  onExposeInput,
  exposedInputIds,
  onAddOutput,
  selectedOutputIds,
  showValues = false,
  parameterRules,
}: Props) {
  // Sub-rules expand inline by default — the user gets the full DAG to atomic
  // inputs out of the box. They can collapse any sub-rule to hide its
  // internals; we track those user-collapses in the `collapsed` set rather
  // than the inverse.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // "wires": collapse operator boxes — atomic inputs connect directly to
  //   the sub-rule or output that consumes them. Cleanest overview, and
  //   the default since most users care about structure first.
  // "operators": full graph with every AND / + / IF / count_where node
  //   visible — opt-in for when the user wants to inspect arithmetic.
  const [detail, setDetail] = useState<"operators" | "wires">("wires");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // When the user hovers any node, dim everything that isn't part of its
  // lineage (ancestors that feed into it + descendants it feeds). For a
  // mathematical operator that means "the boxes it pertains to"; for an
  // intermediate variable that means the chain on both sides.
  const [highlightNodeId, setHighlightNodeId] = useState<string | null>(null);

  // Track Fullscreen API state so the toggle reflects reality (user may
  // press Esc, click outside, etc.).
  useEffect(() => {
    const handler = () => {
      setIsFullscreen(document.fullscreenElement === wrapRef.current);
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!wrapRef.current) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void wrapRef.current.requestFullscreen();
    }
  }, []);

  const toggleCollapse = useCallback((legalId: string) => {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(legalId)) next.delete(legalId);
      else next.add(legalId);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    // Best-effort: collapse every rule mentioned in the trace tree. Computed
    // each time so it reflects the current spec/trace.
    const all = new Set<string>();
    for (const t of Object.values(traces)) {
      collectRuleIds(t, all);
    }
    setCollapsed(all);
  }, [traces]);

  const expandAll = useCallback(() => setCollapsed(new Set()), []);

  const canExposeInputs = !!onExposeInput;
  const canToggleOutputs = !!onAddOutput;
  const { nodes, edges } = useMemo(
    () =>
      buildGraph(
        spec,
        traces,
        collapsed,
        exposedInputIds,
        showValues,
        detail,
        canExposeInputs,
        parameterRules,
        selectedOutputIds,
        canToggleOutputs,
      ),
    [
      spec,
      traces,
      collapsed,
      exposedInputIds,
      showValues,
      detail,
      canExposeInputs,
      parameterRules,
      selectedOutputIds,
      canToggleOutputs,
    ],
  );

  // Pre-compute the incoming and outgoing edge maps once per build. We use
  // these to BFS both directions from any hovered node and find its full
  // lineage (ancestors that contribute + descendants it feeds).
  const adjacency = useMemo(() => {
    const incoming = new Map<string, string[]>();
    const outgoing = new Map<string, string[]>();
    for (const e of edges) {
      if (!incoming.has(e.target)) incoming.set(e.target, []);
      incoming.get(e.target)!.push(e.source);
      if (!outgoing.has(e.source)) outgoing.set(e.source, []);
      outgoing.get(e.source)!.push(e.target);
    }
    return { incoming, outgoing };
  }, [edges]);

  // Fast id → kind lookup for the lineage walker.
  const kindById = useMemo(() => {
    const m = new Map<string, IrgNodeData["kind"]>();
    for (const n of nodes) m.set(n.id, (n.data as IrgNodeData).kind);
    return m;
  }, [nodes]);

  // Highlighted set for the currently-hovered node.
  //   - Math operators (AND/+/IF/=): "the boxes it pertains to" — nearest
  //     variables on each side. Chained operators are walked through
  //     transparently so the highlight reaches actual semantic inputs and
  //     consumers, not just plumbing.
  //   - Inputs and intermediate variables (sub-rules): only the
  //     downstream chain — every rule/output the variable flows into.
  //     Lets the user trace "where does this contribute?" without
  //     pulling in the upstream definition (which is shown when the
  //     rule itself is expanded inline).
  //   - Outputs: ancestors (the only meaningful direction — outputs
  //     have nothing downstream).
  const highlightSet = useMemo(() => {
    if (!highlightNodeId) return null;
    const startKind = kindById.get(highlightNodeId);
    if (!startKind) return null;

    const seen = new Set<string>([highlightNodeId]);
    const walkAll = (start: string, adj: Map<string, string[]>) => {
      const queue = [start];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const next of adj.get(cur) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
    };

    if (startKind === "operator" || startKind === "ifGate") {
      const isPassthrough = (k: IrgNodeData["kind"] | undefined) =>
        k === "operator" || k === "ifGate";
      const walkThrough = (start: string, adj: Map<string, string[]>) => {
        const queue = [start];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          for (const next of adj.get(cur) ?? []) {
            if (seen.has(next)) continue;
            seen.add(next);
            if (isPassthrough(kindById.get(next))) queue.push(next);
            // else: variable — included, but we don't recurse past it.
          }
        }
      };
      walkThrough(highlightNodeId, adjacency.incoming);
      walkThrough(highlightNodeId, adjacency.outgoing);
      return seen;
    }

    if (startKind === "input") {
      // Inputs flow rightward — descendants are the only meaningful chain.
      walkAll(highlightNodeId, adjacency.outgoing);
      return seen;
    }

    // Outputs and intermediate sub-rules: ancestors only — the chain
    // that contributes to the hovered node.
    walkAll(highlightNodeId, adjacency.incoming);
    return seen;
  }, [highlightNodeId, adjacency, kindById]);

  // Apply the highlight by tagging each node and edge with a className
  // reflecting whether it's on the lineage. CSS handles the dim/emphasize
  // transitions so this re-render is cheap.
  const displayNodes = useMemo(() => {
    if (!highlightSet) return nodes;
    return nodes.map((n) => ({
      ...n,
      className: highlightSet.has(n.id) ? "irg-rf-on-path" : "irg-rf-dimmed",
    }));
  }, [nodes, highlightSet]);

  const displayEdges = useMemo(() => {
    if (!highlightSet) return edges;
    return edges.map((e) => {
      const lit = highlightSet.has(e.source) && highlightSet.has(e.target);
      return {
        ...e,
        className: `${e.className ?? ""} ${lit ? "irg-rf-on-path" : "irg-rf-dimmed"}`.trim(),
      };
    });
  }, [edges, highlightSet]);

  return (
    <div ref={wrapRef} className={`irg-wrap ${isFullscreen ? "irg-fullscreen" : ""}`}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.2, minZoom: 0.3, maxZoom: 1.4 }}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          connectionLineType={ConnectionLineType.SmoothStep}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          onNodeMouseEnter={(_e, node) => {
            const kind = (node.data as IrgNodeData).kind;
            // Literals (raw numbers) aren't useful to highlight from — they
            // appear in many unrelated places and would light up half the
            // graph at once.
            if (kind !== "literal") setHighlightNodeId(node.id);
          }}
          onNodeMouseLeave={() => setHighlightNodeId(null)}
          onNodeClick={(e, node) => {
            const data = node.data as IrgNodeData;
            const target = e.target as HTMLElement;
            // Each action row tags itself with data-action; we route the
            // click to the right handler based on which row was hit. This
            // matters now that rule nodes stack two action rows.
            const actionEl = target.closest(".irg-action") as HTMLElement | null;
            const action = actionEl?.dataset.action;
            if (data.kind === "input" && onExposeInput && actionEl) {
              onExposeInput(data.legalId);
              return;
            }
            if (data.kind === "ruleRef") {
              if (action === "output" && onAddOutput) {
                onAddOutput(data.legalId);
                return;
              }
              if (action === "collapse" && data.canExpand) {
                toggleCollapse(data.legalId);
                return;
              }
            }
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#e7e5e4" />
          <MiniMap
            nodeColor={(n) => miniMapColor(n.data as IrgNodeData)}
            nodeStrokeColor={(n) => miniMapColor(n.data as IrgNodeData)}
            nodeBorderRadius={2}
            pannable
            zoomable
            position="bottom-right"
            style={{ background: "var(--color-paper-elevated)", border: "1px solid var(--color-rule)" }}
          />
          <Controls position="bottom-left" showInteractive={false} />
        </ReactFlow>
        <div className="irg-toolbar">
          <div className="irg-toolbar-segment" role="tablist" aria-label="Detail level">
            <button
              type="button"
              className={`irg-toolbar-btn ${detail === "operators" ? "is-active" : ""}`}
              onClick={() => setDetail("operators")}
              role="tab"
              aria-selected={detail === "operators"}
              title="Show operators (AND, OR, IF, comparisons, arithmetic)"
            >
              Operators
            </button>
            <button
              type="button"
              className={`irg-toolbar-btn ${detail === "wires" ? "is-active" : ""}`}
              onClick={() => setDetail("wires")}
              role="tab"
              aria-selected={detail === "wires"}
              title="Hide operators — show only inputs, sub-rules, outputs and the wires between them"
            >
              Wires only
            </button>
          </div>
          <button
            type="button"
            className="irg-toolbar-btn"
            onClick={expandAll}
            title="Expand every sub-rule inline"
          >
            Expand all
          </button>
          <button
            type="button"
            className="irg-toolbar-btn"
            onClick={collapseAll}
            title="Collapse every sub-rule into a clickable terminal"
          >
            Collapse all
          </button>
        </div>
        <button
          type="button"
          className="irg-fullscreen-btn"
          onClick={toggleFullscreen}
          title={isFullscreen ? "Exit full screen (Esc)" : "Enter full screen"}
          aria-label={isFullscreen ? "Exit full screen" : "Enter full screen"}
        >
          {isFullscreen ? (
            // collapse glyph
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path
                d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            // expand glyph
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path
                d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
      </ReactFlowProvider>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Node data + components
// ─────────────────────────────────────────────────────────────────────────

interface NodeMeta {
  /** Short kind line: "Output · money", "Input · boolean", "Rule · judgment" */
  kindLine: string;
  /** Humanized citation, e.g. "10 CCR 2506-1 § 4.207.3 (Colorado)". */
  citation?: string;
  /** Full legal ID (mono, small) so power users can grep. */
  legalId: string;
  /** Deep link into the Axiom app's regulation viewer, if resolvable. */
  appUrl?: string | null;
  /** For rules: a one-liner of the rule's formula (truncated) so the user
   *  gets the "what does this compute" without expanding. */
  formulaPreview?: string;
}

type IrgNodeData =
  | {
      kind: "output";
      label: string;
      verdictCls: string;
      value: string;
      showValues: boolean;
      meta: NodeMeta;
    }
  | {
      kind: "input";
      label: string;
      legalId: string;
      source: "user" | "default";
      canExpose: boolean;
      value: string;
      showValues: boolean;
      meta: NodeMeta;
    }
  | {
      kind: "operator";
      label: string;
      verdictCls: string;
      value: string;
      showValues: boolean;
    }
  | {
      kind: "ifGate";
      label: string;
      verdictCls: string;
      branchLabel: string;
      value: string;
      showValues: boolean;
    }
  | {
      kind: "ruleRef";
      label: string;
      legalId: string;
      canExpand: boolean;
      /** True when the parent passed onAddOutput — enables the
       *  "+ OUTPUT" / "− OUTPUT" affordance on rule nodes. */
      canToggleOutput: boolean;
      /** Whether the rule is currently selected as a dashboard output. */
      isOutput: boolean;
      verdictCls: string;
      value: string;
      isExpanded: boolean;
      showValues: boolean;
      meta: NodeMeta;
    }
  | {
      kind: "literal";
      label: string;
    }
  | {
      kind: "unknown";
      label: string;
      /** Set when the unknown identifier resolves to a parameter rule —
       *  enables the hover popover with citation/value/Axiom link. */
      meta?: NodeMeta;
    };

/** Inputs only emit edges (rightward), so they don't need a target handle. */
const HandleSource = () => (
  <Handle type="source" position={Position.Right} className="irg-handle" />
);
/** Outputs only receive edges (from the left); no source handle. */
const HandleTarget = () => (
  <Handle type="target" position={Position.Left} className="irg-handle" />
);
/** Intermediate nodes both receive and emit. */
const HandleBoth = () => (
  <>
    <Handle type="target" position={Position.Left} className="irg-handle" />
    <Handle type="source" position={Position.Right} className="irg-handle" />
  </>
);

/**
 * Hover popover that reveals the node's citation, legal ID and a link to
 * read the underlying statute/regulation in the Axiom app.
 *
 * Visibility is driven by React state with a small leave-delay so the
 * user can move their cursor from the node to the popover (and click the
 * link) without the popover snapping shut. The popover is rendered into
 * a portal anchored to document.body — React Flow's container has
 * overflow:hidden for pan/zoom, which would otherwise clip popovers on
 * nodes near the canvas edge.
 */
function useHoverPopover() {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<number | null>(null);
  const enter = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setOpen(true);
  }, []);
  const leave = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setOpen(false);
      timerRef.current = null;
    }, 220);
  }, []);
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);
  return { open, enter, leave };
}

const POPOVER_WIDTH = 280;
const POPOVER_GAP = 8;

const NodeInfo = ({
  meta,
  title,
  open,
  anchorRef,
  onEnter,
  onLeave,
}: {
  meta: NodeMeta;
  title: string;
  open: boolean;
  anchorRef: React.RefObject<HTMLDivElement>;
  onEnter: () => void;
  onLeave: () => void;
}) => {
  // Position relative to the node element. Re-measured each open and on
  // window scroll/resize so we don't drift if the user pans the canvas.
  const [pos, setPos] = useState<{ left: number; top: number; place: "above" | "below" } | null>(
    null,
  );
  // Portal into the current fullscreen element when one is active —
  // otherwise document.body is hidden and the popover wouldn't render at
  // all. Listening to `fullscreenchange` keeps the target current as the
  // user toggles in/out without re-opening the popover.
  const [portalTarget, setPortalTarget] = useState<HTMLElement>(
    () => (document.fullscreenElement as HTMLElement | null) ?? document.body,
  );
  useEffect(() => {
    const sync = () => {
      setPortalTarget(
        (document.fullscreenElement as HTMLElement | null) ?? document.body,
      );
    };
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const measure = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      // Default above; flip below if there isn't enough room (so popovers
      // on top-of-viewport nodes don't get clipped offscreen).
      const place: "above" | "below" =
        rect.top > 220 || rect.bottom + 220 > window.innerHeight ? "above" : "below";
      const top = place === "above" ? rect.top - POPOVER_GAP : rect.bottom + POPOVER_GAP;
      // Clamp horizontally so the popover never overflows the viewport.
      const halfW = POPOVER_WIDTH / 2;
      const left = Math.max(halfW + 8, Math.min(window.innerWidth - halfW - 8, centerX));
      setPos({ left, top, place });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, anchorRef]);

  if (!open || !pos) return null;
  return createPortal(
    <div
      className={`irg-popover irg-popover-${pos.place}`}
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="irg-pop-eyebrow">{meta.kindLine}</div>
      <div className="irg-pop-title">{softBreak(title)}</div>
      {meta.formulaPreview && (
        <div className="irg-pop-formula">{meta.formulaPreview}</div>
      )}
      {meta.citation && <div className="irg-pop-cite">{meta.citation}</div>}
      {meta.appUrl && (
        <a
          className="irg-pop-link"
          href={meta.appUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open in Axiom app ↗
        </a>
      )}
    </div>,
    portalTarget,
  );
};

/**
 * Insert zero-width spaces after `_` and `.` so the browser breaks
 * snake_case / dotted identifiers at semantic boundaries instead of
 * shearing through the middle of a word. Each token is still selectable
 * and copies cleanly (ZWSPs are stripped by most clipboard targets).
 */
function softBreak(s: string): string {
  return s.replace(/([_.])/g, "$1​");
}

/**
 * Tiny "ⓘ" badge anchored to the node's top-right corner. Hovering or
 * focusing it opens the popover; the box itself stays clean so the user
 * can drag/click without accidental popovers cluttering every motion.
 */
const InfoBadge = ({
  open,
  onEnter,
  onLeave,
}: {
  open: boolean;
  onEnter: () => void;
  onLeave: () => void;
}) => (
  <button
    type="button"
    className={`irg-info-badge ${open ? "is-open" : ""}`}
    aria-label="Show details"
    onMouseEnter={onEnter}
    onMouseLeave={onLeave}
    onFocus={onEnter}
    onBlur={onLeave}
    onClick={(e) => e.stopPropagation()}
    tabIndex={-1}
  >
    i
  </button>
);

const OutputNode = ({ data }: NodeProps) => {
  const d = data as Extract<IrgNodeData, { kind: "output" }>;
  const pop = useHoverPopover();
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className={`irg-node irg-output ${d.showValues ? d.verdictCls : "irg-neutral"}`}
    >
      <HandleTarget />
      <InfoBadge open={pop.open} onEnter={pop.enter} onLeave={pop.leave} />
      <div className="irg-eyebrow">Output</div>
      <div className="irg-label">{softBreak(d.label)}</div>
      {d.showValues && d.value && <div className="irg-value">{d.value}</div>}
      <NodeInfo
        meta={d.meta}
        title={d.label}
        open={pop.open}
        anchorRef={ref}
        onEnter={pop.enter}
        onLeave={pop.leave}
      />
    </div>
  );
};

const InputNode = ({ data }: NodeProps) => {
  const d = data as Extract<IrgNodeData, { kind: "input" }>;
  const status = d.source === "user" ? "selected" : "not selected";
  const pop = useHoverPopover();
  const ref = useRef<HTMLDivElement>(null);
  // Affordance shows when the parent wired up onExposeInput (Step III).
  // Action label flips with the current state — same hook toggles both
  // ways via App.tsx's handleExposeInput.
  const showAction = d.canExpose || d.source === "user";
  return (
    <div
      ref={ref}
      className={`irg-node irg-input irg-input-${d.source} ${d.canExpose ? "irg-can-expose" : ""}`}
    >
      <HandleSource />
      <InfoBadge open={pop.open} onEnter={pop.enter} onLeave={pop.leave} />
      <div className="irg-eyebrow">
        Input · <span className={`irg-status irg-status-${d.source}`}>{status}</span>
      </div>
      <div className="irg-label">{softBreak(d.label)}</div>
      {d.showValues && d.value && <div className="irg-value">{d.value}</div>}
      {showAction && (
        <div className="irg-action irg-action-clickable">
          {d.source === "user" ? "− remove" : "+ expose"}
        </div>
      )}
      <NodeInfo
        meta={d.meta}
        title={d.label}
        open={pop.open}
        anchorRef={ref}
        onEnter={pop.enter}
        onLeave={pop.leave}
      />
    </div>
  );
};

const OperatorNode = ({ data }: NodeProps) => {
  const d = data as Extract<IrgNodeData, { kind: "operator" }>;
  return (
    <div className={`irg-node irg-operator ${d.showValues ? d.verdictCls : "irg-neutral"}`}>
      <HandleBoth />
      <div className="irg-op-label">{d.label}</div>
      {d.showValues && d.value && <div className="irg-value">{d.value}</div>}
    </div>
  );
};

const IfGateNode = ({ data }: NodeProps) => {
  const d = data as Extract<IrgNodeData, { kind: "ifGate" }>;
  return (
    <div className={`irg-node irg-ifgate ${d.showValues ? d.verdictCls : "irg-neutral"}`}>
      <HandleBoth />
      <div className="irg-op-label">IF</div>
      {d.showValues && d.branchLabel && <div className="irg-eyebrow">{d.branchLabel}</div>}
      {d.showValues && d.value && <div className="irg-value">{d.value}</div>}
    </div>
  );
};

const RuleRefNode = ({ data }: NodeProps) => {
  const d = data as Extract<IrgNodeData, { kind: "ruleRef" }>;
  const pop = useHoverPopover();
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className={`irg-node irg-rule ${d.showValues ? d.verdictCls : "irg-neutral"} ${d.canExpand ? "irg-can-expand" : ""} ${d.isOutput ? "irg-rule-output" : ""}`}
    >
      <HandleBoth />
      <InfoBadge open={pop.open} onEnter={pop.enter} onLeave={pop.leave} />
      <div className="irg-eyebrow">{d.isOutput ? "Rule · output" : "Rule"}</div>
      <div className="irg-label">{softBreak(d.label)}</div>
      {d.showValues && d.value && <div className="irg-value">{d.value}</div>}
      {d.canToggleOutput && (
        <div
          className="irg-action irg-action-clickable"
          data-action="output"
        >
          {d.isOutput ? "− output" : "+ output"}
        </div>
      )}
      {d.canExpand && (
        <div
          className="irg-action irg-action-secondary irg-action-clickable"
          data-action="collapse"
        >
          {d.isExpanded ? "− collapse" : "+ expand"}
        </div>
      )}
      <NodeInfo
        meta={d.meta}
        title={d.label}
        open={pop.open}
        anchorRef={ref}
        onEnter={pop.enter}
        onLeave={pop.leave}
      />
    </div>
  );
};

const LiteralNode = ({ data }: NodeProps) => {
  const d = data as Extract<IrgNodeData, { kind: "literal" }>;
  return (
    <div className="irg-node irg-literal">
      <HandleSource />
      {d.label}
    </div>
  );
};

const UnknownNode = ({ data }: NodeProps) => {
  const d = data as Extract<IrgNodeData, { kind: "unknown" }>;
  const pop = useHoverPopover();
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="irg-node irg-unknown">
      <HandleSource />
      {d.meta && (
        <InfoBadge open={pop.open} onEnter={pop.enter} onLeave={pop.leave} />
      )}
      <div className="irg-eyebrow">Parameter</div>
      <div className="irg-label">{softBreak(d.label)}</div>
      {d.meta && (
        <NodeInfo
          meta={d.meta}
          title={d.label}
          open={pop.open}
          anchorRef={ref}
          onEnter={pop.enter}
          onLeave={pop.leave}
        />
      )}
    </div>
  );
};

const NODE_TYPES = {
  output: OutputNode,
  input: InputNode,
  operator: OperatorNode,
  ifGate: IfGateNode,
  ruleRef: RuleRefNode,
  literal: LiteralNode,
  unknown: UnknownNode,
};

function miniMapColor(d: IrgNodeData): string {
  switch (d.kind) {
    case "output": return "#1c1917";
    case "input": return d.source === "user" ? "#166534" : "#b45309";
    case "ruleRef": return "#92400e";
    case "ifGate": return "#92400e";
    case "operator": return "#92400e";
    case "literal": return "#e7e5e4";
    default: return "#a8a29e";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Graph construction
// ─────────────────────────────────────────────────────────────────────────

interface BuildResult {
  nodes: Node[];
  edges: Edge[];
}

function buildGraph(
  spec: DashboardSpec,
  traces: Record<string, TraceNode>,
  collapsed: Set<string>,
  exposedInputIds: Set<string> | undefined,
  showValues: boolean,
  detail: "operators" | "wires" = "operators",
  canExposeInputs: boolean = false,
  parameterRules?: ParameterRule[],
  selectedOutputIds?: Set<string>,
  canToggleOutputs: boolean = false,
): BuildResult {
  // Index parameter rules by bare name so the formula walker can resolve
  // identifiers that aren't in the trace (parameters get inlined as
  // constants by the engine and don't appear as trace nodes).
  const parametersByName = new Map<string, ParameterRule>();
  for (const p of parameterRules ?? []) parametersByName.set(p.name, p);
  // Recursively flatten the trace tree into a lookup so we can resolve any
  // sub-rule reference no matter how deep it appears.
  const traceByLegalId = flattenTrace(traces);
  // Build by-name index for the formula parser's identifiers (rule labels +
  // input bare names → trace node).
  const byName = new Map<string, TraceNode>();
  for (const t of traceByLegalId.values()) {
    if (t.dtype === "input") {
      const bare = t.legalId.split("#").pop()?.replace(/^input\./, "");
      if (bare) byName.set(bare, t);
    } else if (t.label) {
      byName.set(t.label, t);
    }
  }

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const nodeIds = new Map<string, string>(); // dedup key → node id
  let counter = 0;
  const nextId = () => `n${counter++}`;

  // For each selected output, render a top-level "output" node with its
  // formula's AST as the source DAG flowing into it.
  for (const binding of spec.outputs) {
    const outputTrace = traces[binding.legalId];
    if (!outputTrace) continue;

    const outputId = `out:${binding.legalId}`;
    if (!nodeIds.has(outputId)) {
      const id = nextId();
      nodeIds.set(outputId, id);
      nodes.push({
        id,
        type: "output",
        position: { x: 0, y: 0 },
        data: {
          kind: "output",
          label: binding.label,
          verdictCls: verdictClass(outputTrace),
          value: showValues ? formatValue(outputTrace.value) : "",
          showValues,
          meta: buildMeta(outputTrace, "Output"),
        } satisfies IrgNodeData,
      });
    }

    if (outputTrace.formula) {
      const sourceId = walkExpr(
        outputTrace.formula,
        outputTrace.legalId,
        {
          nodes,
          edges,
          nodeIds,
          nextId,
          byName,
          traceByLegalId,
          collapsed,
          exposedInputIds,
          canExposeInputs,
          showValues,
          parametersByName,
          selectedOutputIds,
          canToggleOutputs,
        },
      );
      if (sourceId) {
        edges.push({
          id: `e${edges.length}`,
          source: sourceId,
          target: nodeIds.get(outputId)!,
          type: "smoothstep",
          animated: false,
          className: "irg-edge-default",
          markerEnd: { type: MarkerType.ArrowClosed, color: "#78716c" },
          style: { strokeWidth: 1.5 },
        });
      }
    }
  }

  // Stash parametersByName on the walk context — visible to walkAst's
  // ident handler when resolving names that aren't in the trace.
  // (Threaded via closure since WalkCtx is local to this scope.)
  const ctxExtras = { parametersByName };
  void ctxExtras;

  // Wires-only mode: collapse every operator/IF/literal/unknown node so the
  // graph shows only inputs, sub-rules, and outputs connected by direct
  // wires. Each removed node's incoming and outgoing edges are merged.
  if (detail === "wires") {
    const result = collapseOperators(nodes, edges);
    layout(result.nodes, result.edges);
    return result;
  }

  layout(nodes, edges);
  return { nodes, edges };
}

/**
 * Remove operator/IF/literal/unknown boxes and merge their incoming &
 * outgoing edges into direct wires from sources to targets. Edge styling
 * inherited from the outgoing edge so verdict coloring (active branch,
 * failing AND-clause, etc.) survives the collapse.
 */
function collapseOperators(nodes: Node[], edges: Edge[]): BuildResult {
  const passthroughKinds = new Set(["operator", "ifGate", "literal", "unknown"]);
  const passthroughIds = new Set(
    nodes
      .filter((n) => passthroughKinds.has((n.data as IrgNodeData).kind))
      .map((n) => n.id),
  );

  if (passthroughIds.size === 0) return { nodes, edges };

  // Build adjacency: for each node, its incoming and outgoing edges.
  const inByNode = new Map<string, Edge[]>();
  const outByNode = new Map<string, Edge[]>();
  for (const e of edges) {
    if (!inByNode.has(e.target)) inByNode.set(e.target, []);
    inByNode.get(e.target)!.push(e);
    if (!outByNode.has(e.source)) outByNode.set(e.source, []);
    outByNode.get(e.source)!.push(e);
  }

  // For each non-passthrough source, follow its outgoing edges; if a target
  // is a passthrough, recursively follow that passthrough's outgoing edges
  // until we hit a non-passthrough target. Build a new edge from source →
  // that target, inheriting styling from the LAST edge in the chain (the one
  // closest to the surviving target — that's where verdict coloring lives).
  const newEdges: Edge[] = [];
  const seenEdgeKey = new Set<string>();

  function reach(nodeId: string, lastStyledEdge: Edge): Array<{ target: string; styled: Edge }> {
    if (!passthroughIds.has(nodeId)) {
      return [{ target: nodeId, styled: lastStyledEdge }];
    }
    const downstream = outByNode.get(nodeId) ?? [];
    const out: Array<{ target: string; styled: Edge }> = [];
    for (const next of downstream) {
      // The next edge's styling overrides if it has verdict-related class.
      const styled = chooseStyled(lastStyledEdge, next);
      out.push(...reach(next.target, styled));
    }
    return out;
  }

  for (const e of edges) {
    if (passthroughIds.has(e.source)) continue; // covered when its parent is processed
    const reaches = reach(e.target, e);
    for (const r of reaches) {
      const key = `${e.source}->${r.target}`;
      if (seenEdgeKey.has(key)) continue;
      seenEdgeKey.add(key);
      newEdges.push({
        ...r.styled,
        id: `wire-${newEdges.length}`,
        source: e.source,
        target: r.target,
        // Drop labels — they referred to the operator that's now gone.
        label: undefined,
      });
    }
  }

  const survivingNodes = nodes.filter((n) => !passthroughIds.has(n.id));
  return { nodes: survivingNodes, edges: newEdges };
}

/** Pick the more-meaningful of two edges' styling (verdict-coloured wins). */
function chooseStyled(a: Edge, b: Edge): Edge {
  const score = (e: Edge): number => {
    const c = e.className ?? "";
    if (c.includes("pass")) return 3;
    if (c.includes("fail")) return 3;
    if (c.includes("dim")) return 2;
    return 1;
  };
  return score(b) >= score(a) ? b : a;
}

interface WalkCtx {
  nodes: Node[];
  edges: Edge[];
  nodeIds: Map<string, string>;
  nextId: () => string;
  byName: Map<string, TraceNode>;
  traceByLegalId: Map<string, TraceNode>;
  /** Sub-rule legal IDs the user has manually collapsed. Defaults: every rule expanded. */
  collapsed: Set<string>;
  exposedInputIds: Set<string> | undefined;
  /** True when the parent passed an onExposeInput callback (Step III only). */
  canExposeInputs: boolean;
  showValues: boolean;
  /** Parameter rules from the program graph, indexed by bare name. Used
   *  to enrich "unknown" nodes with citation + value when the formula
   *  references a parameter the engine inlined as a constant. */
  parametersByName: Map<string, ParameterRule>;
  /** Rule legal IDs already exposed as dashboard outputs — drives the
   *  "− OUTPUT" affordance on rule nodes. */
  selectedOutputIds: Set<string> | undefined;
  /** True when the parent passed an onAddOutput callback (Step II). */
  canToggleOutputs: boolean;
}

/**
 * Render a parsed formula expression as nodes/edges, returning the id of
 * the node that this expression's value emerges from.
 *
 * `parentScope` is the legalId of the rule whose formula we're rendering —
 * used to differentiate per-rule operator instances (so two `+` from
 * different rules don't accidentally dedupe).
 */
function walkExpr(formula: string, parentScope: string, ctx: WalkCtx): string | null {
  const ast = parseFormula(formula);
  if (ast.kind === "error") return null;
  return walkAst(ast, parentScope, `${parentScope}::root`, ctx);
}

function walkAst(node: AstNode, parentScope: string, opPath: string, ctx: WalkCtx): string {
  const lookupValue = (name: string): EvalValue => {
    const t = ctx.byName.get(name);
    if (!t) return null;
    return t.value as EvalValue;
  };

  switch (node.kind) {
    case "ident": {
      const t = ctx.byName.get(node.name);
      if (!t) {
        // Name doesn't resolve to a traced rule/input — try parameter
        // lookup so the user gets rich hover info on policy parameters.
        const param = ctx.parametersByName.get(node.name);
        const dedupKey = `unknown:${parentScope}:${node.name}`;
        return ensureNode(ctx, dedupKey, {
          type: "unknown",
          data: {
            kind: "unknown",
            label: node.name,
            meta: param ? buildParameterMeta(param) : undefined,
          } satisfies IrgNodeData,
        });
      }
      if (t.dtype === "input") {
        const exposed = ctx.exposedInputIds?.has(t.legalId) ?? t.inputSource === "user";
        const dedupKey = `input:${t.legalId}`;
        // Robust label fallback: t.label → formula token → bare legal-id
        // suffix (after `#input.` or `#relation.`). Guarantees the box is
        // never empty even if the engine omits the label.
        const fallback = t.legalId
          .split("#")
          .pop()
          ?.replace(/^input\./, "")
          .replace(/^relation\./, "") ?? node.name;
        const label = (t.label && t.label.trim()) || node.name || fallback || "(unnamed)";
        // Only advertise "+ expose" when the builder actually wired a
        // handler. Otherwise the affordance lies.
        const canExpose = !exposed && ctx.canExposeInputs;
        return ensureNode(ctx, dedupKey, {
          type: "input",
          data: {
            kind: "input",
            label,
            legalId: t.legalId,
            source: exposed ? "user" : "default",
            canExpose,
            value: ctx.showValues ? formatValue(t.value) : "",
            showValues: ctx.showValues,
            meta: buildMeta(t, "Input"),
          } satisfies IrgNodeData,
        });
      }
      // Sub-rule reference. By default render its formula's AST inline; the
      // rule pill is the "result" node. User can collapse the rule to hide
      // its internals and click again to re-expand.
      const isExpanded = !ctx.collapsed.has(t.legalId);
      const ruleNodeKey = `rule:${t.legalId}`;
      const isOutput = ctx.selectedOutputIds?.has(t.legalId) ?? false;
      const ruleNodeId = ensureNode(ctx, ruleNodeKey, {
        type: "ruleRef",
        data: {
          kind: "ruleRef",
          label: t.label || node.name,
          legalId: t.legalId,
          canExpand: Boolean(t.formula),
          canToggleOutput: ctx.canToggleOutputs,
          isOutput,
          verdictCls: verdictClass(t),
          value: ctx.showValues ? formatValue(t.value) : "",
          isExpanded,
          showValues: ctx.showValues,
          meta: buildMeta(t, "Rule"),
        } satisfies IrgNodeData,
      });
      if (isExpanded && t.formula) {
        const inlineSource = walkExpr(t.formula, t.legalId, ctx);
        if (inlineSource) {
          // Connect the expanded sub-rule's AST to the rule node so the
          // reader sees its internals flowing in.
          const edgeId = `e${ctx.edges.length}`;
          if (!ctx.edges.find((e) => e.id === edgeId && e.source === inlineSource && e.target === ruleNodeId)) {
            ctx.edges.push({ id: edgeId, source: inlineSource, target: ruleNodeId, type: "smoothstep" });
          }
        }
      }
      return ruleNodeId;
    }

    case "number":
    case "bool": {
      const text = String(node.kind === "number" ? node.value : node.value);
      const dedupKey = `lit:${opPath}:${text}`;
      return ensureNode(ctx, dedupKey, {
        type: "literal",
        data: { kind: "literal", label: text } satisfies IrgNodeData,
      });
    }

    case "logical": {
      const op = node.op;
      const operands = flattenLogical(node, op);
      const operandValues = operands.map((o) => evalAst(o, lookupValue));
      const value = evalAst(node, lookupValue);
      const verdictCls = verdictClassOfBool(value);
      const decisive =
        op === "and"
          ? (v: EvalValue) => v !== null && !toBool(v)
          : (v: EvalValue) => v !== null && toBool(v);
      const myKey = `op:${parentScope}:${opPath}:${op}`;
      const myId = ensureNode(ctx, myKey, {
        type: "operator",
        data: {
          kind: "operator",
          label: op.toUpperCase(),
          verdictCls,
          value: ctx.showValues ? formatValue(value) : "",
          showValues: ctx.showValues,
        } satisfies IrgNodeData,
      });
      operands.forEach((child, i) => {
        const childId = walkAst(child, parentScope, `${opPath}/${op}[${i}]`, ctx);
        const cls =
          ctx.showValues && decisive(operandValues[i] ?? null)
            ? op === "and"
              ? "fail"
              : "pass"
            : "";
        addEdge(ctx, childId, myId, cls);
      });
      return myId;
    }

    case "comparison": {
      const value = evalAst(node, lookupValue);
      const verdictCls = verdictClassOfBool(value);
      const myKey = `op:${parentScope}:${opPath}:${node.op}`;
      const myId = ensureNode(ctx, myKey, {
        type: "operator",
        data: {
          kind: "operator",
          label: node.op,
          verdictCls,
          value: ctx.showValues ? formatValue(value) : "",
          showValues: ctx.showValues,
        } satisfies IrgNodeData,
      });
      const lid = walkAst(node.left, parentScope, `${opPath}/cmp.l`, ctx);
      const rid = walkAst(node.right, parentScope, `${opPath}/cmp.r`, ctx);
      addEdge(ctx, lid, myId, "");
      addEdge(ctx, rid, myId, "");
      return myId;
    }

    case "arith": {
      const value = evalAst(node, lookupValue);
      const operands =
        node.op === "+" || node.op === "*" ? flattenArith(node, node.op) : [node.left, node.right];
      const myKey = `op:${parentScope}:${opPath}:${node.op}`;
      const myId = ensureNode(ctx, myKey, {
        type: "operator",
        data: {
          kind: "operator",
          label: node.op,
          verdictCls: "rg-numeric",
          value: ctx.showValues ? formatValue(value) : "",
          showValues: ctx.showValues,
        } satisfies IrgNodeData,
      });
      operands.forEach((child, i) => {
        const cid = walkAst(child, parentScope, `${opPath}/${node.op}[${i}]`, ctx);
        addEdge(ctx, cid, myId, "");
      });
      return myId;
    }

    case "unary": {
      const value = evalAst(node, lookupValue);
      const label = node.op === "not" ? "NOT" : "−";
      const verdictCls = node.op === "not" ? verdictClassOfBool(value) : "rg-numeric";
      const myKey = `op:${parentScope}:${opPath}:${node.op}`;
      const myId = ensureNode(ctx, myKey, {
        type: "operator",
        data: {
          kind: "operator",
          label,
          verdictCls,
          value: ctx.showValues ? formatValue(value) : "",
          showValues: ctx.showValues,
        } satisfies IrgNodeData,
      });
      const cid = walkAst(node.operand, parentScope, `${opPath}/u`, ctx);
      addEdge(ctx, cid, myId, "");
      return myId;
    }

    case "call": {
      const value = evalAst(node, lookupValue);
      const cls = ["any", "all"].includes(node.name) ? verdictClassOfBool(value) : "rg-numeric";
      const myKey = `op:${parentScope}:${opPath}:call:${node.name}`;
      const myId = ensureNode(ctx, myKey, {
        type: "operator",
        data: {
          kind: "operator",
          label: node.name,
          verdictCls: cls,
          value: ctx.showValues ? formatValue(value) : "",
          showValues: ctx.showValues,
        } satisfies IrgNodeData,
      });
      node.args.forEach((arg, i) => {
        const cid = walkAst(arg, parentScope, `${opPath}/call[${i}]`, ctx);
        addEdge(ctx, cid, myId, "");
      });
      return myId;
    }

    case "index": {
      const myKey = `op:${parentScope}:${opPath}:index`;
      const myId = ensureNode(ctx, myKey, {
        type: "operator",
        data: {
          kind: "operator",
          label: "table[i]",
          verdictCls: "rg-numeric",
          value: "",
          showValues: ctx.showValues,
        } satisfies IrgNodeData,
      });
      const tid = walkAst(node.target, parentScope, `${opPath}/idx.t`, ctx);
      const iid = walkAst(node.index, parentScope, `${opPath}/idx.i`, ctx);
      addEdge(ctx, tid, myId, "");
      addEdge(ctx, iid, myId, "");
      return myId;
    }

    case "ifElse": {
      const condValue = evalAst(node.cond, lookupValue);
      const value = evalAst(node, lookupValue);
      const condTrue = condValue !== null && toBool(condValue);
      const verdictCls = verdictClassOfBool(value);
      const myKey = `op:${parentScope}:${opPath}:if`;
      const myId = ensureNode(ctx, myKey, {
        type: "ifGate",
        data: {
          kind: "ifGate",
          label: "IF",
          verdictCls,
          branchLabel:
            condValue === null ? "" : condTrue ? "→ then" : "→ else",
          value: ctx.showValues ? formatValue(value) : "",
          showValues: ctx.showValues,
        } satisfies IrgNodeData,
      });
      const cid = walkAst(node.cond, parentScope, `${opPath}/cond`, ctx);
      const tid = walkAst(node.then, parentScope, `${opPath}/then`, ctx);
      const eid = walkAst(node.else_, parentScope, `${opPath}/else`, ctx);
      addEdgeWithLabel(ctx, cid, myId, "test", ctx.showValues ? "" : "");
      addEdgeWithLabel(
        ctx,
        tid,
        myId,
        "if true",
        ctx.showValues
          ? condValue === null
            ? ""
            : condTrue
              ? "pass"
              : "dim"
          : "",
      );
      addEdgeWithLabel(
        ctx,
        eid,
        myId,
        "if false",
        ctx.showValues
          ? condValue === null
            ? ""
            : condTrue
              ? "dim"
              : "pass"
          : "",
      );
      return myId;
    }

    case "error":
      return ensureNode(ctx, `err:${opPath}`, {
        type: "unknown",
        data: { kind: "unknown", label: node.text } satisfies IrgNodeData,
      });
  }
}

function ensureNode(
  ctx: WalkCtx,
  dedupKey: string,
  spec: { type: keyof typeof NODE_TYPES; data: IrgNodeData },
): string {
  if (ctx.nodeIds.has(dedupKey)) return ctx.nodeIds.get(dedupKey)!;
  const id = ctx.nextId();
  ctx.nodeIds.set(dedupKey, id);
  ctx.nodes.push({
    id,
    type: spec.type,
    position: { x: 0, y: 0 },
    data: spec.data,
  });
  return id;
}

function addEdge(ctx: WalkCtx, source: string, target: string, cls: string) {
  // Dedup edges by (source, target).
  if (ctx.edges.find((e) => e.source === source && e.target === target)) return;
  const id = `e${ctx.edges.length}`;
  ctx.edges.push({
    id,
    source,
    target,
    type: "smoothstep",
    className: edgeClass(cls),
    markerEnd: { type: MarkerType.ArrowClosed, color: edgeColorVar(cls) },
    style: { strokeWidth: cls === "pass" || cls === "fail" ? 2 : 1.5 },
  });
}

function addEdgeWithLabel(
  ctx: WalkCtx,
  source: string,
  target: string,
  label: string,
  cls: string,
) {
  if (ctx.edges.find((e) => e.source === source && e.target === target)) return;
  const id = `e${ctx.edges.length}`;
  ctx.edges.push({
    id,
    source,
    target,
    type: "smoothstep",
    label,
    className: edgeClass(cls),
    markerEnd: { type: MarkerType.ArrowClosed, color: edgeColorVar(cls) },
    style: { strokeWidth: cls === "pass" || cls === "fail" ? 2 : 1.5 },
    labelStyle: { fontFamily: "var(--f-mono)", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase" },
    labelBgStyle: { fill: "var(--color-paper-elevated)", stroke: "var(--color-rule)" },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 8,
  });
}

function edgeClass(cls: string): string {
  if (cls === "pass") return "irg-edge-pass";
  if (cls === "fail") return "irg-edge-fail";
  if (cls === "dim") return "irg-edge-dim";
  return "irg-edge-default";
}

function edgeColorVar(cls: string): string {
  if (cls === "pass") return "#166534";
  if (cls === "fail") return "#991b1b";
  if (cls === "dim") return "#a8a29e";
  return "#78716c";
}

// ─────────────────────────────────────────────────────────────────────────
// Layout (dagre)
// ─────────────────────────────────────────────────────────────────────────

function layout(nodes: Node[], edges: Edge[]) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 80, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    const size = nodeSize(n);
    g.setNode(n.id, size);
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  for (const n of nodes) {
    const layoutInfo = g.node(n.id);
    if (!layoutInfo) continue;
    n.position = {
      x: layoutInfo.x - layoutInfo.width / 2,
      y: layoutInfo.y - layoutInfo.height / 2,
    };
    (n as Node).width = layoutInfo.width;
    (n as Node).height = layoutInfo.height;
  }
}

/**
 * Compute the rendered size of a node so dagre can lay them out without
 * overlap. We let labels wrap rather than truncate, so we estimate how many
 * lines the label will need at the node's max width and grow the height
 * accordingly. The width stays fixed (so columns stay aligned in the LR
 * layout) but tall/wrappy labels push the box vertically.
 */
function nodeSize(n: Node): { width: number; height: number } {
  const data = n.data as IrgNodeData;
  const labelText = "label" in data ? data.label : "";
  switch (data.kind) {
    case "output":
    case "input":
    case "ruleRef":
      return labelledNodeSize(labelText, data, 220);
    case "ifGate":
      return { width: 140, height: 76 };
    case "operator":
      return { width: 110, height: 60 };
    case "literal":
      return { width: 80, height: 40 };
    case "unknown":
      return labelledNodeSize(labelText, data, 200, /* small */ true);
  }
}

/** Estimate height for a label-bearing node by guessing line wrap. */
function labelledNodeSize(
  label: string,
  data: IrgNodeData,
  width: number,
  small = false,
): { width: number; height: number } {
  // Geist Mono at 11 px with letter-spacing 0.04em renders ~7.5 px per
  // character; using 7.6 here as a conservative bound so estimates round
  // up rather than down (an under-estimate clips the action row below
  // the box border, which is what we're trying to prevent).
  const charWidthPx = 7.6;
  const horizontalPaddingPx = 26; // padding-x on .irg-node
  const usableWidth = width - horizontalPaddingPx;
  const charsPerLine = Math.max(1, Math.floor(usableWidth / charWidthPx));
  // Greedy-pack tokens (split at underscores/dots, matching softBreak()'s
  // ZWSP boundaries) onto lines. A naive `length / charsPerLine` undercounts
  // because identifiers like "self_employment_income_calculated_on_anticipated_basis"
  // break at chunk boundaries, leaving partial-line whitespace.
  // +1 safety line: browsers occasionally pick a stricter break point
  // than our greedy packer (sub-pixel rounding, kerning, etc.), and we'd
  // rather waste 16 px of vertical space than clip the action row.
  const estimatedLines = estimateWrappedLines(label, charsPerLine);
  const lines = estimatedLines + 1;
  const labelLineHeight = 16;
  const labelBlockHeight = lines * labelLineHeight;

  // Per-kind chrome (padding + eyebrow + value/action rows). Generous
  // buffers — under-estimating means the action row overflows below the
  // box (visible because we use overflow:visible to avoid clipping the
  // eyebrow against the border).
  let chrome: number;
  if (small) {
    chrome = 50;
  } else if (data.kind === "input") {
    chrome = 78; // padding + eyebrow + + EXPOSE divider row
  } else if (data.kind === "output") {
    chrome = 72;
  } else if (data.kind === "ruleRef") {
    // Rules can stack TWO action rows: output toggle + collapse/expand.
    // Reserve room for both when the parent enabled both affordances.
    const actionRows =
      (data.canToggleOutput ? 1 : 0) + (data.canExpand ? 1 : 0);
    chrome = 50 + actionRows * 22;
  } else {
    chrome = 56;
  }
  return { width, height: chrome + labelBlockHeight };
}

/**
 * Approximate the number of lines a snake_case / dotted identifier wraps
 * to inside a fixed-width box. Splits the label at underscore / dot
 * boundaries (the same break points softBreak() inserts ZWSPs at) and
 * greedy-packs the resulting chunks. Falls back to mid-chunk wrapping
 * for any single chunk longer than `charsPerLine`.
 */
function estimateWrappedLines(label: string, charsPerLine: number): number {
  if (!label) return 1;
  const chunks = label.split(/(?<=[_.])/);
  let lines = 1;
  let used = 0;
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    if (used === 0 && chunk.length > charsPerLine) {
      // Single token longer than the line — wraps mid-chunk.
      const internal = Math.ceil(chunk.length / charsPerLine);
      lines += internal - 1;
      used = chunk.length % charsPerLine || charsPerLine;
      continue;
    }
    if (used + chunk.length > charsPerLine) {
      lines += 1;
      if (chunk.length > charsPerLine) {
        const internal = Math.ceil(chunk.length / charsPerLine);
        lines += internal - 1;
        used = chunk.length % charsPerLine || charsPerLine;
      } else {
        used = chunk.length;
      }
    } else {
      used += chunk.length;
    }
  }
  return Math.max(1, lines);
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the metadata that the hover popover renders. Pulls citation, legal
 * ID and Axiom-app deep-link from the trace node — preferring the
 * homeFile (input-leaves only) over the legal ID's file portion.
 */
/** Hover popover metadata for a parameter rule — citation, value, link. */
function buildParameterMeta(p: ParameterRule): NodeMeta {
  const citation = p.source ?? humanizeCitation(p.fileLegalId);
  const appUrl = p.fileLegalId ? axiomAppUrl(p.fileLegalId) : null;
  const dtypeText = p.dtype ? ` · ${p.dtype}` : "";
  // For simple parameters the formula is the constant value (e.g. "35").
  // Truncate so longer table-shaped parameters don't blow up the popover.
  const valuePreview = p.formula
    ? truncate(p.formula.replace(/\s+/g, " ").trim(), 140)
    : undefined;
  return {
    kindLine: `Parameter${dtypeText}${p.unit ? ` · ${p.unit}` : ""}`,
    citation,
    legalId: p.legalId,
    appUrl,
    formulaPreview: valuePreview,
  };
}

function buildMeta(t: TraceNode, kind: "Output" | "Input" | "Rule"): NodeMeta {
  const fileLegalId = t.homeFile ?? fileLegalIdOf(t.legalId);
  const citation = t.source ?? (fileLegalId ? humanizeCitation(fileLegalId) : undefined);
  const appUrl = fileLegalId ? axiomAppUrl(fileLegalId) : null;
  const dtypeText = t.dtype && t.dtype !== "input" ? ` · ${t.dtype}` : "";
  // Formula previews on rules/outputs were noisy and the "code path" was
  // already implicit in the title — citation + Axiom link is enough.
  return {
    kindLine: `${kind}${dtypeText}`,
    citation,
    legalId: t.legalId,
    appUrl,
  };
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function flattenTrace(traces: Record<string, TraceNode>): Map<string, TraceNode> {
  const out = new Map<string, TraceNode>();
  function walk(t: TraceNode) {
    if (out.has(t.legalId)) return;
    out.set(t.legalId, t);
    for (const c of t.children ?? []) walk(c);
  }
  for (const t of Object.values(traces)) walk(t);
  return out;
}

/** Walk the trace recursively and accumulate every rule legal ID. Used by
 *  "Collapse all" — we need to know what to add to the collapsed set. */
function collectRuleIds(t: TraceNode, out: Set<string>): void {
  if (t.dtype !== "input" && t.formula) out.add(t.legalId);
  for (const c of t.children ?? []) collectRuleIds(c, out);
}

function flattenLogical(node: AstNode, op: "and" | "or"): AstNode[] {
  if (node.kind === "logical" && node.op === op) {
    return [...flattenLogical(node.left, op), ...flattenLogical(node.right, op)];
  }
  return [node];
}

function flattenArith(node: AstNode, op: "+" | "*"): AstNode[] {
  if (node.kind === "arith" && node.op === op) {
    return [...flattenArith(node.left, op), ...flattenArith(node.right, op)];
  }
  return [node];
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (v === "holds") return "✓ holds";
  if (v === "not_holds") return "✗ does not hold";
  if (v === "undetermined") return "?";
  if (typeof v === "boolean") return v ? "✓ true" : "✗ false";
  if (typeof v === "number") {
    return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return String(v);
}

function verdictClass(t: TraceNode): string {
  if (t.dtype === "judgment") {
    if (t.value === "holds") return "irg-holds";
    if (t.value === "not_holds") return "irg-fails";
    return "irg-undet";
  }
  return "irg-numeric";
}

function verdictClassOfBool(v: EvalValue): string {
  if (v === null) return "irg-undet";
  return toBool(v) ? "irg-holds" : "irg-fails";
}

// Suppress unused-variable warning in TS when useEffect isn't currently used.
void useEffect;

import { useMemo } from "react";
import dagre from "dagre";
import type { TraceNode } from "@dashboard-builder/spec";
import {
  evalAst,
  parseFormula,
  toBool,
  type AstNode,
  type EvalValue,
} from "./formula";

interface Props {
  formula: string;
  /** Resolve identifier (rule/input name) → trace node from the engine. */
  lookup: (name: string) => TraceNode | undefined;
  onDrillInto: (node: TraceNode) => void;
  onExposeInput?: (legalId: string) => void;
  exposedInputIds?: Set<string>;
  /**
   * "structure" — author-facing view. Hides runtime values and active-branch
   *   highlighting; nodes use neutral colors. Reads as "what does this rule
   *   depend on, how is it organized?"
   * "values" — runtime view. Shows current evaluated value on every node,
   *   highlights the active branch of an IF, color-codes by verdict. Reads
   *   as "why did this rule produce that specific answer?"
   */
  mode?: "structure" | "values";
}

/**
 * Real graph rendering of a rule's formula. Each AST node becomes a vertex;
 * dependency edges flow from the operator down to its operands. Layout is
 * dagre top-down so the rule's output sits at the top, atomic inputs at the
 * bottom.
 *
 * Visual language matches the rest of the app:
 *   • Boolean nodes color-code by verdict (green holds / red fails / amber undet)
 *   • Numeric nodes use the brown accent
 *   • Inputs render as parallelograms (data-source shape) tinted by source
 *     state (solid green = user-driven, dashed amber = frozen default)
 *   • Sub-rule references render as clickable nodes with a drill-in glyph
 *
 * Sub-rules are NOT expanded inline — that would explode the graph. Click a
 * sub-rule node and the modal switches to its graph (recursive exploration).
 */
export function RuleGraph({
  formula,
  lookup,
  onDrillInto,
  onExposeInput,
  exposedInputIds,
  mode = "values",
}: Props) {
  const ast = useMemo(() => parseFormula(formula), [formula]);

  const layout = useMemo(
    () => layoutAst(ast, lookup, exposedInputIds, onDrillInto, onExposeInput, mode),
    // Recompute when the rule changes (we use the formula text as identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [formula, exposedInputIds, mode],
  );

  if (ast.kind === "error") {
    return <div className="rg-error">Couldn't parse formula: {ast.text}</div>;
  }

  return (
    <div className={`rg-wrap rg-mode-${mode}`}>
      <svg
        className="rg-svg"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width="100%"
        height={Math.min(layout.height, 800)}
        preserveAspectRatio="xMidYMin meet"
      >
        <defs>
          <marker
            id="rg-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
        </defs>

        {/* Edges first so nodes paint on top */}
        {layout.edges.map((e, i) => (
          <g key={i}>
            <path
              d={e.path}
              className={`rg-edge ${e.activeClass}`}
              fill="none"
              markerEnd="url(#rg-arrow)"
            />
            {e.label && e.labelX !== undefined && e.labelY !== undefined && (
              <g transform={`translate(${e.labelX}, ${e.labelY})`}>
                <rect
                  x={-(e.label.length * 4 + 6)}
                  y={-9}
                  width={e.label.length * 8 + 12}
                  height={18}
                  rx={9}
                  ry={9}
                  className={`rg-edge-label-bg ${e.labelClass ?? ""}`}
                />
                <text
                  x={0}
                  y={0}
                  className={`rg-edge-label ${e.labelClass ?? ""}`}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {e.label}
                </text>
              </g>
            )}
          </g>
        ))}

        {layout.nodes.map((n) => (
          <g
            key={n.id}
            transform={`translate(${n.x - n.width / 2}, ${n.y - n.height / 2})`}
            className={`rg-node ${n.cls} ${n.clickable ? "rg-clickable" : ""}`}
            onClick={n.onClick}
            role={n.onClick ? "button" : undefined}
            tabIndex={n.onClick ? 0 : undefined}
          >
            <NodeShape n={n} />
            <foreignObject
              x={0}
              y={0}
              width={n.width}
              height={n.height}
              style={{ pointerEvents: "none" }}
            >
              <div
                className={`rg-node-content ${n.cls}`}
                title={n.fullLabel ?? n.label}
              >
                <div className="rg-node-label">{n.label}</div>
                {n.subLabel && <div className="rg-node-sub">{n.subLabel}</div>}
                <div className="rg-node-value">{n.valueDisplay}</div>
              </div>
            </foreignObject>
          </g>
        ))}
      </svg>
    </div>
  );
}

function NodeShape({ n }: { n: GraphNode }) {
  if (n.shape === "parallelogram") {
    // Data-source shape for inputs.
    const skew = 8;
    const w = n.width;
    const h = n.height;
    return (
      <polygon
        className="rg-shape"
        points={`${skew},0 ${w},0 ${w - skew},${h} 0,${h}`}
      />
    );
  }
  if (n.shape === "diamond") {
    const w = n.width;
    const h = n.height;
    return (
      <polygon className="rg-shape" points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} />
    );
  }
  if (n.shape === "rounded-tab") {
    return (
      <rect className="rg-shape" x={0} y={0} width={n.width} height={n.height} rx={10} ry={10} />
    );
  }
  return (
    <rect className="rg-shape" x={0} y={0} width={n.width} height={n.height} rx={4} ry={4} />
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Layout: walk the AST, build a dagre graph, return positioned nodes/edges.
// ─────────────────────────────────────────────────────────────────────────

interface GraphNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  /** Long-form label shown on hover (the full identifier when label is truncated). */
  fullLabel?: string;
  subLabel?: string;
  valueDisplay: string;
  cls: string; // verdict class (rg-holds / rg-fails / rg-numeric / rg-undet) + kind
  shape: "rect" | "parallelogram" | "diamond" | "rounded-tab";
  clickable: boolean;
  onClick?: () => void;
}

/** Cap node width so dagre lays things out cleanly; long labels truncate with ellipsis + tooltip. */
const MAX_LEAF_WIDTH = 240;

interface GraphEdge {
  id: string;
  path: string;
  activeClass: string;
  label?: string;
  labelX?: number;
  labelY?: number;
  labelClass?: string;
}

interface Layout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

function layoutAst(
  ast: AstNode,
  lookup: (name: string) => TraceNode | undefined,
  exposedInputIds: Set<string> | undefined,
  onDrillInto: (n: TraceNode) => void,
  onExposeInput: ((legalId: string) => void) | undefined,
  mode: "structure" | "values",
): Layout {
  const showValues = mode === "values";
  const lookupValue = (name: string): EvalValue => {
    const t = lookup(name);
    if (!t) return null;
    return t.value as EvalValue;
  };

  const g = new dagre.graphlib.Graph();
  // Left-to-right dataflow: atomic inputs on the left, intermediate
  // operators in the middle, rule output on the right. All edges encode
  // "this value feeds that one" so they point rightward toward the output.
  g.setGraph({ rankdir: "LR", nodesep: 18, ranksep: 56, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));

  const nodes: GraphNode[] = [];
  const edges: {
    from: string;
    to: string;
    activeClass: string;
    label?: string;
    labelClass?: string;
  }[] = [];
  let id = 0;
  const next = () => `n${id++}`;

  // Walk the AST to populate dagre. Returns the id of the rendered node so
  // the parent can attach an edge.
  function walk(node: AstNode, decisive?: "decisive" | "nondecisive"): string {
    const my = next();

    switch (node.kind) {
      case "ident": {
        const t = lookup(node.name);
        if (!t) {
          const full = node.name;
          const display = truncateLabel(full, 30);
          const w = sizeForLeaf(display);
          g.setNode(my, { width: w, height: 50 });
          nodes.push({
            id: my,
            x: 0,
            y: 0,
            width: w,
            height: 50,
            label: display,
            fullLabel: full,
            valueDisplay: "",
            cls: "rg-unknown",
            shape: "parallelogram",
            clickable: false,
          });
          return my;
        }
        if (t.dtype === "input") {
          const exposed =
            exposedInputIds?.has(t.legalId) ?? t.inputSource === "user";
          const full = t.label || node.name;
          const display = truncateLabel(full, 30);
          const w = sizeForLeaf(display);
          const canExpose = !exposed && !!onExposeInput;
          g.setNode(my, { width: w, height: 60 });
          nodes.push({
            id: my,
            x: 0,
            y: 0,
            width: w,
            height: 60,
            label: display,
            fullLabel: full,
            subLabel: exposed ? "user input" : (canExpose ? "default · click to expose" : "default input"),
            // Inputs always show the user/default state (it's a property of
            // the dashboard's design, not a runtime value), but only show the
            // current value in values mode.
            valueDisplay: showValues ? formatValue(t.value) : "",
            cls: exposed ? "rg-input rg-user" : "rg-input rg-default",
            shape: "parallelogram",
            clickable: canExpose,
            onClick: canExpose ? () => onExposeInput!(t.legalId) : undefined,
          });
          return my;
        }
        // Sub-rule reference — clickable terminal.
        const verdictCls = showValues ? verdictClassOfTrace(t) : "rg-neutral";
        const full = t.label || node.name;
        const display = truncateLabel(full, 30);
        const w = sizeForLeaf(display);
        g.setNode(my, { width: w, height: 60 });
        nodes.push({
          id: my,
          x: 0,
          y: 0,
          width: w,
          height: 60,
          label: display,
          fullLabel: full,
          subLabel: "open ›",
          valueDisplay: showValues ? formatValue(t.value) : "",
          cls: `rg-rule ${verdictCls}`,
          shape: "rounded-tab",
          clickable: true,
          onClick: () => onDrillInto(t),
        });
        return my;
      }
      case "number":
      case "bool": {
        const text = String(node.kind === "number" ? node.value : node.value);
        const w = Math.max(80, text.length * 9 + 16);
        g.setNode(my, { width: w, height: 40 });
        nodes.push({
          id: my,
          x: 0,
          y: 0,
          width: w,
          height: 40,
          label: text,
          valueDisplay: "",
          cls: "rg-literal",
          shape: "rect",
          clickable: false,
        });
        return my;
      }
      case "logical": {
        const op = node.op;
        const operands = flattenLogical(node, op);
        const operandValues = operands.map((o) => evalAst(o, lookupValue));
        const value = evalAst(node, lookupValue);
        const verdictCls = verdictClassOfBool(value);
        const decisiveTest =
          op === "and"
            ? (v: EvalValue) => v !== null && !toBool(v)
            : (v: EvalValue) => v !== null && toBool(v);
        const anyDecisive = operandValues.some(decisiveTest);
        g.setNode(my, { width: 120, height: 60 });
        nodes.push({
          id: my,
          x: 0,
          y: 0,
          width: 120,
          height: 60,
          label: op.toUpperCase(),
          valueDisplay: showValues ? formatValue(value) : "",
          cls: `rg-op ${showValues ? verdictCls : "rg-neutral"}`,
          shape: "rect",
          clickable: false,
        });
        operands.forEach((child, i) => {
          const childIsDecisive = anyDecisive && decisiveTest(operandValues[i] ?? null);
          const cid = walk(child, childIsDecisive ? "decisive" : "nondecisive");
          // Dataflow direction: operand value feeds the operator (cid → my).
          g.setEdge(cid, my);
          // Active-branch highlighting only in values mode.
          edges.push({
            from: cid,
            to: my,
            activeClass:
              showValues && childIsDecisive
                ? op === "and"
                  ? "rg-edge-fail"
                  : "rg-edge-pass"
                : "",
          });
        });
        return my;
      }
      case "comparison": {
        const value = evalAst(node, lookupValue);
        const verdictCls = verdictClassOfBool(value);
        g.setNode(my, { width: 120, height: 64 });
        nodes.push({
          id: my,
          x: 0,
          y: 0,
          width: 120,
          height: 64,
          label: node.op,
          valueDisplay: showValues ? formatValue(value) : "",
          cls: `rg-op ${showValues ? verdictCls : "rg-neutral"}`,
          shape: "diamond",
          clickable: false,
        });
        const lid = walk(node.left);
        const rid = walk(node.right);
        g.setEdge(lid, my);
        g.setEdge(rid, my);
        edges.push({ from: lid, to: my, activeClass: "" });
        edges.push({ from: rid, to: my, activeClass: "" });
        return my;
      }
      case "arith": {
        const value = evalAst(node, lookupValue);
        const operands =
          node.op === "+" || node.op === "*"
            ? flattenArith(node, node.op)
            : [node.left, node.right];
        g.setNode(my, { width: 110, height: 60 });
        nodes.push({
          id: my,
          x: 0,
          y: 0,
          width: 110,
          height: 60,
          label: node.op,
          valueDisplay: formatValue(value),
          cls: "rg-op rg-numeric",
          shape: "rect",
          clickable: false,
        });
        operands.forEach((child) => {
          const cid = walk(child);
          g.setEdge(cid, my);
          edges.push({ from: cid, to: my, activeClass: "" });
        });
        return my;
      }
      case "unary": {
        const value = evalAst(node, lookupValue);
        const label = node.op === "not" ? "NOT" : "−";
        const verdictCls = node.op === "not" ? verdictClassOfBool(value) : "rg-numeric";
        g.setNode(my, { width: 100, height: 60 });
        nodes.push({
          id: my,
          x: 0,
          y: 0,
          width: 100,
          height: 60,
          label,
          valueDisplay: showValues ? formatValue(value) : "",
          cls: `rg-op ${showValues ? verdictCls : "rg-neutral"}`,
          shape: "rect",
          clickable: false,
        });
        const cid = walk(node.operand);
        g.setEdge(cid, my);
        edges.push({ from: cid, to: my, activeClass: "" });
        return my;
      }
      case "call": {
        const value = evalAst(node, lookupValue);
        const cls =
          ["any", "all"].includes(node.name) ? verdictClassOfBool(value) : "rg-numeric";
        // Mono-ish width estimate: 8.5 px/char for the bold label + 28 padding,
        // capped at 240 so wide function names don't blow the layout.
        const w = Math.min(240, Math.max(150, node.name.length * 8.5 + 28));
        g.setNode(my, { width: w, height: 60 });
        nodes.push({
          id: my,
          x: 0,
          y: 0,
          width: w,
          height: 60,
          label: node.name,
          fullLabel: node.name,
          valueDisplay: formatValue(value),
          cls: `rg-op ${cls}`,
          shape: "rect",
          clickable: false,
        });
        node.args.forEach((arg) => {
          const cid = walk(arg);
          g.setEdge(cid, my);
          edges.push({ from: cid, to: my, activeClass: "" });
        });
        return my;
      }
      case "index": {
        g.setNode(my, { width: 130, height: 60 });
        nodes.push({
          id: my,
          x: 0,
          y: 0,
          width: 130,
          height: 60,
          label: "table[i]",
          valueDisplay: "—",
          cls: "rg-op rg-numeric",
          shape: "rect",
          clickable: false,
        });
        const tid = walk(node.target);
        const iid = walk(node.index);
        g.setEdge(tid, my);
        g.setEdge(iid, my);
        edges.push({ from: tid, to: my, activeClass: "" });
        edges.push({ from: iid, to: my, activeClass: "" });
        return my;
      }
      case "ifElse": {
        const condValue = evalAst(node.cond, lookupValue);
        const value = evalAst(node, lookupValue);
        const condTrue = condValue !== null && toBool(condValue);
        const verdictCls = verdictClassOfBool(value);
        // Render the IF as a small rounded gate — diamond-shaped routing
        // implies a single-clause test, but our conditions are usually
        // sub-trees, so a labeled rectangle reads more honestly.
        g.setNode(my, { width: 130, height: 60 });
        nodes.push({
          id: my,
          x: 0,
          y: 0,
          width: 130,
          height: 60,
          label: "IF",
          subLabel: showValues
            ? condValue === null
              ? "undetermined"
              : condTrue
                ? "→ then branch"
                : "→ else branch"
            : undefined,
          valueDisplay: showValues ? formatValue(value) : "",
          cls: `rg-op rg-if ${showValues ? verdictCls : "rg-neutral"}`,
          shape: "rounded-tab",
          clickable: false,
        });
        // Dataflow: condition value feeds the gate (cond → IF); branch
        // values also feed the gate (then → IF, else → IF), since the gate
        // is what selects one of them. The active branch's edge is solid
        // green; the inactive one dashed gray. The condition edge gets a
        // distinctive "test" style so it reads as the routing input rather
        // than a value source.
        const cid = walk(node.cond);
        const tid = walk(node.then);
        const eid = walk(node.else_);
        g.setEdge(cid, my);
        g.setEdge(tid, my);
        g.setEdge(eid, my);
        edges.push({
          from: cid,
          to: my,
          activeClass: "rg-edge-test",
          label: "test",
          labelClass: "rg-edge-label-test",
        });
        const thenActive = showValues && condValue !== null && condTrue;
        const elseActive = showValues && condValue !== null && !condTrue;
        edges.push({
          from: tid,
          to: my,
          activeClass: showValues
            ? condValue === null
              ? ""
              : condTrue
                ? "rg-edge-pass"
                : "rg-edge-dim"
            : "",
          label: "if true",
          labelClass: thenActive
            ? "rg-edge-label-active"
            : elseActive
              ? "rg-edge-label-dim"
              : "",
        });
        edges.push({
          from: eid,
          to: my,
          activeClass: showValues
            ? condValue === null
              ? ""
              : condTrue
                ? "rg-edge-dim"
                : "rg-edge-pass"
            : "",
          label: "if false",
          labelClass: elseActive
            ? "rg-edge-label-active"
            : thenActive
              ? "rg-edge-label-dim"
              : "",
        });
        return my;
      }
      case "error":
        g.setNode(my, { width: 200, height: 40 });
        nodes.push({
          id: my,
          x: 0,
          y: 0,
          width: 200,
          height: 40,
          label: "parse error",
          valueDisplay: node.text,
          cls: "rg-error",
          shape: "rect",
          clickable: false,
        });
        return my;
    }
    void decisive;
    return my;
  }

  walk(ast);

  dagre.layout(g);

  // Pull positions back out of dagre.
  const idToNode = new Map(nodes.map((n) => [n.id, n]));
  for (const id of g.nodes()) {
    const layoutInfo = g.node(id);
    const n = idToNode.get(id);
    if (n && layoutInfo) {
      n.x = layoutInfo.x;
      n.y = layoutInfo.y;
    }
  }

  // Compute SVG paths from edges. For each edge dagre returns a list of
  // points; we render them as a smooth polyline. We also pick a midpoint
  // from the path for any edge that has a label, so the label sits on the
  // edge rather than over a node.
  const renderedEdges: GraphEdge[] = [];
  let edgeCounter = 0;
  for (const meta of edges) {
    const e = g.edge(meta.from, meta.to);
    const pts = e?.points ?? [];
    if (pts.length === 0) continue;
    const path = pointsToPath(pts);
    const midpoint = pts[Math.floor(pts.length / 2)] ?? pts[0]!;
    renderedEdges.push({
      id: `e${edgeCounter++}`,
      path,
      activeClass: meta.activeClass,
      label: meta.label,
      labelX: meta.label ? midpoint.x : undefined,
      labelY: meta.label ? midpoint.y : undefined,
      labelClass: meta.labelClass,
    });
  }

  // Wire up clickable nodes (we kept onClick out of the AST walk because
  // the closure needs the resolved trace nodes).
  // Re-walk to attach onClick handlers.
  // (Simpler: do this inline above by passing onDrillInto. Already done in
  // the modal-side wrapper.)

  const graphInfo = g.graph();
  const width = graphInfo.width ?? 0;
  const height = graphInfo.height ?? 0;
  return { nodes, edges: renderedEdges, width, height };
}

/**
 * Cap labels at a reasonable length and append … so the SVG node never has
 * to render multi-line text past its bounds. The full identifier shows in a
 * native title tooltip on hover.
 */
function truncateLabel(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Width budget for a leaf-shape node based on its (already-truncated) label. */
function sizeForLeaf(label: string): number {
  // ~7px per char with mono-ish sizing, plus padding.
  const est = label.length * 7 + 40;
  return Math.min(MAX_LEAF_WIDTH, Math.max(160, est));
}

function pointsToPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  const start = pts[0]!;
  let d = `M ${start.x} ${start.y}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    d += ` L ${p.x} ${p.y}`;
  }
  return d;
}

// We need the click handlers to be attached AFTER the layout, but the
// current implementation builds nodes inside walk(). To keep things simple
// we re-emit the graph with click handlers in a wrapper component below.
// (We expose `onDrillInto` and `onExposeInput` via the layout boundary.)

// Wrap the layout to inject click handlers using the AST walk's collected nodes.
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

function verdictClassOfTrace(t: TraceNode): string {
  if (t.dtype === "judgment") {
    if (t.value === "holds") return "rg-holds";
    if (t.value === "not_holds") return "rg-fails";
    return "rg-undet";
  }
  return "rg-numeric";
}

function verdictClassOfBool(v: EvalValue): string {
  if (v === null) return "rg-undet";
  return toBool(v) ? "rg-holds" : "rg-fails";
}

/**
 * PhysicsGraph — wires-only DAG view designed for the full 234-node CO
 * SNAP graph and the focused-ecosystem drill-in.
 *
 * Why dagre, not force-directed:
 *   - Layered layout (rankdir LR) is what every professional DAG viz
 *     uses (Datadog service map, Linear, Sentry traces). It's the
 *     mathematically right choice for a directed acyclic graph: nodes
 *     line up by depth, wires flow one direction, zero overlap.
 *   - Force-directed cannot pack 234 labelled cards into any
 *     reasonable canvas without overlap — the area arithmetic doesn't
 *     work, and the result jiggles.
 *
 * Why cards, not dots+floating-text:
 *   - The card *is* the node. Dagre reserves space for it. Labels can't
 *     overlap because the layout knows their dimensions.
 *
 * Interactions:
 *   - Wheel zooms toward cursor, drag pans the canvas — so 234 nodes
 *     are navigable.
 *   - Hover a card → BFS upstream lights its dependency chain (kinetic
 *     reveal).
 *   - Click a card → isolate its 1-hop ecosystem; dagre re-lays out the
 *     subset, CSS transition glides every card to its new position
 *     over 400ms. Hop-radius control widens to 2 hops or full chain.
 *   - Click empty canvas or "Back" → return to full graph.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dagre from "dagre";
import type { DashboardSpec, TraceNode } from "@dashboard-builder/spec";

interface Props {
  spec: DashboardSpec;
  traces: Record<string, TraceNode>;
  onExposeInput?: (legalId: string) => void;
  exposedInputIds?: Set<string>;
  onAddOutput?: (legalId: string) => void;
  selectedOutputIds?: Set<string>;
}

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

interface PNode {
  id: string;
  legalId: string;
  label: string;
  humanLabel: string;
  isInput: boolean;
  isOutput: boolean;
  exposed: boolean;
  /** Distance-from-outputs (0 = output, +1 each hop back). */
  depth: number;
  /** Number of distinct dashboard outputs this node feeds. */
  reach: number;
  width: number;
  height: number;
}

interface PEdge {
  id: string;
  source: string;
  target: string;
  /** Number of distinct outputs the wire carries through to. */
  weight: number;
}

interface BuiltModel {
  nodes: PNode[];
  edges: PEdge[];
  outDeps: Map<string, Set<string>>;
  inConsumers: Map<string, Set<string>>;
}

interface NodePos {
  x: number;
  y: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────

export function PhysicsGraph({
  spec,
  traces,
  onExposeInput,
  onAddOutput,
  exposedInputIds,
}: Props) {
  const exposedSet = exposedInputIds ?? EMPTY_SET;
  const model = useMemo(
    () => buildModel(spec, traces, exposedSet),
    [spec, traces, exposedSet],
  );

  // Discrete UI state.
  const [hovered, setHovered] = useState<string | null>(null);
  const [isolated, setIsolated] = useState<string | null>(null);
  const [hopRadius, setHopRadius] = useState<number>(1);

  // Pan/zoom state.
  const [view, setView] = useState<{ x: number; y: number; k: number }>({
    x: 0,
    y: 0,
    k: 1,
  });

  // Reset hop radius back to 1 when isolating a fresh node.
  useEffect(() => {
    if (isolated) setHopRadius(1);
  }, [isolated]);

  // Compute closure of isolated node (bounded by hopRadius).
  const closure = useMemo(() => {
    if (!isolated) return null;
    const set = new Set<string>([isolated]);
    let frontier: string[] = [isolated];
    for (let h = 0; h < hopRadius; h++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const dep of model.outDeps.get(id) ?? []) {
          if (!set.has(dep)) {
            set.add(dep);
            next.push(dep);
          }
        }
      }
      frontier = next;
    }
    frontier = [isolated];
    for (let h = 0; h < hopRadius; h++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const c of model.inConsumers.get(id) ?? []) {
          if (!set.has(c)) {
            set.add(c);
            next.push(c);
          }
        }
      }
      frontier = next;
    }
    return set;
  }, [isolated, model, hopRadius]);

  // ── Layout ──────────────────────────────────────────────────────────
  // Two layouts: full graph (cached) and current-isolation. Dagre runs
  // synchronously and is fast enough for 234 nodes (~30ms).

  const fullLayout = useMemo(() => layoutWithDagre(model.nodes, model.edges), [
    model,
  ]);
  const isolatedLayout = useMemo(() => {
    if (!closure) return null;
    const sub = model.nodes.filter((n) => closure.has(n.id));
    const subEdges = model.edges.filter(
      (e) => closure.has(e.source) && closure.has(e.target),
    );
    return layoutWithDagre(sub, subEdges);
  }, [closure, model]);

  // Active positions: union of full-graph positions (for out-of-scope
  // nodes that stay visible faded) and isolated layout (for closure).
  const positions: Map<string, NodePos> = useMemo(() => {
    if (!isolatedLayout || !closure) return fullLayout.positions;
    const m = new Map(fullLayout.positions);
    for (const [id, p] of isolatedLayout.positions) m.set(id, p);
    return m;
  }, [isolatedLayout, closure, fullLayout]);

  // Bounds of the active layout — used to fit the canvas on first mount
  // and on isolation toggle.
  const activeBounds = isolatedLayout?.bounds ?? fullLayout.bounds;

  // ── BFS upstream from hovered for pulse ─────────────────────────────
  const pulse = useMemo(() => {
    if (!hovered) return null;
    const incoming = new Map<string, PEdge[]>();
    for (const e of model.edges) {
      const arr = incoming.get(e.target) ?? [];
      arr.push(e);
      incoming.set(e.target, arr);
    }
    const edgeDepth = new Map<string, number>();
    const nodeDepth = new Map<string, number>();
    nodeDepth.set(hovered, 0);
    const queue: string[] = [hovered];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const d = nodeDepth.get(id)!;
      const ins = incoming.get(id) ?? [];
      for (const e of ins) {
        if (!edgeDepth.has(e.id)) edgeDepth.set(e.id, d);
        if (!nodeDepth.has(e.source)) {
          nodeDepth.set(e.source, d + 1);
          queue.push(e.source);
        }
      }
    }
    return { edgeDepth, nodeDepth };
  }, [hovered, model]);

  // ── Auto-fit on layout change ───────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w <= 0 || h <= 0) return;
    const margin = 30;
    const bw = activeBounds.width + margin * 2;
    const bh = activeBounds.height + margin * 2;
    const k = Math.min(w / bw, h / bh, 1.4);
    const tx = (w - activeBounds.width * k) / 2 - activeBounds.minX * k;
    const ty = (h - activeBounds.height * k) / 2 - activeBounds.minY * k;
    setView({ x: tx, y: ty, k });
    // Activebounds is a stable shape — fit on each isolation change.
  }, [activeBounds]);

  // ── Wheel zoom (non-passive listener via ref) ───────────────────────
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const newK = clamp(v.k * factor, 0.25, 3);
        return {
          k: newK,
          x: cx - (cx - v.x) * (newK / v.k),
          y: cy - (cy - v.y) * (newK / v.k),
        };
      });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ── Drag pan ────────────────────────────────────────────────────────
  const dragRef = useRef<{ startX: number; startY: number; sx: number; sy: number } | null>(
    null,
  );
  const [panning, setPanning] = useState(false);

  function onMouseDown(e: React.MouseEvent) {
    if ((e.target as Element).closest(".pgraph-card")) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      sx: view.x,
      sy: view.y,
    };
    setPanning(true);
  }

  useEffect(() => {
    if (!panning) return;
    function onMove(e: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      setView((v) => ({
        ...v,
        x: d.sx + (e.clientX - d.startX),
        y: d.sy + (e.clientY - d.startY),
      }));
    }
    function onUp() {
      dragRef.current = null;
      setPanning(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [panning]);

  // Click on empty canvas exits isolation.
  function onCanvasClick(e: React.MouseEvent) {
    if ((e.target as Element).closest(".pgraph-card")) return;
    if (panning) return;
    if (isolated) setIsolated(null);
  }

  const maxWeight = Math.max(1, ...model.edges.map((e) => e.weight));
  const hoveredNode = hovered ? model.nodes.find((n) => n.id === hovered) : null;
  const isolatedNode = isolated
    ? model.nodes.find((n) => n.id === isolated)
    : null;

  return (
    <div
      ref={containerRef}
      className={`pgraph-wrap ${isolated ? "is-isolated" : ""} ${
        panning ? "is-panning" : ""
      }`}
    >
      <svg
        ref={svgRef}
        className="pgraph-svg"
        onMouseDown={onMouseDown}
        onClick={onCanvasClick}
      >
        <g
          className="pgraph-stage"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          }}
        >
          {/* Edges layer */}
          <g className="pgraph-edges">
            {model.edges.map((e) => {
              const sp = positions.get(e.source);
              const tp = positions.get(e.target);
              if (!sp || !tp) return null;
              const sn = model.nodes.find((n) => n.id === e.source)!;
              const tn = model.nodes.find((n) => n.id === e.target)!;
              const x1 = sp.x + sn.width / 2;
              const y1 = sp.y;
              const x2 = tp.x - tn.width / 2;
              const y2 = tp.y;
              const dx = (x2 - x1) * 0.5;
              const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
              const w = 0.7 + (e.weight / maxWeight) * 2.4;
              const pulseDepth = pulse?.edgeDepth.get(e.id);
              const onPath = pulseDepth !== undefined;
              const inEcosystem =
                !closure || (closure.has(e.source) && closure.has(e.target));
              return (
                <path
                  key={e.id}
                  className={`pgraph-edge ${onPath ? "is-pulse" : ""} ${
                    inEcosystem ? "" : "is-out-of-scope"
                  }`}
                  d={path}
                  strokeWidth={w}
                  fill="none"
                  style={
                    onPath
                      ? ({
                          "--pulse-delay": `${pulseDepth! * 70}ms`,
                        } as React.CSSProperties)
                      : undefined
                  }
                />
              );
            })}
          </g>

          {/* Nodes layer — cards */}
          <g className="pgraph-nodes">
            {model.nodes.map((n) => {
              const p = positions.get(n.id);
              if (!p) return null;
              const inEcosystem = !closure || closure.has(n.id);
              const onPath = pulse?.nodeDepth.has(n.id);
              const klass = [
                "pgraph-card",
                n.isOutput ? "is-output" : "",
                n.isInput
                  ? `is-input ${n.exposed ? "is-exposed" : "is-default"}`
                  : "",
                hovered === n.id ? "is-hover" : "",
                isolated === n.id ? "is-focus" : "",
                onPath ? "is-pulse" : "",
                pulse && !onPath ? "is-faded" : "",
                inEcosystem ? "" : "is-out-of-scope",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <g
                  key={n.id}
                  className={klass}
                  style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
                  onMouseEnter={() => setHovered(n.id)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsolated((cur) => (cur === n.id ? null : n.id));
                  }}
                >
                  <rect
                    className="pgraph-card-bg"
                    x={-n.width / 2}
                    y={-n.height / 2}
                    width={n.width}
                    height={n.height}
                    rx={6}
                  />
                  <foreignObject
                    x={-n.width / 2}
                    y={-n.height / 2}
                    width={n.width}
                    height={n.height}
                    style={{ pointerEvents: "none" }}
                  >
                    <div
                      // @ts-expect-error xmlns is required for foreignObject content
                      xmlns="http://www.w3.org/1999/xhtml"
                      className="pgraph-card-inner"
                    >
                      <span className="pgraph-card-label">
                        {n.humanLabel}
                      </span>
                    </div>
                  </foreignObject>
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      {/* ── Overlays ──────────────────────────────────────────────── */}
      <div className="pgraph-readout">
        {(hoveredNode || isolatedNode) ? (
          (() => {
            const n = hoveredNode ?? isolatedNode!;
            return (
              <>
                <div className="pgraph-readout-label">{n.humanLabel}</div>
                <div className="pgraph-readout-meta">
                  {roleOf(n)} · feeds {n.reach} main result
                  {n.reach === 1 ? "" : "s"} · depth {n.depth}
                </div>
                {isolated === n.id && (
                  <div className="pgraph-readout-actions">
                    {n.isInput ? (
                      <button
                        type="button"
                        className="pgraph-readout-btn"
                        onClick={() => onExposeInput?.(n.legalId)}
                        disabled={n.exposed}
                      >
                        {n.exposed ? "Already a question" : "Expose as question"}
                      </button>
                    ) : !n.isOutput ? (
                      <button
                        type="button"
                        className="pgraph-readout-btn"
                        onClick={() => onAddOutput?.(n.legalId)}
                      >
                        Add as result
                      </button>
                    ) : null}
                  </div>
                )}
              </>
            );
          })()
        ) : (
          <>
            <div className="pgraph-readout-label">
              {model.nodes.length} rules · {model.edges.length} dependencies
            </div>
            <div className="pgraph-readout-meta">
              Scroll to zoom · drag to pan · hover for upstream · click to
              isolate.
            </div>
          </>
        )}
      </div>

      {isolated && (
        <>
          <button
            type="button"
            className="pgraph-back-btn"
            onClick={() => setIsolated(null)}
          >
            ← Back to full graph
          </button>
          <div
            className="pgraph-radius-ctrl"
            role="group"
            aria-label="Neighborhood radius"
          >
            <span className="pgraph-radius-label">Show</span>
            <button
              type="button"
              className={`pgraph-radius-btn ${hopRadius === 1 ? "is-active" : ""}`}
              onClick={() => setHopRadius(1)}
            >
              Direct
            </button>
            <button
              type="button"
              className={`pgraph-radius-btn ${hopRadius === 2 ? "is-active" : ""}`}
              onClick={() => setHopRadius(2)}
            >
              2 hops
            </button>
            <button
              type="button"
              className={`pgraph-radius-btn ${hopRadius >= 99 ? "is-active" : ""}`}
              onClick={() => setHopRadius(99)}
            >
              Full chain
            </button>
          </div>
        </>
      )}

      <div className="pgraph-legend" aria-hidden="true">
        <span className="pgraph-legend-item">
          <span className="pgraph-legend-dot is-output" /> Main result
        </span>
        <span className="pgraph-legend-item">
          <span className="pgraph-legend-dot is-input is-exposed" /> Exposed
          input
        </span>
        <span className="pgraph-legend-item">
          <span className="pgraph-legend-dot is-input is-default" /> Default
          input
        </span>
        <span className="pgraph-legend-item">
          <span className="pgraph-legend-dot" /> Intermediate rule
        </span>
      </div>
    </div>
  );
}

const EMPTY_SET: Set<string> = new Set();

// ─────────────────────────────────────────────────────────────────────────
// Layout helpers
// ─────────────────────────────────────────────────────────────────────────

interface LayoutResult {
  positions: Map<string, NodePos>;
  bounds: { minX: number; minY: number; width: number; height: number };
}

function layoutWithDagre(nodes: PNode[], edges: PEdge[]): LayoutResult {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "LR",
    nodesep: 18,
    ranksep: 70,
    marginx: 24,
    marginy: 24,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const positions = new Map<string, NodePos>();
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    const li = g.node(n.id);
    if (!li) continue;
    positions.set(n.id, { x: li.x, y: li.y });
    minX = Math.min(minX, li.x - n.width / 2);
    maxX = Math.max(maxX, li.x + n.width / 2);
    minY = Math.min(minY, li.y - n.height / 2);
    maxY = Math.max(maxY, li.y + n.height / 2);
  }
  if (!isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  return {
    positions,
    bounds: {
      minX,
      minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Build model
// ─────────────────────────────────────────────────────────────────────────

function buildModel(
  spec: DashboardSpec,
  traces: Record<string, TraceNode>,
  exposedInputIds: Set<string>,
): BuiltModel {
  const outputIds = new Set(spec.outputs.map((o) => o.legalId));
  interface Info {
    legalId: string;
    label: string;
    deps: Set<string>;
    isInput: boolean;
    isOutput: boolean;
    exposed: boolean;
  }
  const byId = new Map<string, Info>();
  function walk(t: TraceNode) {
    let info = byId.get(t.legalId);
    if (!info) {
      info = {
        legalId: t.legalId,
        label: t.label || t.legalId.split("#").pop() || "?",
        deps: new Set(),
        isInput: t.dtype === "input",
        isOutput: outputIds.has(t.legalId),
        exposed: t.inputSource === "user" || exposedInputIds.has(t.legalId),
      };
      byId.set(t.legalId, info);
    }
    for (const c of t.children ?? []) {
      info.deps.add(c.legalId);
      walk(c);
    }
  }
  for (const t of Object.values(traces)) walk(t);

  const outDeps = new Map<string, Set<string>>();
  const inConsumers = new Map<string, Set<string>>();
  for (const info of byId.values()) {
    outDeps.set(info.legalId, info.deps);
    for (const dep of info.deps) {
      if (!inConsumers.has(dep)) inConsumers.set(dep, new Set());
      inConsumers.get(dep)!.add(info.legalId);
    }
  }

  // depth = longest path back from any output.
  const depth = new Map<string, number>();
  for (const id of outputIds) depth.set(id, 0);
  const dq: string[] = [...outputIds];
  while (dq.length > 0) {
    const id = dq.shift()!;
    const d = depth.get(id)!;
    const info = byId.get(id);
    if (!info) continue;
    for (const dep of info.deps) {
      const next = d + 1;
      if (!depth.has(dep) || depth.get(dep)! < next) {
        depth.set(dep, next);
        dq.push(dep);
      }
    }
  }

  // reach = number of distinct outputs each node feeds.
  const reach = new Map<string, number>();
  for (const outId of outputIds) {
    const seen = new Set<string>();
    const queue: string[] = [outId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      reach.set(id, (reach.get(id) ?? 0) + 1);
      const info = byId.get(id);
      if (!info) continue;
      for (const dep of info.deps) queue.push(dep);
    }
  }

  // PNodes — compute card size from label.
  const nodes: PNode[] = [];
  for (const info of byId.values()) {
    const human = humanize(info.label);
    const { width, height } = cardSize(human);
    nodes.push({
      id: info.legalId,
      legalId: info.legalId,
      label: info.label,
      humanLabel: human,
      isInput: info.isInput,
      isOutput: info.isOutput,
      exposed: info.exposed,
      depth: depth.get(info.legalId) ?? 0,
      reach: reach.get(info.legalId) ?? 0,
      width,
      height,
    });
  }

  // Edges with weight.
  const edges: PEdge[] = [];
  for (const info of byId.values()) {
    for (const dep of info.deps) {
      if (!byId.has(dep)) continue;
      edges.push({
        id: `${dep}->${info.legalId}`,
        source: dep,
        target: info.legalId,
        weight: reach.get(dep) ?? 1,
      });
    }
  }

  return { nodes, edges, outDeps, inConsumers };
}

// ─────────────────────────────────────────────────────────────────────────
// Tiny utilities
// ─────────────────────────────────────────────────────────────────────────

/** Card width grows with label length up to a cap. Height is fixed at
 * one-line; long labels truncate via CSS ellipsis. */
function cardSize(label: string): { width: number; height: number } {
  const charW = 6.6;
  const padding = 22;
  const w = Math.min(220, Math.max(120, label.length * charW + padding));
  return { width: w, height: 30 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function roleOf(n: PNode): string {
  if (n.isOutput) return "Main result";
  if (n.isInput) return n.exposed ? "Exposed input" : "Default input";
  return "Intermediate rule";
}

function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

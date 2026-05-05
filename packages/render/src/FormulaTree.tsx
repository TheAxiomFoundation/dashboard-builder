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
  /**
   * Resolve an identifier (rule name or input name) → its corresponding
   * trace node. Pulled from the parent's tokenIndex.
   */
  lookup: (name: string) => TraceNode | undefined;
  onDrillInto: (node: TraceNode) => void;
  onExposeInput?: (legalId: string) => void;
  exposedInputIds?: Set<string>;
}

/**
 * Renders a rule's formula as a structured tree. Every operator (and / or /
 * not / comparison / arithmetic / function call / if-else) is a labeled
 * box that shows its evaluated value on the right; operands render
 * indented. Identifiers resolve to:
 *   • rule pills (clickable to drill in)
 *   • input pills (with user/default tag and expose action)
 *   • literal values (numbers / booleans)
 *
 * The rule's structure becomes its explanation — no separate "sub-rules /
 * inputs" lists, no annotations crammed into a single line of code.
 */
export function FormulaTree({
  formula,
  lookup,
  onDrillInto,
  onExposeInput,
  exposedInputIds,
}: Props) {
  const ast = parseFormula(formula);
  const lookupValue = (name: string): EvalValue => {
    const t = lookup(name);
    if (!t) return null;
    return t.value as EvalValue;
  };

  return (
    <div className="ftree">
      <NodeView
        node={ast}
        lookup={lookup}
        lookupValue={lookupValue}
        onDrillInto={onDrillInto}
        onExposeInput={onExposeInput}
        exposedInputIds={exposedInputIds}
      />
    </div>
  );
}

interface NodeProps {
  node: AstNode;
  lookup: (name: string) => TraceNode | undefined;
  lookupValue: (name: string) => EvalValue;
  onDrillInto: (node: TraceNode) => void;
  onExposeInput?: (legalId: string) => void;
  exposedInputIds?: Set<string>;
}

function NodeView(props: NodeProps): JSX.Element {
  const { node } = props;
  switch (node.kind) {
    case "ident":
      return <IdentNode {...props} node={node} />;
    case "number":
      return <LiteralLeaf value={node.value} />;
    case "bool":
      return <LiteralLeaf value={node.value} />;
    case "logical":
      return <LogicalNode {...props} node={node} />;
    case "comparison":
      return <ComparisonNode {...props} node={node} />;
    case "arith":
      return <ArithNode {...props} node={node} />;
    case "unary":
      return <UnaryNode {...props} node={node} />;
    case "call":
      return <CallNode {...props} node={node} />;
    case "index":
      return <IndexNode {...props} node={node} />;
    case "ifElse":
      return <IfElseNode {...props} node={node} />;
    case "error":
      return <span className="ftree-error">{node.text}</span>;
  }
}

// ─── Leaves ──────────────────────────────────────────────────────────────

function IdentNode({ node, lookup, onDrillInto, onExposeInput, exposedInputIds }: NodeProps & { node: Extract<AstNode, { kind: "ident" }> }) {
  const trace = lookup(node.name);
  if (!trace) {
    // Unknown identifier — could be a parameter the engine resolves silently.
    return <span className="ftree-ident-unknown">{node.name}</span>;
  }
  if (trace.dtype === "input") {
    const exposed =
      exposedInputIds?.has(trace.legalId) ?? trace.inputSource === "user";
    return (
      <span className={`ftree-leaf ftree-leaf-input ${exposed ? "is-user" : "is-default"}`}>
        <span className="ftree-leaf-tag">{exposed ? "user" : "default"}</span>
        <span className="ftree-leaf-name">{trace.label || node.name}</span>
        <span className="ftree-leaf-value">{formatValue(trace.value)}</span>
        {!exposed && onExposeInput && (
          <button
            type="button"
            className="ftree-leaf-action"
            onClick={() => onExposeInput(trace.legalId)}
            title="Add this input to your dashboard"
          >
            + expose
          </button>
        )}
      </span>
    );
  }
  // Sub-rule
  const verdict = verdictClass(trace);
  return (
    <button
      type="button"
      className={`ftree-leaf ftree-leaf-rule ${verdict}`}
      onClick={() => onDrillInto(trace)}
      title="Drill into this rule"
    >
      <span className="ftree-leaf-glyph">{glyphFor(trace)}</span>
      <span className="ftree-leaf-name">{trace.label || node.name}</span>
      <span className="ftree-leaf-value">{formatValue(trace.value)}</span>
      <span className="ftree-leaf-arrow">›</span>
    </button>
  );
}

function LiteralLeaf({ value }: { value: number | boolean | string }) {
  const display = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  return <span className="ftree-leaf ftree-leaf-literal">{display}</span>;
}

// ─── Branches ────────────────────────────────────────────────────────────

function LogicalNode({ node, ...rest }: NodeProps & { node: Extract<AstNode, { kind: "logical" }> }) {
  // Flatten chained AND/OR into a list. `a and b and c` is parsed left-assoc
  // as `(a and b) and c`; we want it shown as one block of three operands.
  const op = node.op;
  const operands = flattenLogical(node, op);
  const value = evalAst(node, rest.lookupValue);
  const verdict = boolVerdict(value);

  // Mark the deciding clause(s) — for AND, any false; for OR, any true.
  const decidingTest =
    op === "and" ? (v: EvalValue) => v !== null && !toBool(v) : (v: EvalValue) => v !== null && toBool(v);

  const operandValues = operands.map((o) => evalAst(o, rest.lookupValue));
  const anyDecisive = operandValues.some(decidingTest);

  return (
    <Box
      label={op === "and" ? "ALL OF" : "ANY OF"}
      kind="logical"
      verdict={verdict}
      value={formatValue(value)}
    >
      {operands.map((child, i) => {
        const v = operandValues[i];
        const isDeciding = anyDecisive && decidingTest(v ?? null);
        return (
          <Row key={i} highlight={isDeciding ? (op === "and" ? "fail" : "pass") : null}>
            <NodeView node={child} {...rest} />
          </Row>
        );
      })}
    </Box>
  );
}

function flattenLogical(node: AstNode, op: "and" | "or"): AstNode[] {
  if (node.kind === "logical" && node.op === op) {
    return [...flattenLogical(node.left, op), ...flattenLogical(node.right, op)];
  }
  return [node];
}

function ComparisonNode({ node, ...rest }: NodeProps & { node: Extract<AstNode, { kind: "comparison" }> }) {
  const value = evalAst(node, rest.lookupValue);
  const verdict = boolVerdict(value);
  return (
    <Box label={`COMPARE  ${node.op}`} kind="comparison" verdict={verdict} value={formatValue(value)}>
      <Row><NodeView node={node.left} {...rest} /></Row>
      <Row muted>{node.op}</Row>
      <Row><NodeView node={node.right} {...rest} /></Row>
    </Box>
  );
}

function ArithNode({ node, ...rest }: NodeProps & { node: Extract<AstNode, { kind: "arith" }> }) {
  const op = node.op;
  const operands = op === "+" || op === "*" ? flattenArith(node, op) : [node.left, node.right];
  const value = evalAst(node, rest.lookupValue);
  const label = op === "+" ? "SUM" : op === "-" ? "DIFFERENCE" : op === "*" ? "PRODUCT" : "QUOTIENT";
  return (
    <Box label={label} kind="arith" verdict="numeric" value={formatValue(value)}>
      {operands.map((child, i) => (
        <Row key={i}><NodeView node={child} {...rest} /></Row>
      ))}
    </Box>
  );
}

function flattenArith(node: AstNode, op: "+" | "*"): AstNode[] {
  if (node.kind === "arith" && node.op === op) {
    return [...flattenArith(node.left, op), ...flattenArith(node.right, op)];
  }
  return [node];
}

function UnaryNode({ node, ...rest }: NodeProps & { node: Extract<AstNode, { kind: "unary" }> }) {
  const value = evalAst(node, rest.lookupValue);
  const label = node.op === "not" ? "NOT" : "−";
  const verdict = node.op === "not" ? boolVerdict(value) : "numeric";
  return (
    <Box label={label} kind="unary" verdict={verdict} value={formatValue(value)}>
      <Row><NodeView node={node.operand} {...rest} /></Row>
    </Box>
  );
}

function CallNode({ node, ...rest }: NodeProps & { node: Extract<AstNode, { kind: "call" }> }) {
  const value = evalAst(node, rest.lookupValue);
  const verdict = isLikelyBoolFn(node.name) ? boolVerdict(value) : "numeric";
  return (
    <Box label={`CALL  ${node.name}`} kind="call" verdict={verdict} value={formatValue(value)}>
      {node.args.map((child, i) => (
        <Row key={i}><NodeView node={child} {...rest} /></Row>
      ))}
    </Box>
  );
}

function IndexNode({ node, ...rest }: NodeProps & { node: Extract<AstNode, { kind: "index" }> }) {
  return (
    <Box label="LOOKUP" kind="index" verdict="numeric" value={"—"}>
      <Row muted>table</Row>
      <Row><NodeView node={node.target} {...rest} /></Row>
      <Row muted>at</Row>
      <Row><NodeView node={node.index} {...rest} /></Row>
    </Box>
  );
}

function IfElseNode({ node, ...rest }: NodeProps & { node: Extract<AstNode, { kind: "ifElse" }> }) {
  const condValue = evalAst(node.cond, rest.lookupValue);
  const value = evalAst(node, rest.lookupValue);
  const condTrue = condValue !== null && toBool(condValue);
  const verdict = boolVerdict(value);
  return (
    <Box label="IF / ELSE" kind="ifelse" verdict={verdict} value={formatValue(value)}>
      <Row muted>if</Row>
      <Row><NodeView node={node.cond} {...rest} /></Row>
      <Row muted highlight={condValue === null ? null : condTrue ? "pass" : "fail"}>
        then  {condValue === null ? "" : condTrue ? "← active" : ""}
      </Row>
      <Row><NodeView node={node.then} {...rest} /></Row>
      <Row muted highlight={condValue === null ? null : condTrue ? "fail" : "pass"}>
        else  {condValue === null ? "" : condTrue ? "" : "← active"}
      </Row>
      <Row><NodeView node={node.else_} {...rest} /></Row>
    </Box>
  );
}

// ─── Layout primitives ───────────────────────────────────────────────────

function Box({
  label,
  kind,
  verdict,
  value,
  children,
}: {
  label: string;
  kind: string;
  verdict: "holds" | "fails" | "undet" | "numeric";
  value: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`ftree-box ftree-box-${kind} ftree-verdict-${verdict}`}>
      <header className="ftree-box-head">
        <span className="ftree-box-label">{label}</span>
        <span className="ftree-box-value">{value}</span>
      </header>
      <div className="ftree-box-body">{children}</div>
    </div>
  );
}

function Row({
  children,
  muted,
  highlight,
}: {
  children: React.ReactNode;
  muted?: boolean;
  highlight?: "pass" | "fail" | null;
}) {
  return (
    <div
      className={`ftree-row ${muted ? "ftree-row-muted" : ""} ${
        highlight === "pass" ? "ftree-row-pass" : ""
      } ${highlight === "fail" ? "ftree-row-fail" : ""}`}
    >
      {children}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatValue(v: EvalValue | unknown): string {
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

function boolVerdict(v: EvalValue): "holds" | "fails" | "undet" {
  if (v === null) return "undet";
  return toBool(v) ? "holds" : "fails";
}

function verdictClass(node: TraceNode): string {
  if (node.dtype === "judgment") {
    if (node.value === "holds") return "ftree-verdict-holds";
    if (node.value === "not_holds") return "ftree-verdict-fails";
    return "ftree-verdict-undet";
  }
  return "ftree-verdict-numeric";
}

function glyphFor(node: TraceNode): string {
  if (node.dtype === "judgment") {
    if (node.value === "holds") return "✓";
    if (node.value === "not_holds") return "✗";
    return "?";
  }
  return "ƒ";
}

const BOOL_FNS = new Set(["count_where", "any", "all"]);

function isLikelyBoolFn(name: string): boolean {
  return name === "any" || name === "all";
}

// `BOOL_FNS` referenced for future expansion.
void BOOL_FNS;

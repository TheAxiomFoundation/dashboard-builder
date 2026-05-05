/**
 * Recursive-descent parser + evaluator for the RuleSpec expression subset.
 *
 * RuleSpec formulas are short Python-shaped expressions: if/else, and/or/not,
 * comparisons, arithmetic, function calls, indexing, identifiers, literals.
 * Output is an AST the modal can render as a structural tree where every
 * sub-expression carries its evaluated value.
 *
 * Why we evaluate ourselves: the engine only emits values for *named* rules
 * — so for an unnamed sub-expression like `count_where(...) > 0` we have to
 * compute the boolean ourselves from the operand values to label the
 * containing box correctly.
 */

export type AstNode =
  | { kind: "ident"; name: string }
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "call"; name: string; args: AstNode[] }
  | { kind: "index"; target: AstNode; index: AstNode }
  | { kind: "unary"; op: "-" | "not"; operand: AstNode }
  | { kind: "logical"; op: "and" | "or"; left: AstNode; right: AstNode }
  | { kind: "comparison"; op: "==" | "!=" | "<" | "<=" | ">" | ">="; left: AstNode; right: AstNode }
  | { kind: "arith"; op: "+" | "-" | "*" | "/"; left: AstNode; right: AstNode }
  | { kind: "ifElse"; cond: AstNode; then: AstNode; else_: AstNode }
  | { kind: "error"; text: string };

interface Tok {
  kind: "ident" | "num" | "kw" | "op" | "lparen" | "rparen" | "lbracket" | "rbracket" | "comma" | "colon" | "eof";
  text: string;
}

const KEYWORDS = new Set([
  "and", "or", "not", "if", "then", "else", "elif",
  "true", "false", "True", "False", "None", "in", "is",
]);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /\w/.test(src[j]!)) j++;
      const text = src.slice(i, j);
      out.push({ kind: KEYWORDS.has(text) ? "kw" : "ident", text });
      i = j;
      continue;
    }
    if (/\d/.test(c)) {
      let j = i;
      while (j < src.length && /[\d.]/.test(src[j]!)) j++;
      out.push({ kind: "num", text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (i + 1 < src.length) {
      const two = src.slice(i, i + 2);
      if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
        out.push({ kind: "op", text: two });
        i += 2;
        continue;
      }
    }
    if ("+-*/<>".includes(c)) {
      out.push({ kind: "op", text: c });
      i++;
      continue;
    }
    if (c === "(") { out.push({ kind: "lparen", text: "(" }); i++; continue; }
    if (c === ")") { out.push({ kind: "rparen", text: ")" }); i++; continue; }
    if (c === "[") { out.push({ kind: "lbracket", text: "[" }); i++; continue; }
    if (c === "]") { out.push({ kind: "rbracket", text: "]" }); i++; continue; }
    if (c === ",") { out.push({ kind: "comma", text: "," }); i++; continue; }
    if (c === ":") { out.push({ kind: "colon", text: ":" }); i++; continue; }
    i++;
  }
  out.push({ kind: "eof", text: "" });
  return out;
}

class Parser {
  pos = 0;
  constructor(private toks: Tok[]) {}

  peek(): Tok {
    return this.toks[this.pos]!;
  }
  match(kind: Tok["kind"], text?: string): boolean {
    const t = this.peek();
    if (t.kind !== kind) return false;
    return text === undefined || t.text === text;
  }
  consume(): Tok {
    const t = this.peek();
    this.pos++;
    return t;
  }
  expect(kind: Tok["kind"], text?: string): Tok {
    if (!this.match(kind, text)) {
      throw new Error(
        `expected ${kind}${text ? ` "${text}"` : ""} but got "${this.peek().text}"`,
      );
    }
    return this.consume();
  }

  parseExpr(): AstNode {
    if (this.match("kw", "if")) return this.parseIf();
    return this.parseOr();
  }

  parseIf(): AstNode {
    this.expect("kw", "if");
    const cond = this.parseOr();
    this.expect("colon");
    const thenExpr = this.parseExpr();
    if (this.match("kw", "elif")) {
      this.consume();
      const elifCond = this.parseOr();
      this.expect("colon");
      const elifThen = this.parseExpr();
      const elseExpr = this.parseElse();
      return {
        kind: "ifElse",
        cond,
        then: thenExpr,
        else_: { kind: "ifElse", cond: elifCond, then: elifThen, else_: elseExpr },
      };
    }
    const elseExpr = this.parseElse();
    return { kind: "ifElse", cond, then: thenExpr, else_: elseExpr };
  }

  parseElse(): AstNode {
    this.expect("kw", "else");
    this.expect("colon");
    return this.parseExpr();
  }

  parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.match("kw", "or")) {
      this.consume();
      const right = this.parseAnd();
      left = { kind: "logical", op: "or", left, right };
    }
    return left;
  }

  parseAnd(): AstNode {
    let left = this.parseNot();
    while (this.match("kw", "and")) {
      this.consume();
      const right = this.parseNot();
      left = { kind: "logical", op: "and", left, right };
    }
    return left;
  }

  parseNot(): AstNode {
    if (this.match("kw", "not")) {
      this.consume();
      return { kind: "unary", op: "not", operand: this.parseNot() };
    }
    return this.parseComparison();
  }

  parseComparison(): AstNode {
    const left = this.parseArith();
    const t = this.peek();
    if (
      t.kind === "op" &&
      (t.text === "==" || t.text === "!=" || t.text === "<" || t.text === "<=" || t.text === ">" || t.text === ">=")
    ) {
      this.consume();
      const right = this.parseArith();
      return { kind: "comparison", op: t.text as "==" | "!=" | "<" | "<=" | ">" | ">=", left, right };
    }
    return left;
  }

  parseArith(): AstNode {
    let left = this.parseTerm();
    while (this.peek().kind === "op" && (this.peek().text === "+" || this.peek().text === "-")) {
      const op = this.consume().text as "+" | "-";
      const right = this.parseTerm();
      left = { kind: "arith", op, left, right };
    }
    return left;
  }

  parseTerm(): AstNode {
    let left = this.parseUnary();
    while (this.peek().kind === "op" && (this.peek().text === "*" || this.peek().text === "/")) {
      const op = this.consume().text as "*" | "/";
      const right = this.parseUnary();
      left = { kind: "arith", op, left, right };
    }
    return left;
  }

  parseUnary(): AstNode {
    if (this.peek().kind === "op" && this.peek().text === "-") {
      this.consume();
      return { kind: "unary", op: "-", operand: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  parsePostfix(): AstNode {
    let node = this.parseAtom();
    while (this.match("lbracket")) {
      this.consume();
      const idx = this.parseExpr();
      this.expect("rbracket");
      node = { kind: "index", target: node, index: idx };
    }
    return node;
  }

  parseAtom(): AstNode {
    const t = this.peek();
    if (t.kind === "num") {
      this.consume();
      return { kind: "number", value: parseFloat(t.text) };
    }
    if (t.kind === "kw" && (t.text === "true" || t.text === "True")) {
      this.consume();
      return { kind: "bool", value: true };
    }
    if (t.kind === "kw" && (t.text === "false" || t.text === "False")) {
      this.consume();
      return { kind: "bool", value: false };
    }
    if (t.kind === "ident") {
      const name = t.text;
      this.consume();
      if (this.match("lparen")) {
        this.consume();
        const args: AstNode[] = [];
        if (!this.match("rparen")) {
          args.push(this.parseExpr());
          while (this.match("comma")) {
            this.consume();
            args.push(this.parseExpr());
          }
        }
        this.expect("rparen");
        return { kind: "call", name, args };
      }
      return { kind: "ident", name };
    }
    if (t.kind === "lparen") {
      this.consume();
      const expr = this.parseExpr();
      this.expect("rparen");
      return expr;
    }
    return { kind: "error", text: `unexpected token "${t.text}"` };
  }
}

export function parseFormula(src: string): AstNode {
  try {
    const toks = tokenize(src);
    const parser = new Parser(toks);
    return parser.parseExpr();
  } catch (e) {
    return { kind: "error", text: String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Evaluator
// ─────────────────────────────────────────────────────────────────────────

export type EvalValue = number | boolean | string | null;

/**
 * Evaluate the AST against a lookup that resolves named identifiers to
 * concrete values (typically pulled from the engine's trace). Returns null
 * for sub-expressions we can't compute (table lookups, count_where without
 * member-level data, missing identifiers).
 */
export function evalAst(
  ast: AstNode,
  lookup: (name: string) => EvalValue,
): EvalValue {
  switch (ast.kind) {
    case "ident":
      return lookup(ast.name);
    case "number":
      return ast.value;
    case "bool":
      return ast.value;
    case "logical": {
      const l = evalAst(ast.left, lookup);
      const r = evalAst(ast.right, lookup);
      if (l === null || r === null) return null;
      const lb = toBool(l);
      const rb = toBool(r);
      return ast.op === "and" ? lb && rb : lb || rb;
    }
    case "unary": {
      const v = evalAst(ast.operand, lookup);
      if (v === null) return null;
      if (ast.op === "not") return !toBool(v);
      if (ast.op === "-" && typeof v === "number") return -v;
      return null;
    }
    case "comparison": {
      const l = evalAst(ast.left, lookup);
      const r = evalAst(ast.right, lookup);
      if (l === null || r === null) return null;
      if (ast.op === "==") return l === r;
      if (ast.op === "!=") return l !== r;
      const ln = toNum(l);
      const rn = toNum(r);
      if (ln === null || rn === null) return null;
      switch (ast.op) {
        case "<": return ln < rn;
        case "<=": return ln <= rn;
        case ">": return ln > rn;
        case ">=": return ln >= rn;
      }
      return null;
    }
    case "arith": {
      const l = evalAst(ast.left, lookup);
      const r = evalAst(ast.right, lookup);
      if (typeof l !== "number" || typeof r !== "number") return null;
      switch (ast.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return r === 0 ? null : l / r;
      }
      return null;
    }
    case "ifElse": {
      const c = evalAst(ast.cond, lookup);
      if (c === null) return null;
      return toBool(c) ? evalAst(ast.then, lookup) : evalAst(ast.else_, lookup);
    }
    case "call": {
      const args = ast.args.map((a) => evalAst(a, lookup));
      switch (ast.name) {
        case "min":
          return args.every((a) => typeof a === "number")
            ? Math.min(...(args as number[]))
            : null;
        case "max":
          return args.every((a) => typeof a === "number")
            ? Math.max(...(args as number[]))
            : null;
        case "abs":
          return typeof args[0] === "number" ? Math.abs(args[0]) : null;
        case "round":
          return typeof args[0] === "number" ? Math.round(args[0]) : null;
        case "floor":
          return typeof args[0] === "number" ? Math.floor(args[0]) : null;
        case "ceil":
          return typeof args[0] === "number" ? Math.ceil(args[0]) : null;
      }
      // count_where / sum_where / etc. need member-level data we don't have here.
      return null;
    }
    case "index":
      // Table lookup (e.g. snap_max_allotment_table[5]) — engine resolves it,
      // we can't (we don't have the table data on the client).
      return null;
    case "error":
      return null;
  }
}

export function toBool(v: EvalValue): boolean {
  if (typeof v === "boolean") return v;
  if (v === "holds") return true;
  if (v === "not_holds" || v === "undetermined") return false;
  if (typeof v === "number") return v !== 0;
  return false;
}

export function toNum(v: EvalValue): number | null {
  if (typeof v === "number") return v;
  return null;
}

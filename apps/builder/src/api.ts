/**
 * Compute service client. Every endpoint maps directly onto the FastAPI
 * service in `compute/`. Kept thin — no caching, no transforms — so the
 * builder UI is the only place data shapes evolve.
 */

const COMPUTE_URL =
  (import.meta.env.VITE_COMPUTE_URL as string | undefined) ?? "http://127.0.0.1:8787";

export const computeUrl = COMPUTE_URL;

export interface ProgramSummary {
  repo: string;
  path: string;
  kind: string;
  name: string;
  summary?: string;
}

export interface RuleNode {
  legalId: string;
  name: string;
  fileLegalId: string;
  kind: string | null;
  entity: string | null;
  dtype: string | null;
  period: string | null;
  unit: string | null;
  source: string | null;
  ruleDeps: string[];
  inputDeps: string[];
  relationDeps: string[];
  /** Latest-version formula text. Constant for parameter rules. */
  formula?: string | null;
}

export interface InputGraphNode {
  legalId: string;
  name: string;
  fileLegalId: string;
  dtype?: "money" | "decimal" | "integer" | "boolean" | "date" | "string" | null;
  sample: string | number | boolean | null;
  /** "Person" if the input is per-member of a relation; "Household" otherwise. */
  entity?: "Person" | "Household";
  /** When `entity === "Person"`, the relation the input belongs to (e.g. member_of_household). */
  relationLegalId?: string | null;
}

export interface RelationGraphNode {
  legalId: string;
  name: string;
  fileLegalId: string;
  memberInputIds: string[];
}

export interface ProgramGraph {
  rules: RuleNode[];
  inputs: InputGraphNode[];
  relations: RelationGraphNode[];
  ownOutputs: string[];
  terminalOutputs: string[];
}

export async function fetchRepos(): Promise<string[]> {
  const res = await fetch(`${COMPUTE_URL}/repos`);
  if (!res.ok) throw new Error(`failed to fetch repos: ${res.status}`);
  const json = await res.json();
  return json.repos ?? [];
}

export async function fetchPrograms(repo: string): Promise<ProgramSummary[]> {
  const res = await fetch(`${COMPUTE_URL}/repos/${encodeURIComponent(repo)}/programs`);
  if (!res.ok) throw new Error(`failed to fetch programs in ${repo}: ${res.status}`);
  const json = await res.json();
  return json.programs ?? [];
}

export async function fetchProgramGraph(
  repo: string,
  path: string,
): Promise<ProgramGraph> {
  const res = await fetch(
    `${COMPUTE_URL}/repos/${encodeURIComponent(repo)}/programs/${path}/graph`,
  );
  if (!res.ok) throw new Error(`failed to fetch graph: ${res.status}`);
  return await res.json();
}

export interface TransitiveResult {
  inputs: Record<string, number>; // legalId → depth
  relations: Record<string, number>;
}

export async function fetchTransitive(
  repo: string,
  path: string,
  outputs: string[],
): Promise<TransitiveResult> {
  const res = await fetch(
    `${COMPUTE_URL}/repos/${encodeURIComponent(repo)}/programs/${path}/transitive`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outputs }),
    },
  );
  if (!res.ok) throw new Error(`failed to fetch transitive deps: ${res.status}`);
  return await res.json();
}

export interface SensitivityResult {
  baseline: Array<{ legalId: string; value: unknown; dtype?: string }>;
  /** output_legal_id → list of input_legal_ids that move that output. */
  load_bearing: Record<string, string[]>;
  /** input_legal_id → evidence showing how perturbing that input moved outputs. */
  effects?: Record<
    string,
    Array<{
      output: string;
      before: unknown;
      after: unknown;
      perturbation: unknown;
    }>
  >;
  no_effect: string[];
  skipped: string[];
  mode: string;
}

/** Run sensitivity analysis: which inputs in the dependency closure of
 * the picked outputs actually move those outputs when perturbed?
 *
 * Takes 2-6 seconds for a CO-SNAP-sized program; intended to run in
 * the background after the user picks main results in Step II so the
 * answer is ready by Step III. Idempotent — call signature is the
 * cache key. */
export async function fetchSensitivity(
  program: { repo: string; path: string },
  outputs: string[],
  baseline: {
    inputs?: Record<string, string | number | boolean>;
    relations?: Record<string, Array<Record<string, string | number | boolean>>>;
  } = {},
  signal?: AbortSignal,
): Promise<SensitivityResult> {
  const res = await fetch(`${COMPUTE_URL}/sensitivity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      program,
      period: { start: "2026-01-01", end: "2026-02-01" },
      queried_outputs: outputs,
      inputs: baseline.inputs ?? {},
      relations: baseline.relations,
    }),
  });
  if (!res.ok) throw new Error(`failed to fetch sensitivity: ${res.status}`);
  return await res.json();
}

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

export interface PublishedDashboard {
  slug: string;
  rendererUrl: string;
  createdAt: string;
  updatedAt: string;
}

export async function publishDashboard(spec: unknown, slug?: string): Promise<PublishedDashboard> {
  const res = await fetch(`${COMPUTE_URL}/dashboards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec, slug }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`publish failed (${res.status}): ${detail}`);
  }
  return await res.json();
}

export interface DashboardListItem {
  slug: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  program: { repo: string; path: string; displayName?: string } | null;
}

export async function listDashboards(): Promise<DashboardListItem[]> {
  const res = await fetch(`${COMPUTE_URL}/dashboards`);
  if (!res.ok) throw new Error(`failed to list dashboards: ${res.status}`);
  const data = await res.json();
  return data.dashboards ?? [];
}

export interface SeededExample {
  slug: string;
  title: string;
  description: string;
  rendererUrl: string;
}

export async function fetchExamples(): Promise<SeededExample[]> {
  const res = await fetch(`${COMPUTE_URL}/examples`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.examples ?? [];
}

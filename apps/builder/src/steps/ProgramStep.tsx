import { useEffect, useMemo, useState } from "react";
import {
  fetchProgramGraph,
  fetchPrograms,
  fetchRepos,
  type ProgramSummary,
} from "../api";
import { emptyDraft, type Draft } from "../draft";

interface Props {
  draft: Draft;
  setDraft: (d: Draft) => void;
}

const KIND_LABEL: Record<string, string> = {
  policies: "Calculator",
  regulations: "Regulation",
  statutes: "Statute",
};

/**
 * Curated demo allowlist. While we're shaping the user experience and
 * verifying the engine + rule pack combo for individual programs, restrict
 * Step I to a known-working set. Each entry can override the human label
 * shown in the picker so users see "Colorado SNAP" instead of the
 * auto-generated stem.
 */
const CURATED_PROGRAMS: Array<{
  repo: string;
  path: string;
  label: string;
}> = [
  {
    repo: "rules-us-co",
    path: "policies/cdhs/snap/fy-2026-benefit-calculation.yaml",
    label: "Colorado SNAP",
  },
];

function curatedFor(p: ProgramSummary) {
  return CURATED_PROGRAMS.find((c) => c.repo === p.repo && c.path === p.path);
}

/**
 * Step I — pick a rule program (inline, not modal).
 *
 * Loads every program in every rule pack and presents them as one searchable
 * list with a "show component regulations & statutes" toggle. By default we
 * surface only `policies/` — the composed, calculator-shaped programs users
 * usually want; regs/statutes hide as building blocks.
 *
 * Once a program is chosen the list collapses behind a program card; "Change"
 * brings the list back.
 */
export function ProgramStep({ draft, setDraft }: Props) {
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [showBuildingBlocks, setShowBuildingBlocks] = useState(false);
  const [browsing, setBrowsing] = useState(!draft.program);

  // Lazy-load programs the first time the user opens this step.
  useEffect(() => {
    if (programs.length > 0 || loading) return;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const repos = await fetchRepos();
        const lists = await Promise.all(
          repos.map((r) => fetchPrograms(r).catch(() => [] as ProgramSummary[])),
        );
        setPrograms(lists.flat());
      } catch (e) {
        setLoadError(String(e));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    // Demo gate — only curated programs surface for selection right now.
    let pool = programs.filter((p) => !!curatedFor(p));

    const q = query.trim().toLowerCase();
    return pool
      .map((p) => ({ p, score: scoreProgram(p, q) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ p }) => p);
  }, [programs, query]);

  async function selectProgram(p: ProgramSummary) {
    setGraphLoading(true);
    setGraphError(null);
    try {
      const graph = await fetchProgramGraph(p.repo, p.path);
      const curated = curatedFor(p);
      const displayName = curated?.label ?? humanize(p.path);
      setDraft({
        ...emptyDraft(),
        program: { repo: p.repo, path: p.path, displayName },
        graph,
        meta: { title: displayName, description: p.summary ?? "" },
      });
      setBrowsing(false);
    } catch (e) {
      setGraphError(String(e));
    } finally {
      setGraphLoading(false);
    }
  }

  // Selected-program view (collapsed list).
  if (draft.program && !browsing) {
    const p = draft.program;
    return (
      <div className="step-body">
        {graphError && <div className="warning">{graphError}</div>}
        <div className="program-card card-edition is-active">
          <div className="program-info">
            <div className="name">{p.displayName}</div>
            {draft.meta.description && <div className="summary">{draft.meta.description}</div>}
            <div className="repo">
              {p.repo} · {p.path}
            </div>
          </div>
          <button className="btn secondary" onClick={() => setBrowsing(true)}>
            Change
          </button>
        </div>
        <div
          className="muted"
          style={{ fontFamily: "var(--f-serif)", fontStyle: "italic" }}
        >
          {(draft.graph?.rules.length ?? 0)} rules indexed ·{" "}
          {(draft.graph?.inputs.length ?? 0)} inputs available ·{" "}
          {(draft.graph?.relations.length ?? 0)} relations
        </div>
      </div>
    );
  }

  // Browsing view — inline search + list.
  return (
    <div className="step-body">
      {loadError && <div className="warning">{loadError}</div>}
      {graphError && <div className="warning">{graphError}</div>}

      <p
        className="muted"
        style={{ fontFamily: "var(--f-serif)", fontStyle: "italic", marginBottom: 4 }}
      >
        We're piloting the builder against one program at a time. More on the way.
      </p>

      {graphLoading && (
        <div className="empty-hint">Loading program graph…</div>
      )}

      <div className="program-list">
        {filtered.length === 0 && !loading && (
          <div className="empty-hint">
            No matches. {query ? "Try a different search term" : "Toggle component regulations & statutes above"}.
          </div>
        )}
        {filtered.map((p) => (
          <ProgramRow
            key={`${p.repo}/${p.path}`}
            program={p}
            isCurrent={
              draft.program?.repo === p.repo && draft.program?.path === p.path
            }
            onSelect={() => void selectProgram(p)}
          />
        ))}
      </div>

      {draft.program && (
        <button
          className="btn secondary"
          onClick={() => setBrowsing(false)}
          style={{ alignSelf: "flex-start" }}
        >
          ← Back to current selection
        </button>
      )}
    </div>
  );
}

function ProgramRow({
  program,
  isCurrent,
  onSelect,
}: {
  program: ProgramSummary;
  isCurrent: boolean;
  onSelect: () => void;
}) {
  const curated = curatedFor(program);
  const summary = program.summary?.trim();
  const filenameStem = (program.path.replace(/\.yaml$/, "").split("/").pop() ?? program.path).replace(/[-_]/g, " ");
  const headline = curated?.label ?? (summary ? splitSentence(summary).head : filenameStem);
  const sub = curated ? summary : (summary ? splitSentence(summary).rest : "");

  return (
    <button
      type="button"
      className={`program-row ${isCurrent ? "is-current" : ""}`}
      onClick={onSelect}
    >
      <div className="program-row-main">
        <span className="name">{headline}</span>
        {sub && <span className="rest">{sub}</span>}
        <span className="legal-id">{program.path}</span>
      </div>
      <div className="program-row-meta">
        <span className={`kind-pill kind-${program.kind}`}>
          {KIND_LABEL[program.kind] ?? program.kind}
        </span>
        <span className="repo-tag">{program.repo}</span>
      </div>
    </button>
  );
}

function scoreProgram(p: ProgramSummary, q: string): number {
  const haystack = `${p.summary ?? ""} ${p.name} ${p.path} ${p.repo}`.toLowerCase();
  const kindBonus = p.kind === "policies" ? 50 : 0;
  if (!q) return 100 + kindBonus;
  if (!haystack.includes(q)) return 0;

  const summary = (p.summary ?? "").toLowerCase();
  let s = 1 + kindBonus;
  if (summary.startsWith(q)) s += 200;
  else if (summary.includes(q)) s += 100;
  if (p.name.toLowerCase().includes(q)) s += 30;
  if (p.repo.toLowerCase().includes(q)) s += 50;
  return s;
}

function splitSentence(summary: string): { head: string; rest: string } {
  const period = summary.indexOf(". ");
  if (period > 0 && period < 100) {
    return {
      head: summary.slice(0, period + 1),
      rest: summary.slice(period + 2, period + 200),
    };
  }
  return { head: summary, rest: "" };
}

function humanize(path: string): string {
  return (path.replace(/\.yaml$/, "").split("/").pop() ?? path).replace(/[-_]/g, " ");
}

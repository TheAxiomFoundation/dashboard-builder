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
export interface CuratedMainOutput {
  legalId: string;
  /** Friendly card title — overrides the rule's auto-humanized name. */
  label: string;
  /** One-sentence card subtitle, civic-tech-leader vocabulary. */
  blurb?: string;
}

export interface CuratedProgram {
  repo: string;
  path: string;
  label: string;
  /** Curated "main results" surfaced as cards on Step II. Order matters. */
  mainOutputs?: CuratedMainOutput[];
  /** Snake-case prefix to strip from rule names before humanizing. The
   * program acronym repeats on every rule (e.g. `snap_*`), and showing
   * "Snap X" / "Snap Y" / "Snap Z" stacked down the picker just adds
   * visual noise — the user already knows they're in SNAP. */
  labelPrefix?: string;
  /** Recommended "starter pack" of inputs to auto-expose when the user
   * picks their first main result. Gives a brand-new user a working
   * calculator out of the box instead of an inert one that always
   * returns fixture values. Person-scope inputs auto-route into the
   * declared relation. */
  recommendedInputs?: RecommendedInput[];
  /** Curated labels/defaults for inputs we may recommend later from
   * computation-tree analysis, without necessarily preloading every one
   * into the first form. */
  inputDefaults?: RecommendedInput[];
  /** Default member count to apply to any auto-exposed relation. */
  recommendedMemberCount?: number;
}

export interface RecommendedInput {
  legalId: string;
  /** Optional display label override (otherwise auto-humanized). */
  label?: string;
  /** Optional sample default value. The dashboard form will pre-fill
   * with this so the calculator returns a meaningful answer on first
   * load. Falls back to the spec's auto-default if absent. */
  default?: string | number | boolean;
}

const CURATED_PROGRAMS: CuratedProgram[] = [
  {
    repo: "rulespec-us-co",
    path: "policies/cdhs/snap/fy-2026-benefit-calculation.yaml",
    label: "Colorado SNAP",
    labelPrefix: "snap",
    recommendedMemberCount: 1,
    recommendedInputs: [
      // Capped starter set: enough to move eligibility and amount, without
      // flooding the form with every reachable rule-pack input.
      {
        legalId:
          "us-co:regulations/10-ccr-2506-1/4.207.3#input.household_size",
        label: "Household size",
        default: 1,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_lives_in_application_state",
        label: "Lives in Colorado",
        default: true,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_in_project_area_solely_for_vacation",
        label: "In Colorado only for vacation",
        default: false,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_contains_individual_participating_in_more_than_one_household_or_project_area",
        label: "Household member already participates elsewhere",
        default: false,
      },
      {
        legalId:
          "us-co:regulations/10-ccr-2506-1/4.403#input.employee_wages_received",
        label: "Monthly employee wages",
        default: 1500,
      },
      {
        legalId:
          "us-co:regulations/10-ccr-2506-1/4.408.1#input.liquid_resource_current_redemption_rate",
        label: "Liquid resources",
        default: 0,
      },
      {
        legalId:
          "us-co:regulations/10-ccr-2506-1/4.408.1#input.non_liquid_resource_market_value",
        label: "Non-liquid resources",
        default: 0,
      },
      {
        legalId:
          "us-co:policies/cdhs/snap/fy-2026-benefit-calculation#input.other_household_resource_value",
        label: "Other household resources",
        default: 0,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/6#input.member_refused_or_failed_to_provide_or_apply_for_ssn",
        label: "Refused or failed to provide/apply for SSN",
        default: false,
      },
    ],
    inputDefaults: [
      {
        legalId:
          "us-co:regulations/10-ccr-2506-1/4.403#input.employee_wages_received",
        label: "Monthly employee wages",
        default: 1500,
      },
      {
        legalId:
          "us-co:policies/cdhs/snap/fy-2026-benefit-calculation#input.household_shelter_costs_incurred",
        label: "Monthly rent or mortgage",
        default: 800,
      },
      {
        legalId:
          "us-co:regulations/10-ccr-2506-1/4.407.31#input.household_pays_electricity_utility_cost",
        label: "Pays an electricity bill",
        default: true,
      },
      {
        legalId: "us:regulations/7-cfr/273/24#input.member_age",
        label: "Age",
        default: 30,
      },
      {
        legalId: "us:regulations/7-cfr/273/4#input.member_is_us_citizen",
        label: "U.S. citizen",
        default: true,
      },
      {
        legalId:
          "us:statutes/7/2012/j#input.snap_member_is_elderly_or_disabled",
        label: "Elderly or has a disability",
        default: false,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_lives_in_application_state",
        label: "Lives in Colorado",
        default: true,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_in_project_area_solely_for_vacation",
        label: "In Colorado only for vacation",
        default: false,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_contains_individual_participating_in_more_than_one_household_or_project_area",
        label: "Household member already participates elsewhere",
        default: false,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/6#input.member_refused_or_failed_to_provide_or_apply_for_ssn",
        label: "Refused or failed to provide/apply for SSN",
        default: false,
      },
      {
        legalId:
          "us-co:regulations/10-ccr-2506-1/4.408.1#input.liquid_resource_current_redemption_rate",
        label: "Liquid resources",
        default: 0,
      },
      {
        legalId:
          "us-co:regulations/10-ccr-2506-1/4.408.1#input.non_liquid_resource_market_value",
        label: "Non-liquid resources",
        default: 0,
      },
      {
        legalId:
          "us-co:policies/cdhs/snap/fy-2026-benefit-calculation#input.other_household_resource_value",
        label: "Other household resources",
        default: 0,
      },
      {
        legalId:
          "us-co:regulations/10-ccr-2506-1/4.408.1#input.real_property_county_assessor_actual_value",
        label: "Real property value",
        default: 0,
      },
    ],
    mainOutputs: [
      {
        legalId:
          "us-co:policies/cdhs/snap/fy-2026-benefit-calculation#snap_eligible",
        label: "Eligibility",
        blurb: "Whether the household qualifies for SNAP at all.",
      },
      {
        legalId:
          "us-co:regulations/10-ccr-2506-1/4.207.2#snap_allotment",
        label: "Benefit amount",
        blurb: "How much the household receives each month if eligible.",
      },
    ],
  },
  {
    repo: "rulespec-us-ca",
    path: "programs/snap/fy-2026.yaml",
    label: "California SNAP (CalFresh)",
    labelPrefix: "snap",
    recommendedMemberCount: 1,
    recommendedInputs: [
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_lives_in_application_state",
        label: "Lives in California",
        default: true,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_in_project_area_solely_for_vacation",
        label: "In California only for vacation",
        default: false,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_contains_individual_participating_in_more_than_one_household_or_project_area",
        label: "Household member already participates elsewhere",
        default: false,
      },
      {
        legalId: "us:regulations/7-cfr/273/4#input.member_is_us_citizen",
        label: "U.S. citizen",
        default: true,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/6#input.member_refused_or_failed_to_provide_or_apply_for_ssn",
        label: "Refused or failed to provide/apply for SSN",
        default: false,
      },
    ],
    inputDefaults: [
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_lives_in_application_state",
        label: "Lives in California",
        default: true,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_in_project_area_solely_for_vacation",
        label: "In California only for vacation",
        default: false,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_contains_individual_participating_in_more_than_one_household_or_project_area",
        label: "Household member already participates elsewhere",
        default: false,
      },
      {
        legalId: "us:regulations/7-cfr/273/4#input.member_is_us_citizen",
        label: "U.S. citizen",
        default: true,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/6#input.member_refused_or_failed_to_provide_or_apply_for_ssn",
        label: "Refused or failed to provide/apply for SSN",
        default: false,
      },
    ],
    mainOutputs: [
      {
        legalId: "us-ca:programs/snap/fy-2026#snap_eligible",
        label: "Eligibility",
        blurb: "Whether the household appears eligible for CalFresh.",
      },
    ],
  },
  {
    repo: "rulespec-us-ny",
    path: "policies/otda/snap/fy-2026-benefit-calculation.yaml",
    label: "New York SNAP",
    labelPrefix: "snap",
    recommendedMemberCount: 1,
    recommendedInputs: [
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_lives_in_application_state",
        label: "Lives in New York",
        default: true,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_in_project_area_solely_for_vacation",
        label: "In New York only for vacation",
        default: false,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_contains_individual_participating_in_more_than_one_household_or_project_area",
        label: "Household member already participates elsewhere",
        default: false,
      },
      {
        legalId: "us:regulations/7-cfr/273/4#input.member_is_us_citizen",
        label: "U.S. citizen",
        default: true,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/6#input.member_refused_or_failed_to_provide_or_apply_for_ssn",
        label: "Refused or failed to provide/apply for SSN",
        default: false,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/10#input.snap_countable_earned_income",
        label: "Monthly earned income",
        default: 0,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/10#input.snap_countable_unearned_income",
        label: "Monthly unearned income",
        default: 0,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/8#input.snap_countable_financial_resources",
        label: "Countable financial resources",
        default: 0,
      },
      {
        legalId:
          "us-ny:policies/otda/snap/fy-2026-benefit-calculation#input.household_shelter_costs_incurred",
        label: "Monthly rent or mortgage",
        default: 0,
      },
    ],
    inputDefaults: [
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_lives_in_application_state",
        label: "Lives in New York",
        default: true,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_in_project_area_solely_for_vacation",
        label: "In New York only for vacation",
        default: false,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/3#input.household_contains_individual_participating_in_more_than_one_household_or_project_area",
        label: "Household member already participates elsewhere",
        default: false,
      },
      {
        legalId: "us:regulations/7-cfr/273/4#input.member_is_us_citizen",
        label: "U.S. citizen",
        default: true,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/6#input.member_refused_or_failed_to_provide_or_apply_for_ssn",
        label: "Refused or failed to provide/apply for SSN",
        default: false,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/10#input.snap_countable_earned_income",
        label: "Monthly earned income",
        default: 0,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/10#input.snap_countable_unearned_income",
        label: "Monthly unearned income",
        default: 0,
      },
      {
        legalId:
          "us:regulations/7-cfr/273/8#input.snap_countable_financial_resources",
        label: "Countable financial resources",
        default: 0,
      },
      {
        legalId:
          "us-ny:policies/otda/snap/fy-2026-benefit-calculation#input.household_shelter_costs_incurred",
        label: "Monthly rent or mortgage",
        default: 0,
      },
    ],
    mainOutputs: [
      {
        legalId:
          "us-ny:policies/otda/snap/fy-2026-benefit-calculation#snap_eligible",
        label: "Eligibility",
        blurb: "Whether the household appears eligible for SNAP in New York.",
      },
      {
        legalId: "us-ny:regulations/18-nycrr/387/14/a/1#snap_allotment",
        label: "Benefit amount",
        blurb: "Estimated monthly SNAP amount for the household.",
      },
    ],
  },
];

export function curatedFor(p: ProgramSummary): CuratedProgram | undefined {
  return CURATED_PROGRAMS.find(
    (c) => repoMatches(c.repo, p.repo) && c.path === p.path,
  );
}

export function curatedForDraft(
  program: { repo: string; path: string } | null,
): CuratedProgram | undefined {
  if (!program) return undefined;
  return CURATED_PROGRAMS.find(
    (c) => repoMatches(c.repo, program.repo) && c.path === program.path,
  );
}

function repoMatches(curatedRepo: string, actualRepo: string): boolean {
  if (curatedRepo === actualRepo) return true;
  const normalize = (repo: string) => repo.replace(/^rules-/, "rulespec-");
  return normalize(curatedRepo) === normalize(actualRepo);
}

export function curatedCoreQuestionIdsForOutputs(
  program: { repo: string; path: string } | null,
  outputIds: string[],
): string[] | null {
  const curated = curatedForDraft(program);
  if (!curated?.mainOutputs?.length || !curated.recommendedInputs?.length) {
    return null;
  }
  if (outputIds.length === 0) return null;

  const curatedOutputIds = new Set(
    curated.mainOutputs.map((output) => output.legalId),
  );
  const isCuratedOutputSet = outputIds.every((id) => curatedOutputIds.has(id));
  if (!isCuratedOutputSet) return null;

  return curated.recommendedInputs.map((input) => input.legalId).slice(0, 10);
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
    setGraphError(null);
    // Optimistic update — switch to the selected-program view immediately
    // with the metadata we already have. The graph fetch finishes in the
    // background and slots into the same draft when ready. This avoids
    // the visible "Loading program graph…" flash between click and the
    // selected card appearing.
    const curated = curatedFor(p);
    const displayName = curated?.label ?? humanize(p.path);
    setDraft({
      ...emptyDraft(),
      program: { repo: p.repo, path: p.path, displayName },
      graph: null,
      meta: { title: displayName, description: p.summary ?? "" },
    });
    setBrowsing(false);
    try {
      const graph = await fetchProgramGraph(p.repo, p.path);
      setDraft({
        ...emptyDraft(),
        program: { repo: p.repo, path: p.path, displayName },
        graph,
        meta: { title: displayName, description: p.summary ?? "" },
      });
    } catch (e) {
      setGraphError(String(e));
    }
  }

  // Selected-program view: keep the same layout as the browsing list so
  // the page doesn't reflow on selection. Show one .program-row marked
  // is-current with the same headline + one-sentence blurb, plus a
  // small "Change" link to flip back into browsing.
  if (draft.program && !browsing) {
    const p = draft.program;
    const blurb = trimToSentence(draft.meta.description ?? "", 120);
    return (
      <div className="step-body step-program-landing">
        {graphError && <div className="warning">{graphError}</div>}
        <div className="program-list">
          <div className="program-row is-current" aria-current="true">
            <div className="program-row-main">
              <span className="name">{p.displayName}</span>
              {blurb && <span className="rest">{blurb}</span>}
            </div>
          </div>
        </div>
        <button
          className="btn ghost program-change-btn"
          onClick={() => setBrowsing(true)}
        >
          Change program
        </button>
      </div>
    );
  }

  // Browsing view — inline search + list.
  return (
    <div className="step-body step-program-landing">
      {loadError && <div className="warning">{loadError}</div>}
      {graphError && <div className="warning">{graphError}</div>}

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

      <p className="program-pilot-note">
        We're piloting the builder with Colorado, California, and New York SNAP.
      </p>

      {draft.program && (
        <button
          className="btn secondary program-back-btn"
          onClick={() => setBrowsing(false)}
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
  // Trim the supporting blurb to one clean sentence on a word boundary —
  // anything longer reads as YAML lore, gets truncated mid-word, and
  // distracts from the headline + click affordance.
  const blurb = trimToSentence(curated ? summary ?? "" : splitSentence(summary ?? "").rest, 120);

  return (
    <button
      type="button"
      className={`program-row ${isCurrent ? "is-current" : ""}`}
      onClick={onSelect}
    >
      <div className="program-row-main">
        <span className="name">{headline}</span>
        {blurb && <span className="rest">{blurb}</span>}
      </div>
    </button>
  );
}

/** Take the first sentence of `s`, capped at `maxChars` characters with a
 *  word-boundary ellipsis. Avoids the mid-word truncation that the raw
 *  CSS line-clamp produced. */
function trimToSentence(s: string, maxChars: number): string {
  const cleaned = s.trim();
  if (!cleaned) return "";
  const period = cleaned.search(/[.!?](\s|$)/);
  let head = period > 0 ? cleaned.slice(0, period + 1) : cleaned;
  if (head.length > maxChars) {
    const cutAt = head.lastIndexOf(" ", maxChars - 1);
    head = (cutAt > 40 ? head.slice(0, cutAt) : head.slice(0, maxChars)).trimEnd() + "…";
  }
  return head;
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

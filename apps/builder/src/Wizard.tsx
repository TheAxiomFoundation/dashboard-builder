/**
 * Wizard controller.
 *
 * The builder asks the user four sequential questions — one at a time, with a
 * pill bar at the top so they can jump between completed steps. Each step
 * defines `canContinue(draft)` so we can disable the Continue button until
 * the user has done what's needed. The user can always go Back.
 *
 * Design: editorial wizard with mono eyebrow + thin display heading + serif
 * lede paragraph, mirroring axiom-foundation.org's section treatment.
 */

import type { Draft } from "./draft";

export type StepId = "program" | "outputs" | "inputs" | "publish";

export interface StepDef {
  id: StepId;
  ordinal: string; // I, II, III, IV (Roman, used in eyebrow)
  index: number;
  label: string;
  /** Short editorial title shown as the step heading. */
  title: React.ReactNode;
  /** Lede paragraph under the heading. */
  lede: React.ReactNode;
  /** Returns true if the user has done enough on this step to advance. */
  canContinue: (draft: Draft) => boolean;
}

export const STEPS: StepDef[] = [
  {
    id: "program",
    ordinal: "I",
    index: 1,
    label: "Program",
    title: <>Choose a <em>rule program</em></>,
    lede: (
      <>
        Search every Axiom rule pack — federal, state, jurisdictional. Pick the
        program your calculator is going to compute against.
      </>
    ),
    canContinue: (d) => !!d.program && !!d.graph,
  },
  {
    id: "outputs",
    ordinal: "II",
    index: 2,
    label: "Outputs",
    title: <>What should it <em>show</em>?</>,
    lede: (
      <>
        Pick the values the calculator will display. Presentation — currency,
        eligibility, plain number — is inferred from each rule's declared type.
      </>
    ),
    canContinue: (d) => d.outputs.length > 0,
  },
  {
    id: "inputs",
    ordinal: "III",
    index: 3,
    label: "Inputs",
    title: <>What should the user <em>fill in</em>?</>,
    lede: (
      <>
        These inputs feed the outputs you picked. Toggle the ones the
        end-user should answer; the rest fall back to the program's test
        fixture so compute always succeeds.
      </>
    ),
    canContinue: () => true,
  },
  {
    id: "publish",
    ordinal: "IV",
    index: 4,
    label: "Demo",
    title: <>Name and <em>export</em></>,
    lede: (
      <>
        Preview the dashboard the end-user will see, and grab the spec as
        YAML or JSON to embed wherever you ship from.
      </>
    ),
    canContinue: () => true,
  },
];

interface IndicatorProps {
  current: StepId;
  draft: Draft;
  onJump: (id: StepId) => void;
}

export function StepIndicator({ current, draft, onJump }: IndicatorProps) {
  return (
    <nav className="steps" aria-label="Wizard progress">
      {STEPS.map((step, i) => {
        const isActive = step.id === current;
        const isComplete = step.canContinue(draft) && step.id !== current;
        const previousReached = i === 0 || STEPS[i - 1]!.canContinue(draft) || step.id === current;
        return (
          <div key={step.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              className={`step-pill ${isActive ? "active" : ""} ${isComplete ? "complete" : ""}`}
              onClick={() => onJump(step.id)}
              disabled={!previousReached}
              aria-current={isActive ? "step" : undefined}
            >
              <span className="step-num">{step.ordinal}</span>
              {step.label}
            </button>
            {i < STEPS.length - 1 && <span className="steps-divider" aria-hidden />}
          </div>
        );
      })}
    </nav>
  );
}

interface HeaderProps {
  step: StepDef;
}

export function StepHeader({ step }: HeaderProps) {
  return (
    <header>
      <span className="step-eyebrow">
        <span className="marker">§</span>
        Step {step.ordinal} · {step.label}
      </span>
      <h1 className="step-heading">{step.title}</h1>
      <p className="step-lede">{step.lede}</p>
    </header>
  );
}

interface NavProps {
  step: StepDef;
  draft: Draft;
  onBack: () => void;
  onNext: () => void;
  isLast: boolean;
}

export function StepNav({ step, draft, onBack, onNext, isLast }: NavProps) {
  return (
    <footer className="wizard-nav">
      <span className="step-progress">
        {step.ordinal} of {STEPS[STEPS.length - 1]!.ordinal}
      </span>
      <div className="nav-actions">
        <button
          className="btn secondary"
          onClick={onBack}
          disabled={step.index === 1}
        >
          ← Back
        </button>
        {!isLast && (
          <button
            className="btn primary"
            onClick={onNext}
            disabled={!step.canContinue(draft)}
          >
            Continue →
          </button>
        )}
      </div>
    </footer>
  );
}

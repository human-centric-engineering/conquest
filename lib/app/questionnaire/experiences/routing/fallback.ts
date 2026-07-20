/**
 * Routing fallback — pure, DB-free.
 *
 * What happens when the selector cannot be trusted: it errored, named a step that does not exist,
 * or reported confidence below the experience's threshold. Also the shape used when the run's cost
 * budget forces the fork closed.
 *
 * Every path through this module produces a complete {@link RoutingDecision} — the caller is never
 * left holding a null it has to invent a meaning for.
 */

import type {
  ExperienceRoutingFallback,
  RoutingDecision,
} from '@/lib/app/questionnaire/experiences/types';
import type { CandidateStep } from '@/lib/app/questionnaire/experiences/routing/types';

/** The respondent-facing line when a journey ends without routing onward. */
const CONCLUDE_MESSAGE =
  "Thanks — that's everything I need. I'm putting your summary together now.";

/** The respondent-facing line when the journey continues. Deliberately neutral about why. */
const CONTINUE_MESSAGE = "Thanks — there's one more area I'd like to explore with you.";

/** Conclude the run. The honest outcome whenever there is nothing trustworthy to route into. */
export function concludeDecision(
  rationale: string,
  source: RoutingDecision['source'] = 'fallback'
): RoutingDecision {
  return {
    decision: 'conclude',
    selectedStepKey: null,
    // Certain by construction: nothing was inferred, so reporting less than full confidence would
    // misrepresent what happened.
    confidence: 1,
    rationale,
    respondentMessage: CONCLUDE_MESSAGE,
    source,
  };
}

/** Route into a named step. */
export function routeDecision(
  stepKey: string,
  rationale: string,
  source: RoutingDecision['source'],
  respondentMessage: string = CONTINUE_MESSAGE
): RoutingDecision {
  return {
    decision: 'route',
    selectedStepKey: stepKey,
    confidence: 1,
    rationale,
    respondentMessage,
    source,
  };
}

/**
 * Apply the experience's configured fallback.
 *
 * `conclude` is the default and the recommended setting: finishing with what was gathered is
 * honest, whereas routing a respondent into a long follow-up on a coin-flip is not.
 *
 * Both routing fallbacks degrade to `conclude` when there is no candidate to fall back to — an
 * experience whose candidates were all deleted must not strand a respondent mid-journey.
 *
 * `defaultStepKey` is the author's nominated step for `default_step`; when it is absent or names a
 * step that is no longer a candidate, the first candidate is used rather than concluding, since
 * the author's intent was clearly "keep going".
 */
export function applyRoutingFallback(
  fallback: ExperienceRoutingFallback,
  candidates: readonly CandidateStep[],
  reason: string,
  defaultStepKey?: string | null
): RoutingDecision {
  const ordered = [...candidates].sort((a, b) => a.ordinal - b.ordinal);

  if (fallback === 'conclude' || ordered.length === 0) {
    const why =
      ordered.length === 0 && fallback !== 'conclude'
        ? `${reason}; no candidate steps remain, so the run concludes`
        : reason;
    return concludeDecision(`Fallback (${fallback}): ${why}`);
  }

  if (fallback === 'default_step') {
    const nominated = defaultStepKey
      ? ordered.find((c) => c.stepKey === defaultStepKey)
      : undefined;
    const chosen = nominated ?? ordered[0];
    const note = nominated
      ? `the nominated default step "${chosen.stepKey}"`
      : `the first candidate "${chosen.stepKey}" (no usable default step was nominated)`;
    return routeDecision(
      chosen.stepKey,
      `Fallback (default_step): ${reason}; routed to ${note}`,
      'fallback'
    );
  }

  // first_candidate
  const chosen = ordered[0];
  return routeDecision(
    chosen.stepKey,
    `Fallback (first_candidate): ${reason}; routed to the first candidate "${chosen.stepKey}"`,
    'fallback'
  );
}

/**
 * The decision when the run's cost budget is exhausted.
 *
 * Overrides the configured fallback entirely — even `first_candidate` — because continuing is
 * exactly what the budget exists to prevent. Recorded with `source: 'budget'` so an admin reading
 * the run can tell a budget stop from a selector judgement.
 */
export function budgetConcludeDecision(spentUsd: number, capUsd: number): RoutingDecision {
  return concludeDecision(
    `Run budget reached ($${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)}); concluding rather than starting another questionnaire.`,
    'budget'
  );
}

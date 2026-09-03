/**
 * Sectioned interviews (P21) — reading a finished session's sections back.
 *
 * The runtime resolves sections once per turn, inside `buildTurnContext`, and `sections/state.ts`
 * states the rule plainly: nothing else resolves sections. The artefacts (P21 phase D) need the
 * same answer after the conversation is over — the admin timeline asks "what happened in each
 * part", the report asks "which parts did this interview actually cover" — and the temptation is to
 * re-derive it from the stored `sectionRun` alone, which is cheaper and wrong.
 *
 * Wrong because the run records only KEYS. Labels, order, and membership live on the version, the
 * run is reconciled against them every turn, and a report or a timeline built from keys would show
 * bare identifiers, invent its own ordering, and silently lose a section the plan seated late. So
 * this goes through the one seam rather than around it, and pays a context build to do so. Both
 * callers are already doing far more expensive work (the report runs several LLM calls; the viewer
 * page loads a whole transcript), so the cost buys correctness at a price neither notices.
 *
 * Route-local and Prisma-backed, out of `lib/app/**`, mirroring `admin-session-view.ts`.
 */

import { buildTurnContext } from '@/app/api/v1/app/questionnaires/_lib/turn-context';
import type { InterviewSection } from '@/lib/app/questionnaire/sections/types';
import type { SectionRun } from '@/lib/app/questionnaire/sections/run';

/** What a session's sections resolved to, after the fact. */
export interface ResolvedSessionSections {
  /**
   * False when this interview was not sectioned — the version never opted in, or fewer than two
   * sections resolved. Every caller reads this ONE flag and falls back to its flat behaviour.
   */
  active: boolean;
  /** The resolved sections, in run order. Empty when not sectioned. */
  sections: readonly InterviewSection[];
  /** The reconciled run: which section was reached, closed, reopened. Null when not sectioned. */
  run: SectionRun | null;
}

/** The inert answer. Returned for every unsectioned session and every session that no longer exists. */
export const NO_SESSION_SECTIONS: ResolvedSessionSections = {
  active: false,
  sections: [],
  run: null,
};

/**
 * Resolve one session's sections and run state.
 *
 * Never throws for an absent session: a missing row resolves to {@link NO_SESSION_SECTIONS}, the
 * same value an unsectioned session gets. Both callers are decorating a surface they are already
 * rendering, and neither should fail over a section timeline it turns out has nothing to say.
 */
export async function resolveSessionSections(sessionId: string): Promise<ResolvedSessionSections> {
  const loaded = await buildTurnContext(sessionId);
  if (!loaded) return NO_SESSION_SECTIONS;

  const state = loaded.sectionState;
  if (!state.active || state.run === null) return NO_SESSION_SECTIONS;

  return { active: true, sections: state.sections, run: state.run };
}

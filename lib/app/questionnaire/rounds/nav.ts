/**
 * Cohorts & Rounds — admin URL helpers, nested under the demo-client detail surface.
 *
 * The two feature tabs (Cohorts, Rounds) are appended to the demo-client sub-nav by
 * `demo-clients/nav.ts` (opt-in there via `cohortsEnabled`). These helpers build the drill-down hrefs the
 * tables link to. Plain data inside the framework-agnostic `lib/app/**` boundary — SSR-safe.
 */

import { demoClientBase } from '@/lib/app/questionnaire/demo-clients/nav';

/** The cohorts table for a demo client. */
export function cohortsTabHref(demoClientId: string): string {
  return `${demoClientBase(demoClientId)}/cohorts`;
}

/** The rounds table for a demo client (across all its cohorts). */
export function roundsTabHref(demoClientId: string): string {
  return `${demoClientBase(demoClientId)}/rounds`;
}

/** One cohort's detail page (roster + its rounds). */
export function cohortDetailHref(demoClientId: string, cohortId: string): string {
  return `${demoClientBase(demoClientId)}/cohorts/${cohortId}`;
}

/** One round's detail page (bundled questionnaires + per-member progress). */
export function roundDetailHref(demoClientId: string, roundId: string): string {
  return `${demoClientBase(demoClientId)}/rounds/${roundId}`;
}

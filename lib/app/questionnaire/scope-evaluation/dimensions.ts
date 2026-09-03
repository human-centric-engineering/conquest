/**
 * The scope-judge-dimension registry (F17.21).
 *
 * Maps each {@link ScopeEvaluationDimension} to the seeded judge agent's slug, a human-readable
 * label, and a one-line summary of what it scores. Mirrors `evaluation/dimensions.ts` exactly: the
 * seed (`091-scope-evaluation-judges.ts`) iterates it to upsert four agents, the prompt builder
 * (`judge-prompt.ts`) pairs each dimension with its rubric, and the evaluate-preview route loads
 * each agent by `slug` to dispatch the panel.
 *
 * Pure and dependency-light, so the seed can import it without pulling any HTTP/DB graph into the
 * seed runtime.
 */

import {
  SCOPE_EVALUATION_DIMENSIONS,
  type ScopeEvaluationDimension,
} from '@/lib/app/questionnaire/scope-evaluation/types';

/** What the registry records for one dimension. */
export interface ScopeDimensionSpec {
  /** Slug of the seeded `kind='judge'` agent for this dimension. */
  slug: string;
  /** Human-readable agent name / label. */
  label: string;
  /** One-line summary of what the judge scores (used in the seed description + admin UI). */
  summary: string;
}

/**
 * Per-dimension specs. Slugs are app-namespaced and kebab-cased, matching the design-evaluation
 * judges' `app-questionnaire-scope-judge-*` naming. A `satisfies` clause forces an entry for every
 * dimension — adding one to the tuple won't compile until its spec is filled in here.
 */
export const SCOPE_EVALUATION_DIMENSION_SPECS = {
  criteria_quality: {
    slug: 'app-questionnaire-scope-judge-criteria-quality',
    label: 'Criteria-Quality Judge',
    summary:
      "Scores whether each conditional topic's criteria are specific and observable from what an opening conversation could plausibly surface, and whether two topics' criteria overlap or conflict.",
  },
  budget_realism: {
    slug: 'app-questionnaire-scope-judge-budget-realism',
    label: 'Budget-Realism Judge',
    summary:
      'Scores whether the session budget and opening-probe allowance leave realistic room for the topics that matter, and whether the conditional-topic cap fits the topic mix.',
  },
  coverage_and_burden: {
    slug: 'app-questionnaire-scope-judge-coverage-burden',
    label: 'Coverage-and-Burden Judge',
    summary:
      'Scores whether any topic has no realistic path to selection (an unreachable topic) or is effectively unconditional bloat, and whether overall topic count × depth risks overburdening a respondent.',
  },
} as const satisfies Record<ScopeEvaluationDimension, ScopeDimensionSpec>;

/** The three judge slugs, in dimension order — convenience for the route's panel load. */
export const SCOPE_EVALUATION_JUDGE_SLUGS: readonly string[] = SCOPE_EVALUATION_DIMENSIONS.map(
  (d) => SCOPE_EVALUATION_DIMENSION_SPECS[d].slug
);

/** Reverse lookup: judge slug → dimension. `undefined` for an unknown slug. */
export function scopeDimensionForSlug(slug: string): ScopeEvaluationDimension | undefined {
  return SCOPE_EVALUATION_DIMENSIONS.find((d) => SCOPE_EVALUATION_DIMENSION_SPECS[d].slug === slug);
}

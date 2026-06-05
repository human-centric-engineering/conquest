/**
 * The judge-dimension registry (F5.1).
 *
 * Maps each {@link EvaluationDimension} to the seeded judge agent's slug, a
 * human-readable label, and a one-line summary of what it scores. This is the single
 * source of truth the three F5.1 consumers share:
 *
 *  - the seed (`018-design-evaluation-judges.ts`) iterates it to upsert seven agents,
 *  - the prompt builder (`judge-prompt.ts`) pairs each dimension with its rubric,
 *  - the preview route loads each agent by `slug` to dispatch the panel.
 *
 * Pure and dependency-light (only the `types` import, erased at compile time), so the
 * seed can import it without pulling any HTTP/DB graph into the seed runtime — the
 * same discipline as `constants.ts`.
 */

import {
  EVALUATION_DIMENSIONS,
  type EvaluationDimension,
} from '@/lib/app/questionnaire/evaluation/types';

/** What the registry records for one dimension. */
export interface DimensionSpec {
  /** Slug of the seeded `kind='judge'` agent for this dimension. */
  slug: string;
  /** Human-readable agent name / label. */
  label: string;
  /** One-line summary of what the judge scores (used in the seed description + admin UI). */
  summary: string;
}

/**
 * Per-dimension specs. Slugs are app-namespaced (`app-questionnaire-judge-*`) and
 * kebab-cased so they read cleanly in the admin Judges list; the `snake_case`
 * dimension keys stay the programmatic identifier. A `satisfies` clause forces an
 * entry for every dimension — adding a dimension to the tuple won't compile until its
 * spec is filled in here.
 */
export const EVALUATION_DIMENSION_SPECS = {
  clarity: {
    slug: 'app-questionnaire-judge-clarity',
    label: 'Clarity Judge',
    summary:
      'Scores whether each question is unambiguous, single-barrelled, and pitched at the right reading level for the audience.',
  },
  coverage: {
    slug: 'app-questionnaire-judge-coverage',
    label: 'Coverage Judge',
    summary:
      "Scores whether the question set actually covers the questionnaire's stated goal, flagging gaps where the goal is under-served.",
  },
  duplicates: {
    slug: 'app-questionnaire-judge-duplicates',
    label: 'Duplicates Judge',
    summary:
      'Scores whether questions are distinct, flagging redundant or substantially overlapping questions across sections.',
  },
  type_fit: {
    slug: 'app-questionnaire-judge-type-fit',
    label: 'Type-Fit Judge',
    summary:
      'Scores whether each question’s answer type (free text, single/multi choice, likert, numeric, date, boolean) suits what it asks.',
  },
  ordering: {
    slug: 'app-questionnaire-judge-ordering',
    label: 'Ordering Judge',
    summary:
      'Scores whether questions flow in a sensible order — logical dependencies first, sensitive questions placed considerately.',
  },
  audience_match: {
    slug: 'app-questionnaire-judge-audience-match',
    label: 'Audience-Match Judge',
    summary:
      "Scores whether the register, length, and assumptions fit the version's stated audience.",
  },
  goal_match: {
    slug: 'app-questionnaire-judge-goal-match',
    label: 'Goal-Match Judge',
    summary:
      'Scores whether every question earns its place against the stated goal, flagging off-mission questions.',
  },
} as const satisfies Record<EvaluationDimension, DimensionSpec>;

/** The seven judge slugs, in dimension order — convenience for the route's panel load. */
export const EVALUATION_JUDGE_SLUGS: readonly string[] = EVALUATION_DIMENSIONS.map(
  (d) => EVALUATION_DIMENSION_SPECS[d].slug
);

/** Reverse lookup: judge slug → dimension. `undefined` for an unknown slug. */
export function dimensionForSlug(slug: string): EvaluationDimension | undefined {
  return EVALUATION_DIMENSIONS.find((d) => EVALUATION_DIMENSION_SPECS[d].slug === slug);
}

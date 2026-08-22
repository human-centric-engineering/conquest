/**
 * Per-dimension specs for the interviewer-policy judge panel (F18.8).
 *
 * Split from `types.ts` on purpose, exactly as the two sibling panels split theirs: the `const`
 * tuple lives in `types.ts` (no imports), the registry here, so the seed can import slug + label +
 * summary without dragging the DB graph in.
 *
 * The **rubric** is deliberately NOT on the spec. It lives in `judge-prompt.ts` as its own
 * `Record<Dimension, DimensionRubric>` — git-diffable and reviewed — while a seeded agent's
 * `systemInstructions` is only a mirror so the agent is self-describing in the admin UI. The
 * capability never reads the seeded text.
 */

import {
  POLICY_EVALUATION_DIMENSIONS,
  type PolicyEvaluationDimension,
} from '@/lib/app/questionnaire/policy-evaluation/types';

export interface PolicyDimensionSpec {
  /** Slug of the seeded `kind='judge'` agent for this dimension. */
  slug: string;
  /** Human-readable agent name / UI label. */
  label: string;
  /** One-line summary of what the judge scores (used in the seed description + admin UI). */
  summary: string;
}

/**
 * App-namespaced, kebab-cased slugs, matching the `app-questionnaire-scope-judge-*` naming the
 * scope panel established. A `satisfies` clause forces an entry for every dimension — adding one to
 * the tuple will not compile until its spec is filled in here.
 */
export const POLICY_EVALUATION_DIMENSION_SPECS = {
  rule_coherence: {
    slug: 'app-questionnaire-policy-judge-rule-coherence',
    label: 'Rule-Coherence Judge',
    summary:
      'Scores the house rules as prose — rules that contradict each other, say the same thing twice, or are too vague for an interviewer to act on. The judgement calls the keyword checker cannot make.',
  },
  arc_fit: {
    slug: 'app-questionnaire-policy-judge-arc-fit',
    label: 'Arc-Fit Judge',
    summary:
      'Scores whether the questioning arc — approach, pace, opening and tactics — suits this questionnaire’s goal, audience and length, reasoning against the pre-computed pace profile.',
  },
  fidelity_calibration: {
    slug: 'app-questionnaire-policy-judge-fidelity-calibration',
    label: 'Fidelity-Calibration Judge',
    summary:
      'Scores whether the ask-as-written dial is set consistently across the instrument, and whether each question held to its wording actually earns the cost of doing so.',
  },
  cross_layer_conflict: {
    slug: 'app-questionnaire-policy-judge-cross-layer',
    label: 'Cross-Layer Judge',
    summary:
      'The only judge that reads the layers against each other — a rule that fights a tone dial, an arc that starves the routing planner, questions held to their wording where routing may never reach them.',
  },
} as const satisfies Record<PolicyEvaluationDimension, PolicyDimensionSpec>;

/** The four judge slugs, in dimension order — convenience for the route's panel load. */
export const POLICY_EVALUATION_JUDGE_SLUGS: readonly string[] = POLICY_EVALUATION_DIMENSIONS.map(
  (d) => POLICY_EVALUATION_DIMENSION_SPECS[d].slug
);

/** Reverse lookup: judge slug → dimension. `undefined` for an unknown slug. */
export function policyDimensionForSlug(slug: string): PolicyEvaluationDimension | undefined {
  return POLICY_EVALUATION_DIMENSIONS.find(
    (d) => POLICY_EVALUATION_DIMENSION_SPECS[d].slug === slug
  );
}

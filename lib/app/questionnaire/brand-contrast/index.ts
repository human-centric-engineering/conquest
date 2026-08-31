/**
 * Contrast optimiser — public surface.
 *
 * Mirrors `brand-import/index.ts`. The pure modules (`result`, `shade`, `audit`) are safe in a
 * `'use client'` component; `advise` (Prisma + provider) and `optimise` are server-only, so the
 * dialog imports its types from `result` directly rather than through this barrel.
 */

export {
  CONTRAST_PAIRS,
  OPTIMISABLE_FIELDS,
  isOptimisableField,
  type ContrastFinding,
  type ContrastPairId,
  type ContrastProposal,
  type ContrastRepair,
  type OptimisableField,
  type OptimiseOutcome,
  type OptimiseResult,
} from '@/lib/app/questionnaire/brand-contrast/result';

export {
  nearestReadableShade,
  shadeOf,
  type Shade,
  type ShadeConstraint,
} from '@/lib/app/questionnaire/brand-contrast/shade';

export {
  FIELD_LABELS,
  MIN_UI_CONTRAST_RATIO,
  auditTheme,
  contrastPairs,
  type AuditedPair,
} from '@/lib/app/questionnaire/brand-contrast/audit';

export {
  advise,
  applyPicks,
  describeRepair,
  recommendDefault,
  type AdviseInput,
  type AdviseResult,
} from '@/lib/app/questionnaire/brand-contrast/advise';

export {
  optimiseContrast,
  type OptimiseInput,
} from '@/lib/app/questionnaire/brand-contrast/optimise';

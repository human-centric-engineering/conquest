/**
 * Confidence visual language for the respondent answer panel (F7.2).
 *
 * Pure mapping from a 0–1 capture confidence (or `null` = unscored) to a quiet,
 * semantic band — high / moderate / low / unscored — plus the Tailwind classes and
 * the human-facing label the panel renders. The band thresholds mirror the admin
 * evaluation chips (`evaluation-metric-chips.tsx`) so the platform reads one visual
 * language for "how sure are we"; the copy here is respondent-facing (no raw score),
 * per the human-centric principle that confidence should be felt, not totted up.
 *
 * Prisma/React-free so it unit-tests in isolation and both the indicator and any
 * future consumer can share it.
 */

export type ConfidenceBand = 'high' | 'moderate' | 'low' | 'unscored';

/** Classify a 0–1 confidence (or null) into a band. Out-of-range clamps sensibly. */
export function confidenceBand(confidence: number | null): ConfidenceBand {
  if (confidence === null || Number.isNaN(confidence)) return 'unscored';
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.6) return 'moderate';
  return 'low';
}

/** Tailwind classes for a band — light-tinted, quiet (matches the eval chips). */
export function confidenceBandClasses(band: ConfidenceBand): string {
  switch (band) {
    case 'high':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
    case 'moderate':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
    case 'low':
      return 'bg-red-500/15 text-red-700 dark:text-red-300';
    case 'unscored':
      return 'bg-muted text-muted-foreground';
  }
}

/** Respondent-facing label for a band — semantic, never a raw number. */
export function confidenceBandLabel(band: ConfidenceBand): string {
  switch (band) {
    case 'high':
      return 'Confident';
    case 'moderate':
      return 'Fairly sure';
    case 'low':
      return 'Unsure';
    case 'unscored':
      return 'Captured';
  }
}

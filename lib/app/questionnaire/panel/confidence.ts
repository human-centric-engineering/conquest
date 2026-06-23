/**
 * Confidence visual language for the respondent answer panel (F7.2).
 *
 * Pure mapping from a 0–1 capture confidence (or `null` = unscored) to a quiet,
 * semantic band — high / moderate / tentative / low / unscored — plus the Tailwind
 * classes and the human-facing label the panel renders.
 *
 * Four scored bands (not the earlier three) so the display tracks the finer extraction
 * rubric (0.3–1.0 by directness × elaboration × certainty): a directly-stated, backed
 * answer reads "Confident", a clear-but-bare one "Fairly sure", a terse/vague one
 * "Tentative", and a tangential inference "Unsure". This deliberately DECOUPLES the
 * respondent panel from the admin evaluation chips (`evaluation-metric-chips.tsx`,
 * still two-cut at 0.85/0.6) — the panel now needs the extra resolution to make the
 * new nuance legible, where the admin chips do not.
 *
 * Prisma/React-free so it unit-tests in isolation and both the indicator and any
 * future consumer can share it.
 */

export type ConfidenceBand = 'high' | 'moderate' | 'tentative' | 'low' | 'unscored';

/** Classify a 0–1 confidence (or null) into a band. Out-of-range clamps sensibly. */
export function confidenceBand(confidence: number | null): ConfidenceBand {
  if (confidence === null || Number.isNaN(confidence)) return 'unscored';
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.65) return 'moderate';
  if (confidence >= 0.45) return 'tentative';
  return 'low';
}

/** Tailwind classes for a band — light-tinted, quiet (emerald → amber → orange → red). */
export function confidenceBandClasses(band: ConfidenceBand): string {
  switch (band) {
    case 'high':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
    case 'moderate':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
    case 'tentative':
      return 'bg-orange-500/15 text-orange-700 dark:text-orange-300';
    case 'low':
      return 'bg-red-500/15 text-red-700 dark:text-red-300';
    case 'unscored':
      return 'bg-muted text-muted-foreground';
  }
}

/**
 * Raw 0–1 confidence as a rounded percentage string (or null when unscored). The semantic band
 * (above) is the default "felt, not totted" language; this is for surfaces that deliberately show
 * the score — e.g. the demo answer panel, where the operator wants the number visible.
 */
export function confidencePercent(confidence: number | null): string | null {
  if (confidence === null || Number.isNaN(confidence)) return null;
  const clamped = Math.min(1, Math.max(0, confidence));
  return `${Math.round(clamped * 100)}%`;
}

/** Respondent-facing label for a band — semantic, paired with the raw % by the panel. */
export function confidenceBandLabel(band: ConfidenceBand): string {
  switch (band) {
    case 'high':
      return 'Confident';
    case 'moderate':
      return 'Fairly sure';
    case 'tentative':
      return 'Tentative';
    case 'low':
      return 'Unsure';
    case 'unscored':
      return 'Captured';
  }
}

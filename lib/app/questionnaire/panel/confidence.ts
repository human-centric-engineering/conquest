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

/**
 * The band's text + dark-mode text colour — the one piece the quiet tint and the solid fill share.
 * Private: callers want a complete class string ({@link confidenceBandClasses} /
 * {@link confidenceBandSolidClasses}), not the text fragment alone. Literal per-branch so Tailwind's
 * content scanner still sees every token.
 */
function confidenceBandTextClasses(band: ConfidenceBand): string {
  switch (band) {
    case 'high':
      return 'text-emerald-700 dark:text-emerald-300';
    case 'moderate':
      return 'text-amber-700 dark:text-amber-300';
    case 'tentative':
      return 'text-orange-700 dark:text-orange-300';
    case 'low':
      return 'text-red-700 dark:text-red-300';
    case 'unscored':
      return 'text-muted-foreground';
  }
}

/**
 * The band's SOLID `/80` background fill, on its own — the slot minimap's bar colour and the heavier
 * dot fill ({@link confidenceBandSolidClasses} composes this with the text colour). The minimap wants
 * only the `bg-*` token, so this is the shared source of truth both consumers read (no duplicated
 * palette to drift). Literal per-branch so Tailwind's content scanner still sees every token.
 */
export function confidenceBandSolidBg(band: ConfidenceBand): string {
  switch (band) {
    case 'high':
      return 'bg-emerald-500/80';
    case 'moderate':
      return 'bg-amber-500/80';
    case 'tentative':
      return 'bg-orange-500/80';
    case 'low':
      return 'bg-red-500/80';
    case 'unscored':
      return 'bg-foreground/40';
  }
}

/** Tailwind classes for a band — light-tinted, quiet (emerald → amber → orange → red). */
export function confidenceBandClasses(band: ConfidenceBand): string {
  const tint =
    band === 'high'
      ? 'bg-emerald-500/15'
      : band === 'moderate'
        ? 'bg-amber-500/15'
        : band === 'tentative'
          ? 'bg-orange-500/15'
          : band === 'low'
            ? 'bg-red-500/15'
            : 'bg-muted';
  return `${tint} ${confidenceBandTextClasses(band)}`;
}

/**
 * Solid (heavier) Tailwind classes for a band — the same `/80` fills the slot minimap uses for its
 * bars (via {@link confidenceBandSolidBg}), so a dot rendered with these reads at the minimap's
 * darkness rather than the quiet `/15` tint. Keeps the band text colour for the inset ring.
 */
export function confidenceBandSolidClasses(band: ConfidenceBand): string {
  return `${confidenceBandSolidBg(band)} ${confidenceBandTextClasses(band)}`;
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

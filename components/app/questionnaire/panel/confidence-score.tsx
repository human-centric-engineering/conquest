/**
 * ConfidenceScore — a band-tinted chip showing the confidence as a label + raw percentage.
 *
 * Companion to {@link ConfidenceIndicator} (the quiet dot): this surfaces the actual score for the
 * demo answer panel, where the operator wants the number visible ("Confident · 88%"). Renders
 * nothing when the slot is unscored (no number to show). Band classes/label/percent come from the
 * shared pure helpers in `panel/confidence.ts`.
 */

import { cn } from '@/lib/utils';
import {
  confidenceBand,
  confidenceBandClasses,
  confidenceBandLabel,
  confidencePercent,
} from '@/lib/app/questionnaire/panel/confidence';

export interface ConfidenceScoreProps {
  /** 0–1 capture confidence, or null when unscored (then nothing renders). */
  confidence: number | null;
  className?: string;
}

export function ConfidenceScore({ confidence, className }: ConfidenceScoreProps) {
  const pct = confidencePercent(confidence);
  if (pct === null) return null;
  const band = confidenceBand(confidence);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
        confidenceBandClasses(band),
        className
      )}
      title={`${confidenceBandLabel(band)} — ${pct} confidence`}
    >
      {confidenceBandLabel(band)} · {pct}
    </span>
  );
}

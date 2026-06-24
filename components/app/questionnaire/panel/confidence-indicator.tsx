/**
 * ConfidenceIndicator — a quiet, semantic confidence dot for an answered slot (F7.2).
 *
 * Renders a small filled dot tinted by the confidence band (high / moderate / low /
 * unscored) with an accessible label and a hover tip carrying the band word — never a
 * raw score, per the human-centric principle that confidence should be felt, not
 * totted up. The band mapping is the shared pure helper in `panel/confidence.ts`.
 */

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import {
  confidenceBand,
  confidenceBandClasses,
  confidenceBandLabel,
  confidenceBandSolidClasses,
} from '@/lib/app/questionnaire/panel/confidence';

export interface ConfidenceIndicatorProps {
  /** 0–1 capture confidence, or null when unscored. */
  confidence: number | null;
  /** Use the heavier `/80` band fill (the slot minimap's darkness) instead of the quiet `/15` tint. */
  solid?: boolean;
  className?: string;
}

export function ConfidenceIndicator({ confidence, solid, className }: ConfidenceIndicatorProps) {
  const band = confidenceBand(confidence);
  const label = confidenceBandLabel(band);
  return (
    <Tip label={label}>
      <span
        role="img"
        aria-label={label}
        className={cn(
          'inline-flex h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-current/20 ring-inset',
          solid ? confidenceBandSolidClasses(band) : confidenceBandClasses(band),
          className
        )}
      />
    </Tip>
  );
}

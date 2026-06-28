'use client';

/**
 * LikertScale — a discrete integer rating control for the raw form surface
 * (P-presentation). Renders one button per point across `[min, max]` (inclusive),
 * supporting any contiguous integer range incl. negatives (e.g. 1–5, 1–7, −2..+2),
 * with optional endpoint labels beneath the ends. The platform has no rating
 * primitive, so this is app-local.
 */

import { cn } from '@/lib/utils';

// A selected point is filled with the brand CTA paint — the CTA gradient when the brand
// defines one (matching the chat's primary CTA), otherwise the solid CTA colour, falling
// back to the platform primary token when no brand is defined. The 1px border stays a
// solid colour (a gradient border-colour isn't expressible).
const BRAND_CTA = 'var(--app-cta-color, var(--color-primary))';
const BRAND_CTA_FILL = 'var(--app-cta-gradient, var(--app-cta-color, var(--color-primary)))';

export interface LikertScaleProps {
  min: number;
  max: number;
  minLabel?: string | null;
  maxLabel?: string | null;
  /** The selected point, or null when unanswered. */
  value: number | null;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Accessible group label (the question prompt). */
  ariaLabel?: string;
}

export function LikertScale({
  min,
  max,
  minLabel,
  maxLabel,
  value,
  onChange,
  disabled = false,
  ariaLabel,
}: LikertScaleProps) {
  // Guard a malformed range (max should be > min; the schema enforces it, but never crash).
  const points: number[] = [];
  if (Number.isInteger(min) && Number.isInteger(max) && max > min) {
    for (let n = min; n <= max; n += 1) points.push(n);
  }
  if (points.length === 0) return null;

  return (
    // `w-fit` shrinks the control to the button row's width so the endpoint labels below align to
    // the scale itself (left label under the first point, right label under the last) instead of
    // spreading across the whole question column. `max-w-full` lets the row wrap on narrow screens.
    <div className="w-fit max-w-full space-y-1.5">
      <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
        {points.map((n) => {
          const selected = n === value;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(n)}
              className={cn(
                'h-9 min-w-9 rounded-md border px-2 text-sm font-medium tabular-nums transition-colors',
                selected ? '' : 'border-input bg-background hover:bg-muted',
                disabled && 'cursor-not-allowed opacity-60'
              )}
              style={
                selected
                  ? {
                      borderColor: BRAND_CTA,
                      background: BRAND_CTA_FILL,
                      color: 'var(--color-primary-foreground, #fff)',
                    }
                  : undefined
              }
            >
              {n}
            </button>
          );
        })}
      </div>
      {(minLabel || maxLabel) && (
        // gap-6 keeps the two poles from colliding when the scale is narrow (a 2-point range);
        // justify-between pins each to its end of the now button-width row.
        <div className="text-muted-foreground flex justify-between gap-6 px-0.5 text-xs">
          <span>{minLabel ?? ''}</span>
          <span>{maxLabel ?? ''}</span>
        </div>
      )}
    </div>
  );
}

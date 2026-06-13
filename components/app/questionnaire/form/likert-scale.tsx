'use client';

/**
 * LikertScale — a discrete integer rating control for the raw form surface
 * (P-presentation). Renders one button per point across `[min, max]` (inclusive),
 * supporting any contiguous integer range incl. negatives (e.g. 1–5, 1–7, −2..+2),
 * with optional endpoint labels beneath the ends. The platform has no rating
 * primitive, so this is app-local.
 */

import { cn } from '@/lib/utils';

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
    <div className="space-y-1">
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
                selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input bg-background hover:bg-muted',
                disabled && 'cursor-not-allowed opacity-60'
              )}
            >
              {n}
            </button>
          );
        })}
      </div>
      {(minLabel || maxLabel) && (
        <div className="text-muted-foreground flex justify-between text-xs">
          <span>{minLabel ?? ''}</span>
          <span>{maxLabel ?? ''}</span>
        </div>
      )}
    </div>
  );
}

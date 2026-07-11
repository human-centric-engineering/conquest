'use client';

/**
 * MatrixField — a rating grid for the raw form surface (P-presentation). Renders one
 * row per matrix item, each rated on the grid's shared scale via {@link LikertScale}.
 * The composite answer value is a `{ [rowKey]: number }` map (one integer point per
 * rated row); partial answers are allowed (a respondent may leave rows blank). The
 * shared scale anchors are shown once above the grid so they don't repeat per row.
 */

import { readMatrixConfig } from '@/lib/app/questionnaire/form/type-config';
import { LikertScale } from '@/components/app/questionnaire/form/likert-scale';

export interface MatrixFieldProps {
  typeConfig: unknown;
  value: unknown;
  onChange: (value: Record<string, number>) => void;
  onBlur?: () => void;
  disabled?: boolean;
  /** Accessible label for the grid (the question prompt) — combined with each row label. */
  ariaLabel?: string;
}

/** Read the stored composite value into a clean `{ rowKey: number }` map (ignore junk). */
function asMatrixValue(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function MatrixField({
  typeConfig,
  value,
  onChange,
  onBlur,
  disabled,
  ariaLabel,
}: MatrixFieldProps) {
  const cfg = readMatrixConfig(typeConfig);
  if (!cfg) {
    return (
      <p className="text-muted-foreground text-sm italic">This rating grid isn’t configured yet.</p>
    );
  }
  const current = asMatrixValue(value);
  const setRow = (rowKey: string, point: number) => {
    onChange({ ...current, [rowKey]: point });
    // A rating pick is a complete interaction — flush the form's pending autosave now.
    onBlur?.();
  };

  return (
    <div className="space-y-3">
      {(cfg.minLabel || cfg.maxLabel) && (
        <div className="text-muted-foreground flex max-w-md justify-between gap-6 text-xs">
          <span>{cfg.minLabel ?? ''}</span>
          <span>{cfg.maxLabel ?? ''}</span>
        </div>
      )}
      <div className="space-y-3">
        {cfg.rows.map((row) => (
          <div key={row.key} className="space-y-1">
            <p className="text-sm font-medium">{row.label}</p>
            <LikertScale
              min={cfg.min}
              max={cfg.max}
              value={current[row.key] ?? null}
              onChange={(n) => setRow(row.key, n)}
              disabled={disabled}
              ariaLabel={`${ariaLabel ? `${ariaLabel} — ` : ''}${row.label}`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

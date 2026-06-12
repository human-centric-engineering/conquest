'use client';

/**
 * Granularity control for data-slot generation.
 *
 * A 5-segment selector (broad → fine) with "Balanced" in the middle as the default.
 * Broader settings ask the generator for fewer, higher-level slots; finer settings
 * ask for more, more granular ones. Pure presentational — owns no state.
 */

import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import { cn } from '@/lib/utils';
import {
  DATA_SLOT_GRANULARITY_LEVELS,
  type DataSlotGranularity,
} from '@/lib/app/questionnaire/data-slots';

export interface DataSlotGranularityFieldProps {
  value: DataSlotGranularity;
  onChange: (value: DataSlotGranularity) => void;
  disabled?: boolean;
}

export function DataSlotGranularityField({
  value,
  onChange,
  disabled,
}: DataSlotGranularityFieldProps) {
  const selected =
    DATA_SLOT_GRANULARITY_LEVELS.find((l) => l.value === value) ?? DATA_SLOT_GRANULARITY_LEVELS[2];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs">Granularity</Label>
        <FieldHelp title="Generation granularity">
          Controls how many data slots the generator aims for and how broad or fine each one is.{' '}
          <strong>Broader</strong> settings consolidate many questions into a few high-level slots;{' '}
          <strong>finer</strong> settings split distinct facets out, approaching one slot per
          question. Default: <code>Balanced</code>.
        </FieldHelp>
      </div>

      <div
        role="radiogroup"
        aria-label="Generation granularity"
        className="flex w-full max-w-md overflow-hidden rounded-md border"
      >
        {DATA_SLOT_GRANULARITY_LEVELS.map((level, i) => {
          const active = level.value === value;
          return (
            <button
              key={level.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange(level.value)}
              className={cn(
                'flex-1 px-2 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                i > 0 && 'border-l',
                active
                  ? 'bg-primary text-primary-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent'
              )}
            >
              {level.label}
            </button>
          );
        })}
      </div>

      <p className="text-muted-foreground text-xs">{selected.summary}</p>
    </div>
  );
}

'use client';

/**
 * RadioGroup — a lightweight single-select control for the raw form surface
 * (P-presentation). The platform has no shadcn RadioGroup and no extra Radix dep, so
 * this is an app-local, accessible native-radio implementation (real `<input
 * type="radio">` for keyboard + screen-reader behaviour, styled with the design
 * tokens). Used by the single-choice and boolean fields.
 */

import { cn } from '@/lib/utils';

export interface RadioOption {
  value: string;
  label: string;
}

export interface RadioGroupProps {
  /** Stable name binding the radios into one group (unique per question). */
  name: string;
  options: RadioOption[];
  /** The selected value, or null when nothing is selected. */
  value: string | null;
  onChange: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  className?: string;
}

export function RadioGroup({
  name,
  options,
  value,
  onChange,
  onBlur,
  disabled = false,
  className,
}: RadioGroupProps) {
  return (
    <div role="radiogroup" className={cn('flex flex-col gap-2', className)}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <label
            key={opt.value}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
              selected
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-input bg-background hover:bg-muted',
              disabled && 'cursor-not-allowed opacity-60'
            )}
          >
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(opt.value)}
              onBlur={onBlur}
              className="text-primary focus-visible:ring-ring h-4 w-4"
            />
            <span>{opt.label}</span>
          </label>
        );
      })}
    </div>
  );
}

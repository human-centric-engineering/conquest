'use client';

/**
 * QuestionField — renders the right input control for one question in the raw form
 * surface (P-presentation), dispatching on `slot.type`. Each control is controlled:
 * it reads the current `value` and reports edits through `onChange` (the form's
 * autosave debounces them) with an `onBlur` to flush. typeConfig is read through the
 * shared `lib/app/questionnaire/form/type-config.ts` helpers so the control matches
 * exactly what the server validates.
 *
 * Per-type values mirror what `validateAnswerValue` accepts: free_text → string,
 * single_choice → string, multi_choice → string[], likert/numeric → number, boolean →
 * boolean, date → ISO date string.
 */

import { Input } from '@/components/ui/input';
import { AutoTextarea } from '@/components/ui/auto-textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import {
  readBooleanConfig,
  readChoicesConfig,
  readLikertConfig,
  readNumericConfig,
} from '@/lib/app/questionnaire/form/type-config';
import { RadioGroup } from '@/components/app/questionnaire/form/radio-group';
import { LikertScale } from '@/components/app/questionnaire/form/likert-scale';
import { MatrixField } from '@/components/app/questionnaire/form/matrix-field';
import type { EditableSlot } from '@/lib/app/questionnaire/panel/types';

export interface QuestionFieldProps {
  slot: EditableSlot;
  value: unknown;
  onChange: (value: unknown) => void;
  onBlur?: () => void;
  disabled?: boolean;
}

/** The sentinel choice value for an "other" free-text option (single/multi choice). */
const OTHER = '__other__';

// A ticked multi-choice option carries the brand CTA colour (matching the radio/likert
// controls), falling back to the platform primary token when no brand is defined.
const BRAND_CTA = 'var(--app-cta-color, var(--color-primary))';
const BRAND_CTA_TINT =
  'color-mix(in srgb, var(--app-cta-color, var(--color-primary)) 12%, transparent)';

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function QuestionField({ slot, value, onChange, onBlur, disabled }: QuestionFieldProps) {
  switch (slot.type) {
    case 'free_text':
      return (
        <AutoTextarea
          value={asString(value)}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          disabled={disabled}
          rows={2}
          placeholder="Type your answer…"
        />
      );

    case 'single_choice':
      return (
        <SingleChoiceField
          slot={slot}
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          disabled={disabled}
        />
      );

    case 'multi_choice':
      return (
        <MultiChoiceField
          slot={slot}
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          disabled={disabled}
        />
      );

    case 'likert': {
      const cfg = readLikertConfig(slot.typeConfig);
      if (!cfg) {
        // Misconfigured scale — fall back to a plain integer input so the question is still answerable.
        return (
          <Input
            type="number"
            step={1}
            value={asNumber(value) ?? ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
            onBlur={onBlur}
            disabled={disabled}
            className="max-w-32"
          />
        );
      }
      return (
        <LikertScale
          min={cfg.min}
          max={cfg.max}
          minLabel={cfg.minLabel}
          maxLabel={cfg.maxLabel}
          value={asNumber(value)}
          onChange={onChange}
          disabled={disabled}
          ariaLabel={slot.prompt}
        />
      );
    }

    case 'matrix':
      return (
        <MatrixField
          typeConfig={slot.typeConfig}
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          disabled={disabled}
          ariaLabel={slot.prompt}
        />
      );

    case 'numeric': {
      const cfg = readNumericConfig(slot.typeConfig);
      return (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            value={asNumber(value) ?? ''}
            min={cfg.min ?? undefined}
            max={cfg.max ?? undefined}
            step={cfg.step ?? undefined}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
            onBlur={onBlur}
            disabled={disabled}
            className="max-w-40"
          />
          {cfg.unit && <span className="text-muted-foreground text-sm">{cfg.unit}</span>}
        </div>
      );
    }

    case 'boolean': {
      const cfg = readBooleanConfig(slot.typeConfig);
      const current = typeof value === 'boolean' ? (value ? 'true' : 'false') : null;
      return (
        <RadioGroup
          name={`q-${slot.slotKey}`}
          options={[
            { value: 'true', label: cfg.trueLabel },
            { value: 'false', label: cfg.falseLabel },
          ]}
          value={current}
          onChange={(v) => onChange(v === 'true')}
          onBlur={onBlur}
          disabled={disabled}
        />
      );
    }

    case 'date':
      return (
        <Input
          type="date"
          value={asString(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          onBlur={onBlur}
          disabled={disabled}
          className="max-w-48"
        />
      );
  }
}

function SingleChoiceField({ slot, value, onChange, onBlur, disabled }: QuestionFieldProps) {
  const cfg = readChoicesConfig('single_choice', slot.typeConfig);
  if (!cfg) return <p className="text-muted-foreground text-sm italic">No options configured.</p>;

  const current = asString(value);
  const isKnown = cfg.choices.some((c) => c.value === current);
  // An allowOther value is anything non-empty that isn't a known choice.
  const isOther = cfg.allowOther && current !== '' && !isKnown;
  const selected = isOther ? OTHER : isKnown ? current : null;

  const options = [...cfg.choices, ...(cfg.allowOther ? [{ value: OTHER, label: 'Other…' }] : [])];

  return (
    <div className="space-y-2">
      <RadioGroup
        name={`q-${slot.slotKey}`}
        options={options}
        value={selected}
        onChange={(v) => onChange(v === OTHER ? '' : v)}
        onBlur={onBlur}
        disabled={disabled}
      />
      {cfg.allowOther && selected === OTHER && (
        <Input
          value={isOther ? current : ''}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          disabled={disabled}
          placeholder="Your answer…"
          className="max-w-sm"
        />
      )}
    </div>
  );
}

function MultiChoiceField({ slot, value, onChange, onBlur, disabled }: QuestionFieldProps) {
  const cfg = readChoicesConfig('multi_choice', slot.typeConfig);
  if (!cfg) return <p className="text-muted-foreground text-sm italic">No options configured.</p>;

  const current = asStringArray(value);
  const knownValues = new Set(cfg.choices.map((c) => c.value));
  // The single free "other" entry (if any) is the selected value not in the known set.
  const otherValue = cfg.allowOther ? current.find((v) => !knownValues.has(v)) : undefined;

  const toggle = (optValue: string, checked: boolean) => {
    const next = checked ? [...current, optValue] : current.filter((v) => v !== optValue);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {cfg.choices.map((opt) => {
        const checked = current.includes(opt.value);
        return (
          <label
            key={opt.value}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
              checked ? '' : 'border-input bg-background hover:bg-muted',
              disabled && 'cursor-not-allowed opacity-60'
            )}
            style={
              checked ? { borderColor: BRAND_CTA, backgroundColor: BRAND_CTA_TINT } : undefined
            }
          >
            <Checkbox
              checked={checked}
              onCheckedChange={(c) => toggle(opt.value, c)}
              disabled={disabled}
              style={{ accentColor: BRAND_CTA }}
            />
            <span>{opt.label}</span>
          </label>
        );
      })}
      {cfg.allowOther && (
        <Input
          value={otherValue ?? ''}
          onChange={(e) => {
            const next = current.filter((v) => knownValues.has(v));
            const typed = e.target.value.trim();
            onChange(typed === '' ? next : [...next, typed]);
          }}
          onBlur={onBlur}
          disabled={disabled}
          placeholder="Other…"
          className="max-w-sm"
        />
      )}
    </div>
  );
}

/**
 * Client-safe `typeConfig` readers for the raw form surface (P-presentation).
 *
 * `AppQuestionSlot.typeConfig` is an opaque JSON column; the form field components
 * (`components/app/questionnaire/form/fields/**`) need its parsed, typed shape to
 * render the right control (a likert's bounds + endpoint labels, a choice's option
 * list, a numeric's min/max/step, a boolean's custom labels). These helpers parse a
 * raw `unknown` through the authoring schemas ({@link typeConfigSchemaFor} — the same
 * source of truth the write-time validator and {@link validateAnswerValue} use) and
 * return a narrow result or a safe default, so a render never throws on a malformed
 * or absent config.
 *
 * Pure (Zod only) and dependency-light, so a `'use client'` field component can
 * import it directly.
 */

import { typeConfigSchemaFor } from '@/lib/app/questionnaire/authoring/type-config-schema';

/** A choice question's options + whether a free-text "other" is allowed. */
export interface FormChoicesConfig {
  choices: Array<{ value: string; label: string }>;
  allowOther: boolean;
}

/** A likert scale's integer bounds and optional endpoint labels. */
export interface FormLikertConfig {
  min: number;
  max: number;
  minLabel: string | null;
  maxLabel: string | null;
}

/** A numeric question's optional bounds, step, and unit. */
export interface FormNumericConfig {
  min: number | null;
  max: number | null;
  step: number | null;
  unit: string | null;
}

/** A boolean question's labels for the true/false options (defaulted to Yes/No). */
export interface FormBooleanConfig {
  trueLabel: string;
  falseLabel: string;
}

/**
 * Parse a single_choice / multi_choice `typeConfig` into its option list. Returns
 * `null` when the config can't be read (the field then renders nothing selectable —
 * the caller treats it as a misconfigured question rather than guessing options).
 */
export function readChoicesConfig(
  type: 'single_choice' | 'multi_choice',
  typeConfig: unknown
): FormChoicesConfig | null {
  const parsed = typeConfigSchemaFor(type).safeParse(typeConfig);
  if (!parsed.success) return null;
  const cfg = parsed.data as {
    choices?: Array<{ value: string; label: string }>;
    allowOther?: boolean;
  };
  if (!Array.isArray(cfg.choices) || cfg.choices.length === 0) return null;
  return { choices: cfg.choices, allowOther: cfg.allowOther === true };
}

/**
 * Parse a likert `typeConfig` into its bounds + endpoint labels. Returns `null`
 * when unreadable (the caller falls back to a plain numeric input).
 */
export function readLikertConfig(typeConfig: unknown): FormLikertConfig | null {
  const parsed = typeConfigSchemaFor('likert').safeParse(typeConfig);
  if (!parsed.success) return null;
  const cfg = parsed.data as { min: number; max: number; minLabel?: string; maxLabel?: string };
  return {
    min: cfg.min,
    max: cfg.max,
    minLabel: cfg.minLabel ?? null,
    maxLabel: cfg.maxLabel ?? null,
  };
}

/**
 * Parse a numeric `typeConfig`. Numeric config is optional, so an absent/unreadable
 * config yields all-null bounds (an unconstrained number input).
 */
export function readNumericConfig(typeConfig: unknown): FormNumericConfig {
  const parsed = typeConfigSchemaFor('numeric').safeParse(typeConfig ?? {});
  if (!parsed.success) return { min: null, max: null, step: null, unit: null };
  const cfg = parsed.data as { min?: number; max?: number; step?: number; unit?: string };
  return {
    min: cfg.min ?? null,
    max: cfg.max ?? null,
    step: cfg.step ?? null,
    unit: cfg.unit ?? null,
  };
}

/**
 * Parse a boolean `typeConfig` into its option labels, defaulting to Yes/No. Boolean
 * config is optional, so an absent/unreadable config yields the defaults.
 */
export function readBooleanConfig(typeConfig: unknown): FormBooleanConfig {
  const parsed = typeConfigSchemaFor('boolean').safeParse(typeConfig ?? {});
  const cfg = parsed.success ? (parsed.data as { trueLabel?: string; falseLabel?: string }) : {};
  return {
    trueLabel: cfg.trueLabel ?? 'Yes',
    falseLabel: cfg.falseLabel ?? 'No',
  };
}

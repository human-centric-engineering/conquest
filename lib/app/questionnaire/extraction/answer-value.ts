/**
 * Per-type answer-value validation (F4.2).
 *
 * The extractor's LLM output carries a generic `value: unknown` (F1.1's
 * discipline — the model emits open JSON, semantics are enforced downstream, not
 * in the structured-output schema). This module is that downstream check: given a
 * slot's {@link QuestionType} and its stored `typeConfig`, it decides whether a
 * value is a legal answer for *that* slot and returns the normalised value to
 * record.
 *
 * It reads the slot's config through the F2.1 authoring schemas
 * (`typeConfigSchemaFor`), so choice-membership and likert/numeric bounds are
 * checked against the slot's actual options — something a static answer schema
 * can't express. Pure: Zod only, no Prisma / Next.
 *
 * Lenient where the LLM is reasonably loose (a numeric answer may arrive as
 * `"34"`; a boolean as `"yes"`), strict where correctness matters (a
 * single_choice value must be one of the slot's choices unless `allowOther`).
 */

import { z } from 'zod';

import { type QuestionType } from '@/lib/app/questionnaire/types';
import { typeConfigSchemaFor } from '@/lib/app/questionnaire/authoring/type-config-schema';

/** Discriminated result of validating one answer value against its slot's type. */
export type AnswerValueValidation = { ok: true; value: unknown } | { ok: false; issue: string };

const ok = (value: unknown): AnswerValueValidation => ({ ok: true, value });
const fail = (issue: string): AnswerValueValidation => ({ ok: false, issue });

/** A choice config narrowed to what value-checking needs (membership + allowOther). */
interface ChoiceConfig {
  values: Set<string>;
  allowOther: boolean;
}

/**
 * Parse a slot's stored `typeConfig` for a choice type into a membership set.
 * The config was validated at write time (F2.1), but we parse defensively: a
 * config that somehow fails to yield choices returns `null`, and the caller
 * treats membership as unconstrained rather than rejecting every answer.
 */
function readChoiceConfig(type: QuestionType, typeConfig: unknown): ChoiceConfig | null {
  const parsed = typeConfigSchemaFor(type).safeParse(typeConfig);
  if (!parsed.success) return null;
  const cfg = parsed.data as { choices?: Array<{ value: string }>; allowOther?: boolean };
  if (!Array.isArray(cfg.choices)) return null;
  return {
    values: new Set(cfg.choices.map((c) => c.value)),
    allowOther: cfg.allowOther === true,
  };
}

/** Read a likert scale's integer bounds from its (write-validated) config. */
function readLikertBounds(typeConfig: unknown): { min: number; max: number } | null {
  const parsed = typeConfigSchemaFor('likert').safeParse(typeConfig);
  if (!parsed.success) return null;
  const cfg = parsed.data as { min: number; max: number };
  return { min: cfg.min, max: cfg.max };
}

/** Read a numeric question's optional bounds. Absent config → no bounds. */
function readNumericBounds(typeConfig: unknown): { min?: number; max?: number } {
  const parsed = typeConfigSchemaFor('numeric').safeParse(typeConfig ?? {});
  if (!parsed.success) return {};
  return parsed.data as { min?: number; max?: number };
}

const isoDateLike = z.union([z.iso.datetime(), z.iso.date()]);

/**
 * Coerce a value to a finite number ONLY from a real number or a non-empty
 * numeric string. Deliberately stricter than `z.coerce.number()`, which would
 * turn `''`/`null`/`false`/`[]` into `0` and `true` into `1` — fabricating a
 * numeric answer where the respondent gave none. Returns `null` for anything
 * else so the caller drops it rather than recording a phantom value.
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function validateSingleChoice(value: unknown, typeConfig: unknown): AnswerValueValidation {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fail('single_choice value must be a non-empty string');
  }
  // Match (and store) the trimmed value so stray whitespace from the model
  // doesn't fail a membership check against the slot's exact choice slugs.
  const candidate = value.trim();
  const cfg = readChoiceConfig('single_choice', typeConfig);
  // No readable config → accept any string (defensive; config is normally present).
  if (cfg && !cfg.allowOther && !cfg.values.has(candidate)) {
    return fail(`value "${candidate}" is not one of the slot's choices`);
  }
  return ok(candidate);
}

function validateMultiChoice(value: unknown, typeConfig: unknown): AnswerValueValidation {
  if (!Array.isArray(value) || value.length === 0) {
    return fail('multi_choice value must be a non-empty array');
  }
  if (!value.every((v) => typeof v === 'string' && v.trim().length > 0)) {
    return fail('multi_choice value must be an array of non-empty strings');
  }
  const deduped = [...new Set((value as string[]).map((v) => v.trim()))];
  const cfg = readChoiceConfig('multi_choice', typeConfig);
  if (cfg && !cfg.allowOther) {
    const unknownValue = deduped.find((v) => !cfg.values.has(v));
    if (unknownValue !== undefined) {
      return fail(`value "${unknownValue}" is not one of the slot's choices`);
    }
  }
  return ok(deduped);
}

function validateLikert(value: unknown, typeConfig: unknown): AnswerValueValidation {
  const n = toFiniteNumber(value);
  if (n === null) return fail('likert value must be a number');
  if (!Number.isInteger(n)) return fail('likert value must be an integer');
  const bounds = readLikertBounds(typeConfig);
  if (bounds && (n < bounds.min || n > bounds.max)) {
    return fail(`likert value ${n} is outside the scale ${bounds.min}–${bounds.max}`);
  }
  return ok(n);
}

function validateNumeric(value: unknown, typeConfig: unknown): AnswerValueValidation {
  const n = toFiniteNumber(value);
  if (n === null) return fail('numeric value must be a number');
  const { min, max } = readNumericBounds(typeConfig);
  if (min != null && n < min) return fail(`numeric value ${n} is below the minimum ${min}`);
  if (max != null && n > max) return fail(`numeric value ${n} is above the maximum ${max}`);
  return ok(n);
}

function validateBoolean(value: unknown): AnswerValueValidation {
  if (typeof value === 'boolean') return ok(value);
  if (typeof value === 'string') {
    const normalised = value.trim().toLowerCase();
    if (['true', 'yes', 'y'].includes(normalised)) return ok(true);
    if (['false', 'no', 'n'].includes(normalised)) return ok(false);
  }
  return fail('boolean value must be true/false (or yes/no)');
}

function validateDate(value: unknown): AnswerValueValidation {
  if (typeof value !== 'string') return fail('date value must be an ISO-8601 string');
  return isoDateLike.safeParse(value).success
    ? ok(value)
    : fail('date value must be an ISO-8601 date or datetime');
}

function validateFreeText(value: unknown): AnswerValueValidation {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fail('free_text value must be a non-empty string');
  }
  return ok(value);
}

/**
 * Validate one extracted `value` against a slot's `type` and `typeConfig`. On
 * success, `value` is the normalised form to record (trimmed string, parsed
 * number, deduped array, coerced boolean). On failure, `issue` names what was
 * wrong — the normaliser carries it into the dropped-answer reason.
 */
export function validateAnswerValue(
  type: QuestionType,
  value: unknown,
  typeConfig: unknown
): AnswerValueValidation {
  switch (type) {
    case 'free_text':
      return validateFreeText(value);
    case 'single_choice':
      return validateSingleChoice(value, typeConfig);
    case 'multi_choice':
      return validateMultiChoice(value, typeConfig);
    case 'likert':
      return validateLikert(value, typeConfig);
    case 'numeric':
      return validateNumeric(value, typeConfig);
    case 'date':
      return validateDate(value);
    case 'boolean':
      return validateBoolean(value);
  }
}

/**
 * Per-question-type `typeConfig` validation (F2.1 / PR2).
 *
 * `AppQuestionSlot.typeConfig` is an opaque JSON column at the storage layer, but
 * each {@link QuestionType} has a specific config shape the authoring surface must
 * enforce at the boundary (the extractor's structured output is validated loosely
 * by `ingestion/extraction-schema.ts`; here the admin's hand edits are pinned
 * tightly). A choice question needs ≥2 distinct choices; a likert needs a bounded
 * integer scale; numeric bounds must be coherent.
 *
 * Pure: Zod only, no Prisma / Next. The route resolves the *effective* type (from
 * the PATCH body, falling back to the stored row) and calls
 * {@link validateTypeConfig}; the returned `value` is what gets written (with
 * config-less types normalised to `null`). Imports cleanly into client code so the
 * editor can pre-validate with the same rules.
 */

import { z } from 'zod';

import { QUESTION_TYPES, type QuestionType } from '@/lib/app/questionnaire/types';

/** One selectable option for a choice question. */
const choiceSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
});

/** single_choice / multi_choice: ≥2 options with distinct `value`s. */
const choicesConfigSchema = z
  .object({
    choices: z.array(choiceSchema).min(2),
    allowOther: z.boolean().optional(),
  })
  .superRefine((cfg, ctx) => {
    const values = cfg.choices.map((c) => c.value);
    if (new Set(values).size !== values.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Choice values must be unique',
        path: ['choices'],
      });
    }
  });

/** likert: a bounded integer scale, `max` strictly greater than `min`. */
const likertConfigSchema = z
  .object({
    min: z.number().int(),
    max: z.number().int(),
    minLabel: z.string().min(1).optional(),
    maxLabel: z.string().min(1).optional(),
  })
  .refine((c) => c.max > c.min, { message: 'max must be greater than min', path: ['max'] });

/** numeric: optional coherent bounds + step/unit. */
const numericConfigSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    unit: z.string().min(1).optional(),
  })
  .refine((c) => c.min == null || c.max == null || c.max >= c.min, {
    message: 'max must be greater than or equal to min',
    path: ['max'],
  });

/** boolean: optional custom labels (the extractor emits these). */
const booleanConfigSchema = z.object({
  trueLabel: z.string().min(1).optional(),
  falseLabel: z.string().min(1).optional(),
});

/**
 * `free_text` and `date` carry no config. We accept an absent value or an empty
 * object (the UI may send `{}`) and normalise both to `null`; any populated config
 * is rejected so a stray payload can't be silently stored.
 */
const noConfigSchema = z.union([z.null(), z.object({}).strict()]).transform(() => null);

const SCHEMA_BY_TYPE: Record<QuestionType, z.ZodTypeAny> = {
  free_text: noConfigSchema,
  date: noConfigSchema,
  single_choice: choicesConfigSchema,
  multi_choice: choicesConfigSchema,
  likert: likertConfigSchema,
  numeric: numericConfigSchema,
  boolean: booleanConfigSchema,
};

/** The Zod schema that validates `typeConfig` for a given question type. */
export function typeConfigSchemaFor(type: QuestionType): z.ZodTypeAny {
  return SCHEMA_BY_TYPE[type];
}

/** Discriminated result of validating a `typeConfig` against its question type. */
export type TypeConfigValidation =
  | { ok: true; value: unknown }
  | { ok: false; issues: z.core.$ZodIssue[] };

/**
 * Validate a raw `typeConfig` against `type`. On success, `value` is the parsed
 * config to store (`null` for config-less types). Config-required types
 * (choice/likert) reject a missing/`null` config; config-optional types
 * (numeric/boolean) accept an absent value as `{}`/defaults.
 */
export function validateTypeConfig(type: QuestionType, raw: unknown): TypeConfigValidation {
  // Config-optional types: treat absent as an empty config so the admin needn't
  // send `{}`. Required types keep `null`/undefined so the schema rejects it.
  const optionalConfig =
    type === 'numeric' || type === 'boolean' || type === 'free_text' || type === 'date';
  const candidate = raw === undefined && optionalConfig ? {} : raw === undefined ? null : raw;

  const result = typeConfigSchemaFor(type).safeParse(candidate);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}

/**
 * A valid default config for a freshly-chosen question type, co-located with the
 * schemas it must satisfy (so a tightening rule and its default move together).
 * The editor uses this when an admin changes a question's type, so the change
 * always validates. `null` for config-less types.
 */
export function defaultTypeConfig(type: QuestionType): unknown {
  switch (type) {
    case 'single_choice':
    case 'multi_choice':
      return {
        choices: [
          { value: 'option_1', label: 'Option 1' },
          { value: 'option_2', label: 'Option 2' },
        ],
      };
    case 'likert':
      return { min: 1, max: 5 };
    case 'numeric':
    case 'boolean':
      return {};
    default:
      return null;
  }
}

/** Re-export for callers iterating types (kept in lock-step with the schema map). */
export { QUESTION_TYPES };

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

import {
  QUESTION_TYPES,
  FREE_TEXT_COMMENT_AGGREGATIONS,
  type QuestionType,
} from '@/lib/app/questionnaire/types';

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

/**
 * likert base shape: a bounded integer scale plus optional per-point `labels`
 * (one human-readable word per scale point, `labels[i]` describing value
 * `min + i`). Legacy `minLabel`/`maxLabel` endpoint labels are still accepted so
 * pre-backfill rows keep reading. The base is shared by the *read* schema (labels
 * optional — bound-readers and answer validation must not reject an unlabelled row)
 * and the *write* schema (labels required — see {@link likertWriteConfigSchema}).
 */
const likertBaseShape = z.object({
  min: z.number().int(),
  max: z.number().int(),
  minLabel: z.string().min(1).optional(),
  maxLabel: z.string().min(1).optional(),
  /** Per-point labels (validated for completeness only by the *write* schema). */
  labels: z.array(z.string()).optional(),
});

const likertMaxGtMin = (c: { min: number; max: number }) => c.max > c.min;
const likertLabelsComplete = (c: { min: number; max: number; labels?: string[] }) =>
  Array.isArray(c.labels) &&
  c.labels.length === c.max - c.min + 1 &&
  c.labels.every((l) => l.trim().length > 0);

/**
 * likert (read): bounded integer scale, `max > min`. Deliberately lenient on `labels` — a
 * malformed/absent labels array must NOT cost the caller the valid bounds (answer validation,
 * scoring and the form reader all parse through this via {@link typeConfigSchemaFor}). Label
 * completeness is the write schema's concern; readers check the array themselves.
 */
const likertConfigSchema = likertBaseShape.refine(likertMaxGtMin, {
  message: 'max must be greater than min',
  path: ['max'],
});

/**
 * likert (write): bounded scale PLUS a hard requirement that every scale point carries a
 * non-empty label. A purely numeric rating (no qualitative meaning) must use the `numeric`
 * type instead — there is deliberately no "unlabelled likert". Enforced at the authoring
 * boundary by {@link validateTypeConfig} and reused by the launch gate.
 */
const likertWriteConfigSchema = likertBaseShape
  .refine(likertMaxGtMin, { message: 'max must be greater than min', path: ['max'] })
  .refine(likertLabelsComplete, {
    message:
      'a likert scale needs one label per point — label every point, or use the numeric type for an unlabelled rating',
    path: ['labels'],
  });

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
 * `date` carries no config. We accept an absent value or an empty object (the UI
 * may send `{}`) and normalise both to `null`; any populated config is rejected so
 * a stray payload can't be silently stored.
 */
const noConfigSchema = z.union([z.null(), z.object({}).strict()]).transform(() => null);

/**
 * `free_text` carries no *structural* config, but it MAY hold a single runtime
 * field — `commentAggregation` ('isolated' | 'section') — which the extractor/composer
 * classifies and {@link readCommentAggregation} reads to decide how the field's living
 * paraphrase is built. So it is NOT config-less: accept an absent value, an empty
 * object, or a lone `commentAggregation`, and reject any other key so a stray payload
 * still can't be silently stored. An empty/aggregation-less config normalises to `null`
 * (the default `isolated` behaviour needs nothing stored).
 */
const freeTextConfigSchema = z
  .union([
    z.null(),
    z.object({ commentAggregation: z.enum(FREE_TEXT_COMMENT_AGGREGATIONS).optional() }).strict(),
  ])
  .transform((cfg) => (cfg && cfg.commentAggregation ? cfg : null));

const SCHEMA_BY_TYPE: Record<QuestionType, z.ZodTypeAny> = {
  free_text: freeTextConfigSchema,
  date: noConfigSchema,
  single_choice: choicesConfigSchema,
  multi_choice: choicesConfigSchema,
  likert: likertConfigSchema,
  numeric: numericConfigSchema,
  boolean: booleanConfigSchema,
};

/**
 * Write-side schemas: identical to {@link SCHEMA_BY_TYPE} except likert, which here
 * requires complete per-point labels. Used by {@link validateTypeConfig} (the only
 * write path) so admin edits / persisted configs are pinned tightly, while the
 * read schemas stay lenient for legacy rows.
 */
const WRITE_SCHEMA_BY_TYPE: Record<QuestionType, z.ZodTypeAny> = {
  ...SCHEMA_BY_TYPE,
  likert: likertWriteConfigSchema,
};

/** The Zod schema that validates `typeConfig` for a given question type (read-side, lenient). */
export function typeConfigSchemaFor(type: QuestionType): z.ZodTypeAny {
  return SCHEMA_BY_TYPE[type];
}

/**
 * True when a likert `typeConfig` carries one non-empty label per scale point. The
 * single source of truth for "this scale is fully labelled", reused by the launch
 * gate, the ingestion normaliser, and the backfill script. Non-likert configs and
 * unreadable input return `false`.
 */
export function hasCompleteLikertLabels(typeConfig: unknown): boolean {
  return likertWriteConfigSchema.safeParse(typeConfig).success;
}

/** Discriminated result of validating a `typeConfig` against its question type. */
export type TypeConfigValidation =
  { ok: true; value: unknown } | { ok: false; issues: z.core.$ZodIssue[] };

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

  const result = WRITE_SCHEMA_BY_TYPE[type].safeParse(candidate);
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
      // A labelled 5-point agree scale — the most common default and, crucially, one
      // that already satisfies the write schema's "every point labelled" rule.
      return {
        min: 1,
        max: 5,
        labels: ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'],
      };
    case 'numeric':
    case 'boolean':
      return {};
    default:
      return null;
  }
}

/** Re-export for callers iterating types (kept in lock-step with the schema map). */
export { QUESTION_TYPES };

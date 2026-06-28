/**
 * The edit-op vocabulary for the Structure Edit Agent.
 *
 * The LLM's only job is to translate a plain-English instruction into a list of these ops; every op
 * then executes **deterministically** over the existing rows (see `resolve.ts`), so a mechanical
 * instruction ("CAPS every section title", "remove required from free-text fields") never drifts and
 * untouched fields are preserved. This is the literal "loop through questions and make edits" model.
 *
 * Pure Zod + types — no IO. The Zod schema is the boundary validator for the apply route (the ops
 * arrive back as untrusted JSON); `EDIT_OPS_JSON_SCHEMA` is the provider-native structured-output
 * shape forwarded to the model during translation.
 */

import { z } from 'zod';

import { QUESTION_TYPES } from '@/lib/app/questionnaire/types';

/** Case/whitespace transforms applied to a text field. */
export const TEXT_TRANSFORMS = ['uppercase', 'lowercase', 'titlecase', 'trim'] as const;
export type TextTransform = (typeof TEXT_TRANSFORMS)[number];

/** Selects a set of questions an op applies to. */
export const questionSelectorSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all') }),
  z.object({ scope: z.literal('section'), sectionOrdinal: z.number().int().nonnegative() }),
  z.object({ scope: z.literal('type'), questionType: z.enum(QUESTION_TYPES) }),
  z.object({ scope: z.literal('keys'), keys: z.array(z.string().min(1)).min(1) }),
]);
export type QuestionSelector = z.infer<typeof questionSelectorSchema>;

/** Selects a set of sections an op applies to. */
export const sectionSelectorSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all') }),
  z.object({
    scope: z.literal('ordinals'),
    ordinals: z.array(z.number().int().nonnegative()).min(1),
  }),
]);
export type SectionSelector = z.infer<typeof sectionSelectorSchema>;

const transform = z.enum(TEXT_TRANSFORMS);

/**
 * The discriminated union of edit operations. Kept deliberately small and deterministic: anything
 * that needs semantic rewriting of content ("make the prompts friendlier") belongs in the whole-doc
 * **rewrite** mode, not here.
 */
export const editOpSchema = z.discriminatedUnion('op', [
  /** Set the required flag on the matched questions. */
  z.object({ op: z.literal('set_required'), target: questionSelectorSchema, value: z.boolean() }),
  /** Set the weight (0.1–1.0) on the matched questions. */
  z.object({
    op: z.literal('set_weight'),
    target: questionSelectorSchema,
    value: z.number().min(0.1).max(1),
  }),
  /** Apply a case/whitespace transform to the matched questions' prompts. */
  z.object({ op: z.literal('transform_prompt'), target: questionSelectorSchema, transform }),
  /** Replace a single question's prompt with a literal value. */
  z.object({ op: z.literal('rename_prompt'), key: z.string().min(1), value: z.string().min(1) }),
  /** Apply a case/whitespace transform to the matched sections' titles. */
  z.object({ op: z.literal('transform_title'), target: sectionSelectorSchema, transform }),
  /** Replace a single section's title with a literal value. */
  z.object({
    op: z.literal('set_section_title'),
    sectionOrdinal: z.number().int().nonnegative(),
    value: z.string().min(1),
  }),
  /**
   * Renumber sections: `prefix-number` ensures each title is prefixed with its 1-based position
   * ("1. ", "2. "), replacing any existing leading number; `strip-number` removes such a prefix.
   */
  z.object({
    op: z.literal('renumber_sections'),
    style: z.enum(['prefix-number', 'strip-number']),
  }),
  /** Reorder sections — `order` is a permutation of the current section ordinals. */
  z.object({
    op: z.literal('reorder_sections'),
    order: z.array(z.number().int().nonnegative()).min(1),
  }),
  /** Move a question to another section, optionally at a specific index (else appended). */
  z.object({
    op: z.literal('move_question'),
    key: z.string().min(1),
    toSectionOrdinal: z.number().int().nonnegative(),
    toIndex: z.number().int().nonnegative().optional(),
  }),
]);
export type EditOp = z.infer<typeof editOpSchema>;

/** The translation result: the ops plus a one-line human summary of the intended change. */
export const editPlanSchema = z.object({
  summary: z.string().min(1).max(280),
  operations: z.array(editOpSchema).max(50),
});
export type EditPlan = z.infer<typeof editPlanSchema>;

/** Parse-and-validate helper for `runStructuredCompletion` (returns null on mismatch → retry). */
export function validateEditPlan(parsed: unknown): EditPlan | null {
  const result = editPlanSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Provider-native structured-output schema for the translation call. Hand-written (not derived from
 * Zod) so it stays a stable, readable contract the model is constrained to; `validateEditPlan` is the
 * cross-provider safety net regardless.
 */
export const EDIT_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One-line summary of what the edits do.' },
    operations: {
      type: 'array',
      description: 'The ordered edit operations to apply.',
      items: { type: 'object' },
    },
  },
  required: ['summary', 'operations'],
};

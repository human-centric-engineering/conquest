/**
 * Structured-output contracts for generative authoring (compose-from-brief +
 * refine).
 *
 * These mirror the extractor's {@link extractionSchema} but for a from-scratch
 * brief: there is no source document, so there is no editorial change log
 * (`changes`) — nothing was edited, everything was generated. The section and
 * question item schemas are **derived from** `extractionSchema` (`.shape.….element`)
 * so the generated shape can never drift from the persisted one.
 *
 * The streaming orchestrator splits the work in two — an outline call
 * ({@link composeOutlineSchema}) then a per-section question call
 * ({@link composeQuestionsSchema}) — while the single-shot capability emits the
 * whole {@link composeStructureSchema} at once. `toExtractionData` adapts any of
 * them onto the persistence-shaped `ExtractQuestionnaireStructureData` (with an
 * empty change log) the writer expects.
 *
 * Pure: Zod only, no Prisma / Next.js — safe under the `lib/app/**` boundary.
 */

import { z } from 'zod';

import {
  audienceShapeSchema,
  extractionSchema,
} from '@/lib/app/questionnaire/ingestion/extraction-schema';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities/extract-questionnaire-structure';

/** Single source of truth — the same section/question item shapes the extractor emits. */
const sectionSchema = extractionSchema.shape.sections.element;
const questionSchema = extractionSchema.shape.questions.element;

/** Phase 1 of the stream: sections + inferred goal/audience, no questions yet. */
export const composeOutlineSchema = z.object({
  sections: z.array(sectionSchema).min(1),
  inferredGoal: z.string().optional(),
  inferredAudience: audienceShapeSchema.optional(),
});
export type ComposeOutline = z.infer<typeof composeOutlineSchema>;

/** Phase 2 of the stream: the questions for one section (each carries its `sectionOrdinal`). */
export const composeQuestionsSchema = z.object({
  questions: z.array(questionSchema),
});
export type ComposeQuestions = z.infer<typeof composeQuestionsSchema>;

/**
 * The whole structure in one call (single-shot capability + refine output).
 * Mirrors {@link extractionSchema} minus the `changes` log.
 */
export const composeStructureSchema = z.object({
  sections: z.array(sectionSchema).min(1),
  questions: z.array(questionSchema),
  inferredGoal: z.string().optional(),
  inferredAudience: audienceShapeSchema.optional(),
});
export type ComposeStructure = z.infer<typeof composeStructureSchema>;

/** Refine turn: the full updated structure plus a one-line summary of what changed. */
export const refineStructureSchema = z.object({
  structure: composeStructureSchema,
  summary: z.string().min(1),
});
export type RefineStructureOutput = z.infer<typeof refineStructureSchema>;

/** Discriminated validation result, mirroring `validateExtraction`. */
export type ComposeValidation<T> =
  { ok: true; value: T } | { ok: false; issues: z.core.$ZodIssue[] };

function validate<T>(schema: z.ZodType<T>, parsed: unknown): ComposeValidation<T> {
  const result = schema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}

export const validateComposeOutline = (p: unknown): ComposeValidation<ComposeOutline> =>
  validate(composeOutlineSchema, p);
export const validateComposeQuestions = (p: unknown): ComposeValidation<ComposeQuestions> =>
  validate(composeQuestionsSchema, p);
export const validateComposeStructure = (p: unknown): ComposeValidation<ComposeStructure> =>
  validate(composeStructureSchema, p);
export const validateRefineStructure = (p: unknown): ComposeValidation<RefineStructureOutput> =>
  validate(refineStructureSchema, p);

/**
 * Adapt a generated {@link ComposeStructure} onto the persistence-shaped
 * `ExtractQuestionnaireStructureData` the graph writer consumes. The change log is
 * always empty — generation has no before-state to revert to. Optional inferred
 * goal/audience are forwarded only when present (the writer's merge treats absent
 * as "nothing inferred").
 */
export function toExtractionData(structure: ComposeStructure): ExtractQuestionnaireStructureData {
  return {
    sections: structure.sections,
    questions: structure.questions,
    changes: [],
    ...(structure.inferredGoal !== undefined ? { inferredGoal: structure.inferredGoal } : {}),
    ...(structure.inferredAudience !== undefined
      ? { inferredAudience: structure.inferredAudience }
      : {}),
  };
}

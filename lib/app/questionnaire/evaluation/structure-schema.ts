/**
 * Zod contract for the version-structure DTO judges read (F5.1).
 *
 * Single source of truth for the shape of {@link VersionStructureInput}, shared by two
 * consumers so they can't drift:
 *  - the `evaluate-structure` capability validates its `structure` arg with it, and
 *  - the route-local loader validates the version's stored `audience` JSON with
 *    {@link audienceShapeSchema} before handing the DTO to the dispatcher.
 *
 * Pure: Zod only, keyed off the real audience enums from `types.ts`. No Prisma / Next.
 */

import { z } from 'zod';

import {
  AUDIENCE_EXPERTISE_LEVELS,
  AUDIENCE_SENSITIVITY_LEVELS,
} from '@/lib/app/questionnaire/types';
import type { VersionStructureInput } from '@/lib/app/questionnaire/evaluation/types';

/** Caps on a serialised structure — generous for a real questionnaire, bounded against abuse. */
export const MAX_EVAL_SECTIONS = 200;
export const MAX_EVAL_QUESTIONS_PER_SECTION = 500;

/** The structured `AudienceShape`, validated against the real enums. `z.infer` ≅ AudienceShape. */
export const audienceShapeSchema = z.object({
  description: z.string().optional(),
  role: z.string().optional(),
  expertiseLevel: z.enum(AUDIENCE_EXPERTISE_LEVELS).optional(),
  estimatedDurationMinutes: z.number().optional(),
  locale: z.string().optional(),
  sensitivity: z.enum(AUDIENCE_SENSITIVITY_LEVELS).optional(),
  notes: z.string().optional(),
});

export const structureQuestionSchema = z.object({
  key: z.string().min(1),
  prompt: z.string(),
  type: z.string(),
  required: z.boolean(),
  guidelines: z.string().optional(),
});

export const structureSectionSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  questions: z.array(structureQuestionSchema).max(MAX_EVAL_QUESTIONS_PER_SECTION),
});

/**
 * The full version-structure DTO. The `satisfies z.ZodType<VersionStructureInput>`
 * clause enforces that this schema and the hand-written {@link VersionStructureInput}
 * interface (in `types.ts`, kept Zod-free so the pure prompt builder can import it)
 * stay aligned in BOTH directions — a field added to one but not the other fails to
 * compile here.
 */
export const versionStructureSchema = z.object({
  goal: z.string().nullable(),
  audience: audienceShapeSchema.nullable(),
  sections: z.array(structureSectionSchema).max(MAX_EVAL_SECTIONS),
}) satisfies z.ZodType<VersionStructureInput>;

/**
 * Validate an unknown value (e.g. a version's stored `audience` JSON) as an
 * {@link audienceShapeSchema}. Returns the typed audience or `null` — the loader uses
 * this so a malformed stored audience degrades to "no audience" rather than throwing.
 */
export function parseAudienceShape(value: unknown): z.infer<typeof audienceShapeSchema> | null {
  const result = audienceShapeSchema.safeParse(value);
  return result.success ? result.data : null;
}

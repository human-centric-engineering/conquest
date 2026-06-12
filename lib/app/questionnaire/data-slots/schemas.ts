/**
 * Zod schemas for the data-slots feature: the generator's structured output, the capability's
 * input DTO, and the admin CRUD / bulk-save request bodies. Dependency-light (only `zod`) so
 * leaf consumers (capability, routes) import without pulling server deps.
 */

import { z } from 'zod';

/** A name is 1–4 words (the "short semantic target" contract). */
const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(60, 'Name is too long')
  .refine((v) => v.split(/\s+/).filter(Boolean).length <= 4, 'Name must be at most 4 words');

const themeSchema = z.string().trim().min(1, 'Theme is required').max(60);
// Descriptions guide the interviewer, so they must carry the full intent of the
// question(s) a slot abstracts — generous cap to allow that detail.
const descriptionSchema = z.string().trim().min(1, 'Description is required').max(1000);

/** One generated slot as the LLM emits it (questions referenced by key). */
export const generatedDataSlotSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
  theme: themeSchema,
  questionKeys: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});

/** The generator capability's structured output. */
export const dataSlotGenerationOutputSchema = z.object({
  slots: z.array(generatedDataSlotSchema).max(60),
});

export type DataSlotGenerationOutput = z.infer<typeof dataSlotGenerationOutputSchema>;

/** The questions DTO the generation capability scans (one entry per question). */
export const questionForGenerationSchema = z.object({
  key: z.string().min(1),
  prompt: z.string().min(1),
  type: z.string().min(1),
  sectionTitle: z.string().optional(),
});

/** The full version structure the generator reasons over. */
export const dataSlotStructureSchema = z.object({
  goal: z.string().nullish(),
  audience: z.unknown().optional(),
  questions: z.array(questionForGenerationSchema).min(1),
});

export type DataSlotStructureInput = z.infer<typeof dataSlotStructureSchema>;

/** Create-or-edit a single data slot from the admin review surface. */
export const createDataSlotSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
  theme: themeSchema,
  questionKeys: z.array(z.string().min(1)).default([]),
  weight: z.number().positive().max(100).optional(),
});

export const updateDataSlotSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    theme: themeSchema.optional(),
    questionKeys: z.array(z.string().min(1)).optional(),
    weight: z.number().positive().max(100).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'At least one field is required');

/** Bulk-save the admin's accepted set (replaces the version's data slots). */
export const saveDataSlotsSchema = z.object({
  slots: z.array(createDataSlotSchema).max(60),
});

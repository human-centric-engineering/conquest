/**
 * DEMO-ONLY (F2.5.1): request-body schemas for the demo-client admin API.
 *
 * Pure Zod — no Prisma / Next — so the routes validate at the boundary and the
 * form components can share the inferred types. Slug is optional on create
 * (derive-with-override, see `slug.ts`); when supplied it must be kebab-case. The
 * DB enforces uniqueness; a collision surfaces as a 409 in the route.
 */

import { z } from 'zod';

import {
  DEMO_CLIENT_SLUG_MAX_LENGTH,
  DEMO_CLIENT_SLUG_PATTERN,
} from '@/lib/app/questionnaire/demo-clients/slug';

const NAME_MAX = 120;
const DESCRIPTION_MAX = 500;

const slugField = z
  .string()
  .trim()
  .min(1)
  .max(DEMO_CLIENT_SLUG_MAX_LENGTH)
  .regex(
    DEMO_CLIENT_SLUG_PATTERN,
    'Slug must be kebab-case: lowercase letters, numbers, and single hyphens'
  );

const nameField = z.string().trim().min(1, 'Name is required').max(NAME_MAX);

// Empty string from a form field means "no description" — coerce to null so the
// column stores null rather than an empty string.
const descriptionField = z
  .string()
  .trim()
  .max(DESCRIPTION_MAX)
  .transform((v) => (v.length === 0 ? null : v))
  .nullable();

/** Create body: name required; slug optional (derived from name when absent). */
export const createDemoClientSchema = z.object({
  name: nameField,
  slug: slugField.optional(),
  description: descriptionField.optional(),
  isActive: z.boolean().optional(),
});

/** Update body: every field optional, but at least one must be present. */
export const updateDemoClientSchema = z
  .object({
    name: nameField,
    slug: slugField,
    description: descriptionField,
    isActive: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field must be provided',
  });

/** Attribution body for `PATCH /questionnaires/:id` — set or clear the demo client. */
export const assignDemoClientSchema = z.object({
  demoClientId: z.string().min(1).nullable(),
});

export type CreateDemoClientInput = z.infer<typeof createDemoClientSchema>;
export type UpdateDemoClientInput = z.infer<typeof updateDemoClientSchema>;
export type AssignDemoClientInput = z.infer<typeof assignDemoClientSchema>;

/**
 * Client-side form schema for the respondent profile capture form (F-capture).
 *
 * Builds a Zod object schema from a version's `profileFields`, used by the in-flow capture gate
 * (`components/app/questionnaire/profile/profile-capture-gate.tsx`) for instant, per-field feedback.
 * All values are strings (form inputs); the SERVER is the enforcing boundary — it re-derives the
 * fields, coerces types, and (for agentic/hybrid fields) re-runs plausibility/normalisation before
 * persisting, so this client schema is deliberately the deterministic-format layer only.
 *
 * Pure (Zod only) so both the client bundle and any test can import it without pulling in server deps.
 */

import { z } from 'zod';

import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';

/** Build the client form schema for a set of profile fields. Values are strings; server coerces. */
export function buildProfileFormSchema(fields: ProfileFieldConfig[]): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    let base: z.ZodTypeAny;
    switch (field.type) {
      case 'email':
        base = z.string().trim().email('Enter a valid email address');
        break;
      case 'number':
        base = z
          .string()
          .trim()
          .regex(/^-?\d+(\.\d+)?$/, 'Enter a number');
        break;
      case 'select':
        base = z.string().min(1, 'Select an option');
        break;
      case 'text':
      default:
        base = z.string().trim().min(1, 'This field is required');
        break;
    }
    // Optional fields accept an empty string (rendered blank, stripped before submit).
    shape[field.key] = field.required ? base : z.union([base, z.literal('')]);
  }
  return z.object(shape);
}

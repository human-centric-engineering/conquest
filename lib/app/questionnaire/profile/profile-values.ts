/**
 * Respondent profile-value collection — pure validation (F8.3).
 *
 * The admin authors a version's `profileFields` (name/email/role/custom) on the
 * config; at session start a respondent supplies a value for each. This module turns
 * the stored field config into a Zod schema and validates a respondent's raw
 * submission against it, so the same rules guard both the client form
 * (`components/app/questionnaire/profile/`) and the server capture seam
 * (`questionnaire-sessions/_lib/create.ts`).
 *
 * Pure: Zod only, no Prisma / Next. The capture seam is the enforcing boundary —
 * `.strict()` rejects unknown keys so a client can't smuggle arbitrary PII into the
 * snapshot's `values`, and required fields must be present.
 *
 * ANONYMOUS MODE: never reaches here — the capture seam skips collection entirely when
 * `anonymousMode = true`, so no profile values are validated, stored, or surfaced.
 */

import { z } from 'zod';

import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';
import { profileFieldSchema } from '@/lib/app/questionnaire/authoring/config-schema';

/** The collected profile, keyed by field `key`. Values are strings or numbers. */
export type ProfileValues = Record<string, string | number>;

/** Outcome of validating a raw submission against a version's `profileFields`. */
export type ProfileValuesResult =
  | { ok: true; values: ProfileValues }
  | { ok: false; message: string };

/**
 * Cast a stored `AppRespondentProfileSnapshot.values` Json column back to
 * {@link ProfileValues}. Returns null for an absent/non-object column. Mirrors the
 * `asAudience` / `asRefinementHistory` JSON-column readers in the export seams — the
 * value was validated on write, so this is a shape guard, not re-validation.
 */
export function asProfileValues(value: unknown): ProfileValues | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as ProfileValues;
}

/**
 * Parse the stored `AppQuestionnaireConfig.profileFields` Json column back to typed
 * configs, dropping silently to `[]` on a malformed column (the read view already
 * resolves defaults; the capture seam treats "no fields" as "nothing to collect").
 */
export function parseProfileFields(json: unknown): ProfileFieldConfig[] {
  const parsed = z.array(profileFieldSchema).safeParse(json);
  return parsed.success ? parsed.data : [];
}

/** Build the per-field value schema for one configured profile field. */
function fieldValueSchema(field: ProfileFieldConfig): z.ZodTypeAny {
  switch (field.type) {
    case 'email':
      return z.string().trim().email('Enter a valid email address').max(320);
    case 'number':
      return z.coerce.number().finite('Enter a valid number');
    case 'select': {
      const options = field.options ?? [];
      // A select always has ≥1 option (config rule); guard the empty case so a
      // malformed config degrades to a free string rather than throwing.
      return options.length > 0 ? z.enum([...options]) : z.string().trim().min(1);
    }
    case 'text':
    default:
      return z.string().trim().min(1).max(2000);
  }
}

/**
 * Build a strict object schema from a version's profile fields: required fields are
 * mandatory, optional ones may be omitted, and no unknown keys are allowed.
 */
export function buildProfileValuesSchema(fields: ProfileFieldConfig[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    const base = fieldValueSchema(field);
    shape[field.key] = field.required ? base : base.optional();
  }
  return z.object(shape).strict();
}

/**
 * Validate a raw respondent submission against a version's profile fields. Empty
 * strings / nulls are treated as "not supplied" (dropped before validation), so an
 * omitted optional field passes and a blank required field fails. Returns the cleaned
 * {@link ProfileValues} on success, or the first issue's message on failure.
 */
export function validateProfileValues(
  fields: ProfileFieldConfig[],
  raw: unknown
): ProfileValuesResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Profile values must be an object' };
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    cleaned[key] = value;
  }

  const parsed = buildProfileValuesSchema(fields).safeParse(cleaned);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid profile values' };
  }
  return { ok: true, values: parsed.data as ProfileValues };
}

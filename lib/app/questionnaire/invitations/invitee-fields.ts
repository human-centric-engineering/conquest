/**
 * Invitee detail fields — pure config parsing + per-invitee value validation.
 *
 * The admin authors which of the closed {@link INVITEE_FIELD_KEYS} set to capture per version
 * (`config.inviteeFields`); the import/verify grid renders a column per shown field and the send
 * path validates each invitee's `profile` against it. `email` is ALWAYS shown + required regardless
 * of what's stored — it's the dedup + delivery key — so this module forces it at every boundary.
 *
 * Pure: Zod only, no Prisma / Next. Mirrors `profile/profile-values.ts` (the session-start identity
 * capture); kept separate because invitee fields are a fixed key set authored at invite time, not
 * the free-form per-session profile.
 */

import { z } from 'zod';

import {
  DEFAULT_INVITEE_FIELDS,
  INVITEE_FIELD_KEYS,
  type InviteeFieldConfig,
  type InviteeFieldKey,
} from '@/lib/app/questionnaire/types';

/** A captured invitee profile, keyed by field key (all string values). */
export type InviteeProfile = Partial<Record<InviteeFieldKey, string>>;

/** Outcome of validating a raw invitee submission against a version's `inviteeFields`. */
export type InviteeProfileResult =
  { ok: true; values: InviteeProfile } | { ok: false; message: string };

/** Zod shape for one stored field-config entry. */
const inviteeFieldConfigSchema = z.object({
  key: z.enum(INVITEE_FIELD_KEYS),
  shown: z.boolean(),
  required: z.boolean(),
});

/**
 * Parse the stored `inviteeFields` JSON into a complete, canonical, ordered list — one entry per
 * {@link INVITEE_FIELD_KEYS} in declaration order, filling any missing/malformed key from
 * {@link DEFAULT_INVITEE_FIELDS}, and FORCING `email` to `shown: true, required: true`. So callers
 * always get the full closed set in a stable order with the email invariant guaranteed.
 */
export function parseInviteeFields(json: unknown): InviteeFieldConfig[] {
  const parsed = z.array(inviteeFieldConfigSchema).safeParse(json);
  const stored = new Map<InviteeFieldKey, InviteeFieldConfig>();
  if (parsed.success) for (const f of parsed.data) stored.set(f.key, f);

  return INVITEE_FIELD_KEYS.map((key) => {
    if (key === 'email') return { key, shown: true, required: true };
    const fromStored = stored.get(key);
    const fallback = DEFAULT_INVITEE_FIELDS.find((f) => f.key === key)!;
    return fromStored ?? fallback;
  });
}

/** The fields an admin must actually fill for an invitee (shown only), in display order. */
export function shownInviteeFields(fields: InviteeFieldConfig[]): InviteeFieldConfig[] {
  return fields.filter((f) => f.shown);
}

/** Per-field value schema — email is validated as an address; the rest are short free text. */
function fieldValueSchema(key: InviteeFieldKey): z.ZodTypeAny {
  return key === 'email'
    ? z.string().trim().toLowerCase().email('Enter a valid email address').max(254)
    : z.string().trim().min(1).max(200);
}

/**
 * Validate one invitee's raw profile against the version's field config. Blank/omitted values are
 * dropped before validation, so an omitted optional field passes and a blank required one fails.
 * `email` is always required + email-validated regardless of config. Unknown keys are rejected.
 */
export function validateInviteeProfile(
  fields: InviteeFieldConfig[],
  raw: unknown
): InviteeProfileResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Invitee details must be an object' };
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    cleaned[key] = value;
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of parseInviteeFields(fields)) {
    if (!field.shown) continue;
    const base = fieldValueSchema(field.key);
    shape[field.key] = field.required ? base : base.optional();
  }

  const parsed = z.object(shape).strict().safeParse(cleaned);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid invitee details' };
  }
  return { ok: true, values: parsed.data };
}

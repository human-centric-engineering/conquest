/**
 * DEMO-ONLY (F3.4): Zod validators for the demo-client theme fields.
 *
 * Pure Zod — no Prisma / Next — so the demo-client admin routes validate at the
 * boundary and the form component shares the inferred types. Each field is form-
 * friendly: an empty string (a cleared input) coerces to `null` so the column stores
 * null (→ Sunrise default via resolveTheme) rather than an empty string. Colours must
 * be hex; the logo must be an absolute https URL. The {@link themeFields} bag is
 * spread into the demo-client create/update schemas.
 */

import { z } from 'zod';

/** #rgb or #rrggbb. Case-insensitive; the only colour shape the email/CSS consume. */
export const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Welcome copy is a short intro line, not a body of prose — keep it bounded. */
export const WELCOME_COPY_MAX = 280;

/** True for an absolute `https://` URL (logos must be served over TLS). Exported so
 *  the admin form shares one https predicate with the server schema (no drift). */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Empty string → null; otherwise validate as a hex colour. */
const colorField = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .refine((v) => v === null || HEX_COLOR_PATTERN.test(v), {
    message: 'Must be a hex colour like #5469d4',
  });

/** Empty string → null; otherwise validate as an absolute https URL. */
const logoUrlField = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .refine((v) => v === null || isHttpsUrl(v), {
    message: 'Must be an absolute https:// URL',
  });

/** Empty string → null; otherwise a bounded single line of intro copy. */
const welcomeCopyField = z
  .string()
  .trim()
  .max(WELCOME_COPY_MAX)
  .transform((v) => (v.length === 0 ? null : v))
  .nullable();

/**
 * The theme field bag, spread into both demo-client schemas. Each is `.optional()`
 * so an omitted field is left untouched (create defaults to null at the DB; update is
 * a partial patch) while a present-but-empty field clears to null.
 */
export const themeFields = {
  ctaColor: colorField.optional(),
  accentColor: colorField.optional(),
  logoUrl: logoUrlField.optional(),
  welcomeCopy: welcomeCopyField.optional(),
};

/** Standalone object schema for the four theme fields (tests + reuse). */
export const themeFieldsSchema = z.object(themeFields);

export type ThemeFieldsInput = z.infer<typeof themeFieldsSchema>;

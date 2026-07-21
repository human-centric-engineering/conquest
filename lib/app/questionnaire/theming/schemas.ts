/**
 * DEMO-ONLY (F3.4): Zod validators for the demo-client theme fields.
 *
 * Pure Zod — no Prisma / Next — so the demo-client admin routes validate at the
 * boundary and the form component shares the inferred types. Each field is form-
 * friendly: an empty string (a cleared input) coerces to `null` so the column stores
 * null (→ ConQuest default via resolveTheme) rather than an empty string. Colours must
 * be hex; the logo must be an absolute https URL. The {@link themeFields} bag is
 * spread into the demo-client create/update schemas.
 */

import { z } from 'zod';

import { isBrandImageSrc } from '@/lib/app/questionnaire/theming/brand-image';

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

/**
 * Empty string → null; otherwise an https URL or one of our own upload paths.
 *
 * NOT https-only: the local storage provider serves uploads from `public/uploads/`, so a
 * logo uploaded in development is `/uploads/...` on our own origin. `isBrandImageSrc`
 * owns that distinction (and keeps the relative branch narrow enough that it can only
 * address our upload tree).
 */
const brandImageField = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .refine((v) => v === null || isBrandImageSrc(v), {
    message: 'Must be an absolute https:// URL or an uploaded image',
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
 *
 * The F7.1+ chrome fields (surfaceColor, ctaColorEnd, logoBackgroundColor) are hex
 * colours with the same empty-string → null coercion; logoBackgroundEnabled is a plain
 * boolean toggle (no coercion — a checkbox always sends true/false).
 */
export const themeFields = {
  ctaColor: colorField.optional(),
  accentColor: colorField.optional(),
  logoUrl: brandImageField.optional(),
  bannerUrl: brandImageField.optional(),
  welcomeCopy: welcomeCopyField.optional(),
  surfaceColor: colorField.optional(),
  ctaColorEnd: colorField.optional(),
  logoBackgroundColor: colorField.optional(),
  logoBackgroundEnabled: z.boolean().optional(),
};

/** Standalone object schema for the four theme fields (tests + reuse). */
export const themeFieldsSchema = z.object(themeFields);

export type ThemeFieldsInput = z.infer<typeof themeFieldsSchema>;

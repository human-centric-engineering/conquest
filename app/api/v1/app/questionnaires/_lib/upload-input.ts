/**
 * Ingestion upload parsing + validation (F1.1 / PR4, T1.4.1).
 *
 * Turns the multipart form into the typed inputs the route needs: the file's
 * extension allowlist check, the admin-supplied goal/audience metadata (validated
 * with Zod), and the PDF `extractTables` flag.
 *
 * Boundary note on "supplied": the F1.1 plan says an admin field being *present*
 * means "admin owns this" (suppresses inference). At the HTTP boundary an empty
 * or whitespace-only form field is an *un-filled* field, not an intentional
 * override — so we trim and treat empties as absent. A genuinely-supplied value
 * is any non-empty string.
 */

import { z } from 'zod';

import { ValidationError } from '@/lib/api/errors';
import {
  AUDIENCE_EXPERTISE_LEVELS,
  AUDIENCE_SENSITIVITY_LEVELS,
  type AudienceShape,
} from '@/lib/app/questionnaire/types';

/**
 * Extension allowlist — the source of truth for accepted formats (the caller's
 * MIME type is advisory only, mirroring the knowledge documents route). Narrower
 * than the knowledge KB's list: a questionnaire is a document, not a corpus.
 */
export const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.md', '.txt'] as const;

export function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Parsed, validated admin-supplied metadata. Absent fields are omitted. */
export interface AdminMetadata {
  goal?: string;
  audience?: Partial<AudienceShape>;
}

/**
 * Zod schema for the admin audience fields. Each field optional; estimated
 * duration is coerced from its string form value. `.strict()` rejects unknown
 * `audience.*` keys so a typo surfaces rather than being silently dropped.
 */
const adminAudienceSchema = z
  .object({
    description: z.string().min(1),
    role: z.string().min(1),
    expertiseLevel: z.enum(AUDIENCE_EXPERTISE_LEVELS),
    estimatedDurationMinutes: z.coerce.number().int().positive(),
    locale: z.string().min(1),
    sensitivity: z.enum(AUDIENCE_SENSITIVITY_LEVELS),
    notes: z.string().min(1),
  })
  .partial()
  .strict();

/** Audience form fields arrive dot-prefixed: `audience.role`, `audience.locale`, … */
const AUDIENCE_FORM_PREFIX = 'audience.';

/** Read a single string form value, trimmed; returns undefined when empty/absent. */
function readTrimmed(formData: FormData, key: string): string | undefined {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Collect and validate the admin-supplied goal/audience from the form. Throws
 * {@link ValidationError} (→ 400) when an audience field fails validation, so the
 * admin gets a precise message rather than a silently-dropped override.
 */
export function parseAdminMetadata(formData: FormData): AdminMetadata {
  const meta: AdminMetadata = {};

  const goal = readTrimmed(formData, 'goal');
  if (goal !== undefined) meta.goal = goal;

  // Gather non-empty audience.* fields into a raw object for Zod.
  const rawAudience: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(AUDIENCE_FORM_PREFIX) || typeof value !== 'string') continue;
    const field = key.slice(AUDIENCE_FORM_PREFIX.length);
    const trimmed = value.trim();
    if (trimmed.length > 0) rawAudience[field] = trimmed;
  }

  if (Object.keys(rawAudience).length > 0) {
    const parsed = adminAudienceSchema.safeParse(rawAudience);
    if (!parsed.success) {
      const details: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.length > 0 ? `audience.${issue.path.join('.')}` : 'audience';
        (details[path] ??= []).push(issue.message);
      }
      throw new ValidationError('Invalid audience metadata', details);
    }
    if (Object.keys(parsed.data).length > 0) meta.audience = parsed.data;
  }

  return meta;
}

/** Truthy-string form values that turn the PDF table extraction on. */
const TRUTHY_FLAG_VALUES = new Set(['true', '1', 'on', 'yes']);

/** Read the optional PDF `extractTables` flag from the form. */
export function parseExtractTablesFlag(formData: FormData): boolean {
  const raw = formData.get('extractTables');
  return typeof raw === 'string' && TRUTHY_FLAG_VALUES.has(raw.toLowerCase());
}

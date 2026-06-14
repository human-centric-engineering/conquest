/**
 * Structured-output contract for AI invitee extraction (PDF/image). Pure Zod — the LLM returns a
 * JSON object of people; we validate deterministically and drop anything malformed. Email is the
 * only required field per person; rows without a usable email are dropped (the admin re-validates in
 * the verify grid and on send).
 */

import { z } from 'zod';

import type { ParsedInvitee } from '@/lib/app/questionnaire/invitations/import/types';

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const optionalText = z
  .string()
  .trim()
  .max(200)
  .transform((v) => (v.length === 0 ? undefined : v))
  .optional();

const extractedPersonSchema = z.object({
  // Optional so ONE email-less entry doesn't fail the whole parse — we drop it below instead.
  email: z.string().trim().toLowerCase().optional(),
  firstName: optionalText,
  surname: optionalText,
  jobTitle: optionalText,
  team: optionalText,
  organisation: optionalText,
});

export const extractPeopleSchema = z.object({
  people: z.array(extractedPersonSchema).max(500),
});

/**
 * Parse the model's raw text into {@link ParsedInvitee}[]. Tolerates a ```json fence, keeps only
 * entries with a valid-looking email, and dedupes by lowercased email. Returns null on unparseable
 * JSON / schema mismatch so {@link runStructuredCompletion} triggers its repair retry.
 */
export function parseExtractedPeople(raw: string): ParsedInvitee[] | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const result = extractPeopleSchema.safeParse(json);
  if (!result.success) return null;

  const byEmail = new Map<string, ParsedInvitee>();
  for (const p of result.data.people) {
    if (!p.email || !EMAIL_RE.test(p.email) || byEmail.has(p.email)) continue;
    byEmail.set(p.email, {
      email: p.email,
      ...(p.firstName ? { firstName: p.firstName } : {}),
      ...(p.surname ? { surname: p.surname } : {}),
      ...(p.jobTitle ? { jobTitle: p.jobTitle } : {}),
      ...(p.team ? { team: p.team } : {}),
      ...(p.organisation ? { organisation: p.organisation } : {}),
    });
  }
  return [...byEmail.values()];
}

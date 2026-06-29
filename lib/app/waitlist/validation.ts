/**
 * Waitlist sign-up validation schemas.
 *
 * ConQuest pre-launch waitlist. Mirrors the contact-form pattern (shared client
 * + server schemas, honeypot field) but is app-owned. Captures name + email and
 * an optional free-text "what you'd use ConQuest for" so we get a demand signal,
 * plus a `source` marking which CTA/page the sign-up came from.
 */

import { z } from 'zod';
import { emailSchema } from '@/lib/validations/auth';

/** Core waitlist fields shared by client and server. */
export const waitlistSchema = z.object({
  name: z
    .string()
    .min(1, 'Please tell us your name')
    .max(100, 'Name must be less than 100 characters')
    .trim(),
  email: emailSchema,
  useCase: z.string().max(2000, 'Please keep this under 2000 characters').trim().optional(),
  /** Which CTA/page the sign-up came from — set by the page, not the user. */
  source: z.string().max(60).optional(),
});

/**
 * Client-side schema: adds the honeypot field. Any value is allowed here — the
 * empty-check happens server-side so we never tip off a bot.
 */
export const waitlistClientSchema = waitlistSchema.extend({
  website: z.string().optional(),
});

/**
 * Server-side schema: the honeypot must be empty (hidden from real users, filled
 * by bots).
 */
export const waitlistWithHoneypotSchema = waitlistSchema.extend({
  website: z.string().max(0, 'Invalid submission').optional(),
});

export type WaitlistInput = z.infer<typeof waitlistSchema>;
export type WaitlistClientInput = z.infer<typeof waitlistClientSchema>;
export type WaitlistWithHoneypotInput = z.infer<typeof waitlistWithHoneypotSchema>;

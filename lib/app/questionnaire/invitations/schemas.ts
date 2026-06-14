/**
 * Request-body schemas for the invitation admin + accept APIs (F3.2). Pure Zod —
 * no Prisma / Next — so routes validate at the boundary and the form components
 * share the inferred types.
 *
 * Single and bulk are one shape: `recipients` is an array (length 1 = single
 * invite). Emails are normalised (trim + lowercase) and de-duplicated within the
 * batch; the DB has no `(versionId, email)` unique — duplicate-vs-existing dedup is
 * application-layer in the route (revoke → re-invite must work).
 */

import { z } from 'zod';

/** Max recipients per bulk request — keeps one POST bounded (email send + audit). */
export const MAX_INVITE_RECIPIENTS = 50;

const NAME_MAX = 120;
const EMAIL_MAX = 254; // RFC 5321 practical maximum

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(EMAIL_MAX);

const nameField = z
  .string()
  .trim()
  .max(NAME_MAX)
  .transform((v) => (v.length === 0 ? undefined : v))
  .optional();

/** A short, optional invitee detail field (firstName, surname, jobTitle, team, organisation). */
const detailField = z
  .string()
  .trim()
  .max(200)
  .transform((v) => (v.length === 0 ? undefined : v))
  .optional();

/**
 * The configurable per-invitee detail fields (email is the top-level `email`; `name` is derived
 * from first/last at the route). Validated for shown/required against the version's `inviteeFields`
 * in the route — the schema only bounds shapes/lengths.
 */
const inviteeProfileSchema = z
  .object({
    firstName: detailField,
    surname: detailField,
    jobTitle: detailField,
    team: detailField,
    organisation: detailField,
  })
  .optional();

const recipientSchema = z.object({
  email: emailField,
  name: nameField,
  profile: inviteeProfileSchema,
});

/** Create body: 1..MAX recipients, emails unique within the batch. */
export const createInvitationsSchema = z.object({
  recipients: z
    .array(recipientSchema)
    .min(1, 'At least one recipient is required')
    .max(MAX_INVITE_RECIPIENTS, `At most ${MAX_INVITE_RECIPIENTS} recipients per request`)
    .superRefine((recipients, ctx) => {
      const seen = new Set<string>();
      recipients.forEach((r, i) => {
        if (seen.has(r.email)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate email in this batch: ${r.email}`,
            path: [i, 'email'],
          });
        }
        seen.add(r.email);
      });
    }),
});

/** Accept body (public respondent registration) — token + chosen password. */
export const acceptInvitationSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  name: nameField,
});

export type CreateInvitationsInput = z.infer<typeof createInvitationsSchema>;
export type InvitationRecipientInput = z.infer<typeof recipientSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

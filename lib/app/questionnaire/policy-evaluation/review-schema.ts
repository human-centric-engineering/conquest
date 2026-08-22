/**
 * Request contract for the policy-evaluation finding-review action (PATCH a finding), F18.8.
 *
 * Mirrors both siblings exactly: `accept` / `decline` / `edit` (store an `editedOverride`) /
 * `mark_applied` (the admin made the change by hand on the Settings tab — stamp the finding's
 * terminal state without mutating the config again).
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import { policyProposedEditSchema } from '@/lib/app/questionnaire/policy-evaluation/judge-schema';

export const policyReviewFindingSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept') }),
  z.object({ action: z.literal('decline') }),
  z.object({ action: z.literal('edit'), editedOverride: policyProposedEditSchema }),
  z.object({ action: z.literal('mark_applied'), appliedToVersionId: z.string().min(1) }),
]);

export type PolicyReviewFindingInput = z.infer<typeof policyReviewFindingSchema>;

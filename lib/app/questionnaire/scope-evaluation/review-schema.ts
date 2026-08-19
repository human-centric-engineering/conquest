/**
 * Request contract for the scope-evaluation finding-review action (PATCH a finding), F17.21.
 *
 * Mirrors `evaluation/review-schema.ts` exactly: `accept` / `decline` / `edit` (store an
 * `editedOverride`) / `mark_applied` (the admin authored the change by hand on the Topics tab —
 * stamp the finding's terminal state without mutating the config again).
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import { scopeProposedEditSchema } from '@/lib/app/questionnaire/scope-evaluation/judge-schema';

export const scopeReviewFindingSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept') }),
  z.object({ action: z.literal('decline') }),
  z.object({ action: z.literal('edit'), editedOverride: scopeProposedEditSchema }),
  z.object({ action: z.literal('mark_applied'), appliedToVersionId: z.string().min(1) }),
]);

export type ScopeReviewFindingInput = z.infer<typeof scopeReviewFindingSchema>;

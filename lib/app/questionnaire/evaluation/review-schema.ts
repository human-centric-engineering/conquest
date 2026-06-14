/**
 * Request contract for the F5.3 finding-review action (PATCH a finding).
 *
 * Four actions, discriminated on `action`: `accept` (agree, not yet applied), `decline` (dismiss),
 * `edit` (store an admin-edited `editedOverride` op that takes precedence over the judge's
 * `proposedEdit` at apply), and `mark_applied` (record that the suggestion was authored by hand in
 * the editor — the question was already created via the authoring route, so this only stamps the
 * finding's terminal state + the version it landed in; it does NOT mutate structure). The one-click
 * structural mutation is the separate `…/apply` POST.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import { proposedEditSchema } from '@/lib/app/questionnaire/evaluation/judge-schema';

/** PATCH a finding — accept / decline (triage), edit (store an override op), or mark_applied. */
export const reviewFindingSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept') }),
  z.object({ action: z.literal('decline') }),
  z.object({ action: z.literal('edit'), editedOverride: proposedEditSchema }),
  z.object({ action: z.literal('mark_applied'), appliedToVersionId: z.string().min(1) }),
]);

export type ReviewFindingInput = z.infer<typeof reviewFindingSchema>;

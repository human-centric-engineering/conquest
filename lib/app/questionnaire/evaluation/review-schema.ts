/**
 * Request contract for the F5.3 finding-review action (PATCH a finding).
 *
 * Three triage actions, discriminated on `action`: `accept` (agree, not yet applied),
 * `decline` (dismiss), and `edit` (store an admin-edited `editedOverride` op that takes
 * precedence over the judge's `proposedEdit` at apply). Apply is a separate, explicit POST —
 * accepting is triage, not a structural mutation, so it stays distinct from forking the draft.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import { proposedEditSchema } from '@/lib/app/questionnaire/evaluation/judge-schema';

/** PATCH a finding — accept / decline (triage) or edit (store an override op). */
export const reviewFindingSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept') }),
  z.object({ action: z.literal('decline') }),
  z.object({ action: z.literal('edit'), editedOverride: proposedEditSchema }),
]);

export type ReviewFindingInput = z.infer<typeof reviewFindingSchema>;

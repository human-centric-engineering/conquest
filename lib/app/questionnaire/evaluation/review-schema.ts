/**
 * Request contract for the finding-review action (PATCH a finding).
 *
 * Discriminated on `action`:
 *
 *  - `accept` — agree with the suggestion. Nothing is written to the questionnaire; the whole run
 *    is triaged first and then executed together by the batch `…/apply` POST (F5.4). May carry an
 *    `instruction`, the reviewer's own steer for how to make the change.
 *  - `decline` — dismiss it.
 *  - `set_instruction` — attach or clear that steer without changing the decision, so a reviewer
 *    can note "keep it under 15 words" while still undecided and not lose it.
 *  - `edit` — store an admin-edited `editedOverride` op that takes precedence over the judge's
 *    `proposedEdit` at apply. No longer offered by the UI (the free-text instruction replaced the
 *    typed op form), but kept: the capability is API-accessible and existing rows still carry
 *    overrides that apply must honour.
 *  - `mark_applied` — record that the suggestion was authored by hand in the editor. Stamps the
 *    finding's terminal state + the version it landed in; it does NOT mutate structure.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import { proposedEditSchema } from '@/lib/app/questionnaire/evaluation/judge-schema';

/**
 * Upper bound on the reviewer's steer.
 *
 * Generous, because this is prose a person types about one question and a hard limit that bites
 * mid-sentence is worse than a long prompt; but bounded, because it is replayed verbatim into an
 * LLM prompt at batch apply, where an unbounded field is both a cost and an injection surface.
 */
export const MAX_APPLY_INSTRUCTION = 2_000;

/**
 * The steer itself. Trimmed, and an empty string normalises to `null` so "cleared the box" and
 * "never typed anything" are one state in the column rather than two that read differently.
 */
const applyInstructionSchema = z
  .string()
  .max(MAX_APPLY_INSTRUCTION)
  .transform((v) => {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  })
  .nullable();

/** PATCH a finding — triage, attach a steer, store an override op, or mark_applied. */
export const reviewFindingSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept'), instruction: applyInstructionSchema.optional() }),
  z.object({ action: z.literal('decline') }),
  z.object({ action: z.literal('set_instruction'), instruction: applyInstructionSchema }),
  z.object({ action: z.literal('edit'), editedOverride: proposedEditSchema }),
  z.object({ action: z.literal('mark_applied'), appliedToVersionId: z.string().min(1) }),
]);

export type ReviewFindingInput = z.infer<typeof reviewFindingSchema>;

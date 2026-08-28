/**
 * The contract for the reviewer's steer — what the AI leg of batch apply is allowed to change.
 *
 * A reviewer triaging an evaluation run can attach a free-text instruction to any suggestion
 * ("keep it short, and don't name the department"). That instruction is never parsed into an op:
 * it is prose about *how* to make a change the judge already proposed, and the judge's op is what
 * the reviewer accepted. So the AI leg is deliberately not "read the instruction and decide what to
 * do" — it is **rewrite the wording of this exact change, and nothing else**.
 *
 * That distinction is the whole safety model here, and it is enforced structurally rather than by
 * prompt wording:
 *
 *  1. The model may only return the union below — one member per steerable op, carrying **only the
 *     free-text fields** of that op. There is no member that changes an op's kind, and no field for
 *     an ordinal, a section, a slot key, a question type or a `typeConfig`. A model that decides the
 *     question should really be deleted has no way to say so.
 *  2. {@link mergeSteeredEdit} refuses a revision whose `op` differs from the judge's, and rebuilds
 *     the op from the original for every field the model was not offered. A reviewer who accepted
 *     "split this question" gets a split, worded their way — never a rename, never a new key.
 *
 * Three ops carry no wording at all (`delete_question`, `reorder`, `change_type`), so an
 * instruction attached to one has nothing to act on. {@link isSteerableOp} is how the batch tells
 * the reviewer that plainly instead of applying the change with their words discarded.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import { audienceShapeSchema } from '@/lib/app/questionnaire/ingestion/extraction-schema';
import type { ProposedEdit } from '@/lib/app/questionnaire/evaluation/types';

/** Cap on each rewritten text field — the judge's own `EDIT_TEXT_MAX`, so a steer can't outgrow it. */
const EDIT_TEXT_MAX = 2_000;

/** Cap on the model's account of what it did. One or two sentences, read in a results list. */
const NOTE_MAX = 400;

/**
 * The ops whose content the reviewer's words can reach.
 *
 * Everything absent from this list is a *structural* change with no prose in it: `delete_question`
 * removes a slot, `reorder` moves one, `change_type` swaps an answer type. There is no wording for
 * an instruction to steer, so the batch reports those rather than pretending the steer was honoured.
 */
export const STEERABLE_OPS = [
  'replace_prompt',
  'split_question',
  'edit_guidelines',
  'add_question',
  'edit_goal',
  'edit_audience',
] as const;
export type SteerableOp = (typeof STEERABLE_OPS)[number];

/** Is this op one the reviewer's words can change? Narrows the op for {@link mergeSteeredEdit}. */
export function isSteerableOp(op: ProposedEdit): op is Extract<ProposedEdit, { op: SteerableOp }> {
  return (STEERABLE_OPS as readonly string[]).includes(op.op);
}

const text = z.string().min(1).max(EDIT_TEXT_MAX);

/**
 * The revised change — one member per steerable op, carrying only its rewritable fields.
 *
 * Note what is *not* here: `split_question` has no `secondKey`, `add_question` no `key`, `type` or
 * `sectionKey`. Those decide identity and placement, the judge set them against the structure it
 * read, and the reviewer accepted them; a rewrite of the wording has no business moving them. They
 * are carried from the original op in {@link mergeSteeredEdit}.
 */
export const steeredEditSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('replace_prompt'), prompt: text }),
  z.object({ op: z.literal('split_question'), prompt: text, secondPrompt: text }),
  /** Nullable because clearing the guidelines is a legitimate change the judge can propose. */
  z.object({ op: z.literal('edit_guidelines'), guidelines: text.nullable() }),
  z.object({ op: z.literal('add_question'), prompt: text, guidelines: text.nullish() }),
  z.object({ op: z.literal('edit_goal'), goal: text }),
  z.object({ op: z.literal('edit_audience'), audience: audienceShapeSchema }),
]);
export type SteeredEdit = z.infer<typeof steeredEditSchema>;

/**
 * One steered change, with an honest account of the parts of the instruction it could not honour.
 *
 * `unhonoured` exists for the same reason `unresolved` does on the reconciler: a model handed
 * "make it shorter and change it to a 1–5 scale" can do the first and not the second, and silently
 * doing half of what someone asked reads to them as all of it. The batch surfaces this line next to
 * the applied change, so a steer that only partly landed is visible at the moment it lands rather
 * than discovered later in the questionnaire.
 */
export const steerResultSchema = z.object({
  revised: steeredEditSchema,
  /** One line, in the reviewer's terms, describing what the instruction changed. */
  note: z.string().min(1).max(NOTE_MAX),
  /** The part of the instruction wording alone could not satisfy, or `null` when there was none. */
  unhonoured: z.string().max(NOTE_MAX).nullish(),
});
export type SteerResult = z.infer<typeof steerResultSchema>;

/** Parse-and-validate helper for `runStructuredCompletion` (returns null on mismatch → retry). */
export function validateSteerResult(parsed: unknown): SteerResult | null {
  const result = steerResultSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Provider-native structured-output shape for the steer call.
 *
 * Hand-written rather than derived from Zod — the same posture as `EDIT_PLAN_JSON_SCHEMA` — so it
 * stays a stable, readable contract, with `validateSteerResult` as the cross-provider safety net
 * regardless of what any one provider does with it.
 */
export const STEER_RESULT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    revised: {
      type: 'object',
      description:
        'The same change, reworded. Its "op" must equal the op you were given; include only that ' +
        "op's text fields.",
    },
    note: { type: 'string', description: 'One line on what the instruction changed.' },
    unhonoured: {
      type: ['string', 'null'],
      description: 'The part of the instruction you could not honour by wording alone, else null.',
    },
  },
  required: ['revised', 'note'],
};

/**
 * Fold a revision back into the judge's op.
 *
 * Returns `null` when the model answered about a different op than the one it was given — the
 * single case where a steer is refused outright rather than partly used. It is not paranoia about a
 * malformed reply: an op-kind switch is the model overruling the reviewer's decision, and applying
 * it would write a change nobody accepted.
 *
 * Every field the steer schema does not carry is taken from `original`, so the rewrite cannot drift
 * a key, a type, a section or an ordinal even by accident.
 */
export function mergeSteeredEdit(
  original: ProposedEdit,
  revised: SteeredEdit
): ProposedEdit | null {
  if (original.op !== revised.op) return null;

  switch (revised.op) {
    case 'replace_prompt':
      return { op: 'replace_prompt', prompt: revised.prompt };
    case 'split_question':
      // `secondKey` is the judge's, not the model's: it addresses the new slot, and the reviewer
      // accepted a split that creates *that* question.
      return original.op === 'split_question'
        ? {
            op: 'split_question',
            prompt: revised.prompt,
            secondPrompt: revised.secondPrompt,
            ...(original.secondKey ? { secondKey: original.secondKey } : {}),
          }
        : null;
    case 'edit_guidelines':
      return { op: 'edit_guidelines', guidelines: revised.guidelines };
    case 'add_question':
      // Type, key and section come from the judge's draft — the steer rewrites what the question
      // says, not what kind of question it is or where it goes.
      //
      // `guidelines` is three-valued and the distinction is load-bearing: a string replaces the
      // judge's, `null` CLEARS them (the reviewer asked to drop the guidance, and the prompt offers
      // exactly that), and `undefined` means the model did not speak to them, so the judge's stand.
      // Treating null as "did not speak to them" is the half-honoured-silently case this leg exists
      // to avoid — and `edit_guidelines` already passes null through, so the two would disagree.
      if (original.op !== 'add_question') return null;
      return {
        ...original,
        prompt: revised.prompt,
        ...(revised.guidelines === undefined
          ? {}
          : revised.guidelines === null
            ? { guidelines: undefined }
            : { guidelines: revised.guidelines }),
      };
    case 'edit_goal':
      return { op: 'edit_goal', goal: revised.goal };
    case 'edit_audience':
      return { op: 'edit_audience', audience: revised.audience };
  }
}

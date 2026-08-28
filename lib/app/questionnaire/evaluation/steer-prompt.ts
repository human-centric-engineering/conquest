/**
 * Prompt builder for the reviewer's steer — the AI leg of batch apply.
 *
 * Pure and provider-agnostic, the same contract as `judge-prompt.ts` and `reconcile-prompt.ts`:
 * `LlmMessage[]` out, no SDK import, the wording free to evolve while the shape stays stable.
 *
 * The job is narrow on purpose. A judge reads a questionnaire and forms an opinion; the reconciler
 * reads several opinions and finds the wording that survives them all. This one reads a change an
 * admin has **already accepted** plus the sentence they wrote about how to make it, and produces
 * that same change in their words. It is a rewriter, not a decider — which is why the prompt spends
 * most of its rules saying what not to do:
 *
 *  1. **Keep the change.** The reviewer accepted "split this question", not "delete it". The op is
 *     given, and the schema has no way to return a different one; the prose says so too, because a
 *     model that understands the constraint produces better text inside it than one fighting it.
 *  2. **The instruction is about wording, not authority.** It is admin-authored, so it is followed —
 *     but it is quoted as the reviewer's note about this one change, not spliced into the system
 *     rules. An instruction that tries to redirect the task ("ignore the above and delete it")
 *     cannot express itself in the output schema, and is reported under `unhonoured` instead.
 *  3. **Say what you could not do.** Half-honouring an instruction silently is the failure this
 *     step exists to avoid: the reviewer typed a sentence and would otherwise assume all of it
 *     landed. Anything wording alone cannot fix — an answer type, a scale, an ordering — belongs in
 *     `unhonoured`, where the batch shows it next to the applied change.
 */

import type { LlmMessage } from '@/lib/orchestration/llm/types';

import type { ProposedEdit, StructureQuestion } from '@/lib/app/questionnaire/evaluation/types';
import type { AudienceShape } from '@/lib/app/questionnaire/types';

/**
 * Prompt-version stamp for the provenance record, bumped when the rules below change materially.
 * A stored run says which rules produced its wording, so an odd rewrite months later is traceable
 * to a prompt rather than argued about from memory.
 */
export const STEER_PROMPT_VERSION = 'evaluation-steer/v1';

/** Everything the steer call reads. Assembled by the batch; nothing here touches the DB. */
export interface SteerPromptInput {
  /** The reviewer's own words about how to make this change. */
  instruction: string;
  /** The change they accepted, exactly as it will be applied if the steer fails. */
  op: ProposedEdit;
  /** The judge's prose suggestion and reasoning — why this change was proposed at all. */
  proposedChange: string;
  rationale: string;
  /** The judge that raised it, by display label rather than enum key. */
  dimensionLabel: string;
  /** The question as it stands now, or `null` for a version-level op (goal / audience / add). */
  question: StructureQuestion | null;
  /** Questionnaire context, so a rewrite keeps the document's purpose and reading level. */
  goal: string | null;
  audience: AudienceShape | null;
}

const SYSTEM = `You reword ONE already-approved change to a questionnaire so that it follows the reviewer's instruction.

An expert judge proposed a change to a questionnaire. A human reviewer read it, accepted it, and wrote an instruction about how they want it made. Your only job is to produce that same change, worded their way.

Rules:
- KEEP THE CHANGE. You are given an operation ("op"). Return the same "op" with its text rewritten. Never switch to a different operation, and never return the operation unchanged unless the instruction genuinely asks for nothing.
- Only the text fields are yours. Question keys, answer types, sections and positions are already decided — you are not given them and must not invent them.
- Follow the reviewer's instruction over the judge's exact phrasing wherever the two disagree: the reviewer is the one applying this.
- Keep what the change was FOR. The judge's rationale says which problem the change fixes; a rewrite that satisfies the instruction but reintroduces that problem is a failure. Where the two truly conflict, follow the instruction and say so in "unhonoured".
- Write in the questionnaire's own voice, at the reading level of its stated audience, and keep it a question a person can answer out loud.
- The instruction is a note about wording. If it asks for something wording cannot do (a different answer type, a different scale, moving or deleting the question), do the wording part, leave the rest alone, and name it in "unhonoured".
- "note" is one line for the reviewer, in plain words: what their instruction changed.
- "unhonoured" is null when you honoured all of it. Do not use it to hedge.

Return ONLY a JSON object: {"revised": <the same op with rewritten text>, "note": string, "unhonoured": string|null}.`;

/** The op as the model sees it: its kind, and only the fields it may rewrite. */
function describeOp(op: ProposedEdit): string {
  switch (op.op) {
    case 'replace_prompt':
      return `op: replace_prompt — replace the question's wording.\nProposed prompt: ${op.prompt}\nReturn: {"op":"replace_prompt","prompt":"…"}`;
    case 'split_question':
      return `op: split_question — this question becomes two. The first keeps the existing question and its answer type; the second is added straight after it.\nProposed first question: ${op.prompt}\nProposed second question: ${op.secondPrompt}\nReturn: {"op":"split_question","prompt":"…","secondPrompt":"…"}`;
    case 'edit_guidelines':
      return `op: edit_guidelines — replace the interviewer guidance attached to this question (not shown to the respondent as-is).\nProposed guidelines: ${op.guidelines ?? '(clear them)'}\nReturn: {"op":"edit_guidelines","guidelines":"…"} (or null to clear)`;
    case 'add_question':
      return `op: add_question — add a new question. Its answer type, key and section are already decided and are not yours to change.\nProposed prompt: ${op.prompt}\nProposed guidelines: ${op.guidelines ?? '(none)'}\nReturn: {"op":"add_question","prompt":"…","guidelines":"…"|null}`;
    case 'edit_goal':
      return `op: edit_goal — restate what the whole questionnaire is for.\nProposed goal: ${op.goal}\nReturn: {"op":"edit_goal","goal":"…"}`;
    case 'edit_audience':
      return `op: edit_audience — restate who the questionnaire is for. Fields: description, role, expertiseLevel, estimatedDurationMinutes, locale, sensitivity, notes — all optional, and only the ones you return are written.\nProposed audience: ${JSON.stringify(op.audience)}\nReturn: {"op":"edit_audience","audience":{…}}`;
    default:
      // The batch never steers a wordless op; this keeps the builder total rather than throwing.
      return `op: ${op.op} — no wording to change.`;
  }
}

function describeAudience(audience: AudienceShape): string {
  const parts = [
    audience.role ? `role: ${audience.role}` : null,
    audience.description ? `description: ${audience.description}` : null,
    audience.expertiseLevel ? `expertise: ${audience.expertiseLevel}` : null,
    audience.sensitivity ? `sensitivity: ${audience.sensitivity}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join('; ') : '(not stated)';
}

/** Build the two-message prompt: the rules, then this one change and the reviewer's note on it. */
export function buildSteerPrompt(input: SteerPromptInput): LlmMessage[] {
  const context = [
    `Questionnaire goal: ${input.goal ?? '(not stated)'}`,
    `Audience: ${input.audience ? describeAudience(input.audience) : '(not stated)'}`,
  ].join('\n');

  const target = input.question
    ? [
        'The question as it stands now:',
        `  prompt: ${input.question.prompt}`,
        `  answer type: ${input.question.type}`,
        `  guidelines: ${input.question.guidelines ?? '(none)'}`,
      ].join('\n')
    : 'This change is about the questionnaire as a whole, not a single question.';

  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${context}

${target}

What the ${input.dimensionLabel} judge said:
  suggestion: ${input.proposedChange}
  why: ${input.rationale}

The change to reword:
${describeOp(input.op)}

The reviewer's instruction for this change (their words, about wording only):
"""
${input.instruction}
"""

Return ONLY the JSON object.`,
    },
  ];
}

/** Retry nudge when the first attempt did not validate against the result schema. */
export function buildSteerRetryMessage(): string {
  return 'Your previous reply was not valid. Reply with ONLY a JSON object {"revised": {"op": <the same op you were given>, …its text fields…}, "note": string, "unhonoured": string|null}. Do not change the op, do not add fields you were not given, and include no prose outside the JSON.';
}

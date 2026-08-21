/**
 * Question fidelity → system-prompt text.
 *
 * The per-question sibling of `interviewer-strategy.ts` (session-level questioning approach) and
 * `house-rules.ts` (session-level behaviour policy): those shape how the interviewer sounds and
 * operates across a whole conversation, this one governs how faithfully it must put ONE question.
 * Same pattern — a pure renderer, no I/O, unit-tested in isolation.
 *
 * See `.context/app/questionnaire/question-fidelity.md` for the model. The short version: the
 * asking prompt's standing `rules` tell the interviewer to ask openly, never read out a choice
 * list, and never request a scale number — which is right for most questions and destructive for an
 * instrument. This block is the per-question override.
 *
 * **Nothing to say ⇒ `''`.** `balanced` is the default stop and renders nothing, `section()`
 * collapses the empty block away, and the assembled prompt is byte-identical to a version that
 * never heard of fidelity. Combined with the version-level gate (see `resolveQuestionFidelity`),
 * that is what makes the feature safe to ship inert.
 *
 * **Placement is load-bearing.** The section must sit AFTER `<rules>` and `<this_turn>`, on the
 * prompt's later-section-wins convention, because at `close`/`must_ask` it directly contradicts the
 * standing open-invitation rules. Placed before them, a must-ask Likert question would still be
 * asked as an open feelings question.
 */

import { joinSections } from '@/lib/app/questionnaire/prompt/format';
import type { QuestionFidelityLevel, QuestionType } from '@/lib/app/questionnaire/types';

/**
 * What the interviewer is told at each stop. `balanced` is absent on purpose — it is the default
 * behaviour the rest of the prompt already describes, and saying it twice would only add tokens and
 * risk the model over-weighting a redundant restatement.
 */
const LEVEL_CLAUSE: Record<Exclude<QuestionFidelityLevel, 'balanced'>, string> = {
  free:
    'This question does NOT need to be put to the respondent at all. Treat the wording you were ' +
    'given as a description of what we need to learn, not as a script. If the ground it covers has ' +
    'already come up, or you can reach it more naturally by following what they are actually ' +
    'talking about, do that instead. Prefer the conversation over the question.',
  loose:
    'You have wide latitude with this question. Reach what it is getting at from whatever angle ' +
    'the conversation offers — you need not preserve its wording, its framing, or its structure. ' +
    'Getting an honest, usable answer matters more than asking it the way it was written.',
  close:
    'Stay CLOSE to the wording you were given. You may adjust the register and connect the question ' +
    'to what they just said, but keep its specific terms, qualifiers, timeframe and scope exactly ' +
    'as written — those are load-bearing, not incidental phrasing. Do not broaden it, soften it, ' +
    'split it into parts, or swap its key words for synonyms.',
  must_ask:
    "This question MUST be put to the respondent exactly as written. Use the author's own words " +
    'for the question itself — do not paraphrase it, soften it, split it, merge it with anything ' +
    'else, or substitute your own phrasing. You may write ONE short sentence before it so the shift ' +
    'does not feel abrupt, and that lead-in is yours to word naturally. The question that follows ' +
    'is verbatim. This OVERRIDES the earlier instructions to ask openly and to infer the answer ' +
    'from how they talk: for this question, asking it properly IS the job.',
};

/**
 * At `must_ask` a typed question must also show its actual answer options, which directly reverses
 * the standing rule ("do NOT read out the list of options" / "do NOT ask them to pick a number").
 * Reversing it needs saying out loud — a model given only "ask it as written" will still honour the
 * earlier prohibition and ask a Likert item as an open feelings question.
 *
 * Skipped when the surface renders a real answer control alongside the message (see
 * `answerControlShown`): reading a list out under a rendered radio group is duplication the
 * respondent has to reconcile.
 */
const PRESENT_OPTIONS_CLAUSE =
  'Because this question has fixed answer options, present them WITH the question so the ' +
  'respondent can answer it directly. This is the one case where reading out the choices or the ' +
  'scale is correct — the earlier rule against it does not apply here.';

/** A free-text question at `must_ask`: the wording is the instrument; there is nothing to render. */
const FREE_TEXT_NOTE =
  'This is an open question, so there are no options to present — the exact wording IS what must be ' +
  'preserved. Let them answer in their own words and at their own length, as usual.';

export interface QuestionFidelityContext {
  /** The question's type — decides whether answer options are part of "as written". */
  type: QuestionType;
  /**
   * Whether the surface is rendering a real answer control (radio group, scale, matrix) beside the
   * message. When it is, the prose must NOT also recite the options. Phase 2 always passes `false`;
   * the in-chat question card passes `true`.
   */
  answerControlShown?: boolean;
}

/** Types whose "as written" form includes a fixed set of options or a numeric scale. */
const TYPED_WITH_OPTIONS: ReadonlySet<QuestionType> = new Set<QuestionType>([
  'single_choice',
  'multi_choice',
  'likert',
  'matrix',
  'boolean',
]);

/**
 * Render the `<question_fidelity>` body for one question, or `''` when there is nothing to say.
 *
 * Returns `''` for `balanced` — the caller then emits no section at all and the prompt is unchanged
 * from before this feature existed.
 */
export function buildQuestionFidelityInstructions(
  level: QuestionFidelityLevel,
  ctx: QuestionFidelityContext
): string {
  if (level === 'balanced') return '';

  const clause = LEVEL_CLAUSE[level];
  if (level !== 'must_ask') return clause;

  // Only `must_ask` needs to say anything about the answer options: at `close` the interviewer is
  // still inferring from natural language, it is only the WORDING it must preserve.
  const optionsClause = TYPED_WITH_OPTIONS.has(ctx.type)
    ? ctx.answerControlShown === true
      ? ''
      : PRESENT_OPTIONS_CLAUSE
    : ctx.type === 'free_text'
      ? FREE_TEXT_NOTE
      : '';

  return joinSections(clause, optionsClause);
}

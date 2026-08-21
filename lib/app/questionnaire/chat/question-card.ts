/**
 * Question card — the decision, and the payload the surface renders (P18 phase 3).
 *
 * A `must_ask` question is an instrument: its wording AND its answer options are the thing being
 * measured. Reading a five-point scale out in prose and mapping whatever the respondent says back
 * onto it is exactly the inference that fidelity exists to switch off. So for a typed question the
 * surface renders the real control — the same `QuestionField` the raw form and the correction strip
 * already use — inside the turn.
 *
 * Pure: no Prisma, no React, no I/O. The route decides *whether* via {@link shouldShowQuestionCard}
 * and *what* via {@link buildQuestionCard}; the SSE frame carries the result.
 *
 * Two things deliberately do NOT get a card:
 *
 *  - **Free text.** There is no control to render — the protected thing is the wording, and the
 *    respondent answers in the ordinary composer. (This was an explicit product decision, not an
 *    omission.)
 *  - **A question whose typeConfig can't produce a control.** A `single_choice` with no choices, a
 *    `likert` with broken bounds. Rendering an empty radio group would be a dead end with no way to
 *    answer, so these fall back to prose — which still asks the question, just conversationally.
 */

import {
  readChoicesConfig,
  readLikertConfig,
  readMatrixConfig,
} from '@/lib/app/questionnaire/form/type-config';
import type { QuestionFidelityLevel, QuestionType } from '@/lib/app/questionnaire/types';

/**
 * The payload the `question_card` SSE frame carries, and the props the card component renders from.
 * Deliberately self-contained — the client must not have to look anything up to draw the control,
 * because the card can also be replayed from a persisted transcript on resume.
 */
export interface QuestionCardPayload {
  /** `AppQuestionSlot.key` — the handle `PUT …/answers` writes against. */
  questionKey: string;
  /** The author's exact wording. Rendered verbatim; never paraphrased. */
  prompt: string;
  type: QuestionType;
  /** Choices / scale bounds / matrix rows — whatever `QuestionField` needs for this type. */
  typeConfig: unknown;
  /** Drives the "Required" marker and suppresses the skip affordance. */
  required: boolean;
  /**
   * Why the card is being shown. `must_ask` = the author marked it an instrument; `last_resort` =
   * the conversation could not map a reply, so we fall back to the raw control rather than asking
   * a third time. The two carry different copy — one is deliberate, the other is a rescue.
   */
  reason: 'must_ask' | 'last_resort';
}

/** Types whose answer is a fixed set of options or a bounded scale — i.e. renderable as a control. */
const CONTROLLABLE: ReadonlySet<QuestionType> = new Set<QuestionType>([
  'single_choice',
  'multi_choice',
  'likert',
  'matrix',
  'numeric',
  'date',
  'boolean',
]);

/**
 * Whether this type + typeConfig can actually produce a usable control.
 *
 * Reuses the SAME readers `QuestionField` dispatches on, so "can we render it?" and "what gets
 * rendered" cannot drift: if `readChoicesConfig` returns null here, the component would render
 * "No options configured." there.
 *
 * `numeric`, `date` and `boolean` always render (their readers supply defaults), so they need no
 * check beyond their type.
 */
export function canRenderAnswerControl(type: QuestionType, typeConfig: unknown): boolean {
  switch (type) {
    case 'single_choice':
    case 'multi_choice':
      return readChoicesConfig(type, typeConfig) !== null;
    case 'likert':
      return readLikertConfig(typeConfig) !== null;
    case 'matrix':
      return readMatrixConfig(typeConfig) !== null;
    case 'numeric':
    case 'date':
    case 'boolean':
      return true;
    case 'free_text':
      return false;
  }
}

export interface QuestionCardDecisionInput {
  /**
   * The version-level gate. The card is part of the fidelity feature, so it stays behind the one
   * switch — including the last-resort case, which would otherwise change behaviour on
   * questionnaires whose admin never opted in.
   */
  fidelityEnabled: boolean;
  /** The resolved level for this question (already gate-aware, but see `fidelityEnabled`). */
  level: QuestionFidelityLevel;
  type: QuestionType;
  typeConfig: unknown;
  /**
   * This turn re-selected the question the previous turn asked — the reply could not be mapped.
   * The generalised "last resort": rather than asking a third time in prose, show the real control.
   */
  isReask: boolean;
}

/**
 * Decide whether this turn should render an answer control beside the interviewer's message, and
 * why. `null` = ask in prose, exactly as before.
 */
export function shouldShowQuestionCard(
  input: QuestionCardDecisionInput
): QuestionCardPayload['reason'] | null {
  if (!input.fidelityEnabled) return null;
  if (!CONTROLLABLE.has(input.type)) return null;
  if (!canRenderAnswerControl(input.type, input.typeConfig)) return null;

  // `must_ask` wins the label even on a re-ask: the card was always going to be shown, so calling it
  // a rescue would misdescribe it (and would show the respondent apologetic copy for a question that
  // is simply meant to be asked this way).
  if (input.level === 'must_ask') return 'must_ask';
  if (input.isReask) return 'last_resort';
  return null;
}

/** Assemble the frame payload. Callers pass the slot exactly as stored — no rewording. */
export function buildQuestionCard(input: {
  questionKey: string;
  prompt: string;
  type: QuestionType;
  typeConfig: unknown;
  required: boolean;
  reason: QuestionCardPayload['reason'];
}): QuestionCardPayload {
  return {
    questionKey: input.questionKey,
    prompt: input.prompt,
    type: input.type,
    typeConfig: input.typeConfig ?? null,
    required: input.required,
    reason: input.reason,
  };
}

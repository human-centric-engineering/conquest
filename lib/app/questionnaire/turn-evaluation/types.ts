/**
 * Turn-evaluation core — shared input types.
 *
 * The evaluator judges ONE completed interview turn from the Preview Turn Inspector. Its
 * input is the live inspector dump for that turn (every LLM/embedding call with its prompt,
 * response, model, latency, tokens, and cost — see `inspector/types.ts`) plus optional
 * server-loaded context about the questionnaire (goal, audience, strategy, tone) and the
 * turn's respondent/interviewer messages. The dump is supplied by the client (inspector data
 * is live-only and never persisted); the context is loaded server-side by the route so the
 * questionnaire objectives can't be spoofed.
 *
 * Pure (no Prisma / Next) so the schema, prompt builder, serializer, and service share it.
 */

import type { TurnInspectorData } from '@/lib/app/questionnaire/inspector';

/**
 * Optional context about the questionnaire and the turn, loaded server-side. Every field is
 * optional: the evaluator degrades gracefully when a field is absent (e.g. an anonymous
 * questionnaire with no stated audience, or a turn with no prior history).
 */
export interface TurnEvaluationContext {
  /** The questionnaire's overall goal/objective (from the version). */
  goal?: string;
  /** Human-readable summary of the target audience. */
  audience?: string;
  /** The active selection strategy (sequential | random | weighted | adaptive). */
  selectionStrategy?: string;
  /** Human-readable summary of the configured interviewer tone/persona. */
  tone?: string;
  /** The respondent's answer that opened this turn. */
  respondentMessage?: string;
  /** The interviewer's composed reply that closed this turn (the next question/offer). */
  interviewerMessage?: string;
  /** Recent conversation history, oldest first — for stage/flow judgement. */
  recentMessages?: string[];
}

/** Everything the evaluator service needs to judge one turn. */
export interface TurnEvaluationInput {
  /** The inspector dump for the turn under evaluation. */
  turn: TurnInspectorData;
  /** Optional server-loaded context; absent fields are simply omitted from the prompt. */
  context?: TurnEvaluationContext;
}

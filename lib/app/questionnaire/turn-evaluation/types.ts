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
 *
 * The four **policy** fields below (`houseRules`, `interviewerStrategy`, `questionFidelity`,
 * `conditionalTopics`) exist for the same reason `tone` does: they describe behaviour the admin
 * *configured*, so the judge must read it as the standard to score against rather than as a fault.
 * Without them a `must_ask` question — required to be put verbatim, with its options recited —
 * reads to the rubric as a closed, leading question and is marked down for doing exactly as it
 * was told.
 *
 * They are **descriptions, not instructions**: rendered from the neutral third-person
 * `SETTING_DESCRIPTORS` rows, never from the second-person prompt builders in `chat/**` (splicing
 * "You have wide latitude with this question…" into a judge's context would tell the *judge* to
 * behave that way).
 *
 * Unlike the interviewer's own prompt blocks, these do NOT vanish when a feature is off: the
 * registry states "House rules: None" and "Conditional topics: Disabled" rather than emitting nothing.
 * That is deliberate here — a judge that is simply not told about a policy cannot tell "none is in
 * force" from "you weren't told", and will speculate. The interviewer needs silence (an empty
 * block costs it nothing and says nothing); the judge needs the negative stated. `tone` is the one
 * exception and it predates this: its descriptor genuinely emits nothing when no dial is set.
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
  /** The client's behaviour policy for this questionnaire (always / never / if-asked), summarised. */
  houseRules?: string;
  /** The questioning approach, pace, opening mode and tactics, summarised. */
  interviewerStrategy?: string;
  /** The version-level question-fidelity gate, summarised. */
  questionFidelity?: string;
  /** Whether this interview was narrowed by Conditional Topics, and under what limits. */
  conditionalTopics?: string;
  /**
   * How faithfully THIS turn's targeted question had to be put — the resolved five-stop level,
   * already gate-aware. Omitted at `balanced` (the default behaviour the rubric already assumes)
   * and whenever the turn targeted no question, matching the prompt builder's own
   * "nothing to say ⇒ say nothing" rule.
   */
  questionFidelityLevel?: string;
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

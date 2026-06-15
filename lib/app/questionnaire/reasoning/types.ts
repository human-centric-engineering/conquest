/**
 * Reasoning-trace contract for the live "watch it think" stream (demo feature).
 *
 * Each respondent turn, the per-turn orchestrator already extracts answers, detects
 * contradictions, refines earlier answers, assesses completion, and chooses the next
 * question — but the respondent only ever sees a "thinking" dot then a reply. This module
 * owns the pure, DB-free shape of the *visible* reasoning: a short, respondent-safe list of
 * {@link ReasoningStep}s derived from a {@link import('@/lib/app/questionnaire/orchestrator/types').TurnResult}
 * by {@link import('./build-reasoning-trace').buildReasoningTrace}.
 *
 * **Pure by design**, like the P4 cores it reads from. The builder is data-in / data-out
 * (no Prisma, no Next, no clock), so the route can build the trace right after the turn runs
 * and emit it over SSE, and so it unit-tests in isolation.
 *
 * **Respondent-safe by construction.** The builder deliberately surfaces only the steps a
 * respondent may see — extraction, contradiction, refinement, selection, completion — and
 * never the abuse/seriousness verdict or the sensitivity disclosure summary (those are
 * PII-guarded / would be jarring). See the exclusions in the builder.
 */

import type { AnswerProvenance } from '@/lib/app/questionnaire/types';

/** The pipeline step a {@link ReasoningStep} narrates. Drives the per-kind icon in the UI. */
export const REASONING_STEP_KINDS = [
  'extraction',
  'contradiction',
  'refinement',
  'completion',
  'selection',
] as const;
export type ReasoningStepKind = (typeof REASONING_STEP_KINDS)[number];

/**
 * The visual register of a step. `neutral` is routine progress; `insight` is an "intelligent"
 * moment worth highlighting (an inference, the next-question reasoning); `caution` is a gentle
 * flag (a possible contradiction).
 */
export const REASONING_TONES = ['neutral', 'insight', 'caution'] as const;
export type ReasoningTone = (typeof REASONING_TONES)[number];

/**
 * One visible line in the reasoning feed. Short and human — the headline (`label`) reads on its
 * own; `detail` is an optional second line; `sourceQuote` echoes the respondent's own words an
 * answer was drawn from. `confidence`/`provenance` render a small confidence pip + provenance tag.
 */
export interface ReasoningStep {
  kind: ReasoningStepKind;
  /** The headline, e.g. `Captured "What's your budget?"`. Always present and self-contained. */
  label: string;
  /** Optional supporting line, e.g. a provenance/confidence phrase or the selection rationale. */
  detail?: string;
  /**
   * The agent's own justification for *why* the value was captured/updated this way — the
   * extractor's / refiner's `rationale`. Rendered smaller + italic, below the detail. Distinct from
   * `detail` (the provenance/confidence summary) and `sourceQuote` (the respondent's own words).
   */
  rationale?: string;
  /** The span of the respondent's message this was drawn from (extraction `direct` answers). */
  sourceQuote?: string;
  /** 0–1 model confidence, when the step has one — rendered as a small pip, not a number. */
  confidence?: number;
  /** How the agent arrived at the value (extraction / refinement steps). */
  provenance?: AnswerProvenance;
  tone: ReasoningTone;
}

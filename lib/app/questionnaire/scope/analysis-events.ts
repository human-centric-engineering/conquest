/**
 * Event contract for the streaming Routing Analysis (`POST …/topics/analyse/stream`).
 *
 * One reasoning call over a whole instrument — including its full source document, which is the
 * largest single input any app capability takes — routinely runs past a synchronous request's idle
 * limit. So the run is streamed over SSE: the bridge's keepalive frames hold the connection while
 * the model reads, and the terminal `done` event hands the client the proposal itself.
 *
 * Shared by BOTH the server route and the client review surface, so it must stay free of any
 * server-only import. Mirrors `glossary/analysis-events.ts`.
 */

import type { ProposedTopicSet } from '@/lib/app/questionnaire/scope/types';

/**
 * Progress phases surfaced while the analysis runs.
 *
 * `reading` covers assembling the instrument and its document into the prompt; `analysing` is the
 * model call, which is nearly all of the wall clock; `saving` is the write of the draft. Only
 * three, because a single completion has no honest intermediate milestones to report.
 */
export type RoutingAnalysisPhase = 'reading' | 'analysing' | 'saving';

/** A real progress event — the client renders `message`. */
export interface RoutingAnalysisPhaseEvent {
  type: 'phase';
  phase: RoutingAnalysisPhase;
  message: string;
}

/** A terminal failure. The response is already streaming, so a failure can't be a 5xx. */
export interface RoutingAnalysisErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

/**
 * The terminal success — the pending proposal, in full.
 *
 * Carried in the event rather than left to a `router.refresh()`: the review surface holds its
 * working set in `useState`, whose initialiser does not re-run, and `router.refresh()` deliberately
 * preserves client state. Without this the admin would be told "12 topics proposed" while the panel
 * still read "nothing to review". Same reason the data-slot and glossary streams return their sets.
 */
export interface RoutingAnalysisDoneEvent {
  type: 'done';
  versionId: string;
  draft: ProposedTopicSet;
  /** How many proposed topics reuse the key of a topic already on the version. */
  replacedCount: number;
  /** Question keys the proposal left in no topic. Zero is what the admin is looking for. */
  uncoveredQuestionCount: number;
}

export type RoutingAnalysisEvent =
  RoutingAnalysisPhaseEvent | RoutingAnalysisErrorEvent | RoutingAnalysisDoneEvent;

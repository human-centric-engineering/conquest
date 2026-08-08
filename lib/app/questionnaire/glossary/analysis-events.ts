/**
 * Event contract for the streaming Glossary Analysis (`POST …/glossary/analyse/stream`).
 *
 * One structured reasoning call over the whole questionnaire (plus the definitions document when
 * attached) can run past a synchronous request's idle limit on a long instrument, so the run is
 * streamed over SSE — the bridge's keepalive frames hold the connection while the model thinks,
 * and the terminal `done` event hands the client its counts.
 *
 * Shared by BOTH the server route and the client editor, so it must stay free of any server-only
 * import. Mirrors `ingestion/extraction-stream-events.ts`.
 */

import type { GlossaryTermView } from '@/lib/app/questionnaire/glossary/types';

/**
 * Progress phases surfaced while the analysis runs.
 *
 * `reading` covers assembling the questionnaire (and document) into the prompt; `analysing` is the
 * model call itself, which is the overwhelming majority of the wall clock; `saving` is the write of
 * the proposals. Only three, because unlike ingest there is nothing finer the run can honestly
 * report — a single completion has no intermediate milestones to stream.
 */
export type GlossaryAnalysisPhase = 'reading' | 'analysing' | 'saving';

/** A real progress event — the client renders `message`. */
export interface GlossaryAnalysisPhaseEvent {
  type: 'phase';
  phase: GlossaryAnalysisPhase;
  message: string;
}

/** A terminal failure. The response is already streaming, so a failure can't be a 5xx. */
export interface GlossaryAnalysisErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

/**
 * The terminal success.
 *
 * `proposedCount` is what the admin will find in the review queue AFTER de-duplication against
 * terms they have already adjudicated; `skippedExistingCount` is how many the analyst suggested
 * that were dropped for that reason. Reporting both matters: a run that returns "0 new" is
 * otherwise indistinguishable from a run that failed to find anything, and the second number is
 * what tells the admin the analyst is working and simply had nothing new to add.
 */
export interface GlossaryAnalysisDoneEvent {
  type: 'done';
  versionId: string;
  /**
   * The version's FULL curated set after the run — proposals plus everything already adjudicated.
   *
   * Carried in the event rather than left to a `router.refresh()`: the editor holds its working
   * set in `useState`, whose initialiser does not re-run, and `router.refresh()` deliberately
   * preserves client state. Without this the admin would be told "12 terms to review" while the
   * panel still read "No terms yet". Same reason the data-slot generation stream returns its
   * slots.
   */
  terms: GlossaryTermView[];
  proposedCount: number;
  skippedExistingCount: number;
  /** Accepted terms already on the version — the review queue is added to this, not replacing it. */
  acceptedCount: number;
}

export type GlossaryAnalysisEvent =
  GlossaryAnalysisPhaseEvent | GlossaryAnalysisErrorEvent | GlossaryAnalysisDoneEvent;

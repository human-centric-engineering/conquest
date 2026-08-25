/**
 * Event contract for the streaming questionnaire ingest (`POST …/questionnaires/stream`)
 * and its re-ingest twin (`POST …/versions/:vid/reingest/stream`).
 *
 * Upload → extract → (verify) → persist can run well past a synchronous request's
 * idle limit on a multi-page PDF (the extractor's own LLM call is bounded at 120s, and
 * the table pass adds to it). Streaming the work over SSE keeps the connection alive
 * (the bridge emits keepalive frames on an independent timer) and hands the client the
 * new draft's ids on the terminal `done` event — the same shape the compose-stream route
 * uses. This module is the shared type surface, imported by BOTH the server route and the
 * client dialog, so it must stay free of any server-only import.
 */

import type { ScopeCandidacyVerdict } from '@/lib/app/questionnaire/scope/candidacy-schema';

/**
 * Progress phases surfaced to the admin while the draft builds. Unlike the old scripted
 * ticker these are REAL: each is emitted by the orchestrator as it reaches that stage.
 * `verifying`/`repairing` fire only when the ingest verify+repair pass is enabled.
 * `checking_scope` fires only on a fresh, eligible version (P17.19) — see
 * `_lib/scope-candidacy.ts`. `proposing_scope` fires only when that check said yes (F17.22
 * Phase 2): the Routing Analyst runs there and then, while the admin is still watching, rather
 * than on some later visit to the Adaptive scope tab.
 */
export type ExtractionPhase =
  'extracting' | 'verifying' | 'repairing' | 'checking_scope' | 'proposing_scope' | 'saving';

/** A real progress event — the client renders `message` and, when present, the `progress` counts. */
export interface ExtractionPhaseEvent {
  type: 'phase';
  phase: ExtractionPhase;
  message: string;
  /**
   * Live counts, when the stage can report them:
   *  - `extracting` — a RISING count of questions parsed out of the response so
   *    far, with `total` omitted (the model doesn't know its own count up front).
   *  - `repairing` — how many of the flagged questions are being repaired, with a
   *    known `total`.
   * `message` always restates the count in prose, so a client that ignores this
   * field still shows progress.
   */
  progress?: { done: number; total?: number };
}

/** A terminal failure. The response is already streaming, so a failure can't be a 5xx. */
export interface ExtractionErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

/** The terminal success — the persisted draft's ids + counts, so the client can open it. */
export interface ExtractionDoneEvent {
  type: 'done';
  questionnaireId: string;
  versionId: string;
  sectionCount: number;
  questionCount: number;
  changeCount: number;
  /**
   * Re-ingest only: the upload was byte-identical to the version's current source
   * document, so nothing was re-extracted or written and the counts below are the
   * version's unchanged ones. Absent (or `false`) on a real ingest/re-ingest. The
   * no-op short-circuit rides the SAME terminal event rather than a separate JSON
   * response so the client keeps one code path for "the work finished".
   */
  deduped?: boolean;
  /**
   * Adaptive Scope candidacy check (P17.19) — present only when the check actually ran (a fresh,
   * eligible version) and returned a verdict. Absent on a deduped no-op, on an ineligible version
   * (scope already on / already authored), and on any check failure — all of which mean "nothing to
   * report" rather than "checked and found nothing".
   */
  adaptiveScopeCandidate?: ScopeCandidacyVerdict;
  /**
   * What the Routing Analyst proposed during this upload (F17.22 Phase 2) — present only when the
   * candidacy check said yes AND the proposal succeeded. Nothing is live: it is a pending draft
   * waiting on the Adaptive scope tab, and adaptive scope itself stays off. Absent means "no
   * proposal was made", which covers the check saying no, the analyst failing, and the whole
   * fail-soft path — an upload that completed is never reported as failed because an optional
   * proposal could not be made.
   */
  adaptiveScopeProposal?: { topicCount: number; conditionalCount: number };
}

export type ExtractionStreamEvent =
  ExtractionPhaseEvent | ExtractionErrorEvent | ExtractionDoneEvent;

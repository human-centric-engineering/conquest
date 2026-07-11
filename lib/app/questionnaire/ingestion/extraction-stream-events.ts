/**
 * Event contract for the streaming questionnaire ingest (`POST …/questionnaires/stream`).
 *
 * Upload → extract → (verify) → persist can run well past a synchronous request's
 * idle limit on a multi-page PDF (the extractor's own LLM call is bounded at 120s, and
 * the table pass adds to it). Streaming the work over SSE keeps the connection alive
 * (the bridge emits keepalive frames on an independent timer) and hands the client the
 * new draft's ids on the terminal `done` event — the same shape the compose-stream route
 * uses. This module is the shared type surface, imported by BOTH the server route and the
 * client dialog, so it must stay free of any server-only import.
 */

/**
 * Progress phases surfaced to the admin while the draft builds. Unlike the old scripted
 * ticker these are REAL: each is emitted by the orchestrator as it reaches that stage.
 * `verifying`/`repairing` fire only when the ingest verify+repair pass is enabled.
 */
export type ExtractionPhase = 'extracting' | 'verifying' | 'repairing' | 'saving';

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
}

export type ExtractionStreamEvent =
  | ExtractionPhaseEvent
  | ExtractionErrorEvent
  | ExtractionDoneEvent;

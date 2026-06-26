/**
 * Streamed generation events for a synthesis report (cohort report kind).
 *
 * The generator (`streamGenerateCohortReport`) yields one of these at each phase boundary so the
 * admin sees the report build live ("Building dataset — N respondents…", "Synthesising themes…")
 * instead of a single 90-second spinner. Pure types, shared by the server orchestrator and the
 * client SSE frame parser — mirrors the compose-stream event contract.
 *
 * Every event carries `type` (the SSE `event:` line). The terminal event is `done` (the report was
 * persisted as a new revision) or `error` (generation failed; the header was marked `failed`).
 */

/** Discrete phases reported while a report generates. */
export type ReportGenPhase =
  | 'started' // generation accepted; about to build the dataset
  | 'dataset_built' // analytical substrate ready (carries respondent + segment counts)
  | 'material_built' // data-slot thematic material assembled
  | 'context_loaded' // optional round/cohort/KB context resolved
  | 'synthesizing'; // the structured LLM call is in flight

/** A progress event for one of the {@link ReportGenPhase} boundaries. */
export interface ReportGenProgressEvent {
  type: ReportGenPhase;
  /** Respondent count in the dataset (present from `dataset_built` onward). */
  sessionCount?: number;
  /** Number of demographic/subgroup segments (present from `dataset_built` onward). */
  segmentCount?: number;
}

/** Terminal success — a new revision was appended and the report marked `ready`. */
export interface ReportGenDoneEvent {
  type: 'done';
  revisionNumber: number;
  /** ISO timestamp of the generation. */
  generatedAt: string;
  costUsd: number;
}

/** Terminal failure — generation threw; the header was marked `failed`. */
export interface ReportGenErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

/** The full event union streamed over SSE. */
export type ReportGenEvent = ReportGenProgressEvent | ReportGenDoneEvent | ReportGenErrorEvent;

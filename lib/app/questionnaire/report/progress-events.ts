/**
 * Report generation progress — the phase vocabulary and the preview stream's event contract.
 *
 * Generating a report is four to six sequential model calls: invent a sample respondent, answer the
 * questionnaire as them (a fan-out of batches), write the report, format it, and — when configured —
 * research and append. A measured run of a 69-question version takes ~100 seconds end to end. The
 * admin "Preview report" dialog used to show one static spinner for all of it, so a slow preview and
 * a broken one looked identical and the honest advice ("wait ~two minutes") was nowhere on screen.
 *
 * So the generation core reports what it is doing as it does it. Two pieces here:
 *
 *   - {@link ReportProgressEvent} + {@link ReportProgressEmitter} — what
 *     `synthesiseSampleReportInputs` and `generateReportFromInputs` emit at each boundary. The
 *     emitter is optional at every call site: passing none changes nothing, which is what keeps the
 *     live (queued, unwatched) report path untouched.
 *   - {@link ReportPreviewEvent} — the SSE union the preview stream route sends, i.e. the progress
 *     events plus a terminal `done` (carrying the rendered sample report) or `error`.
 *
 * {@link reportProgressLabel} is the single place the on-screen wording lives, shared by the server
 * (which never renders it) and the client (which does), so the two can't drift.
 *
 * Pure types + one pure function — no I/O, safe to import from a client component.
 *
 * @see lib/app/questionnaire/report/preview-run.ts — the SSE driver
 * @see .context/app/questionnaire/respondent-report.md — "Config preview (AI-synthesised)"
 */

/**
 * The phases a report run crosses, in order.
 *
 * Deliberately coarser than the pipeline's real steps — `finishing` covers the appendix pass and the
 * method summary, two calls that are usually skipped and never worth two labels. Each phase is a
 * claim about work that has genuinely started, so none of them can be a lie.
 */
export const REPORT_PROGRESS_PHASES = [
  'started', // request accepted; structure loaded
  'persona', // inventing the sample respondent (preview only)
  'sampling', // answering the questionnaire as that respondent (batched fan-out; preview only)
  'grounding', // retrieving client knowledge-base snippets
  'researching', // web-search rounds
  'writing', // the report writer call is in flight
  'formatting', // the formatter second pass is in flight
  'finishing', // appendix / method summary
] as const;

export type ReportProgressPhase = (typeof REPORT_PROGRESS_PHASES)[number];

/** One progress event. The optional counters only appear on the phases that have them. */
export interface ReportProgressEvent {
  type: ReportProgressPhase;
  /** `sampling`: how many answer batches have come back. */
  batchesDone?: number;
  /** `sampling`: how many answer batches the fan-out started with. */
  batchesTotal?: number;
  /** `started`: how many questions the sample respondent will answer. */
  questionCount?: number;
  /** `started`: how many data slots the sample respondent will fill. */
  dataSlotCount?: number;
}

/**
 * What an instrumented generation core is handed: fire-and-forget, never awaited, never able to
 * fail the run. Optional at every call site.
 */
export type ReportProgressEmitter = (event: ReportProgressEvent) => void;

/** Terminal success — the sample report, ready to render. */
export interface ReportPreviewDoneEvent {
  type: 'done';
  questionnaireTitle: string;
  mode: string;
  content: unknown;
  formatted: boolean;
  completionPct: number;
}

/** Terminal failure — generation threw; the message is safe to show an admin. */
export interface ReportPreviewErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

/** The full event union the preview stream sends. */
export type ReportPreviewEvent =
  ReportProgressEvent | ReportPreviewDoneEvent | ReportPreviewErrorEvent;

/** Narrow a parsed SSE payload to a progress event (i.e. not one of the two terminals). */
export function isReportProgressEvent(event: ReportPreviewEvent): event is ReportProgressEvent {
  return event.type !== 'done' && event.type !== 'error';
}

/**
 * What each phase says on screen.
 *
 * Plain English per the house rule — no "fan-out", "batch", "LLM", no slugs. `sampling` counts the
 * batches because that is the one phase with a real denominator, and a wait that visibly advances
 * reads very differently from one that does not.
 */
export function reportProgressLabel(event: ReportProgressEvent): string {
  switch (event.type) {
    case 'started': {
      const questions = event.questionCount ?? 0;
      const slots = event.dataSlotCount ?? 0;
      if (questions === 0 && slots === 0) return 'Starting…';
      const parts: string[] = [];
      if (questions > 0) parts.push(`${questions} question${questions === 1 ? '' : 's'}`);
      if (slots > 0) parts.push(`${slots} data slot${slots === 1 ? '' : 's'}`);
      return `Preparing a sample respondent for ${parts.join(' and ')}…`;
    }
    case 'persona':
      return 'Inventing a sample respondent…';
    case 'sampling': {
      const total = event.batchesTotal ?? 0;
      const done = event.batchesDone ?? 0;
      if (total <= 0) return 'Answering the questionnaire as them…';
      return `Answering the questionnaire as them — ${done} of ${total} parts done…`;
    }
    case 'grounding':
      return 'Reading the client knowledge base…';
    case 'researching':
      return 'Researching…';
    case 'writing':
      return 'Writing the report…';
    case 'formatting':
      return 'Laying out the report…';
    case 'finishing':
      return 'Finishing up…';
    default:
      return 'Working…';
  }
}

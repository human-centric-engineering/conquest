/**
 * ReportApi — the endpoint/body abstraction that lets ONE cohort-report panel serve both report
 * owners (a round, or a whole questionnaire version).
 *
 * A cohort (synthesis) report used to be round-only; it is now polymorphic — the same report can be
 * scoped to one ROUND or to a whole VERSION (across all its rounds + open-ended sessions). The two
 * owners differ only in their URLs and how the owning version is identified: round routes take
 * `?versionId=` on reads and `{ versionId }` in mutating bodies; version routes carry the version in
 * the path, so their bodies omit it. `CohortReportPanel` consumes a `ReportApi` instead of building
 * round URLs directly, so it is owner-agnostic. Build one with `roundReportApi` / `versionReportApi`.
 */

import { API } from '@/lib/api/endpoints';

export interface ReportApi {
  /** GET the read view (`CohortReportView`). Round: includes `?versionId=`. */
  viewUrl: string;
  /** GET the analytical dataset (`CohortDataset`). */
  datasetUrl: string;
  /** POST → `text/event-stream` of generation phase + done/error events. */
  generateStreamUrl: string;
  /** GET revision history / POST `{ revisionNumber }` to restore. */
  revisionsUrl: string;
  /** POST to publish / DELETE to unpublish. */
  publishUrl: string;
  /** GET href for the themed PDF. Round: includes `?versionId=`. */
  pdfUrl: string;
  /** PATCH `{ content }` to save edits. */
  patchUrl: string;
  /**
   * POST `{ heading, body, instruction }` for per-section AI assist. Only the round owner exposes a
   * refine route today; omitted for the version owner (the editor hides AI assist when absent).
   */
  refineUrl?: string;
  /** Merged into every mutating request body — round: `{ versionId }`; version: `{}`. */
  body: Record<string, string>;
}

/** Round-scoped report endpoints. The owning version travels in the query string / body. */
export function roundReportApi(roundId: string, versionId: string): ReportApi {
  const vid = `versionId=${encodeURIComponent(versionId)}`;
  return {
    viewUrl: `${API.APP.ROUNDS.cohortReport(roundId)}?${vid}`,
    datasetUrl: `${API.APP.ROUNDS.cohortReportDataset(roundId)}?${vid}`,
    generateStreamUrl: `${API.APP.ROUNDS.cohortReportGenerate(roundId)}/stream`,
    revisionsUrl: API.APP.ROUNDS.cohortReportRevisions(roundId),
    publishUrl: API.APP.ROUNDS.cohortReportPublish(roundId),
    pdfUrl: `${API.APP.ROUNDS.cohortReportPdf(roundId)}?${vid}`,
    patchUrl: API.APP.ROUNDS.cohortReport(roundId),
    refineUrl: API.APP.ROUNDS.cohortReportRefine(roundId),
    body: { versionId },
  };
}

/** Version-scoped report endpoints. The version is in the path, so bodies/queries carry no id. */
export function versionReportApi(id: string, versionId: string): ReportApi {
  return {
    viewUrl: API.APP.QUESTIONNAIRES.versionCohortReport(id, versionId),
    datasetUrl: API.APP.QUESTIONNAIRES.versionCohortReportDataset(id, versionId),
    generateStreamUrl: API.APP.QUESTIONNAIRES.versionCohortReportGenerateStream(id, versionId),
    revisionsUrl: API.APP.QUESTIONNAIRES.versionCohortReportRevisions(id, versionId),
    publishUrl: API.APP.QUESTIONNAIRES.versionCohortReportPublish(id, versionId),
    pdfUrl: API.APP.QUESTIONNAIRES.versionCohortReportPdf(id, versionId),
    patchUrl: API.APP.QUESTIONNAIRES.versionCohortReport(id, versionId),
    body: {},
  };
}

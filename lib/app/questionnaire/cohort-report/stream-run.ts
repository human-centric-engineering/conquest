/**
 * Streamed generation run (report kind `cohort`) — the shared SSE driver.
 *
 * Wraps {@link streamGenerateCohortReport} for a route: forwards each phase event to the client, and
 * on the terminal step appends the new AI revision (marking the report `ready`) and emits `done`, or
 * marks the report `failed` and emits a sanitised `error`. Owner-agnostic — the round and version
 * stream routes both call this with their own {@link ReportScope}. Server-side (touches Prisma +
 * audit). The route owns the pre-stream guards (auth, flag, rate-limit, ensure-header); this owns
 * everything from the first phase event onward.
 */

import { logger } from '@/lib/logging';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { streamGenerateCohortReport } from '@/lib/app/questionnaire/cohort-report/generate';
import {
  appendCohortReportRevision,
  markCohortReportFailed,
} from '@/lib/app/questionnaire/cohort-report/persist';
import { scopeRoundId, type ReportScope } from '@/lib/app/questionnaire/cohort-report/scope';
import type { ReportGenEvent } from '@/lib/app/questionnaire/cohort-report/report-events';
import type { CohortDataset } from '@/lib/app/questionnaire/cohort-report/types';

/** Inputs for one streamed generation run. */
export interface StreamReportRunParams {
  scope: ReportScope;
  /** Pre-built dataset (the route already built it for the k-anon check + reuse). */
  dataset: CohortDataset;
  /** The ensured report-header id to append the revision to. */
  reportId: string;
  /** Admin who triggered the run (revision author + audit actor). */
  adminId: string;
  /** Display name for the audit entry (round name, or questionnaire title). */
  entityName: string;
  /** Client IP for the audit entry. */
  clientIp: string;
}

/**
 * Drive a streamed generation: yield every phase event, then persist + emit `done` (or `error`).
 * Never throws — terminal failures surface as an `error` event after marking the header `failed`.
 */
export async function* streamReportRun(
  params: StreamReportRunParams
): AsyncGenerator<ReportGenEvent> {
  const { scope, dataset, reportId, adminId, entityName, clientIp } = params;
  try {
    const gen = streamGenerateCohortReport({ scope, dataset });
    let step = await gen.next();
    while (!step.done) {
      yield step.value;
      step = await gen.next();
    }
    const { content, costUsd } = step.value;

    const revisionNumber = await appendCohortReportRevision({
      reportId,
      content,
      authoredBy: 'ai',
      summary: 'AI generation',
      costUsd,
      userId: adminId,
    });
    logAdminAction({
      userId: adminId,
      action: 'app_cohort_report.generate',
      entityType: 'app_cohort_report',
      entityId: reportId,
      entityName,
      metadata: { scopeKind: scope.kind, versionId: scope.versionId, revisionNumber, costUsd },
      clientIp,
    });
    yield {
      type: 'done',
      revisionNumber,
      generatedAt: new Date().toISOString(),
      costUsd,
    };
  } catch (err) {
    await markCohortReportFailed(reportId, err).catch(() => undefined);
    logger.error('Cohort report streamed generation failed', {
      scopeKind: scope.kind,
      roundId: scopeRoundId(scope),
      versionId: scope.versionId,
      error: err instanceof Error ? err.message : String(err),
    });
    yield {
      type: 'error',
      code: 'GENERATION_FAILED',
      message: 'Report generation failed',
    };
  }
}

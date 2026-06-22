/**
 * Cohort Report persistence (report kind `cohort`, F14.3).
 *
 * Append-only revision writes: a generation / manual edit / AI-assist creates the next
 * `AppCohortReportRevision` (never mutates one) so the authoring history is preserved and any
 * revision can be restored or published (F14.6). The 1:1 `AppCohortReport` header is upserted per
 * round and carries the generation status + cumulative cost. Server-side (touches Prisma).
 */

import { prisma } from '@/lib/db/client';
import type { CohortReportAuthor } from '@/lib/app/questionnaire/types';
import type { CohortReportContent } from '@/lib/app/questionnaire/cohort-report/content';
import type { Prisma } from '@prisma/client';

/** Ensure the 1:1 report header exists for a round; returns its id. Idempotent. */
export async function ensureCohortReport(params: {
  roundId: string;
  versionId: string;
  title: string;
  userId: string;
}): Promise<string> {
  const { roundId, versionId, title, userId } = params;
  const report = await prisma.appCohortReport.upsert({
    where: { roundId },
    create: { roundId, versionId, title, status: 'queued', createdBy: userId },
    update: {}, // never clobber an existing header (status/version/title) on re-trigger
    select: { id: true },
  });
  return report.id;
}

/**
 * Append a new revision (next `revisionNumber`) and mark the report `ready`. An AI revision carries
 * its `costUsd`, which is added to the header's cumulative `costUsd`. Returns the new revision number.
 */
export async function appendCohortReportRevision(params: {
  reportId: string;
  content: CohortReportContent;
  authoredBy: CohortReportAuthor;
  summary?: string;
  costUsd?: number;
  userId: string;
}): Promise<number> {
  const { reportId, content, authoredBy, summary, costUsd, userId } = params;

  return prisma.$transaction(async (tx) => {
    const last = await tx.appCohortReportRevision.findFirst({
      where: { reportId },
      orderBy: { revisionNumber: 'desc' },
      select: { revisionNumber: true },
    });
    const revisionNumber = (last?.revisionNumber ?? 0) + 1;

    await tx.appCohortReportRevision.create({
      data: {
        reportId,
        revisionNumber,
        content: content as unknown as Prisma.InputJsonValue,
        authoredBy,
        summary: summary ?? null,
        costUsd: costUsd ?? null,
        createdBy: userId,
      },
    });

    await tx.appCohortReport.update({
      where: { id: reportId },
      data: {
        status: 'ready',
        generatedAt: new Date(),
        error: null,
        ...(typeof costUsd === 'number' ? { costUsd: { increment: costUsd } } : {}),
      },
    });

    return revisionNumber;
  });
}

/** Mark a report `failed` with a (truncated) error message. */
export async function markCohortReportFailed(reportId: string, error: unknown): Promise<void> {
  await prisma.appCohortReport.update({
    where: { id: reportId },
    data: { status: 'failed', error: String(error).slice(0, 1000) },
  });
}

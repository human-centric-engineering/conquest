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
import {
  validateCohortReportContent,
  type CohortReportContent,
} from '@/lib/app/questionnaire/cohort-report/content';
import {
  scopeOwnerCreate,
  scopeOwnerWhere,
  type ReportScope,
} from '@/lib/app/questionnaire/cohort-report/scope';
import type { Prisma } from '@prisma/client';

/** One revision's metadata for the history list (client-safe; no content). */
export interface CohortReportRevisionSummary {
  revisionNumber: number;
  authoredBy: CohortReportAuthor;
  summary: string | null;
  costUsd: number | null;
  createdAt: string;
}

/** Ensure the 1:1 report header exists for a scope (round or version); returns its id. Idempotent. */
export async function ensureCohortReport(params: {
  scope: ReportScope;
  title: string;
  userId: string;
}): Promise<string> {
  const { scope, title, userId } = params;
  const report = await prisma.appCohortReport.upsert({
    where: scopeOwnerWhere(scope),
    create: { ...scopeOwnerCreate(scope), title, status: 'queued', createdBy: userId },
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

/** List a report's revisions, newest first (metadata only — no content). */
export async function listCohortReportRevisions(
  reportId: string
): Promise<CohortReportRevisionSummary[]> {
  const rows = await prisma.appCohortReportRevision.findMany({
    where: { reportId },
    orderBy: { revisionNumber: 'desc' },
    select: {
      revisionNumber: true,
      authoredBy: true,
      summary: true,
      costUsd: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    revisionNumber: r.revisionNumber,
    authoredBy: (r.authoredBy as CohortReportAuthor) ?? 'ai',
    summary: r.summary,
    costUsd: r.costUsd,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Restore a past revision: append its content as a new `admin` revision (the working head), leaving
 * history intact. Returns the new revision number, or null when the source revision doesn't exist.
 */
export async function restoreCohortReportRevision(params: {
  reportId: string;
  sourceRevisionNumber: number;
  userId: string;
}): Promise<number | null> {
  const { reportId, sourceRevisionNumber, userId } = params;
  const source = await prisma.appCohortReportRevision.findUnique({
    where: { reportId_revisionNumber: { reportId, revisionNumber: sourceRevisionNumber } },
    select: { content: true },
  });
  if (!source) return null;
  return appendCohortReportRevision({
    reportId,
    content: validateCohortReportContent(source.content),
    authoredBy: 'admin',
    summary: `Restored revision ${sourceRevisionNumber}`,
    userId,
  });
}

/**
 * Publish (pin a revision) or unpublish a report. `revisionNumber` = publish that revision; `null` =
 * revert to draft. Validates the revision exists when publishing.
 */
export async function setCohortReportPublish(params: {
  reportId: string;
  revisionNumber: number | null;
}): Promise<boolean> {
  const { reportId, revisionNumber } = params;
  if (revisionNumber !== null) {
    const exists = await prisma.appCohortReportRevision.findUnique({
      where: { reportId_revisionNumber: { reportId, revisionNumber } },
      select: { revisionNumber: true },
    });
    if (!exists) return false;
  }
  await prisma.appCohortReport.update({
    where: { id: reportId },
    data: {
      publishStatus: revisionNumber !== null ? 'published' : 'draft',
      publishedRevisionNumber: revisionNumber,
    },
  });
  return true;
}

/**
 * Read one revision's content for a scope (round or version), resolving `'head'` (highest),
 * `'published'` (the pinned one, falling back to head), or a specific number. Returns null when
 * there's no matching revision.
 */
export async function getCohortReportRevisionContent(
  scope: ReportScope,
  which: number | 'head' | 'published'
): Promise<{ content: CohortReportContent; revisionNumber: number; title: string } | null> {
  const report = await prisma.appCohortReport.findUnique({
    where: scopeOwnerWhere(scope),
    select: { id: true, title: true, publishedRevisionNumber: true },
  });
  if (!report) return null;

  let revisionNumber: number | undefined;
  if (typeof which === 'number') revisionNumber = which;
  else if (which === 'published') revisionNumber = report.publishedRevisionNumber ?? undefined;

  const row = await prisma.appCohortReportRevision.findFirst({
    where: { reportId: report.id, ...(revisionNumber !== undefined ? { revisionNumber } : {}) },
    orderBy: { revisionNumber: 'desc' },
    select: { revisionNumber: true, content: true },
  });
  if (!row) return null;
  return {
    content: validateCohortReportContent(row.content),
    revisionNumber: row.revisionNumber,
    title: report.title,
  };
}

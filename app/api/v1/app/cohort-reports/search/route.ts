/**
 * Cohort Report search (report kind `cohort`, F14.6).
 *
 * GET /api/v1/app/cohort-reports/search?q=…&demoClientId=…
 *   Admin-only. Searches PUBLISHED cohort reports (across rounds, optionally scoped to one demo
 *   client) by title + section text, returning matches with a snippet. Read-only; gated by the
 *   cohort-report flag. (Within-report find is the browser's native search over the rendered report.)
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams } from '@/lib/api/validation';
import { prisma } from '@/lib/db/client';
import { z } from 'zod';

import { withCohortReportEnabled } from '@/lib/app/questionnaire/feature-flag';
import { validateCohortReportContent } from '@/lib/app/questionnaire/cohort-report';
import { htmlToParagraphs } from '@/lib/app/questionnaire/cohort-report/pdf-model';

const querySchema = z.object({
  q: z.string().trim().min(2).max(200),
  demoClientId: z.string().min(1).max(64).optional(),
});

const MAX_RESULTS = 25;

/** Flatten a report's published content to one searchable text blob. */
function searchableText(content: unknown): string {
  const c = validateCohortReportContent(content);
  const parts = [
    ...htmlToParagraphs(c.summary),
    ...c.sections.flatMap((s) => [s.heading, ...htmlToParagraphs(s.body)]),
    ...c.recommendations,
    ...c.actions,
  ];
  return parts.join('\n');
}

/** A ±60-char snippet around the first match of `q` (case-insensitive). */
function snippetAround(text: string, q: string): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, 120);
  const start = Math.max(0, idx - 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, idx + q.length + 60).trim()}…`;
}

const handleSearch = withAdminAuth(async (request) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { q, demoClientId } = validateQueryParams(searchParams, querySchema);

  // Published reports (optionally scoped to one demo client), newest generation first.
  const reports = await prisma.appCohortReport.findMany({
    where: {
      publishStatus: 'published',
      ...(demoClientId ? { round: { cohort: { demoClientId } } } : {}),
    },
    orderBy: { generatedAt: 'desc' },
    take: 200,
    select: {
      scopeKind: true,
      roundId: true,
      versionId: true,
      title: true,
      publishedRevisionNumber: true,
      round: { select: { name: true, cohort: { select: { name: true, demoClientId: true } } } },
      revisions: {
        orderBy: { revisionNumber: 'desc' },
        select: { revisionNumber: true, content: true },
      },
    },
  });

  const needle = q.toLowerCase();
  const results: Array<{
    /** 'round' or 'version' — version-wide reports carry no round/cohort. */
    scopeKind: string;
    roundId: string | null;
    versionId: string;
    title: string;
    roundName: string | null;
    cohortName: string | null;
    demoClientId: string | null;
    snippet: string;
  }> = [];

  for (const report of reports) {
    const published =
      report.revisions.find((r) => r.revisionNumber === report.publishedRevisionNumber) ??
      report.revisions[0];
    if (!published) continue;
    const text = `${report.title}\n${searchableText(published.content)}`;
    if (!text.toLowerCase().includes(needle)) continue;
    results.push({
      scopeKind: report.scopeKind,
      roundId: report.roundId,
      versionId: report.versionId,
      title: report.title,
      // Round/cohort metadata is present only for round-scoped reports.
      roundName: report.round?.name ?? null,
      cohortName: report.round?.cohort?.name ?? null,
      demoClientId: report.round?.cohort?.demoClientId ?? null,
      snippet: snippetAround(text, q),
    });
    if (results.length >= MAX_RESULTS) break;
  }

  log.info('Cohort report search', { q, demoClientId, matches: results.length });
  return successResponse({ results });
});

export const GET = withCohortReportEnabled(handleSearch);

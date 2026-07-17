/**
 * Admin session-ref browser read model (alpha tooling).
 *
 * The enriched query behind `GET /api/v1/app/questionnaire-sessions/refs`: a paginated, cross-
 * questionnaire list of every session that carries a support reference, newest first, with the
 * questionnaire title + version it belongs to so each row can deep-link to the session viewer (where
 * the admin can inspect it and regenerate its report) and to the version's analytics. Optional ref
 * substring search; optional status filter.
 *
 * Route-local DB seam — the `lib/app/questionnaire/**` domain stays Prisma-free, so this read query
 * lives here next to the other admin session reads (`admin-session-view.ts`).
 */

import { z } from 'zod';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { SESSION_STATUSES, narrowToEnum, type SessionStatus } from '@/lib/app/questionnaire/types';
import { formatSessionRef, normalizeSessionRef } from '@/lib/app/questionnaire/session-ref';

/** One row of the admin session-ref browser. */
export interface AdminSessionRefItem {
  sessionId: string;
  /** Raw 8-char support reference. */
  ref: string;
  /** Grouped for display (e.g. `7F3K-9M2P`). */
  refFormatted: string;
  status: SessionStatus;
  isPreview: boolean;
  /** ISO timestamp the session was created. */
  createdAt: string;
  questionnaireId: string;
  questionnaireTitle: string;
  versionId: string;
  versionNumber: number;
  /** Number of respondent turns taken in the session (one per exchanged message). */
  turns: number;
  /** Answered question slots for this session. */
  answeredCount: number;
  /** Total question slots in the session's version. */
  totalQuestions: number;
  /**
   * Completion percentage — answered slots ÷ total question slots, rounded. Matches the report
   * generator's `completionPct` (a version with no slots reports 100).
   */
  percentComplete: number;
}

/** Query params for the browser: pagination, optional ref search, optional status filter. */
export const adminSessionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Case-insensitive substring match on the support reference (normalised first). */
  q: z.string().trim().min(1).max(64).optional(),
  status: z.enum(SESSION_STATUSES).optional(),
});

export type AdminSessionListQuery = z.infer<typeof adminSessionListQuerySchema>;

/**
 * List sessions that carry a support reference, newest first, for the alpha ref browser. Returns the
 * page of items plus the unpaginated `total` for the pager.
 */
export async function listAdminSessionRefs(
  query: AdminSessionListQuery
): Promise<{ items: AdminSessionRefItem[]; total: number }> {
  const { page, limit, q, status } = query;

  const where: Prisma.AppQuestionnaireSessionWhereInput = { publicRef: { not: null } };
  if (status) where.status = status;
  if (q) {
    // The stored ref is the normalised (separator-free, upper) form; normalise the query the same way
    // so a pasted `7F3K-9M2P` matches. Substring so a partial ref still finds its session.
    where.publicRef = { contains: normalizeSessionRef(q), mode: 'insensitive' };
  }

  const [rows, total] = await Promise.all([
    prisma.appQuestionnaireSession.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        publicRef: true,
        status: true,
        isPreview: true,
        createdAt: true,
        versionId: true,
        version: {
          select: {
            versionNumber: true,
            questionnaireId: true,
            questionnaire: { select: { title: true } },
          },
        },
        // Turn count (one row per respondent exchange) and answered-slot count, both derived — the
        // session stores neither. Answered feeds the completion percentage below.
        _count: { select: { turns: true, answers: true } },
      },
    }),
    prisma.appQuestionnaireSession.count({ where }),
  ]);

  // Total question slots per version — the denominator for completion. One grouped count over the
  // versions on this page (slot rows carry a denormalised `versionId`), so no per-row query.
  const versionIds = [...new Set(rows.map((r) => r.versionId))];
  const slotCounts = versionIds.length
    ? await prisma.appQuestionSlot.groupBy({
        by: ['versionId'],
        where: { versionId: { in: versionIds } },
        _count: { _all: true },
      })
    : [];
  const totalByVersion = new Map(slotCounts.map((g) => [g.versionId, g._count._all]));

  const items: AdminSessionRefItem[] = [];
  for (const r of rows) {
    // `publicRef` is filtered non-null above; `version` is a required relation. Guard defensively so a
    // malformed row is skipped rather than crashing the whole page.
    if (!r.publicRef || !r.version) continue;
    const answeredCount = r._count.answers;
    const totalQuestions = totalByVersion.get(r.versionId) ?? 0;
    // Same formula as the report generator's `completionPct`: a version with no slots reports 100.
    const percentComplete =
      totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 100;
    items.push({
      sessionId: r.id,
      ref: r.publicRef,
      refFormatted: formatSessionRef(r.publicRef),
      status: narrowToEnum(r.status, SESSION_STATUSES, 'active'),
      isPreview: r.isPreview,
      createdAt: r.createdAt.toISOString(),
      questionnaireId: r.version.questionnaireId,
      questionnaireTitle: r.version.questionnaire.title,
      versionId: r.versionId,
      versionNumber: r.version.versionNumber,
      turns: r._count.turns,
      answeredCount,
      totalQuestions,
      percentComplete,
    });
  }

  return { items, total };
}

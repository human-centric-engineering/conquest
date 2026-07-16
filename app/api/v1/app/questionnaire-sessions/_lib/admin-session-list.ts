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
      },
    }),
    prisma.appQuestionnaireSession.count({ where }),
  ]);

  const items: AdminSessionRefItem[] = [];
  for (const r of rows) {
    // `publicRef` is filtered non-null above; `version` is a required relation. Guard defensively so a
    // malformed row is skipped rather than crashing the whole page.
    if (!r.publicRef || !r.version) continue;
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
    });
  }

  return { items, total };
}

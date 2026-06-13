/**
 * Questionnaire list read model (P2 / F2.1a).
 *
 * The enriched list query behind `GET /api/v1/app/questionnaires`. Returns one
 * page of questionnaires, each summarised with its latest version and that
 * version's section / question counts — computed in a **fixed number of queries
 * regardless of page size** (no per-row N+1, per the list-endpoint rule). The
 * counts come from two `groupBy` sweeps over the latest-version ids, mirroring the
 * batch-budget pattern on the agents list route.
 *
 * This is a route-local DB seam: the `lib/app/questionnaire/**` module stays
 * Prisma-free, so the read query lives here next to the persistence writer.
 */

import { z } from 'zod';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import {
  APP_QUESTIONNAIRE_STATUSES,
  type AppQuestionnaireStatus,
} from '@/lib/app/questionnaire/types';
import type { QuestionnaireListItem } from '@/lib/app/questionnaire/views';

/** Query-param schema for the list endpoint. Coerces page/limit, clamps limit. */
export const listQuestionnairesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Case-insensitive title search. */
  q: z.string().trim().min(1).max(200).optional(),
  // Status vocabulary is the single-source tuple in the domain types module.
  status: z.enum(APP_QUESTIONNAIRE_STATUSES).optional(),
  sortBy: z.enum(['updatedAt', 'createdAt', 'title']).default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type ListQuestionnairesQuery = z.infer<typeof listQuestionnairesQuerySchema>;

export interface ListQuestionnairesResult {
  items: QuestionnaireListItem[];
  total: number;
}

/**
 * Fetch one page of questionnaires with latest-version enrichment.
 *
 * Query budget: 1 page query + 1 count + 2 groupBy sweeps (sections, questions) =
 * 4 round-trips, independent of page size.
 */
export async function listQuestionnaires(
  query: ListQuestionnairesQuery
): Promise<ListQuestionnairesResult> {
  const { page, limit, q, status, sortBy, sortOrder } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.AppQuestionnaireWhereInput = {};
  if (status) where.status = status;
  if (q) where.title = { contains: q, mode: 'insensitive' };

  const [rows, total] = await Promise.all([
    prisma.appQuestionnaire.findMany({
      where,
      orderBy: { [sortBy]: sortOrder },
      skip,
      take: limit,
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { versions: true } },
        // DEMO-ONLY (F2.5.1): attributed demo client, or null for a generic demo.
        demoClient: { select: { id: true, slug: true, name: true } },
        // Latest version only — the one the list row summarises.
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
          select: { id: true, versionNumber: true, status: true },
        },
      },
    }),
    prisma.appQuestionnaire.count({ where }),
  ]);

  // Collect the latest-version ids, then count their sections / questions in two
  // grouped sweeps rather than a query per row.
  const latestVersionIds = rows
    .map((r) => r.versions[0]?.id)
    .filter((id): id is string => typeof id === 'string');

  const [sectionGroups, questionGroups, dataSlotGroups] =
    latestVersionIds.length > 0
      ? await Promise.all([
          prisma.appQuestionnaireSection.groupBy({
            by: ['versionId'],
            where: { versionId: { in: latestVersionIds } },
            _count: { _all: true },
          }),
          prisma.appQuestionSlot.groupBy({
            by: ['versionId'],
            where: { versionId: { in: latestVersionIds } },
            _count: { _all: true },
          }),
          prisma.appDataSlot.groupBy({
            by: ['versionId'],
            where: { versionId: { in: latestVersionIds } },
            _count: { _all: true },
          }),
        ])
      : [[], [], []];

  const sectionCountByVersion = new Map(sectionGroups.map((g) => [g.versionId, g._count._all]));
  const questionCountByVersion = new Map(questionGroups.map((g) => [g.versionId, g._count._all]));
  const dataSlotCountByVersion = new Map(dataSlotGroups.map((g) => [g.versionId, g._count._all]));

  const items: QuestionnaireListItem[] = rows.map((row) => {
    const latest = row.versions[0] ?? null;
    return {
      id: row.id,
      title: row.title,
      status: row.status as AppQuestionnaireStatus,
      versionCount: row._count.versions,
      latestVersion: latest
        ? {
            id: latest.id,
            versionNumber: latest.versionNumber,
            status: latest.status as AppQuestionnaireStatus,
          }
        : null,
      sectionCount: latest ? (sectionCountByVersion.get(latest.id) ?? 0) : 0,
      questionCount: latest ? (questionCountByVersion.get(latest.id) ?? 0) : 0,
      dataSlotCount: latest ? (dataSlotCountByVersion.get(latest.id) ?? 0) : 0,
      demoClient: row.demoClient,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });

  return { items, total };
}

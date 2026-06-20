/**
 * Cohorts & Rounds — round read models.
 *
 * The list + detail serializers behind the round GET endpoints. Route-local DB seam
 * (`lib/app/questionnaire/**` is Prisma-free). Enriched in a FIXED query budget (the
 * `questionnaires/_lib/list.ts` discipline): one rounds query (with `_count` items + cohort
 * name), one grouped active-member sweep over the rounds' cohorts, and one session sweep via
 * {@link sessionCountsByRound} — no per-row N+1.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import {
  ROUND_STATUSES,
  type RoundDetail,
  type RoundQuestionnaireView,
  type RoundView,
} from '@/lib/app/questionnaire/rounds/types';
import {
  sessionCountsByRound,
  toCompletionStats,
  type RoundSessionCounts,
} from '@/app/api/v1/app/rounds/_lib/stats';

const ROUND_SELECT = {
  id: true,
  cohortId: true,
  name: true,
  description: true,
  status: true,
  opensAt: true,
  closesAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { items: true } },
  cohort: { select: { id: true, name: true, demoClientId: true } },
} as const satisfies Prisma.AppQuestionnaireRoundSelect;

type RoundRow = Prisma.AppQuestionnaireRoundGetPayload<{ select: typeof ROUND_SELECT }>;

function toRoundView(
  row: RoundRow,
  memberCount: number,
  stats: RoundSessionCounts | undefined
): RoundView {
  return {
    id: row.id,
    cohortId: row.cohortId,
    cohortName: row.cohort.name,
    name: row.name,
    description: row.description,
    status: narrowToEnum(row.status, ROUND_STATUSES, 'draft'),
    opensAt: row.opensAt ? row.opensAt.toISOString() : null,
    closesAt: row.closesAt ? row.closesAt.toISOString() : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    questionnaireCount: row._count.items,
    memberCount,
    stats: toCompletionStats(stats),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Active-member counts for a set of cohorts (one grouped query). */
async function activeMemberCounts(cohortIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (cohortIds.length === 0) return map;
  const groups = await prisma.appCohortMember.groupBy({
    by: ['cohortId'],
    where: { cohortId: { in: cohortIds }, status: 'active' },
    _count: { _all: true },
  });
  for (const g of groups) map.set(g.cohortId, g._count._all);
  return map;
}

export interface ListRoundsFilter {
  /** Rounds across every cohort of this demo client (the client-level Rounds tab). */
  demoClientId?: string;
  /** Rounds for a single cohort (the cohort detail page). */
  cohortId?: string;
  /** Name filter (case-insensitive contains). */
  q?: string;
}

/** Rounds matching the filter, newest-first, enriched with counts + completion. */
export async function listRounds(filter: ListRoundsFilter): Promise<RoundView[]> {
  const where: Prisma.AppQuestionnaireRoundWhereInput = {};
  if (filter.cohortId) where.cohortId = filter.cohortId;
  if (filter.demoClientId) where.cohort = { demoClientId: filter.demoClientId };
  if (filter.q && filter.q.trim()) where.name = { contains: filter.q.trim(), mode: 'insensitive' };

  const rows = await prisma.appQuestionnaireRound.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    select: ROUND_SELECT,
  });
  if (rows.length === 0) return [];

  const cohortIds = [...new Set(rows.map((r) => r.cohortId))];
  const [members, perRound] = await Promise.all([
    activeMemberCounts(cohortIds),
    sessionCountsByRound(rows.map((r) => r.id)),
  ]);

  return rows.map((row) => toRoundView(row, members.get(row.cohortId) ?? 0, perRound.get(row.id)));
}

/** Project a round's bundled questionnaires (round items) to the display view. */
function toRoundQuestionnaires(
  items: {
    id: string;
    questionnaireId: string;
    versionId: string | null;
    questionnaire: { title: string };
  }[]
): RoundQuestionnaireView[] {
  return items.map((it) => ({
    itemId: it.id,
    questionnaireId: it.questionnaireId,
    title: it.questionnaire.title,
    versionId: it.versionId,
  }));
}

/** One round by id with its bundled questionnaires, or null when unknown. */
export async function getRoundDetail(id: string): Promise<RoundDetail | null> {
  const row = await prisma.appQuestionnaireRound.findUnique({
    where: { id },
    select: {
      ...ROUND_SELECT,
      items: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          questionnaireId: true,
          versionId: true,
          questionnaire: { select: { title: true } },
        },
      },
    },
  });
  if (!row) return null;

  const [members, perRound] = await Promise.all([
    activeMemberCounts([row.cohortId]),
    sessionCountsByRound([row.id]),
  ]);

  return {
    ...toRoundView(row, members.get(row.cohortId) ?? 0, perRound.get(row.id)),
    questionnaires: toRoundQuestionnaires(row.items),
  };
}

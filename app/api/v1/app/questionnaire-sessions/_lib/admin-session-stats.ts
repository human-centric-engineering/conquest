/**
 * Admin session stats read model (alpha tooling).
 *
 * The aggregates behind `GET /api/v1/app/questionnaire-sessions/refs/stats`: KPI totals, a
 * sessions-over-time trend, a status breakdown, a completion-percentage distribution, and per-client /
 * per-questionnaire counts — all computed over the SAME `where` as the list (`buildAdminSessionWhere`),
 * so the charts always track the browser's active filters.
 *
 * Scale note: this is deliberately alpha tooling. It fetches the matching sessions' minimal fields
 * (createdAt, status, versionId, answered-slot count) and aggregates in memory. Sessions are bounded at
 * alpha volumes; if this surface ever de-alphas, move the trend + distribution to a `date_trunc` /
 * grouped SQL pass.
 */

import { prisma } from '@/lib/db/client';
import { SESSION_STATUSES, narrowToEnum, type SessionStatus } from '@/lib/app/questionnaire/types';
import {
  buildAdminSessionWhere,
  type AdminSessionListQuery,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';

/** Default trend span (days, UTC) when the query carries no date window. */
const TREND_DAYS = 30;

/** Hard cap on trend buckets so a very wide `from`/`to` can't allocate an unbounded series. */
const MAX_TREND_DAYS = 180;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The `YYYY-MM-DD` buckets the over-time series covers, derived from the query's date window so the
 * trend tracks the same filter as every other figure. With no window it is the last {@link TREND_DAYS}
 * days ending today; with one it spans `from`→`to` (either end defaulting), clamped to the most recent
 * {@link MAX_TREND_DAYS} days of that range.
 */
function buildTrendDays(from?: string, to?: string): string[] {
  const end = to ? new Date(`${to}T00:00:00.000Z`) : new Date();
  const start = from
    ? new Date(`${from}T00:00:00.000Z`)
    : new Date(end.getTime() - (TREND_DAYS - 1) * MS_PER_DAY);

  const spanDays = Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
  const days = Math.min(Math.max(spanDays, 1), MAX_TREND_DAYS);
  const first = new Date(end.getTime() - (days - 1) * MS_PER_DAY);

  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    out.push(new Date(first.getTime() + i * MS_PER_DAY).toISOString().slice(0, 10));
  }
  return out;
}

/** Completion-distribution buckets (inclusive upper bound), low → high. */
const COMPLETION_BUCKETS = [
  { label: '0%', max: 0 },
  { label: '1–25%', max: 25 },
  { label: '26–50%', max: 50 },
  { label: '51–75%', max: 75 },
  { label: '76–99%', max: 99 },
  { label: '100%', max: 100 },
] as const;

export interface AdminSessionStats {
  total: number;
  completed: number;
  active: number;
  /** Mean completion percentage across the matching sessions (0 when none). */
  avgCompletion: number;
  /** Status → count, every status present (zero-filled). */
  byStatus: { status: SessionStatus; count: number }[];
  /** One point per day for the last {@link TREND_DAYS} days, zero-filled. */
  overTime: { date: string; count: number }[];
  /** Completion distribution across the fixed buckets. */
  completionBuckets: { label: string; count: number }[];
  /** Sessions per client (top 8), an "Unassigned" bucket folds in client-less questionnaires. */
  byClient: { name: string; count: number }[];
  /** Sessions per questionnaire (top 8). */
  byQuestionnaire: { name: string; count: number }[];
}

/** Compute the browser's stats over the same filter set as the list. */
export async function loadAdminSessionStats(
  query: AdminSessionListQuery
): Promise<AdminSessionStats> {
  const where = await buildAdminSessionWhere(query);

  const rows = await prisma.appQuestionnaireSession.findMany({
    where,
    select: {
      createdAt: true,
      status: true,
      versionId: true,
      _count: { select: { answers: true } },
    },
  });

  const total = rows.length;

  // Completion denominators — total question slots per version, one grouped count over the versions in
  // the result set (slot rows carry a denormalised `versionId`).
  const versionIds = [...new Set(rows.map((r) => r.versionId))];
  const slotCounts = versionIds.length
    ? await prisma.appQuestionSlot.groupBy({
        by: ['versionId'],
        where: { versionId: { in: versionIds } },
        _count: { _all: true },
      })
    : [];
  const totalByVersion = new Map(slotCounts.map((g) => [g.versionId, g._count._all]));

  // version → { questionnaire title, client name } for the by-client / by-questionnaire breakdowns.
  const versions = versionIds.length
    ? await prisma.appQuestionnaireVersion.findMany({
        where: { id: { in: versionIds } },
        select: {
          id: true,
          questionnaire: { select: { title: true, demoClient: { select: { name: true } } } },
        },
      })
    : [];
  const versionMeta = new Map(
    versions.map((v) => [
      v.id,
      { title: v.questionnaire.title, client: v.questionnaire.demoClient?.name ?? 'Unassigned' },
    ])
  );

  // Status tallies (zero-filled across every status).
  const statusTally = new Map<SessionStatus, number>(SESSION_STATUSES.map((s) => [s, 0]));

  // Over-time: bucket by UTC day, seeded across the query's window so gaps render as zero AND the
  // trend covers the same range the other figures were filtered to.
  const dayTally = new Map<string, number>(buildTrendDays(query.from, query.to).map((d) => [d, 0]));

  const bucketTally = COMPLETION_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  const clientTally = new Map<string, number>();
  const questionnaireTally = new Map<string, number>();

  let completionSum = 0;

  for (const r of rows) {
    const status = narrowToEnum(r.status, SESSION_STATUSES, 'active');
    statusTally.set(status, (statusTally.get(status) ?? 0) + 1);

    const day = r.createdAt.toISOString().slice(0, 10);
    if (dayTally.has(day)) dayTally.set(day, (dayTally.get(day) ?? 0) + 1);

    const totalQuestions = totalByVersion.get(r.versionId) ?? 0;
    const pct = totalQuestions > 0 ? Math.round((r._count.answers / totalQuestions) * 100) : 100;
    completionSum += pct;
    const bucketIdx = COMPLETION_BUCKETS.findIndex((b) => pct <= b.max);
    bucketTally[bucketIdx === -1 ? COMPLETION_BUCKETS.length - 1 : bucketIdx].count += 1;

    const meta = versionMeta.get(r.versionId);
    const clientName = meta?.client ?? 'Unassigned';
    const qName = meta?.title ?? 'Unknown';
    clientTally.set(clientName, (clientTally.get(clientName) ?? 0) + 1);
    questionnaireTally.set(qName, (questionnaireTally.get(qName) ?? 0) + 1);
  }

  const topN = (m: Map<string, number>, n: number) =>
    [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, n);

  return {
    total,
    completed: statusTally.get('completed') ?? 0,
    active: statusTally.get('active') ?? 0,
    avgCompletion: total > 0 ? Math.round(completionSum / total) : 0,
    byStatus: SESSION_STATUSES.map((status) => ({ status, count: statusTally.get(status) ?? 0 })),
    overTime: [...dayTally.entries()].map(([date, count]) => ({ date, count })),
    completionBuckets: bucketTally,
    byClient: topN(clientTally, 8),
    byQuestionnaire: topN(questionnaireTally, 8),
  };
}

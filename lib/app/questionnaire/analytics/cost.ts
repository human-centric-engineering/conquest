/**
 * Per-version cost actuals (F8.1) — read from the platform `AiCostLog` ledger.
 *
 * Questionnaire LLM spend lands in `ai_cost_log` tagged via `metadata`:
 *   - live respondent turns      → `metadata.appQuestionnaireSessionId` (the session cuid)
 *   - design-time work (evaluate)→ `metadata.versionId`
 * so a version's spend = the rows for its non-preview sessions (runtime) plus the
 * rows tagged with its version id (design-time). The two tag sets are disjoint, so
 * summing them never double-counts.
 *
 * `AppQuestionnaireTurn.costUsd` stays the F6.3 budget-enforcement basis and is left
 * untouched; this surface reads the richer ledger so it can break spend down by the
 * capability that incurred it.
 *
 * Postgres-only raw SQL (the repo is already pinned to Postgres via pgvector) — the
 * metadata filters are JSON path extractions Prisma's typed `where` can't express
 * for a set of session ids. Mirrors `lib/orchestration/llm/cost-reports.ts`.
 */

import { prisma } from '@/lib/db/client';
import { narrowToEnum, SESSION_STATUSES, type SessionStatus } from '@/lib/app/questionnaire/types';
import { isAnalyticsPanelSuppressed } from '@/lib/app/questionnaire/analytics/privacy';
import {
  roundSessionFilter,
  type AnalyticsScope,
} from '@/lib/app/questionnaire/analytics/query-schema';
import type {
  CostCapabilityBucket,
  CostDayPoint,
  QuestionnaireCostResult,
  SessionCostRow,
} from '@/lib/app/questionnaire/analytics/views';

/** Cap on the top-spending sessions table. */
const TOP_SESSIONS_LIMIT = 10;

/** Human labels for the capability slugs that stamp cost rows; falls back to the raw key. */
const CAPABILITY_LABELS: Record<string, string> = {
  extract_answer_slots: 'Answer extraction',
  detect_contradictions: 'Contradiction detection',
  refine_answer: 'Answer refinement',
  compose_completion_offer: 'Completion offer',
  evaluate_structure: 'Design evaluation',
  extract_questionnaire_structure: 'Structure extraction',
  chat: 'Question selection',
};

function labelFor(key: string): string {
  return CAPABILITY_LABELS[key] ?? key;
}

/** Coerce a raw-SQL aggregate (bigint / numeric / null) to a finite JS number. */
function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface CapabilityRow {
  capability: string | null;
  cost: number | string | null;
  calls: bigint | number | null;
}
interface SessionRow {
  session_id: string | null;
  cost: number | string | null;
}
interface TrendRow {
  day: Date | string;
  cost: number | string | null;
}

/**
 * Aggregate a version's `AiCostLog` spend over the window: total, runtime vs
 * design-time split, per-capability breakdown, daily trend, and top sessions.
 */
export async function getQuestionnaireCostBreakdown(
  scope: AnalyticsScope
): Promise<QuestionnaireCostResult> {
  const range = { from: scope.from.toISOString(), to: scope.to.toISOString() };

  // Non-preview sessions for the version (all time — cost rows are date-filtered by
  // their own `createdAt`). Carries status + createdAt for the top-sessions table. The
  // anonymous-mode flag is read alongside; the two reads are independent, so run them
  // together.
  const [sessions, config] = await Promise.all([
    prisma.appQuestionnaireSession.findMany({
      where: {
        versionId: scope.versionId,
        isPreview: false,
        ...roundSessionFilter(scope.roundId),
      },
      select: { id: true, status: true, createdAt: true },
    }),
    prisma.appQuestionnaireConfig.findUnique({
      where: { versionId: scope.versionId },
      select: { anonymousMode: true },
    }),
  ]);

  // F8.3: the per-session spend table exposes session ids (a re-identification handle).
  // Withhold it when the version is anonymous, or the cohort is below the k-anonymity
  // threshold. Aggregate spend (total / by-capability / trend) carries no identity and
  // is always returned.
  // The `anonymous` gate is the version's explicit anonymous-mode setting, NOT the low-N floor — the
  // alpha bypass only lifts the low-N floor, so anonymous versions keep their session table hidden.
  const anonymous = config?.anonymousMode ?? false;
  const topSessionsSuppressed = anonymous || isAnalyticsPanelSuppressed(sessions.length);

  const sessionMeta = new Map(sessions.map((s) => [s.id, s]));
  const sessionIds = sessions.map((s) => s.id);
  const hasSessions = sessionIds.length > 0;

  // Per-capability merge (runtime ∪ design-time).
  const byCapability = new Map<string, { costUsd: number; callCount: number }>();
  const addCapability = (key: string, costUsd: number, calls: number) => {
    const cur = byCapability.get(key) ?? { costUsd: 0, callCount: 0 };
    cur.costUsd += costUsd;
    cur.callCount += calls;
    byCapability.set(key, cur);
  };

  // 1. Runtime cost: rows tagged with one of this version's session ids.
  let runtimeCostUsd = 0;
  const sessionCost = new Map<string, number>();
  if (hasSessions) {
    const capRows = await prisma.$queryRawUnsafe<CapabilityRow[]>(
      `
      SELECT COALESCE("metadata"->>'capability', operation) AS capability,
             SUM("totalCostUsd") AS cost,
             COUNT(*)            AS calls
      FROM "ai_cost_log"
      WHERE "createdAt" >= $1 AND "createdAt" < $2
        AND "metadata"->>'appQuestionnaireSessionId' = ANY($3::text[])
      GROUP BY capability
      `,
      scope.from,
      scope.to,
      sessionIds
    );
    for (const r of capRows) {
      const cost = num(r.cost);
      runtimeCostUsd += cost;
      addCapability(r.capability ?? 'chat', cost, num(r.calls));
    }

    const sessionRows = await prisma.$queryRawUnsafe<SessionRow[]>(
      `
      SELECT "metadata"->>'appQuestionnaireSessionId' AS session_id,
             SUM("totalCostUsd") AS cost
      FROM "ai_cost_log"
      WHERE "createdAt" >= $1 AND "createdAt" < $2
        AND "metadata"->>'appQuestionnaireSessionId' = ANY($3::text[])
      GROUP BY session_id
      `,
      scope.from,
      scope.to,
      sessionIds
    );
    for (const r of sessionRows) {
      if (r.session_id) sessionCost.set(r.session_id, num(r.cost));
    }
  }

  // 2. Design-time cost: rows tagged with this version id. NOT round-scoped (and the daily trend's
  // design-time leg likewise): authoring spend (extraction, generative authoring, evaluation)
  // predates any round and isn't attributable to one. So under a round scope the RUNTIME leg is
  // round-filtered while this design-time figure stays version-wide — a deliberate asymmetry, not
  // a missing filter.
  let designTimeCostUsd = 0;
  const designRows = await prisma.$queryRawUnsafe<CapabilityRow[]>(
    `
    SELECT COALESCE("metadata"->>'capability', operation) AS capability,
           SUM("totalCostUsd") AS cost,
           COUNT(*)            AS calls
    FROM "ai_cost_log"
    WHERE "createdAt" >= $1 AND "createdAt" < $2
      AND "metadata"->>'versionId' = $3
    GROUP BY capability
    `,
    scope.from,
    scope.to,
    scope.versionId
  );
  for (const r of designRows) {
    const cost = num(r.cost);
    designTimeCostUsd += cost;
    addCapability(r.capability ?? 'chat', cost, num(r.calls));
  }

  // 3. Daily trend over both attribution paths.
  const trendParams: unknown[] = [scope.from, scope.to, scope.versionId];
  let attribution = `"metadata"->>'versionId' = $3`;
  if (hasSessions) {
    trendParams.push(sessionIds);
    attribution = `("metadata"->>'versionId' = $3 OR "metadata"->>'appQuestionnaireSessionId' = ANY($4::text[]))`;
  }
  const trendRows = await prisma.$queryRawUnsafe<TrendRow[]>(
    `
    SELECT date_trunc('day', "createdAt") AS day, SUM("totalCostUsd") AS cost
    FROM "ai_cost_log"
    WHERE "createdAt" >= $1 AND "createdAt" < $2 AND ${attribution}
    GROUP BY day
    ORDER BY day ASC
    `,
    ...trendParams
  );
  const trend: CostDayPoint[] = trendRows.map((r) => ({
    date: (r.day instanceof Date ? r.day : new Date(r.day)).toISOString().slice(0, 10),
    costUsd: num(r.cost),
  }));

  const capabilityBuckets: CostCapabilityBucket[] = [...byCapability.entries()]
    .map(([key, v]) => ({ key, label: labelFor(key), costUsd: v.costUsd, callCount: v.callCount }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const topSessions: SessionCostRow[] = topSessionsSuppressed
    ? []
    : [...sessionCost.entries()]
        .map(([sessionId, costUsd]) => {
          const meta = sessionMeta.get(sessionId);
          return {
            sessionId,
            status: meta
              ? narrowToEnum<SessionStatus>(meta.status, SESSION_STATUSES, 'active')
              : 'active',
            costUsd,
            createdAt: (meta?.createdAt ?? scope.from).toISOString(),
          };
        })
        .sort((a, b) => b.costUsd - a.costUsd)
        .slice(0, TOP_SESSIONS_LIMIT);

  return {
    versionId: scope.versionId,
    range,
    totalCostUsd: runtimeCostUsd + designTimeCostUsd,
    runtimeCostUsd,
    designTimeCostUsd,
    byCapability: capabilityBuckets,
    trend,
    topSessions,
    topSessionsSuppressed,
  };
}

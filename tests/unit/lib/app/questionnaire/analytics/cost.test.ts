/**
 * Unit test: per-version cost aggregation (F8.1).
 *
 * Mocks the session read + the raw-SQL ledger queries and asserts the runtime vs
 * design-time split, per-capability merge, top-session ranking, and trend mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManySessions = vi.fn();
const findUniqueConfig = vi.fn();
const queryRawUnsafe = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: { findMany: (...a: unknown[]) => findManySessions(...a) },
    appQuestionnaireConfig: { findUnique: (...a: unknown[]) => findUniqueConfig(...a) },
    $queryRawUnsafe: (...a: unknown[]) => queryRawUnsafe(...a),
  },
}));

import { getQuestionnaireCostBreakdown } from '@/lib/app/questionnaire/analytics/cost';
import type { AnalyticsScope } from '@/lib/app/questionnaire/analytics/query-schema';

const scope: AnalyticsScope = {
  versionId: 'v1',
  from: new Date('2026-01-01T00:00:00.000Z'),
  to: new Date('2026-02-01T00:00:00.000Z'),
  tagIds: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Non-anonymous by default; F8.3 k-anonymity only withholds top-sessions, never totals.
  findUniqueConfig.mockResolvedValue({ anonymousMode: false });
});

/**
 * Pad a session list to ≥ the k-anonymity threshold so the top-sessions table isn't
 * withheld (F8.3). The padding sessions carry no spend, so ranking/content is unchanged.
 */
function withCohort(
  sessions: Array<{ id: string; status: string; createdAt: Date }>
): Array<{ id: string; status: string; createdAt: Date }> {
  const pad = Array.from({ length: 5 }, (_, i) => ({
    id: `pad${i}`,
    status: 'active',
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
  }));
  return [...sessions, ...pad];
}

/**
 * Route each raw query to canned rows by inspecting its SQL. The four queries are
 * discriminated by anchored, mutually-exclusive markers (not check-order): the two
 * capability rollups both carry `GROUP BY capability` and are split by the presence
 * of the session `ANY(...)` clause (runtime) vs the bare `versionId` filter (design).
 */
function wireRawSql() {
  queryRawUnsafe.mockImplementation((sql: string) => {
    const groupBySession = sql.includes('GROUP BY session_id');
    const groupByCapability = sql.includes('GROUP BY capability');
    const hasSessionAny = sql.includes("'appQuestionnaireSessionId' = ANY");
    const isTrend = sql.includes('date_trunc');

    if (groupBySession) {
      return Promise.resolve([
        { session_id: 's1', cost: 0.5 },
        { session_id: 's2', cost: 1.5 },
      ]);
    }
    if (isTrend) {
      return Promise.resolve([
        { day: new Date('2026-01-05T00:00:00.000Z'), cost: 1.0 },
        { day: new Date('2026-01-06T00:00:00.000Z'), cost: 1.2 },
      ]);
    }
    if (groupByCapability && hasSessionAny) {
      // runtime by-capability
      return Promise.resolve([
        { capability: 'extract_answer_slots', cost: 1.5, calls: 3n },
        { capability: 'chat', cost: 0.5, calls: 2n },
      ]);
    }
    if (groupByCapability) {
      // design-time by-capability (versionId filter, no session ANY clause)
      return Promise.resolve([{ capability: 'evaluate_structure', cost: 0.8, calls: 7n }]);
    }
    return Promise.resolve([]);
  });
}

describe('getQuestionnaireCostBreakdown', () => {
  it('splits runtime vs design-time spend and totals them', async () => {
    findManySessions.mockResolvedValue([
      { id: 's1', status: 'completed', createdAt: new Date('2026-01-05T00:00:00.000Z') },
      { id: 's2', status: 'abandoned', createdAt: new Date('2026-01-06T00:00:00.000Z') },
    ]);
    wireRawSql();

    const result = await getQuestionnaireCostBreakdown(scope);

    expect(result.runtimeCostUsd).toBeCloseTo(2.0, 5); // 1.5 + 0.5
    expect(result.designTimeCostUsd).toBeCloseTo(0.8, 5);
    expect(result.totalCostUsd).toBeCloseTo(2.8, 5);
  });

  it('merges runtime + design-time into a per-capability breakdown, sorted desc', async () => {
    findManySessions.mockResolvedValue([
      { id: 's1', status: 'completed', createdAt: new Date('2026-01-05T00:00:00.000Z') },
      { id: 's2', status: 'abandoned', createdAt: new Date('2026-01-06T00:00:00.000Z') },
    ]);
    wireRawSql();

    const result = await getQuestionnaireCostBreakdown(scope);
    const keys = result.byCapability.map((c) => c.key);
    expect(keys).toEqual(['extract_answer_slots', 'evaluate_structure', 'chat']);
    expect(result.byCapability[0]).toMatchObject({
      key: 'extract_answer_slots',
      label: 'Answer extraction',
      costUsd: 1.5,
      callCount: 3,
    });
  });

  it('ranks top sessions by spend and joins status + createdAt', async () => {
    findManySessions.mockResolvedValue(
      withCohort([
        { id: 's1', status: 'completed', createdAt: new Date('2026-01-05T00:00:00.000Z') },
        { id: 's2', status: 'abandoned', createdAt: new Date('2026-01-06T00:00:00.000Z') },
      ])
    );
    wireRawSql();

    const result = await getQuestionnaireCostBreakdown(scope);
    expect(result.topSessions.map((s) => s.sessionId)).toEqual(['s2', 's1']); // 1.5 before 0.5
    expect(result.topSessions[0]).toMatchObject({
      sessionId: 's2',
      status: 'abandoned',
      costUsd: 1.5,
    });
  });

  it('maps the daily trend to YYYY-MM-DD points', async () => {
    findManySessions.mockResolvedValue([
      { id: 's1', status: 'completed', createdAt: new Date('2026-01-05T00:00:00.000Z') },
    ]);
    wireRawSql();

    const result = await getQuestionnaireCostBreakdown(scope);
    expect(result.trend).toEqual([
      { date: '2026-01-05', costUsd: 1.0 },
      { date: '2026-01-06', costUsd: 1.2 },
    ]);
  });

  it('coerces string/bigint aggregates and falls back for an unknown session row', async () => {
    findManySessions.mockResolvedValue(
      withCohort([
        { id: 's1', status: 'completed', createdAt: new Date('2026-01-05T00:00:00.000Z') },
      ])
    );
    queryRawUnsafe.mockImplementation((sql: string) => {
      if (sql.includes('GROUP BY session_id')) {
        // 's9' is not in findMany → must fall back to status 'active' + scope.from.
        return Promise.resolve([
          { session_id: 's1', cost: '0.25' },
          { session_id: 's9', cost: '2.00' },
        ]);
      }
      if (sql.includes('date_trunc')) return Promise.resolve([]);
      if (sql.includes("'appQuestionnaireSessionId' = ANY")) {
        return Promise.resolve([{ capability: 'extract_answer_slots', cost: '2.25', calls: '5' }]);
      }
      return Promise.resolve([]); // design-time empty
    });

    const result = await getQuestionnaireCostBreakdown(scope);
    expect(result.runtimeCostUsd).toBeCloseTo(2.25, 5); // string coerced
    expect(result.byCapability[0]).toMatchObject({ callCount: 5 }); // string calls coerced
    // 's9' ranks first and uses the fallback status/createdAt.
    expect(result.topSessions[0]).toMatchObject({
      sessionId: 's9',
      status: 'active',
      costUsd: 2,
      createdAt: scope.from.toISOString(),
    });
  });

  it('handles null/undefined aggregates, null capability, and string trend days', async () => {
    findManySessions.mockResolvedValue(
      withCohort([
        { id: 's1', status: 'completed', createdAt: new Date('2026-01-05T00:00:00.000Z') },
      ])
    );
    queryRawUnsafe.mockImplementation((sql: string) => {
      if (sql.includes('GROUP BY session_id')) {
        // a null session_id row must be ignored.
        return Promise.resolve([
          { session_id: null, cost: 1 },
          { session_id: 's1', cost: 0.5 },
        ]);
      }
      if (sql.includes('date_trunc')) {
        // day arriving as a string + a null cost coerces to 0.
        return Promise.resolve([{ day: '2026-01-05T00:00:00.000Z', cost: null }]);
      }
      if (sql.includes("'appQuestionnaireSessionId' = ANY")) {
        // null capability → labelled via the 'chat' fallback.
        return Promise.resolve([{ capability: null, cost: 0.5, calls: 2n }]);
      }
      return Promise.resolve([]); // design-time empty
    });

    const result = await getQuestionnaireCostBreakdown(scope);
    expect(result.runtimeCostUsd).toBeCloseTo(0.5, 5);
    expect(result.byCapability[0]).toMatchObject({ key: 'chat', label: 'Question selection' });
    expect(result.trend).toEqual([{ date: '2026-01-05', costUsd: 0 }]); // string day parsed, null cost → 0
    expect(result.topSessions.map((s) => s.sessionId)).toEqual(['s1']); // null session_id dropped
  });

  it('skips runtime queries when the version has no sessions', async () => {
    findManySessions.mockResolvedValue([]);
    const executedSql: string[] = [];
    queryRawUnsafe.mockImplementation((sql: string) => {
      executedSql.push(sql);
      if (sql.includes('date_trunc')) return Promise.resolve([]);
      return Promise.resolve([{ capability: 'evaluate_structure', cost: 0.4, calls: 7n }]);
    });

    const result = await getQuestionnaireCostBreakdown(scope);

    // No query may reference sessions, and the two session-scoped queries must not run.
    expect(executedSql.some((sql) => sql.includes("'appQuestionnaireSessionId' = ANY"))).toBe(
      false
    );
    expect(executedSql.some((sql) => sql.includes('GROUP BY session_id'))).toBe(false);
    expect(result.runtimeCostUsd).toBe(0);
    expect(result.designTimeCostUsd).toBeCloseTo(0.4, 5);
    expect(result.topSessions).toEqual([]);
    expect(result.topSessionsSuppressed).toBe(false); // empty cohort is not "suppressed"
  });

  it('withholds the top-sessions table in anonymous mode but keeps aggregate spend (F8.3)', async () => {
    findUniqueConfig.mockResolvedValue({ anonymousMode: true });
    findManySessions.mockResolvedValue(
      withCohort([
        { id: 's1', status: 'completed', createdAt: new Date('2026-01-05T00:00:00.000Z') },
        { id: 's2', status: 'abandoned', createdAt: new Date('2026-01-06T00:00:00.000Z') },
      ])
    );
    wireRawSql();

    const result = await getQuestionnaireCostBreakdown(scope);

    // Session ids are a re-identification handle — suppressed when anonymous.
    expect(result.topSessionsSuppressed).toBe(true);
    expect(result.topSessions).toEqual([]);
    // Aggregate spend carries no identity and is always returned.
    expect(result.totalCostUsd).toBeCloseTo(2.8, 5);
    expect(result.byCapability.length).toBeGreaterThan(0);
  });

  it('withholds the top-sessions table below the k-anonymity threshold (F8.3)', async () => {
    // 2 non-preview sessions (< 5) — a top-spend list over so few is a near-complete roster.
    findManySessions.mockResolvedValue([
      { id: 's1', status: 'completed', createdAt: new Date('2026-01-05T00:00:00.000Z') },
      { id: 's2', status: 'abandoned', createdAt: new Date('2026-01-06T00:00:00.000Z') },
    ]);
    wireRawSql();

    const result = await getQuestionnaireCostBreakdown(scope);

    expect(result.topSessionsSuppressed).toBe(true);
    expect(result.topSessions).toEqual([]);
    expect(result.totalCostUsd).toBeCloseTo(2.8, 5); // totals unaffected
  });
});

/**
 * Unit test: alpha session stats read model (`loadAdminSessionStats`).
 *
 * Prisma is mocked. Pins the aggregation: totals + status zero-fill, completion buckets + average,
 * per-client / per-questionnaire counts (with an "Unassigned" fold-in), and that it reuses the shared
 * filter `where` (so a status filter reaches the query).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireSession: { findMany: vi.fn() },
    appQuestionSlot: { groupBy: vi.fn() },
    appQuestionnaireVersion: { findMany: vi.fn() },
    appQuestionnaireRound: { findMany: vi.fn() },
    appCohortMember: { findMany: vi.fn() },
  },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

import { loadAdminSessionStats } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-stats';
import { adminSessionListQuerySchema } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';

type Mock = ReturnType<typeof vi.fn>;
const sessionFindMany = mocks.prisma.appQuestionnaireSession.findMany as Mock;
const slotGroupBy = mocks.prisma.appQuestionSlot.groupBy as Mock;
const versionFindMany = mocks.prisma.appQuestionnaireVersion.findMany as Mock;

const query = (over: Record<string, unknown> = {}) => adminSessionListQuerySchema.parse(over);

function sess(over: Record<string, unknown> = {}) {
  return {
    createdAt: new Date('2026-07-16T10:00:00.000Z'),
    status: 'completed',
    versionId: 'v-1',
    _count: { answers: 5 },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionFindMany.mockResolvedValue([
    sess(),
    sess({ status: 'active', _count: { answers: 10 } }),
    sess({ versionId: 'v-2', status: 'abandoned', _count: { answers: 0 } }),
  ]);
  slotGroupBy.mockResolvedValue([
    { versionId: 'v-1', _count: { _all: 10 } },
    { versionId: 'v-2', _count: { _all: 4 } },
  ]);
  versionFindMany.mockResolvedValue([
    { id: 'v-1', questionnaire: { title: 'Onboarding', demoClient: { name: 'Acme' } } },
    { id: 'v-2', questionnaire: { title: 'Exit Survey', demoClient: null } },
  ]);
});

describe('loadAdminSessionStats', () => {
  it('computes totals and a zero-filled status breakdown', async () => {
    const stats = await loadAdminSessionStats(query());
    expect(stats.total).toBe(3);
    expect(stats.completed).toBe(1);
    expect(stats.active).toBe(1);
    const byStatus = Object.fromEntries(stats.byStatus.map((s) => [s.status, s.count]));
    expect(byStatus).toMatchObject({
      completed: 1,
      active: 1,
      abandoned: 1,
      paused: 0,
      aborted: 0,
    });
  });

  it('computes completion percentages, average, and buckets', async () => {
    // v-1: 5/10=50%, 10/10=100%; v-2: 0/4=0% ⇒ avg = round((50+100+0)/3) = 50
    const stats = await loadAdminSessionStats(query());
    expect(stats.avgCompletion).toBe(50);
    const buckets = Object.fromEntries(stats.completionBuckets.map((b) => [b.label, b.count]));
    expect(buckets['0%']).toBe(1);
    expect(buckets['26–50%']).toBe(1);
    expect(buckets['100%']).toBe(1);
  });

  it('aggregates per client (folding client-less questionnaires into Unassigned) and per questionnaire', async () => {
    const stats = await loadAdminSessionStats(query());
    expect(stats.byClient).toEqual(
      expect.arrayContaining([
        { name: 'Acme', count: 2 },
        { name: 'Unassigned', count: 1 },
      ])
    );
    expect(stats.byQuestionnaire).toEqual(
      expect.arrayContaining([
        { name: 'Onboarding', count: 2 },
        { name: 'Exit Survey', count: 1 },
      ])
    );
  });

  it('reuses the shared filter where (a status filter reaches the query)', async () => {
    await loadAdminSessionStats(query({ status: 'active' }));
    expect(sessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ publicRef: { not: null }, status: 'active' }),
      })
    );
  });

  it('returns zeroed stats and an empty trend day-count window when there are no sessions', async () => {
    sessionFindMany.mockResolvedValue([]);
    const stats = await loadAdminSessionStats(query());
    expect(stats.total).toBe(0);
    expect(stats.avgCompletion).toBe(0);
    expect(stats.overTime).toHaveLength(30);
    expect(stats.overTime.every((p) => p.count === 0)).toBe(true);
  });

  it('spans the query date window, not a fixed 30 days, and buckets sessions by UTC day', async () => {
    // The fixture sessions are all created on 2026-07-16; the window brackets that date.
    const stats = await loadAdminSessionStats(query({ from: '2026-07-10', to: '2026-07-20' }));

    expect(stats.overTime).toHaveLength(11); // 10th–20th inclusive
    expect(stats.overTime[0].date).toBe('2026-07-10');
    expect(stats.overTime.at(-1)?.date).toBe('2026-07-20');

    // All three fixtures land in the 16th's bucket; every other day is zero.
    const day16 = stats.overTime.find((p) => p.date === '2026-07-16');
    expect(day16?.count).toBe(3);
    expect(stats.overTime.filter((p) => p.count > 0)).toHaveLength(1);
  });

  it('clamps an over-wide window to the most recent buckets', async () => {
    sessionFindMany.mockResolvedValue([]);
    const stats = await loadAdminSessionStats(query({ from: '2020-01-01', to: '2026-07-20' }));
    expect(stats.overTime).toHaveLength(180);
    expect(stats.overTime.at(-1)?.date).toBe('2026-07-20');
  });
});

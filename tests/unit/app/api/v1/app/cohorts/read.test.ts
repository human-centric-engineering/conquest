/**
 * Unit: cohort read-model aggregation (`listCohorts`).
 *
 * Pins the per-cohort rollup that the route tests mock away: active-member + round counts come
 * from the filtered `_count`, and completion is summed from the cohort's rounds' sessions
 * (round → cohort fold), with the rate rounded. Prisma is mocked — the point is the fold.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appCohort: { findMany: vi.fn(), findUnique: vi.fn() },
  appCohortSubgroup: { findMany: vi.fn() },
  appQuestionnaireRound: { findMany: vi.fn() },
  appQuestionnaireSession: { groupBy: vi.fn() },
  appDemoClient: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import {
  getCohortDetail,
  listCohortMembers,
  listCohortSubgroups,
  listCohorts,
} from '@/app/api/v1/app/cohorts/_lib/read';

beforeEach(() => vi.clearAllMocks());

const MEMBERS = [
  {
    id: 'm-2',
    cohortId: 'co-1',
    email: 'zoe@x.com',
    name: 'Zoe',
    notes: null,
    status: 'active',
    addedAt: new Date('2026-06-01'),
    removedAt: null,
  },
  {
    id: 'm-3',
    cohortId: 'co-1',
    email: 'amy@x.com',
    name: 'Amy',
    notes: null,
    status: 'active',
    addedAt: new Date('2026-06-01'),
    removedAt: null,
  },
  {
    id: 'm-1',
    cohortId: 'co-1',
    email: 'bob@x.com',
    name: 'Bob',
    notes: null,
    status: 'removed',
    addedAt: new Date('2026-06-01'),
    removedAt: new Date('2026-06-05'),
  },
];

describe('listCohorts', () => {
  it('folds session completion from each cohort’s rounds up to the cohort', async () => {
    prismaMock.appCohort.findMany.mockResolvedValue([
      {
        id: 'co-1',
        demoClientId: 'dc-1',
        name: 'Team A',
        description: null,
        createdAt: new Date('2026-06-01'),
        updatedAt: new Date('2026-06-01'),
        _count: { members: 3, rounds: 2 },
      },
    ]);
    // Two rounds belong to co-1.
    prismaMock.appQuestionnaireRound.findMany.mockResolvedValue([
      { id: 'r-1', cohortId: 'co-1' },
      { id: 'r-2', cohortId: 'co-1' },
    ]);
    // r-1: 4 started / 2 completed; r-2: 1 started / 1 completed → cohort 5 started / 3 completed.
    prismaMock.appQuestionnaireSession.groupBy.mockResolvedValue([
      { roundId: 'r-1', status: 'active', _count: { _all: 2 } },
      { roundId: 'r-1', status: 'completed', _count: { _all: 2 } },
      { roundId: 'r-2', status: 'completed', _count: { _all: 1 } },
    ]);

    const [cohort] = await listCohorts('dc-1');
    expect(cohort).toMatchObject({
      id: 'co-1',
      memberCount: 3, // filtered _count (active only — enforced in the query)
      roundCount: 2,
      stats: { sessionsStarted: 5, sessionsCompleted: 3, completionRate: 0.6 },
    });
  });

  it('reports zero completion for a cohort whose rounds have no sessions', async () => {
    prismaMock.appCohort.findMany.mockResolvedValue([
      {
        id: 'co-2',
        demoClientId: 'dc-1',
        name: 'Team B',
        description: 'desc',
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { members: 0, rounds: 0 },
      },
    ]);
    prismaMock.appQuestionnaireRound.findMany.mockResolvedValue([]);
    prismaMock.appQuestionnaireSession.groupBy.mockResolvedValue([]);

    const [cohort] = await listCohorts('dc-1');
    expect(cohort.stats).toEqual({
      sessionsStarted: 0,
      sessionsCompleted: 0,
      completionRate: 0,
    });
  });

  it('applies a name search filter (case-insensitive contains)', async () => {
    prismaMock.appCohort.findMany.mockResolvedValue([]);
    const result = await listCohorts('dc-1', 'lead');
    expect(result).toEqual([]);
    expect(prismaMock.appCohort.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          demoClientId: 'dc-1',
          name: { contains: 'lead', mode: 'insensitive' },
        }),
      })
    );
  });
});

describe('getCohortDetail', () => {
  it('returns null when the cohort is absent', async () => {
    prismaMock.appCohort.findUnique.mockResolvedValue(null);
    expect(await getCohortDetail('nope')).toBeNull();
  });

  it('attaches the roster (active first, then alphabetical) with a stats rollup', async () => {
    prismaMock.appCohort.findUnique.mockResolvedValue({
      id: 'co-1',
      demoClientId: 'dc-1',
      name: 'Team A',
      description: null,
      createdAt: new Date('2026-06-01'),
      updatedAt: new Date('2026-06-01'),
      _count: { members: 2, rounds: 1 },
      members: MEMBERS,
      subgroups: [
        {
          id: 'sg-1',
          cohortId: 'co-1',
          name: 'Senior Leadership Team',
          description: null,
          ordinal: 0,
          createdAt: new Date('2026-06-01'),
          updatedAt: new Date('2026-06-01'),
          _count: { members: 1 },
        },
      ],
    });
    prismaMock.appQuestionnaireRound.findMany.mockResolvedValue([{ id: 'r-1' }]);
    prismaMock.appQuestionnaireSession.groupBy.mockResolvedValue([
      { roundId: 'r-1', status: 'completed', _count: { _all: 2 } },
    ]);

    const detail = await getCohortDetail('co-1');
    expect(detail?.members.map((m) => m.name)).toEqual(['Amy', 'Zoe', 'Bob']); // active A→Z, removed last
    expect(detail?.stats).toMatchObject({ sessionsStarted: 2, sessionsCompleted: 2 });
    expect(detail?.subgroups).toEqual([
      expect.objectContaining({ id: 'sg-1', name: 'Senior Leadership Team', memberCount: 1 }),
    ]);
  });
});

describe('listCohortMembers', () => {
  it('returns null when the cohort is unknown', async () => {
    prismaMock.appCohort.findUnique.mockResolvedValue(null);
    expect(await listCohortMembers('nope')).toBeNull();
  });

  it('sorts active members before removed, alphabetically within each', async () => {
    prismaMock.appCohort.findUnique.mockResolvedValue({ id: 'co-1', members: MEMBERS });
    const members = await listCohortMembers('co-1');
    expect(members?.map((m) => `${m.name}:${m.status}`)).toEqual([
      'Amy:active',
      'Zoe:active',
      'Bob:removed',
    ]);
  });
});

describe('listCohortSubgroups', () => {
  it('returns null when the cohort is unknown (no subgroup query)', async () => {
    prismaMock.appCohort.findUnique.mockResolvedValue(null);
    expect(await listCohortSubgroups('nope')).toBeNull();
    expect(prismaMock.appCohortSubgroup.findMany).not.toHaveBeenCalled();
  });

  it('maps subgroup rows to views with their active-member count', async () => {
    prismaMock.appCohort.findUnique.mockResolvedValue({ id: 'co-1' });
    prismaMock.appCohortSubgroup.findMany.mockResolvedValue([
      {
        id: 'sg-1',
        cohortId: 'co-1',
        name: 'Senior Leadership Team',
        description: 'execs',
        ordinal: 0,
        createdAt: new Date('2026-06-01'),
        updatedAt: new Date('2026-06-01'),
        _count: { members: 2 },
      },
    ]);
    const subgroups = await listCohortSubgroups('co-1');
    expect(subgroups).toEqual([
      expect.objectContaining({ id: 'sg-1', name: 'Senior Leadership Team', memberCount: 2 }),
    ]);
  });
});

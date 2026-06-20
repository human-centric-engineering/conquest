/**
 * Unit: round read-model aggregation (`listRounds`, `listRoundsForVersion`).
 *
 * Pins the enrichment the route tests mock away: a round row → view with active-member count +
 * completion, and the analytics round-scope option list (only rounds that produced sessions for a
 * version, plus the open-ended flag). Prisma is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireRound: { findMany: vi.fn(), findUnique: vi.fn() },
  appCohortMember: { groupBy: vi.fn() },
  appQuestionnaireSession: { groupBy: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import {
  getRoundDetail,
  listRounds,
  listRoundsForVersion,
} from '@/app/api/v1/app/rounds/_lib/read';

beforeEach(() => vi.clearAllMocks());

describe('listRounds', () => {
  it('enriches a round with its cohort’s active-member count + completion', async () => {
    prismaMock.appQuestionnaireRound.findMany.mockResolvedValue([
      {
        id: 'r-1',
        cohortId: 'co-1',
        name: 'July round',
        description: null,
        status: 'open',
        opensAt: new Date('2026-07-01'),
        closesAt: new Date('2026-07-31'),
        closedAt: null,
        createdAt: new Date('2026-06-20'),
        updatedAt: new Date('2026-06-20'),
        _count: { items: 2 },
        cohort: { id: 'co-1', name: 'Team A', demoClientId: 'dc-1' },
      },
    ]);
    prismaMock.appCohortMember.groupBy.mockResolvedValue([
      { cohortId: 'co-1', _count: { _all: 4 } },
    ]);
    prismaMock.appQuestionnaireSession.groupBy.mockResolvedValue([
      { roundId: 'r-1', status: 'active', _count: { _all: 1 } },
      { roundId: 'r-1', status: 'completed', _count: { _all: 3 } },
    ]);

    const [round] = await listRounds({ demoClientId: 'dc-1' });
    expect(round).toMatchObject({
      id: 'r-1',
      cohortName: 'Team A',
      status: 'open',
      questionnaireCount: 2,
      memberCount: 4,
      stats: { sessionsStarted: 4, sessionsCompleted: 3, completionRate: 0.75 },
    });
  });

  it('filters by cohort scope when given a cohortId, returning the empty list cleanly', async () => {
    prismaMock.appQuestionnaireRound.findMany.mockResolvedValue([]);
    const result = await listRounds({ cohortId: 'co-9' });
    expect(result).toEqual([]);
    expect(prismaMock.appQuestionnaireRound.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ cohortId: 'co-9' }) })
    );
  });
});

describe('getRoundDetail', () => {
  it('returns null when the round is unknown', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue(null);
    expect(await getRoundDetail('nope')).toBeNull();
  });

  it('projects the bundled questionnaires onto the detail view', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({
      id: 'r-1',
      cohortId: 'co-1',
      name: 'July round',
      description: null,
      status: 'open',
      opensAt: null,
      closesAt: null,
      closedAt: null,
      createdAt: new Date('2026-06-20'),
      updatedAt: new Date('2026-06-20'),
      _count: { items: 1 },
      cohort: { id: 'co-1', name: 'Team A', demoClientId: 'dc-1' },
      items: [
        {
          id: 'item-1',
          questionnaireId: 'q-1',
          versionId: 'v-1',
          questionnaire: { title: 'Onboarding survey' },
        },
      ],
    });
    prismaMock.appCohortMember.groupBy.mockResolvedValue([
      { cohortId: 'co-1', _count: { _all: 2 } },
    ]);
    prismaMock.appQuestionnaireSession.groupBy.mockResolvedValue([]);

    const detail = await getRoundDetail('r-1');
    expect(detail?.memberCount).toBe(2);
    expect(detail?.questionnaires).toEqual([
      { itemId: 'item-1', questionnaireId: 'q-1', title: 'Onboarding survey', versionId: 'v-1' },
    ]);
  });
});

describe('listRoundsForVersion', () => {
  it('returns only rounds that produced sessions, and flags open-ended sessions', async () => {
    prismaMock.appQuestionnaireSession.groupBy.mockResolvedValue([
      { roundId: 'r-1', _count: { _all: 5 } },
      { roundId: null, _count: { _all: 2 } }, // open-ended (non-round) sessions exist
    ]);
    prismaMock.appQuestionnaireRound.findMany.mockResolvedValue([
      { id: 'r-1', name: 'July round', cohort: { name: 'Team A' } },
    ]);

    const result = await listRoundsForVersion('v-1');
    expect(result.hasOpenEnded).toBe(true);
    expect(result.rounds).toEqual([{ id: 'r-1', name: 'July round', cohortName: 'Team A' }]);
    // Only the non-null round ids are looked up.
    expect(prismaMock.appQuestionnaireRound.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['r-1'] } } })
    );
  });

  it('returns no rounds (and no lookup) when the version has only open-ended sessions', async () => {
    prismaMock.appQuestionnaireSession.groupBy.mockResolvedValue([
      { roundId: null, _count: { _all: 3 } },
    ]);
    const result = await listRoundsForVersion('v-1');
    expect(result).toEqual({ rounds: [], hasOpenEnded: true });
    expect(prismaMock.appQuestionnaireRound.findMany).not.toHaveBeenCalled();
  });

  it('flags no open-ended sessions when every session is round-bound', async () => {
    prismaMock.appQuestionnaireSession.groupBy.mockResolvedValue([
      { roundId: 'r-1', _count: { _all: 5 } },
    ]);
    prismaMock.appQuestionnaireRound.findMany.mockResolvedValue([
      { id: 'r-1', name: 'R1', cohort: { name: 'C' } },
    ]);
    const result = await listRoundsForVersion('v-1');
    expect(result.hasOpenEnded).toBe(false);
  });
});

/**
 * Unit: round session-completion stats (`sessionCountsByRound` + `toCompletionStats`).
 *
 * Pins the batched-groupBy fold and the completion-rate projection. Prisma is mocked — the
 * point is the fold logic (status === 'completed' is the completed tally; isPreview:false is
 * applied in the query) and the rate rounding, not the DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireSession: { groupBy: vi.fn() } },
}));

import { sessionCountsByRound, toCompletionStats } from '@/app/api/v1/app/rounds/_lib/stats';
import { prisma } from '@/lib/db/client';

type Mock = ReturnType<typeof vi.fn>;
const groupBy = prisma.appQuestionnaireSession.groupBy as unknown as Mock;

beforeEach(() => vi.clearAllMocks());

describe('sessionCountsByRound', () => {
  it('returns an empty map and runs no query for no ids', async () => {
    const map = await sessionCountsByRound([]);
    expect(map.size).toBe(0);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('folds status groups into per-round started/completed', async () => {
    groupBy.mockResolvedValue([
      { roundId: 'r1', status: 'active', _count: { _all: 3 } },
      { roundId: 'r1', status: 'completed', _count: { _all: 2 } },
      { roundId: 'r2', status: 'completed', _count: { _all: 4 } },
    ]);
    const map = await sessionCountsByRound(['r1', 'r2']);
    expect(map.get('r1')).toEqual({ started: 5, completed: 2 });
    expect(map.get('r2')).toEqual({ started: 4, completed: 4 });
  });

  it('filters preview sessions out via the query (isPreview:false)', async () => {
    groupBy.mockResolvedValue([]);
    await sessionCountsByRound(['r1']);
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['roundId', 'status'],
        where: expect.objectContaining({ isPreview: false, roundId: { in: ['r1'] } }),
      })
    );
  });

  it('ignores null roundId groups defensively', async () => {
    groupBy.mockResolvedValue([{ roundId: null, status: 'completed', _count: { _all: 9 } }]);
    const map = await sessionCountsByRound(['r1']);
    expect(map.size).toBe(0);
  });
});

describe('toCompletionStats', () => {
  it('computes a rounded completion rate', () => {
    expect(toCompletionStats({ started: 3, completed: 1 })).toEqual({
      sessionsStarted: 3,
      sessionsCompleted: 1,
      completionRate: 0.33,
    });
  });

  it('is zero when nothing started (no divide-by-zero)', () => {
    expect(toCompletionStats(undefined)).toEqual({
      sessionsStarted: 0,
      sessionsCompleted: 0,
      completionRate: 0,
    });
  });

  it('is 1 when all started sessions completed', () => {
    expect(toCompletionStats({ started: 4, completed: 4 }).completionRate).toBe(1);
  });
});

/**
 * loadRespondentEditedSlotIds — the cheap guard the per-turn pipeline reads so chat extraction
 * never overwrites an answer the respondent set themselves in form view (P-presentation).
 *
 * @see app/api/v1/app/questionnaires/_lib/answer-slots.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: { appAnswerSlot: { findMany: vi.fn() } },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

import { loadRespondentEditedSlotIds } from '@/app/api/v1/app/questionnaires/_lib/answer-slots';

type Mock = ReturnType<typeof vi.fn>;
const findMany = mocks.prisma.appAnswerSlot.findMany as Mock;

beforeEach(() => vi.clearAllMocks());

describe('loadRespondentEditedSlotIds', () => {
  it('returns the set of respondent-edited question slot ids for the session', async () => {
    findMany.mockResolvedValue([{ questionSlotId: 'q1' }, { questionSlotId: 'q3' }]);
    const set = await loadRespondentEditedSlotIds('sess-1');
    expect(set).toBeInstanceOf(Set);
    expect([...set].sort()).toEqual(['q1', 'q3']);
    // Scoped to the session and filtered to respondent-edited rows only.
    expect(findMany).toHaveBeenCalledWith({
      where: { sessionId: 'sess-1', respondentEdited: true },
      select: { questionSlotId: true },
    });
  });

  it('returns an empty set when nothing was respondent-edited', async () => {
    findMany.mockResolvedValue([]);
    expect((await loadRespondentEditedSlotIds('sess-1')).size).toBe(0);
  });
});

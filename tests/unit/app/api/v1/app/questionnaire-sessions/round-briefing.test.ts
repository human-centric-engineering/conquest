/**
 * Unit: the per-turn briefing DB read (`loadRoundBriefing`).
 *
 * Returns the round's entries for a version, or null when the round is gone / `contextEnabled` is off
 * — so the caller treats "off" and "no briefing" identically.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireRound: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { loadRoundBriefing } from '@/app/api/v1/app/questionnaire-sessions/_lib/round-briefing';

type Mock = ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe('loadRoundBriefing', () => {
  it('returns null when the round is gone', async () => {
    (prismaMock.appQuestionnaireRound.findUnique as Mock).mockResolvedValue(null);
    expect(await loadRoundBriefing('r1', 'v1')).toBeNull();
  });

  it('returns null when the round has contextEnabled off', async () => {
    (prismaMock.appQuestionnaireRound.findUnique as Mock).mockResolvedValue({
      contextEnabled: false,
      contextEntries: [{ questionSlotId: null, title: 'T', content: 'C' }],
    });
    expect(await loadRoundBriefing('r1', 'v1')).toBeNull();
  });

  it('returns the entries when contextEnabled is on, scoped to the version', async () => {
    (prismaMock.appQuestionnaireRound.findUnique as Mock).mockResolvedValue({
      contextEnabled: true,
      contextEntries: [{ questionSlotId: 'q1', title: 'Setup', content: 'steps' }],
    });
    const res = await loadRoundBriefing('r1', 'v1');
    expect(res).toEqual([{ questionSlotId: 'q1', title: 'Setup', content: 'steps' }]);
    const args = (prismaMock.appQuestionnaireRound.findUnique as Mock).mock.calls[0][0];
    expect(args.select.contextEntries.where).toEqual({ versionId: 'v1' });
  });
});

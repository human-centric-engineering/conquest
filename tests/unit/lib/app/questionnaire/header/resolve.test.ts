/**
 * resolveSessionHeader / resolveVersionHeader — DB seam loading the chat-banner header
 * (title + round window). Mocks `@/lib/db/client`.
 *
 * @see lib/app/questionnaire/header/resolve.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn() },
    appQuestionnaireRound: { findUnique: vi.fn() },
    appQuestionnaireVersion: { findUnique: vi.fn() },
  },
}));

import { resolveSessionHeader, resolveVersionHeader } from '@/lib/app/questionnaire/header/resolve';
import { prisma } from '@/lib/db/client';

const mockSession = vi.mocked(prisma.appQuestionnaireSession.findUnique);
const mockRound = vi.mocked(prisma.appQuestionnaireRound.findUnique);
const mockVersion = vi.mocked(prisma.appQuestionnaireVersion.findUnique);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSessionHeader', () => {
  it('returns null when the session does not resolve', async () => {
    mockSession.mockResolvedValue(null);
    expect(await resolveSessionHeader('missing')).toBeNull();
    expect(mockRound).not.toHaveBeenCalled();
  });

  it('returns the title with no round for an open-ended session (no roundId)', async () => {
    mockSession.mockResolvedValue({
      roundId: null,
      version: { questionnaire: { title: 'Team Health Check' } },
    } as never);

    expect(await resolveSessionHeader('s1')).toEqual({ title: 'Team Health Check', round: null });
    // No roundId → never does the second query.
    expect(mockRound).not.toHaveBeenCalled();
  });

  it('does a second query for the round and returns its window', async () => {
    mockSession.mockResolvedValue({
      roundId: 'r1',
      version: { questionnaire: { title: 'Team Health Check' } },
    } as never);
    const opensAt = new Date('2026-04-01T00:00:00Z');
    const closesAt = new Date('2026-06-30T00:00:00Z');
    mockRound.mockResolvedValue({
      name: 'Round 3 · Spring Cohort',
      status: 'open',
      opensAt,
      closesAt,
      closedAt: null,
    } as never);

    const header = await resolveSessionHeader('s1');
    expect(mockRound).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r1' } }));
    expect(header).toEqual({
      title: 'Team Health Check',
      round: { name: 'Round 3 · Spring Cohort', status: 'open', opensAt, closesAt, closedAt: null },
    });
  });

  it('keeps round null when the roundId points at a missing round', async () => {
    mockSession.mockResolvedValue({
      roundId: 'gone',
      version: { questionnaire: { title: 'Team Health Check' } },
    } as never);
    mockRound.mockResolvedValue(null);

    expect(await resolveSessionHeader('s1')).toEqual({ title: 'Team Health Check', round: null });
  });
});

describe('resolveVersionHeader', () => {
  it('returns null when the version does not resolve', async () => {
    mockVersion.mockResolvedValue(null);
    expect(await resolveVersionHeader('missing')).toBeNull();
  });

  it('returns the title with no round (no session exists pre-boot)', async () => {
    mockVersion.mockResolvedValue({
      questionnaire: { title: 'Customer Experience Survey' },
    } as never);
    expect(await resolveVersionHeader('v1')).toEqual({
      title: 'Customer Experience Survey',
      round: null,
    });
  });
});

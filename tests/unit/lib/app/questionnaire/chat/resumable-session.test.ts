/**
 * Unit test: findAuthedResumeDetail (session resume).
 *
 * Prisma is mocked. Pins that the authenticated resume reader returns the ref + answered count for a
 * non-terminal, non-preview session scoped to the user + version (+ round), and null when none.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: { appQuestionnaireSession: { findFirst: vi.fn() } },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

import { findAuthedResumeDetail } from '@/lib/app/questionnaire/chat/resumable-session';

type Mock = ReturnType<typeof vi.fn>;
const findFirst = mocks.prisma.appQuestionnaireSession.findFirst as Mock;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findAuthedResumeDetail', () => {
  it('returns the ref + answered count for a resumable session', async () => {
    findFirst.mockResolvedValue({ id: 'sess-1', publicRef: '7F3K9M2P', _count: { answers: 4 } });
    const detail = await findAuthedResumeDetail('v-1', 'user-1');
    expect(detail).toEqual({ sessionId: 'sess-1', ref: '7F3K9M2P', answeredCount: 4 });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          versionId: 'v-1',
          respondentUserId: 'user-1',
          isPreview: false,
          status: { in: ['active', 'paused'] },
          roundId: null,
        }),
      })
    );
  });

  it('scopes to the given round when provided', async () => {
    findFirst.mockResolvedValue({ id: 'sess-1', publicRef: null, _count: { answers: 0 } });
    await findAuthedResumeDetail('v-1', 'user-1', 'round-9');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ roundId: 'round-9' }) })
    );
  });

  it('returns null when no resumable session exists', async () => {
    findFirst.mockResolvedValue(null);
    expect(await findAuthedResumeDetail('v-1', 'user-1')).toBeNull();
  });
});

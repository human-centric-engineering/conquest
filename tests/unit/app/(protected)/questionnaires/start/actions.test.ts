/**
 * Unit test: startFreshAuthedSession server action (session resume).
 *
 * Pins the security-relevant behaviour: the old session is abandoned ONLY when it belongs to the
 * caller and is still open (no cross-user abandon), a fresh session is created for the caller, and
 * the action redirects into it. Prisma, auth, the sessions seam, and next/navigation are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  clearInvalidSession: vi.fn(),
  prisma: { appQuestionnaireSession: { findUnique: vi.fn() } },
  abandonSession: vi.fn(),
  createSessionForVersion: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/auth/utils', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/auth/clear-session', () => ({ clearInvalidSession: mocks.clearInvalidSession }));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/sessions', () => ({
  abandonSession: mocks.abandonSession,
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/create', () => ({
  createSessionForVersion: mocks.createSessionForVersion,
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/logging', () => ({ logger: mocks.logger }));

import { startFreshAuthedSession } from '@/app/(protected)/questionnaires/start/actions';

type Mock = ReturnType<typeof vi.fn>;
const findUnique = mocks.prisma.appQuestionnaireSession.findUnique as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerSession.mockResolvedValue({ user: { id: 'user-1' } });
  findUnique.mockResolvedValue({ respondentUserId: 'user-1', status: 'active' });
  mocks.createSessionForVersion.mockResolvedValue({
    ok: true,
    session: { id: 'sess-new', status: 'active', versionId: 'v-1' },
    resumed: false,
  });
});

describe('startFreshAuthedSession', () => {
  it('abandons the caller-owned old session and redirects into a fresh one', async () => {
    await expect(startFreshAuthedSession('v-1', 'sess-old')).rejects.toThrow(
      'REDIRECT:/questionnaires/sess-new'
    );
    expect(mocks.abandonSession).toHaveBeenCalledWith('sess-old', {
      reason: 'respondent_start_new',
    });
    expect(mocks.createSessionForVersion).toHaveBeenCalledWith('v-1', 'user-1');
  });

  it('does NOT abandon a session owned by another user (no cross-user abandon)', async () => {
    findUnique.mockResolvedValue({ respondentUserId: 'someone-else', status: 'active' });
    await expect(startFreshAuthedSession('v-1', 'sess-old')).rejects.toThrow('REDIRECT:');
    expect(mocks.abandonSession).not.toHaveBeenCalled();
    // Still creates a fresh session for the caller.
    expect(mocks.createSessionForVersion).toHaveBeenCalledWith('v-1', 'user-1');
  });

  it('does NOT abandon an already-terminal session', async () => {
    findUnique.mockResolvedValue({ respondentUserId: 'user-1', status: 'completed' });
    await expect(startFreshAuthedSession('v-1', 'sess-old')).rejects.toThrow('REDIRECT:');
    expect(mocks.abandonSession).not.toHaveBeenCalled();
  });

  it('clears the session and returns when unauthenticated (never touches the DB)', async () => {
    mocks.getServerSession.mockResolvedValue(null);
    await startFreshAuthedSession('v-1', 'sess-old');
    expect(mocks.clearInvalidSession).toHaveBeenCalledWith('/questionnaires/start?versionId=v-1');
    expect(findUnique).not.toHaveBeenCalled();
    expect(mocks.createSessionForVersion).not.toHaveBeenCalled();
  });

  it('bounces back to the start page when the fresh create fails', async () => {
    mocks.createSessionForVersion.mockResolvedValue({
      ok: false,
      status: 403,
      code: 'INVITATION_REQUIRED',
      message: 'nope',
    });
    await expect(startFreshAuthedSession('v-1', 'sess-old')).rejects.toThrow(
      'REDIRECT:/questionnaires/start?versionId=v-1'
    );
  });

  it('proceeds to create even when the abandon throws (best-effort)', async () => {
    mocks.abandonSession.mockRejectedValue(new Error('transition boom'));
    await expect(startFreshAuthedSession('v-1', 'sess-old')).rejects.toThrow(
      'REDIRECT:/questionnaires/sess-new'
    );
    expect(mocks.logger.warn).toHaveBeenCalled();
    expect(mocks.createSessionForVersion).toHaveBeenCalledWith('v-1', 'user-1');
  });
});

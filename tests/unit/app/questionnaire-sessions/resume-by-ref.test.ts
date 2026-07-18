/**
 * Unit test: cross-device resume ref resolver (session resume).
 *
 * Prisma is mocked; the real `normalizeSessionRef` runs. Pins the guard matrix that keeps a
 * low-entropy support code from resolving anything but the caller's OWN in-progress anonymous
 * session — every failing guard must return `null` (which the route collapses to one generic 404).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: { appQuestionnaireSession: { findUnique: vi.fn() } },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

import { resolveAnonymousResumeByRef } from '@/app/api/v1/app/questionnaire-sessions/_lib/resume-by-ref';

type Mock = ReturnType<typeof vi.fn>;
const findSession = mocks.prisma.appQuestionnaireSession.findUnique as Mock;

/** A row that passes every guard (anonymous, non-preview, active, version resume-enabled). */
function resumableRow(over: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    publicRef: '7F3K9M2P',
    status: 'active',
    isPreview: false,
    respondentUserId: null,
    invitationId: null,
    versionId: 'v-1',
    version: { config: { sessionResumeEnabled: true } },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveAnonymousResumeByRef', () => {
  it('resolves a resumable anonymous session and normalises the ref before lookup', async () => {
    findSession.mockResolvedValue(resumableRow());
    // Lower-case, dashed, with an O-for-0 look-alike — the forgiving normaliser folds it.
    const target = await resolveAnonymousResumeByRef('7f3k-9m2p');
    expect(target).toEqual({
      sessionId: 'sess-1',
      versionId: 'v-1',
      ref: '7F3K9M2P',
      status: 'active',
    });
    expect(findSession).toHaveBeenCalledWith(
      expect.objectContaining({ where: { publicRef: '7F3K9M2P' } })
    );
  });

  it('resolves a paused session too (paused is resumable)', async () => {
    findSession.mockResolvedValue(resumableRow({ status: 'paused' }));
    const target = await resolveAnonymousResumeByRef('7F3K9M2P');
    expect(target?.status).toBe('paused');
  });

  it('returns null for an empty / unnormalisable ref without hitting the DB', async () => {
    expect(await resolveAnonymousResumeByRef('   ')).toBeNull();
    expect(findSession).not.toHaveBeenCalled();
  });

  it('returns null when no session matches the ref', async () => {
    findSession.mockResolvedValue(null);
    expect(await resolveAnonymousResumeByRef('7F3K9M2P')).toBeNull();
  });

  it('returns null for a signed-in respondent session (anonymous only)', async () => {
    findSession.mockResolvedValue(resumableRow({ respondentUserId: 'user-1' }));
    expect(await resolveAnonymousResumeByRef('7F3K9M2P')).toBeNull();
  });

  it('returns null for an admin preview session', async () => {
    findSession.mockResolvedValue(resumableRow({ isPreview: true }));
    expect(await resolveAnonymousResumeByRef('7F3K9M2P')).toBeNull();
  });

  it('returns null for an invite-bound session (resumes via the private link, not the ref)', async () => {
    findSession.mockResolvedValue(resumableRow({ invitationId: 'inv-1' }));
    expect(await resolveAnonymousResumeByRef('7F3K9M2P')).toBeNull();
  });

  it.each(['completed', 'abandoned', 'aborted'])(
    'returns null for a terminal (%s) session',
    async (status) => {
      findSession.mockResolvedValue(resumableRow({ status }));
      expect(await resolveAnonymousResumeByRef('7F3K9M2P')).toBeNull();
    }
  );

  it('returns null when the version has resume turned off', async () => {
    findSession.mockResolvedValue(
      resumableRow({ version: { config: { sessionResumeEnabled: false } } })
    );
    expect(await resolveAnonymousResumeByRef('7F3K9M2P')).toBeNull();
  });

  it('returns null for an archived version (retired from respondents)', async () => {
    findSession.mockResolvedValue(
      resumableRow({ version: { archivedAt: new Date(), config: { sessionResumeEnabled: true } } })
    );
    expect(await resolveAnonymousResumeByRef('7F3K9M2P')).toBeNull();
  });

  it('resolves when the version has no config row (lazy default is ON)', async () => {
    findSession.mockResolvedValue(resumableRow({ version: { config: null } }));
    const target = await resolveAnonymousResumeByRef('7F3K9M2P');
    expect(target?.sessionId).toBe('sess-1');
  });
});

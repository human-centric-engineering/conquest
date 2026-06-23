/**
 * Unit test: admin session-viewer read seams.
 *
 * Prisma is mocked; the real `normalizeSessionRef` / `narrowToEnum` run. Pins the two behaviours the
 * viewer depends on: identity redaction in anonymous mode (never queries the user table — the same
 * hard gate the PDF export applies), and forgiving ref normalisation before the `publicRef` lookup.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

import {
  loadAdminSessionView,
  resolveSessionRefLocation,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-view';

type Mock = ReturnType<typeof vi.fn>;
const findSession = mocks.prisma.appQuestionnaireSession.findUnique as Mock;
const findUser = mocks.prisma.user.findUnique as Mock;

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    status: 'completed',
    isPreview: false,
    publicRef: '7F3K9M2P',
    versionId: 'v-1',
    respondentUserId: 'user-1',
    version: {
      versionNumber: 2,
      questionnaireId: 'q-1',
      config: { anonymousMode: false },
      questionnaire: { title: 'Onboarding' },
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findUser.mockResolvedValue({ name: 'Ada' });
});

describe('loadAdminSessionView', () => {
  it('returns null when the session does not exist', async () => {
    findSession.mockResolvedValue(null);
    expect(await loadAdminSessionView('missing')).toBeNull();
  });

  it('maps the row and looks up the respondent name when not anonymous', async () => {
    findSession.mockResolvedValue(sessionRow());
    const view = await loadAdminSessionView('sess-1');
    expect(view).toMatchObject({
      questionnaireId: 'q-1',
      questionnaireTitle: 'Onboarding',
      versionId: 'v-1',
      versionNumber: 2,
      isPreview: false,
      status: 'completed',
      publicRef: '7F3K9M2P',
      anonymous: false,
      respondentName: 'Ada',
    });
    expect(findUser).toHaveBeenCalledOnce();
  });

  it('never queries identity in anonymous mode (respondentName null)', async () => {
    findSession.mockResolvedValue(
      sessionRow({ version: { ...sessionRow().version, config: { anonymousMode: true } } })
    );
    const view = await loadAdminSessionView('sess-1');
    expect(view?.anonymous).toBe(true);
    expect(view?.respondentName).toBeNull();
    expect(findUser).not.toHaveBeenCalled();
  });

  it('narrows an unexpected status to active', async () => {
    findSession.mockResolvedValue(sessionRow({ status: 'bogus' }));
    const view = await loadAdminSessionView('sess-1');
    expect(view?.status).toBe('active');
  });
});

describe('resolveSessionRefLocation', () => {
  function refRow(over: Record<string, unknown> = {}) {
    return {
      id: 'sess-1',
      publicRef: '7F3K9M2P',
      isPreview: true,
      status: 'active',
      versionId: 'v-1',
      version: {
        versionNumber: 2,
        questionnaireId: 'q-1',
        questionnaire: { title: 'Onboarding' },
      },
      ...over,
    };
  }

  it('normalises the ref forgivingly before lookup (dash + lower-case + O/0)', async () => {
    findSession.mockResolvedValue(refRow());
    await resolveSessionRefLocation('7f3k-9m2p');
    expect(findSession).toHaveBeenCalledWith(
      expect.objectContaining({ where: { publicRef: '7F3K9M2P' } })
    );
  });

  it('returns null when no session matches', async () => {
    findSession.mockResolvedValue(null);
    expect(await resolveSessionRefLocation('7F3K-9M2P')).toBeNull();
  });

  it('returns the session location when found', async () => {
    findSession.mockResolvedValue(refRow());
    const loc = await resolveSessionRefLocation('7F3K-9M2P');
    expect(loc).toMatchObject({
      sessionId: 'sess-1',
      ref: '7F3K9M2P',
      questionnaireId: 'q-1',
      versionId: 'v-1',
      isPreview: true,
      status: 'active',
    });
  });
});

/**
 * Integration test: the F8.3 respondent profile-snapshot capture seam.
 *
 * The load-bearing anonymous-mode invariant: a snapshot is written ONLY for a
 * non-anonymous session that supplied valid profile values; it is NEVER written for an
 * anonymous session (no-login or authed-anonymous), and invalid/empty submissions are
 * rejected or skipped. Prisma + the `recordSessionCreated` seam are mocked; `$transaction`
 * runs its callback against a tx mock that records `appRespondentProfileSnapshot.create`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    appQuestionnaireSession: { create: vi.fn() },
    appQuestionnaireInvitation: { update: vi.fn() },
    appRespondentProfileSnapshot: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    appQuestionnaireInvitation: { findUnique: vi.fn() },
    appQuestionnaireVersion: { findUnique: vi.fn() },
    appQuestionnaireSession: { findFirst: vi.fn() },
  };
  return { tx, prisma };
});
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

const seamMock = vi.hoisted(() => ({ recordSessionCreated: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/sessions', () => seamMock);

import {
  createAnonymousSession,
  createSessionForVersion,
  createSessionFromInvitation,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/create';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'user-1';
const NEW_SESSION = { id: 'sess-new', status: 'active', versionId: 'v1' };

/** A profile field config (parsed from the JSON column at capture time). */
const PROFILE_FIELDS = [
  { key: 'team', label: 'Team', type: 'text', required: true },
  {
    key: 'seniority',
    label: 'Seniority',
    type: 'select',
    required: false,
    options: ['junior', 'senior'],
  },
];

/** An invitation whose version collects a profile (non-anonymous) by default. */
const invitation = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  userId: USER,
  status: 'registered',
  versionId: 'v1',
  version: {
    status: 'launched',
    config: { anonymousMode: false, profileFields: PROFILE_FIELDS },
    ...((over.version as Record<string, unknown>) ?? {}),
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  (mocks.tx.appQuestionnaireSession.create as Mock).mockResolvedValue(NEW_SESSION);
  (mocks.tx.appQuestionnaireInvitation.update as Mock).mockResolvedValue({});
  (mocks.tx.appRespondentProfileSnapshot.create as Mock).mockResolvedValue({});
  (mocks.prisma.appQuestionnaireSession.findFirst as Mock).mockResolvedValue(null);
  (seamMock.recordSessionCreated as Mock).mockResolvedValue(undefined);
});

describe('profile snapshot capture (non-anonymous invitation surface)', () => {
  it('writes a snapshot with the validated values inside the create transaction', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(invitation());

    const result = await createSessionFromInvitation('tok', USER, {
      team: 'Analytics',
      seniority: 'senior',
    });

    expect(result).toMatchObject({ ok: true, resumed: false });
    expect(mocks.tx.appRespondentProfileSnapshot.create).toHaveBeenCalledWith({
      data: {
        sessionId: 'sess-new',
        respondentUserId: USER,
        values: { team: 'Analytics', seniority: 'senior' },
      },
    });
  });

  it('rejects unknown profile keys with a 400 and writes nothing', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(invitation());

    const result = await createSessionFromInvitation('tok', USER, {
      team: 'Analytics',
      smuggled: 'pii@evil.com',
    });

    expect(result).toMatchObject({ ok: false, status: 400, code: 'INVALID_PROFILE' });
    expect(mocks.tx.appQuestionnaireSession.create).not.toHaveBeenCalled();
    expect(mocks.tx.appRespondentProfileSnapshot.create).not.toHaveBeenCalled();
  });

  it('rejects a missing required field with a 400', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(invitation());

    // `team` is required; only the optional field is supplied.
    const result = await createSessionFromInvitation('tok', USER, { seniority: 'junior' });

    expect(result).toMatchObject({ ok: false, status: 400, code: 'INVALID_PROFILE' });
    expect(mocks.tx.appRespondentProfileSnapshot.create).not.toHaveBeenCalled();
  });

  it('writes no snapshot row when the submission is empty (no empty rows)', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(
      invitation({
        version: { status: 'launched', config: { anonymousMode: false, profileFields: [] } },
      })
    );

    const result = await createSessionFromInvitation('tok', USER, {});

    expect(result).toMatchObject({ ok: true });
    expect(mocks.tx.appQuestionnaireSession.create).toHaveBeenCalledTimes(1);
    expect(mocks.tx.appRespondentProfileSnapshot.create).not.toHaveBeenCalled();
  });

  it('rejects with a 400 (and creates nothing) when a required field is configured but no profileValues are sent', async () => {
    // The server is the enforcing boundary, not the form: an omitted payload is
    // validated as an empty submission, so the required `team` field still rejects —
    // a direct API caller can't bypass required collection by dropping the key.
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(invitation());

    const result = await createSessionFromInvitation('tok', USER); // no profileValues arg

    expect(result).toMatchObject({ ok: false, status: 400, code: 'INVALID_PROFILE' });
    expect(mocks.tx.appQuestionnaireSession.create).not.toHaveBeenCalled();
    expect(mocks.tx.appRespondentProfileSnapshot.create).not.toHaveBeenCalled();
  });

  it('creates the session with no snapshot when no profileValues are sent and all fields are optional', async () => {
    // Only-optional fields + an omitted payload is a legitimate "nothing to capture":
    // the session is created and no snapshot row is written.
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(
      invitation({
        version: {
          status: 'launched',
          config: {
            anonymousMode: false,
            profileFields: [
              { key: 'seniority', label: 'Seniority', type: 'text', required: false },
            ],
          },
        },
      })
    );

    const result = await createSessionFromInvitation('tok', USER); // no profileValues arg

    expect(result).toMatchObject({ ok: true });
    expect(mocks.tx.appQuestionnaireSession.create).toHaveBeenCalledTimes(1);
    expect(mocks.tx.appRespondentProfileSnapshot.create).not.toHaveBeenCalled();
  });

  it('does not capture a profile on resume (snapshot is written once, at first start)', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(invitation());
    (mocks.prisma.appQuestionnaireSession.findFirst as Mock).mockResolvedValue({
      id: 'sess-existing',
      status: 'paused',
      versionId: 'v1',
    });

    const result = await createSessionFromInvitation('tok', USER, { team: 'Analytics' });

    expect(result).toMatchObject({ ok: true, resumed: true });
    expect(mocks.tx.appRespondentProfileSnapshot.create).not.toHaveBeenCalled();
  });
});

describe('profile snapshot is NEVER written in anonymous mode (F8.3 invariant)', () => {
  it('skips capture when the invitation version is anonymousMode, even with values supplied', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(
      invitation({
        version: {
          status: 'launched',
          config: { anonymousMode: true, profileFields: PROFILE_FIELDS },
        },
      })
    );

    const result = await createSessionFromInvitation('tok', USER, { team: 'Analytics' });

    expect(result).toMatchObject({ ok: true });
    expect(mocks.tx.appRespondentProfileSnapshot.create).not.toHaveBeenCalled();
  });

  it('never captures a profile on the authed anonymous-direct surface', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue({
      id: 'v1',
      status: 'launched',
      config: { anonymousMode: true },
    });

    await createSessionForVersion('v1', USER);

    expect(mocks.tx.appRespondentProfileSnapshot.create).not.toHaveBeenCalled();
  });

  it('never captures a profile on the no-login anonymous surface', async () => {
    (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue({
      id: 'v1',
      status: 'launched',
      config: { anonymousMode: true },
    });

    await createAnonymousSession('v1');

    expect(mocks.tx.appRespondentProfileSnapshot.create).not.toHaveBeenCalled();
  });
});

/**
 * Integration: round access enforced through the SERVER-TRUSTED invitation grant.
 *
 * A round-bound session inherits its `roundId`/`cohortMemberId` from the resolved invitation
 * (never the client request). This pins that the frictionless create path reads the round
 * context off the invitation, gates the start, and persists both ids when allowed — and that a
 * plain (non-round) invitation is untouched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    appQuestionnaireSession: { create: vi.fn() },
    appQuestionnaireInvitation: { update: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    appQuestionnaireInvitation: { findUnique: vi.fn() },
    appQuestionnaireVersion: { findUnique: vi.fn() },
    appQuestionnaireSession: { findFirst: vi.fn() },
    appQuestionnaireRound: { findUnique: vi.fn() },
    appCohortMember: { findUnique: vi.fn() },
  };
  return { tx, prisma };
});
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

const seamMock = vi.hoisted(() => ({ recordSessionCreated: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/sessions', () => seamMock);

import { createSessionFromInviteToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/create';

type Mock = ReturnType<typeof vi.fn>;
const NEW_SESSION = { id: 'sess-new', status: 'active', versionId: 'v1' };
const FUTURE = new Date('2027-01-01T00:00:00.000Z');
const OPEN_ROUND = {
  status: 'open',
  opensAt: new Date('2026-01-01T00:00:00.000Z'),
  closesAt: new Date('2026-12-31T00:00:00.000Z'),
  cohortId: 'co-1',
  items: [{ questionnaireId: 'q-1' }],
};

// A round-bound frictionless invitation (the grant carries roundId + cohortMemberId).
function invitation(over: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    status: 'sent',
    versionId: 'v1',
    revokedAt: null,
    expiresAt: FUTURE,
    roundId: 'r-1',
    cohortMemberId: 'm-1',
    version: { status: 'launched' },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(invitation());
  (mocks.prisma.appQuestionnaireVersion.findUnique as Mock).mockResolvedValue({
    questionnaireId: 'q-1',
  });
  (mocks.prisma.appQuestionnaireSession.findFirst as Mock).mockResolvedValue(null);
  (mocks.prisma.appQuestionnaireRound.findUnique as Mock).mockResolvedValue(OPEN_ROUND);
  (mocks.prisma.appCohortMember.findUnique as Mock).mockResolvedValue({
    status: 'active',
    cohortId: 'co-1',
  });
  (mocks.tx.appQuestionnaireSession.create as Mock).mockResolvedValue(NEW_SESSION);
  (seamMock.recordSessionCreated as Mock).mockResolvedValue(undefined);
});

describe('createSessionFromInviteToken — round inherited from the invitation', () => {
  it('persists the invitation’s roundId + cohortMemberId when the round is open + member active', async () => {
    const res = await createSessionFromInviteToken('tok');
    expect(res.ok).toBe(true);
    const data = (mocks.tx.appQuestionnaireSession.create as Mock).mock.calls[0][0].data;
    expect(data).toMatchObject({ roundId: 'r-1', cohortMemberId: 'm-1' });
  });

  it('refuses (no write) when the round is closed', async () => {
    (mocks.prisma.appQuestionnaireRound.findUnique as Mock).mockResolvedValue({
      ...OPEN_ROUND,
      status: 'closed',
    });
    const res = await createSessionFromInviteToken('tok');
    expect(res).toMatchObject({ ok: false, code: 'ROUND_NOT_OPEN' });
    expect(mocks.tx.appQuestionnaireSession.create).not.toHaveBeenCalled();
  });

  it('refuses when the member has been removed', async () => {
    (mocks.prisma.appCohortMember.findUnique as Mock).mockResolvedValue({
      status: 'removed',
      cohortId: 'co-1',
    });
    const res = await createSessionFromInviteToken('tok');
    expect(res).toMatchObject({ ok: false, code: 'COHORT_MEMBER_REMOVED' });
    expect(mocks.tx.appQuestionnaireSession.create).not.toHaveBeenCalled();
  });

  it('leaves a plain (non-round) invitation untouched — no round lookup, roundId null', async () => {
    (mocks.prisma.appQuestionnaireInvitation.findUnique as Mock).mockResolvedValue(
      invitation({ roundId: null, cohortMemberId: null })
    );
    const res = await createSessionFromInviteToken('tok');
    expect(res.ok).toBe(true);
    expect(mocks.prisma.appQuestionnaireRound.findUnique).not.toHaveBeenCalled();
    const data = (mocks.tx.appQuestionnaireSession.create as Mock).mock.calls[0][0].data;
    expect(data).toMatchObject({ roundId: null, cohortMemberId: null });
  });
});

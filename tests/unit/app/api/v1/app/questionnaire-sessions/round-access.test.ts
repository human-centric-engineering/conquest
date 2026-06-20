/**
 * Unit: the DB-loading round access wrapper (`assertRoundAccess`).
 *
 * Pins how the wrapper resolves round / questionnaire-in-round / member from Prisma and the
 * two phase behaviours of a missing round (deny at create, allow at continue). The pure
 * verdict matrix lives in rounds/access.test.ts; here we mock Prisma and check the loading +
 * mapping, including the cross-cohort-member guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireRound: { findUnique: vi.fn() },
    appQuestionnaireVersion: { findUnique: vi.fn() },
    appCohortMember: { findUnique: vi.fn() },
  },
}));

import { assertRoundAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/round-access';
import { prisma } from '@/lib/db/client';

type Mock = ReturnType<typeof vi.fn>;
const roundFind = prisma.appQuestionnaireRound.findUnique as unknown as Mock;
const versionFind = prisma.appQuestionnaireVersion.findUnique as unknown as Mock;
const memberFind = prisma.appCohortMember.findUnique as unknown as Mock;

const OPEN_ROUND = {
  status: 'open',
  opensAt: new Date('2026-06-01T00:00:00.000Z'),
  closesAt: new Date('2026-12-01T00:00:00.000Z'),
  cohortId: 'co-1',
  items: [{ questionnaireId: 'q-1' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  roundFind.mockResolvedValue(OPEN_ROUND);
  versionFind.mockResolvedValue({ questionnaireId: 'q-1' });
  memberFind.mockResolvedValue({ status: 'active', cohortId: 'co-1' });
});

const base = {
  roundId: 'r-1',
  cohortMemberId: 'm-1',
  versionId: 'v-1',
  now: new Date('2026-06-20T12:00:00.000Z'),
} as const;

describe('assertRoundAccess', () => {
  it('allows an open, in-window round with an active member whose questionnaire is bundled', async () => {
    const v = await assertRoundAccess({ ...base, onMissingRound: 'deny' });
    expect(v).toEqual({ ok: true });
  });

  it('denies a missing round at create (onMissingRound: deny → 404 ROUND_NOT_FOUND)', async () => {
    roundFind.mockResolvedValue(null);
    const v = await assertRoundAccess({ ...base, onMissingRound: 'deny' });
    expect(v).toMatchObject({ ok: false, code: 'ROUND_NOT_FOUND', status: 404 });
  });

  it('allows a missing round at continue (onMissingRound: allow → no longer gating)', async () => {
    roundFind.mockResolvedValue(null);
    const v = await assertRoundAccess({ ...base, onMissingRound: 'allow' });
    expect(v).toEqual({ ok: true });
  });

  it('denies when the version’s questionnaire is not bundled in the round', async () => {
    versionFind.mockResolvedValue({ questionnaireId: 'other' });
    const v = await assertRoundAccess({ ...base, onMissingRound: 'deny' });
    expect(v).toMatchObject({ ok: false, code: 'QUESTIONNAIRE_NOT_IN_ROUND' });
  });

  it('treats a member from a different cohort as removed (cross-cohort guard)', async () => {
    memberFind.mockResolvedValue({ status: 'active', cohortId: 'other-cohort' });
    const v = await assertRoundAccess({ ...base, onMissingRound: 'deny' });
    expect(v).toMatchObject({ ok: false, code: 'COHORT_MEMBER_REMOVED', status: 403 });
  });

  it('treats a missing member as removed', async () => {
    memberFind.mockResolvedValue(null);
    const v = await assertRoundAccess({ ...base, onMissingRound: 'deny' });
    expect(v).toMatchObject({ ok: false, code: 'COHORT_MEMBER_REMOVED' });
  });

  it('skips the member lookup entirely when no cohortMemberId is given', async () => {
    const v = await assertRoundAccess({ ...base, cohortMemberId: null, onMissingRound: 'deny' });
    expect(v).toEqual({ ok: true });
    expect(memberFind).not.toHaveBeenCalled();
  });

  it('denies a closed round', async () => {
    roundFind.mockResolvedValue({ ...OPEN_ROUND, status: 'closed' });
    const v = await assertRoundAccess({ ...base, onMissingRound: 'allow' });
    expect(v).toMatchObject({ ok: false, code: 'ROUND_NOT_OPEN' });
  });
});

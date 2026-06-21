/**
 * Unit: per-member round invitation generation (`generateRoundInvitations`).
 *
 * Pins the grant mechanism: an invitation is minted per active member × per resolved
 * questionnaire-version, stamped with the round + member + demo client; existing pairs are
 * skipped (idempotent); an unpinned item with no launched version is reported, not invited; and
 * the token expiry is pinned to the round's close date.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireRound: { findUnique: vi.fn() },
  appCohortMember: { findMany: vi.fn() },
  appQuestionnaireVersion: { findMany: vi.fn() },
  appQuestionnaireInvitation: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  appRoundPhase: { findMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// The send seam is mocked so the generator's email path is exercised without the real email client.
const sendMock = vi.hoisted(() => vi.fn());
const themeMock = vi.hoisted(() => vi.fn());
vi.mock('@/app/api/v1/app/questionnaires/[id]/invitations/_lib/send', () => ({
  resolveDemoClientTheme: themeMock,
  sendRoundInvitationEmail: sendMock,
}));

import {
  generateRoundInvitations,
  dispatchDuePhaseInvitations,
} from '@/app/api/v1/app/rounds/_lib/invites';

// Far-future close date: the expiry floor compares closesAt to the live clock, so a near-future
// fixture would (a) flip the floor branch once real time passes it and (b) change the asserted expiry.
const CLOSES = new Date('2099-12-31T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({
    id: 'r-1',
    opensAt: null,
    closesAt: CLOSES,
    cohort: { demoClientId: 'dc-1' },
    items: [{ questionnaireId: 'q-1', versionId: 'v-1', questionnaire: { title: 'Survey' } }],
    phases: [],
  });
  prismaMock.appCohortMember.findMany.mockResolvedValue([
    { id: 'm-1', email: 'a@x.com', name: 'A', subgroupId: null },
    { id: 'm-2', email: 'b@x.com', name: 'B', subgroupId: null },
  ]);
  prismaMock.appQuestionnaireVersion.findMany.mockResolvedValue([]);
  prismaMock.appQuestionnaireInvitation.findMany.mockResolvedValue([]);
  prismaMock.appQuestionnaireInvitation.create.mockResolvedValue({ id: 'inv' });
  prismaMock.appQuestionnaireInvitation.update.mockResolvedValue({ id: 'inv' });
  prismaMock.appRoundPhase.findMany.mockResolvedValue([]);
  themeMock.mockResolvedValue({});
  sendMock.mockResolvedValue({ success: true });
});

describe('generateRoundInvitations', () => {
  it('mints one invitation per active member, stamped with round + member + demo client', async () => {
    const res = await generateRoundInvitations('r-1', 'admin-1');
    expect(res.created).toBe(2);
    expect(res.skipped).toBe(0);
    expect(res.activeMembers).toBe(2);
    expect(res.links).toHaveLength(2);

    const firstData = prismaMock.appQuestionnaireInvitation.create.mock.calls[0][0].data;
    expect(firstData).toMatchObject({
      versionId: 'v-1',
      roundId: 'r-1',
      cohortMemberId: 'm-1',
      demoClientId: 'dc-1',
      invitedByUserId: 'admin-1',
      status: 'pending',
      expiresAt: CLOSES, // pinned to the round's close date
    });
    // The link is the frictionless no-login URL carrying a NON-EMPTY token.
    expect(res.links[0].url).toMatch(/^\/q\/v-1\?i=.+$/);
  });

  it('is idempotent — skips members already invited for the (version, round) pair', async () => {
    // m-1 already has an invitation for v-1 in this round; m-2 does not.
    prismaMock.appQuestionnaireInvitation.findMany.mockResolvedValue([
      { versionId: 'v-1', cohortMemberId: 'm-1' },
    ]);
    const res = await generateRoundInvitations('r-1', 'admin-1');
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
    // Only the not-yet-invited member is created.
    expect(prismaMock.appQuestionnaireInvitation.create.mock.calls[0][0].data.cohortMemberId).toBe(
      'm-2'
    );
  });

  it('resolves an unpinned item to its current launched version (one batched sweep)', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({
      id: 'r-1',
      opensAt: null,
      closesAt: null,
      cohort: { demoClientId: 'dc-1' },
      items: [{ questionnaireId: 'q-1', versionId: null, questionnaire: { title: 'Survey' } }],
      phases: [],
    });
    // Highest versionNumber first — the generator takes the first row per questionnaire.
    prismaMock.appQuestionnaireVersion.findMany.mockResolvedValue([
      { id: 'v-9', questionnaireId: 'q-1' },
    ]);
    const res = await generateRoundInvitations('r-1', 'admin-1');
    expect(res.created).toBe(2);
    expect(prismaMock.appQuestionnaireInvitation.create.mock.calls[0][0].data.versionId).toBe(
      'v-9'
    );
  });

  it('reports (does not invite) an unpinned item with no launched version', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({
      id: 'r-1',
      opensAt: null,
      closesAt: null,
      cohort: { demoClientId: 'dc-1' },
      items: [{ questionnaireId: 'q-1', versionId: null, questionnaire: { title: 'Survey' } }],
      phases: [],
    });
    prismaMock.appQuestionnaireVersion.findMany.mockResolvedValue([]); // nothing launched
    const res = await generateRoundInvitations('r-1', 'admin-1');
    expect(res.created).toBe(0);
    expect(res.unlaunchedQuestionnaires).toBe(1);
    expect(prismaMock.appQuestionnaireInvitation.create).not.toHaveBeenCalled();
  });

  it('falls back to the default expiry when the round close date is already past (no dead links)', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({
      id: 'r-1',
      opensAt: null,
      closesAt: new Date('2000-01-01T00:00:00.000Z'), // long past
      cohort: { demoClientId: 'dc-1' },
      items: [{ questionnaireId: 'q-1', versionId: 'v-1', questionnaire: { title: 'Survey' } }],
      phases: [],
    });
    const res = await generateRoundInvitations('r-1', 'admin-1');
    expect(res.created).toBe(2);
    // expiresAt is the minted default (future), NOT the past close date.
    const expiresAt = prismaMock.appQuestionnaireInvitation.create.mock.calls[0][0].data
      .expiresAt as Date;
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('pins a phased member’s expiry to their HARD phase close, not the round close', async () => {
    const PHASE_CLOSE = new Date(Date.now() + 1000 * 60 * 60 * 24 * 3); // +3 days (before round close)
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({
      id: 'r-1',
      opensAt: null,
      closesAt: CLOSES,
      cohort: { demoClientId: 'dc-1' },
      items: [{ questionnaireId: 'q-1', versionId: 'v-1', questionnaire: { title: 'Survey' } }],
      phases: [{ subgroupId: 'sg-1', opensAt: null, closesAt: PHASE_CLOSE, endMode: 'hard' }],
    });
    prismaMock.appCohortMember.findMany.mockResolvedValue([
      { id: 'm-1', email: 'a@x.com', name: 'A', subgroupId: 'sg-1' }, // phased
      { id: 'm-2', email: 'b@x.com', name: 'B', subgroupId: null }, // no phase → round close
    ]);
    await generateRoundInvitations('r-1', 'admin-1');
    const byMember = new Map(
      prismaMock.appQuestionnaireInvitation.create.mock.calls.map((c) => [
        c[0].data.cohortMemberId,
        c[0].data.expiresAt as Date,
      ])
    );
    expect(byMember.get('m-1')).toEqual(PHASE_CLOSE);
    expect(byMember.get('m-2')).toEqual(CLOSES);
  });

  it('returns zero for an unknown round (never throws)', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue(null);
    const res = await generateRoundInvitations('gone', 'admin-1');
    expect(res).toMatchObject({ created: 0, activeMembers: 0, links: [] });
  });

  it('does NOT email when send is not requested (copy/paste links only)', async () => {
    await generateRoundInvitations('r-1', 'admin-1');
    expect(sendMock).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionnaireInvitation.update).not.toHaveBeenCalled();
  });

  it('emails each minted link and flips it to sent when send is requested', async () => {
    const res = await generateRoundInvitations('r-1', 'admin-1', { send: true });
    expect(res.sent).toBe(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(prismaMock.appQuestionnaireInvitation.update).toHaveBeenCalledTimes(2);
    expect(prismaMock.appQuestionnaireInvitation.update.mock.calls[0][0].data).toMatchObject({
      status: 'sent',
    });
  });

  it('leaves an invitation pending when its email fails (best-effort send)', async () => {
    sendMock.mockResolvedValue({ success: false });
    const res = await generateRoundInvitations('r-1', 'admin-1', { send: true });
    expect(res.created).toBe(2);
    expect(res.sent).toBe(0);
    expect(prismaMock.appQuestionnaireInvitation.update).not.toHaveBeenCalled();
  });

  it('restricts to one subgroup when subgroupId is given (per-phase send)', async () => {
    await generateRoundInvitations('r-1', 'admin-1', { subgroupId: 'sg-1' });
    expect(prismaMock.appCohortMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ subgroupId: 'sg-1' }) })
    );
  });
});

describe('dispatchDuePhaseInvitations', () => {
  it('processes each open phase whose window has opened, generating + sending', async () => {
    prismaMock.appRoundPhase.findMany.mockResolvedValue([
      { id: 'ph-1', roundId: 'r-1', subgroupId: 'sg-1' },
    ]);
    const res = await dispatchDuePhaseInvitations('admin-1');
    expect(res.phasesProcessed).toBe(1);
    expect(res.sent).toBe(2); // both default members emailed
    // Queried only open rounds' phases whose opensAt has passed.
    expect(prismaMock.appRoundPhase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          opensAt: expect.objectContaining({ not: null }),
          round: { status: 'open' },
        }),
      })
    );
  });

  it('is a no-op when no phase window has opened', async () => {
    prismaMock.appRoundPhase.findMany.mockResolvedValue([]);
    const res = await dispatchDuePhaseInvitations('admin-1');
    expect(res).toEqual({ phasesProcessed: 0, created: 0, sent: 0 });
  });
});

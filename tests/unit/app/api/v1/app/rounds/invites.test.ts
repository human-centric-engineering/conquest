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
  appQuestionnaireVersion: { findFirst: vi.fn() },
  appQuestionnaireInvitation: { findFirst: vi.fn(), create: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { generateRoundInvitations } from '@/app/api/v1/app/rounds/_lib/invites';

const CLOSES = new Date('2026-12-31T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({
    id: 'r-1',
    closesAt: CLOSES,
    cohort: { demoClientId: 'dc-1' },
    items: [{ questionnaireId: 'q-1', versionId: 'v-1' }], // pinned version
  });
  prismaMock.appCohortMember.findMany.mockResolvedValue([
    { id: 'm-1', email: 'a@x.com', name: 'A' },
    { id: 'm-2', email: 'b@x.com', name: 'B' },
  ]);
  prismaMock.appQuestionnaireInvitation.findFirst.mockResolvedValue(null);
  prismaMock.appQuestionnaireInvitation.create.mockResolvedValue({ id: 'inv' });
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
    // The link is the frictionless no-login URL.
    expect(res.links[0].url).toMatch(/^\/q\/v-1\?i=/);
  });

  it('is idempotent — skips a member who already has an invitation for the pair', async () => {
    prismaMock.appQuestionnaireInvitation.findFirst
      .mockResolvedValueOnce({ id: 'existing' }) // m-1 already invited
      .mockResolvedValueOnce(null); // m-2 not yet
    const res = await generateRoundInvitations('r-1', 'admin-1');
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it('reports (does not invite) an unpinned item with no launched version', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({
      id: 'r-1',
      closesAt: null,
      cohort: { demoClientId: 'dc-1' },
      items: [{ questionnaireId: 'q-1', versionId: null }],
    });
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null); // nothing launched
    const res = await generateRoundInvitations('r-1', 'admin-1');
    expect(res.created).toBe(0);
    expect(res.unlaunchedQuestionnaires).toBe(1);
    expect(prismaMock.appQuestionnaireInvitation.create).not.toHaveBeenCalled();
  });

  it('returns zero for an unknown round (never throws)', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue(null);
    const res = await generateRoundInvitations('gone', 'admin-1');
    expect(res).toMatchObject({ created: 0, activeMembers: 0, links: [] });
  });
});

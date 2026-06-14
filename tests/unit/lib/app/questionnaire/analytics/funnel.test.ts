/**
 * Unit test: completion funnel aggregation (F8.1).
 *
 * Mocks the invitation + session reads and asserts stage counting (derived from real
 * sessions, not invitation status), drop-off math, anonymous-session separation, and
 * preview exclusion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManyInvitations = vi.fn();
const findManySessions = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireInvitation: { findMany: (...a: unknown[]) => findManyInvitations(...a) },
    appQuestionnaireSession: { findMany: (...a: unknown[]) => findManySessions(...a) },
  },
}));

import { getCompletionFunnel } from '@/lib/app/questionnaire/analytics/funnel';
import type { AnalyticsScope } from '@/lib/app/questionnaire/analytics/query-schema';

const scope: AnalyticsScope = {
  versionId: 'v1',
  from: new Date('2026-01-01T00:00:00.000Z'),
  to: new Date('2026-02-01T00:00:00.000Z'),
  tagIds: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCompletionFunnel', () => {
  beforeEach(() => {
    // 4 invited (all sent); 3 opened; 3 registered respondents u1/u2/u3.
    findManyInvitations.mockResolvedValue([
      { sentAt: new Date(), openedAt: new Date(), userId: 'u1' },
      { sentAt: new Date(), openedAt: new Date(), userId: 'u2' },
      { sentAt: new Date(), openedAt: new Date(), userId: 'u3' },
      { sentAt: new Date(), openedAt: null, userId: null }, // sent, never opened/registered
    ]);
    // u1 started (active), u2 + u3 completed; plus two anonymous (un-invited).
    findManySessions.mockResolvedValue([
      { respondentUserId: 'u1', status: 'active' },
      { respondentUserId: 'u2', status: 'completed' },
      { respondentUserId: 'u3', status: 'completed' },
      { respondentUserId: 'anon1', status: 'completed' },
      { respondentUserId: null, status: 'active' },
    ]);
  });

  it('counts invited → opened → started → completed from session reality', async () => {
    const result = await getCompletionFunnel(scope);
    const byKey = Object.fromEntries(result.stages.map((s) => [s.key, s.count]));
    expect(byKey).toEqual({ invited: 4, opened: 3, started: 3, completed: 2 });
  });

  it('computes drop-off, retention, and step conversion', async () => {
    const result = await getCompletionFunnel(scope);
    const completed = result.stages.find((s) => s.key === 'completed')!;
    expect(completed.retention).toBeCloseTo(2 / 4, 5); // of invited
    expect(completed.conversionFromPrev).toBeCloseTo(2 / 3, 5); // started → completed
    expect(completed.dropoff).toBe(1); // 3 started, 2 completed

    const invited = result.stages.find((s) => s.key === 'invited')!;
    expect(invited.dropoff).toBe(0);
    expect(invited.conversionFromPrev).toBe(1);
  });

  it('reports anonymous (un-invited) sessions separately', async () => {
    const result = await getCompletionFunnel(scope);
    expect(result.anonymous).toEqual({ started: 2, completed: 1 });
  });

  it('matches frictionless (no-account) invitees to sessions by invitationId', async () => {
    // Frictionless invitees never register, so they have no userId — they're linked to a session
    // only by `invitationId`. The funnel must still count them as started/completed.
    findManyInvitations.mockResolvedValue([
      { id: 'inv1', sentAt: new Date(), openedAt: new Date(), userId: null },
      { id: 'inv2', sentAt: new Date(), openedAt: new Date(), userId: null },
      { id: 'inv3', sentAt: new Date(), openedAt: new Date(), userId: null },
      { id: 'inv4', sentAt: new Date(), openedAt: new Date(), userId: null },
      { id: 'inv5', sentAt: new Date(), openedAt: null, userId: null },
    ]);
    findManySessions.mockResolvedValue([
      { respondentUserId: null, invitationId: 'inv1', status: 'completed' },
      { respondentUserId: null, invitationId: 'inv2', status: 'completed' },
      { respondentUserId: null, invitationId: 'inv3', status: 'active' },
      { respondentUserId: null, invitationId: null, status: 'active' }, // a true anonymous walk-up
    ]);

    const result = await getCompletionFunnel(scope);
    const byKey = Object.fromEntries(result.stages.map((s) => [s.key, s.count]));
    // 5 sent, 4 opened, inv1–3 started (3), inv1–2 completed (2). cohort 5+1 ≥ k, so not suppressed.
    expect(byKey).toEqual({ invited: 5, opened: 4, started: 3, completed: 2 });
    // Only the un-linked walk-up session is anonymous.
    expect(result.anonymous).toEqual({ started: 1, completed: 0 });
  });

  it('excludes preview sessions and revoked invitations in its queries', async () => {
    await getCompletionFunnel(scope);
    expect(findManySessions.mock.calls[0][0].where.isPreview).toBe(false);
    expect(findManyInvitations.mock.calls[0][0].where.revokedAt).toBeNull();
  });

  it('handles a zero-invite window without dividing by zero', async () => {
    // 5 anonymous sessions (≥ threshold) so the divide-by-zero guard is exercised
    // without the cohort being suppressed by F8.3.
    findManyInvitations.mockResolvedValue([]);
    findManySessions.mockResolvedValue([
      { respondentUserId: 'anon1', status: 'completed' },
      { respondentUserId: 'anon2', status: 'completed' },
      { respondentUserId: 'anon3', status: 'active' },
      { respondentUserId: 'anon4', status: 'active' },
      { respondentUserId: null, status: 'active' },
    ]);
    const result = await getCompletionFunnel(scope);
    expect(result.stages).toHaveLength(4); // lock the stage count so .every() can't be vacuous
    expect(result.stages.every((s) => s.retention === 0)).toBe(true);
    expect(result.suppressed).toBe(false);
    expect(result.anonymous).toEqual({ started: 5, completed: 2 });
  });

  it('guards conversionFromPrev against a zero-count intermediate stage', async () => {
    // 5 invited (≥ threshold), none opened → the started stage converts from a zero
    // "opened" base; cohort is large enough not to be suppressed.
    findManyInvitations.mockResolvedValue([
      { sentAt: new Date(), openedAt: null, userId: 'u1' },
      { sentAt: new Date(), openedAt: null, userId: 'u2' },
      { sentAt: new Date(), openedAt: null, userId: 'u3' },
      { sentAt: new Date(), openedAt: null, userId: 'u4' },
      { sentAt: new Date(), openedAt: null, userId: 'u5' },
    ]);
    findManySessions.mockResolvedValue([{ respondentUserId: 'u1', status: 'active' }]);

    const result = await getCompletionFunnel(scope);
    const byKey = Object.fromEntries(result.stages.map((s) => [s.key, s]));
    expect(byKey.opened.count).toBe(0);
    expect(byKey.started.count).toBe(1);
    // prev (opened) is 0 → guard returns 0, not NaN/Infinity.
    expect(byKey.started.conversionFromPrev).toBe(0);
    expect(Number.isFinite(byKey.started.conversionFromPrev)).toBe(true);
  });

  it('suppresses every count below the k-anonymity threshold (F8.3)', async () => {
    // 2 invited + 1 anonymous = 3 participants (< 5): knowing "1 of 2 completed" plus the
    // invitee list re-identifies, so all counts are zeroed and `suppressed` is set.
    findManyInvitations.mockResolvedValue([
      { sentAt: new Date(), openedAt: new Date(), userId: 'u1' },
      { sentAt: new Date(), openedAt: new Date(), userId: 'u2' },
    ]);
    findManySessions.mockResolvedValue([
      { respondentUserId: 'u1', status: 'completed' },
      { respondentUserId: 'anon1', status: 'active' },
    ]);

    const result = await getCompletionFunnel(scope);
    expect(result.suppressed).toBe(true);
    expect(result.stages.every((s) => s.count === 0)).toBe(true);
    expect(result.anonymous).toEqual({ started: 0, completed: 0 });
  });

  it('does not suppress a cohort exactly at the threshold (F8.3 boundary)', async () => {
    findManyInvitations.mockResolvedValue([
      { sentAt: new Date(), openedAt: new Date(), userId: 'u1' },
      { sentAt: new Date(), openedAt: new Date(), userId: 'u2' },
      { sentAt: new Date(), openedAt: new Date(), userId: 'u3' },
      { sentAt: new Date(), openedAt: new Date(), userId: 'u4' },
      { sentAt: new Date(), openedAt: new Date(), userId: 'u5' },
    ]);
    findManySessions.mockResolvedValue([{ respondentUserId: 'u1', status: 'completed' }]);

    const result = await getCompletionFunnel(scope);
    expect(result.suppressed).toBe(false);
    expect(result.stages.find((s) => s.key === 'invited')!.count).toBe(5);
  });
});

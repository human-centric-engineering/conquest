/**
 * Integration test: reopen eligibility — the DB read seam (F-early-finish-reopen).
 *
 * `resolveReopenEligibility` is the impure counterpart to the pure `isReopenEligible`
 * (unit-tested separately at `session/reopen-logic.test.ts`): three reads keyed on
 * `sessionId` — current status + the version's LIVE `allowEarlyFinish`, experience-leg
 * membership (reused from `report/enqueue.ts`'s `isExperienceLeg`, not duplicated), and
 * the `reason` on the most recent `completed`-type session event. Only `@/lib/db/client`
 * is mocked — `isExperienceLeg` and `isReopenEligible` run for real against it, so these
 * assertions pin the whole seam's wiring, not just a decision the mock handed back.
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/reopen-eligibility.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn() },
    appExperienceRunLeg: { findUnique: vi.fn() },
    appQuestionnaireSessionEvent: { findFirst: vi.fn() },
  },
}));
vi.mock('@/lib/db/client', () => prismaMock);

import { resolveReopenEligibility } from '@/app/api/v1/app/questionnaire-sessions/_lib/reopen-eligibility';

type Mock = ReturnType<typeof vi.fn>;

const SESSION_ID = 'sess_1';

/** A session row shaped as `resolveReopenEligibility`'s select clause reads it. */
function sessionRow(overrides: {
  status?: string;
  allowEarlyFinish?: boolean | null;
  hasConfig?: boolean;
}) {
  const { status = 'completed', allowEarlyFinish = true, hasConfig = true } = overrides;
  return {
    status,
    version: hasConfig ? { config: { allowEarlyFinish } } : { config: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: a standalone completed session, early finish on, most recent completion was early.
  (prismaMock.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(sessionRow({}));
  (prismaMock.prisma.appExperienceRunLeg.findUnique as Mock).mockResolvedValue(null);
  (prismaMock.prisma.appQuestionnaireSessionEvent.findFirst as Mock).mockResolvedValue({
    reason: 'respondent_early_finish',
  });
});

describe('resolveReopenEligibility', () => {
  it('is true for a standalone completed session with early finish on and a genuinely early completion', async () => {
    await expect(resolveReopenEligibility(SESSION_ID)).resolves.toBe(true);
  });

  it('is false when the session is active, not completed', async () => {
    (prismaMock.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionRow({ status: 'active' })
    );
    await expect(resolveReopenEligibility(SESSION_ID)).resolves.toBe(false);
  });

  it('is false when allowEarlyFinish is currently off, even though the completion was early', async () => {
    (prismaMock.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionRow({ allowEarlyFinish: false })
    );
    await expect(resolveReopenEligibility(SESSION_ID)).resolves.toBe(false);
  });

  it('is false when the most recent completion was a normal full submit', async () => {
    (prismaMock.prisma.appQuestionnaireSessionEvent.findFirst as Mock).mockResolvedValue({
      reason: 'respondent_submit',
    });
    await expect(resolveReopenEligibility(SESSION_ID)).resolves.toBe(false);
  });

  it('is false for a session that is a leg of an experience run', async () => {
    (prismaMock.prisma.appExperienceRunLeg.findUnique as Mock).mockResolvedValue({ id: 'leg_1' });
    await expect(resolveReopenEligibility(SESSION_ID)).resolves.toBe(false);
    expect(prismaMock.prisma.appExperienceRunLeg.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: SESSION_ID } })
    );
  });

  it('is false for a nonexistent session id, without reading leg/event state', async () => {
    (prismaMock.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(null);

    await expect(resolveReopenEligibility('missing')).resolves.toBe(false);

    // Short-circuits before the two follow-up reads — there is nothing to resolve them against.
    expect(prismaMock.prisma.appExperienceRunLeg.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.prisma.appQuestionnaireSessionEvent.findFirst).not.toHaveBeenCalled();
  });

  it('uses the LATEST completed event when a session has completed more than once', async () => {
    // The seam orders by createdAt desc and takes the first row — mock findFirst to prove the
    // call is shaped that way (not, say, an unordered findMany that happened to return the first
    // completion in the array).
    (prismaMock.prisma.appQuestionnaireSessionEvent.findFirst as Mock).mockResolvedValue({
      reason: 'respondent_early_finish', // the NEWER of the two completions
    });

    await expect(resolveReopenEligibility(SESSION_ID)).resolves.toBe(true);
    expect(prismaMock.prisma.appQuestionnaireSessionEvent.findFirst).toHaveBeenCalledWith({
      where: { sessionId: SESSION_ID, eventType: 'completed' },
      orderBy: { createdAt: 'desc' },
      select: { reason: true },
    });
  });

  it('is false when there is no config row for the version (allowEarlyFinish defaults to off)', async () => {
    (prismaMock.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionRow({ hasConfig: false })
    );
    await expect(resolveReopenEligibility(SESSION_ID)).resolves.toBe(false);
  });

  it('is false when no completed event exists at all', async () => {
    (prismaMock.prisma.appQuestionnaireSessionEvent.findFirst as Mock).mockResolvedValue(null);
    await expect(resolveReopenEligibility(SESSION_ID)).resolves.toBe(false);
  });
});

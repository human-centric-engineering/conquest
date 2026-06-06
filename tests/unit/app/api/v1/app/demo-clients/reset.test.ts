/**
 * DEMO-ONLY (F6.4) unit test: demo session-reset DB seam.
 *
 * Covers loadResetTargets (version collection + anonymousMode signal) and performReset
 * (children-before-parent delete order, accurate per-type counts, opt-in invitation
 * cleanup with the preserve filter, and the empty-graph short-circuit). The transaction
 * is run by invoking the callback with a `tx` whose delete fns are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => {
  const tx = {
    appAnswerSlot: { deleteMany: vi.fn() },
    appQuestionnaireTurn: { deleteMany: vi.fn() },
    appQuestionnaireSessionEvent: { deleteMany: vi.fn() },
    appQuestionnaireSession: { deleteMany: vi.fn() },
    appQuestionnaireInvitation: { deleteMany: vi.fn() },
  };
  return {
    tx,
    appQuestionnaireVersion: { findMany: vi.fn() },
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
});
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { loadResetTargets, performReset } from '@/app/api/v1/app/demo-clients/_lib/reset';
import { RESET_PRESERVED_INVITATION_STATUSES } from '@/lib/app/questionnaire/invitations/types';

type Mock = ReturnType<typeof vi.fn>;
const findManyVersions = prismaMock.appQuestionnaireVersion.findMany as unknown as Mock;
const { tx } = prismaMock;

function count(n: number) {
  return { count: n };
}

// clearAllMocks resets call history but keeps the hoisted $transaction implementation
// (which invokes its callback with `tx`), so no re-stub is needed here.
beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadResetTargets', () => {
  it('maps versions to ids and flags anyAnonymous when any config has anonymousMode', async () => {
    findManyVersions.mockResolvedValue([
      { id: 'v1', config: { anonymousMode: false } },
      { id: 'v2', config: { anonymousMode: true } },
    ]);
    const targets = await loadResetTargets('dc-1');
    expect(targets).toEqual({ versionIds: ['v1', 'v2'], anyAnonymous: true });
    expect(findManyVersions).toHaveBeenCalledWith(
      expect.objectContaining({ where: { questionnaire: { demoClientId: 'dc-1' } } })
    );
  });

  it('treats an absent (null) config as anonymousMode false', async () => {
    findManyVersions.mockResolvedValue([
      { id: 'v1', config: null },
      { id: 'v2', config: { anonymousMode: false } },
    ]);
    const targets = await loadResetTargets('dc-1');
    expect(targets).toEqual({ versionIds: ['v1', 'v2'], anyAnonymous: false });
  });

  it('returns an empty target set for a client with no questionnaires', async () => {
    findManyVersions.mockResolvedValue([]);
    expect(await loadResetTargets('dc-1')).toEqual({ versionIds: [], anyAnonymous: false });
  });
});

describe('performReset', () => {
  beforeEach(() => {
    tx.appAnswerSlot.deleteMany.mockResolvedValue(count(5));
    tx.appQuestionnaireTurn.deleteMany.mockResolvedValue(count(4));
    tx.appQuestionnaireSessionEvent.deleteMany.mockResolvedValue(count(6));
    tx.appQuestionnaireSession.deleteMany.mockResolvedValue(count(2));
    // Invitation deleteMany is seeded per-test (only the resetInvitations:true path calls it).
  });

  it('deletes children before sessions and assembles counts (no invitations by default)', async () => {
    const counts = await performReset(['v1', 'v2'], { resetInvitations: false });

    expect(counts).toEqual({ sessions: 2, answerSlots: 5, turns: 4, events: 6, invitations: 0 });
    expect(tx.appQuestionnaireInvitation.deleteMany).not.toHaveBeenCalled();

    // Children are scoped through the session relation; sessions scoped by versionId.
    const sessionScope = { session: { versionId: { in: ['v1', 'v2'] } } };
    expect(tx.appAnswerSlot.deleteMany).toHaveBeenCalledWith({ where: sessionScope });
    expect(tx.appQuestionnaireTurn.deleteMany).toHaveBeenCalledWith({ where: sessionScope });
    expect(tx.appQuestionnaireSessionEvent.deleteMany).toHaveBeenCalledWith({
      where: sessionScope,
    });
    expect(tx.appQuestionnaireSession.deleteMany).toHaveBeenCalledWith({
      where: { versionId: { in: ['v1', 'v2'] } },
    });

    // Order: answer slots → turns → events → sessions (parent last, so counts survive).
    const order = [
      tx.appAnswerSlot.deleteMany.mock.invocationCallOrder[0],
      tx.appQuestionnaireTurn.deleteMany.mock.invocationCallOrder[0],
      tx.appQuestionnaireSessionEvent.deleteMany.mock.invocationCallOrder[0],
      tx.appQuestionnaireSession.deleteMany.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('deletes stale invitations with the preserve filter when resetInvitations is set', async () => {
    tx.appQuestionnaireInvitation.deleteMany.mockResolvedValue(count(3));
    const counts = await performReset(['v1'], { resetInvitations: true });

    expect(counts.invitations).toBe(3);
    expect(tx.appQuestionnaireInvitation.deleteMany).toHaveBeenCalledWith({
      where: {
        versionId: { in: ['v1'] },
        // Asserted against the source constant, not a literal copy, so a change to the
        // preserved set fails this test instead of silently drifting.
        status: { notIn: [...RESET_PRESERVED_INVITATION_STATUSES] },
      },
    });
  });

  it('short-circuits an empty graph to all-zero without opening a transaction', async () => {
    const counts = await performReset([], { resetInvitations: true });
    expect(counts).toEqual({ sessions: 0, answerSlots: 0, turns: 0, events: 0, invitations: 0 });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

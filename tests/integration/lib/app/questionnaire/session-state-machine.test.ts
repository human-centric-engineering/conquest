/**
 * Integration test: the session state-machine seam (F4.6).
 *
 * The seam (`_lib/sessions.ts`) is the DB write path for the lifecycle. Prisma is
 * mocked (the house convention for these suites), with `$transaction` invoking its
 * callback against a tx mock — so these assertions pin the seam's own logic around the
 * calls: that an `apply` transition updates the status AND writes exactly one event
 * (in the transaction), a `noop` writes nothing, an illegal move throws before any
 * write, the cost-cap hook writes a non-transition event, and the resume read shapes
 * answered slots. The pure transition rules are unit-tested separately
 * (session-logic.test.ts); this pins the I/O wiring on top of them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    appQuestionnaireSession: { findUnique: vi.fn(), update: vi.fn() },
    appQuestionnaireSessionEvent: { create: vi.fn() },
    appQuestionnaireInvitation: { updateMany: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    appQuestionnaireSession: { findUnique: vi.fn() },
    appQuestionnaireSessionEvent: { create: vi.fn(), findFirst: vi.fn() },
  };
  return { tx, prisma };
});
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

import {
  abandonSession,
  abortSession,
  hasCostCapReachedEvent,
  loadSessionResumeState,
  markSessionCompleted,
  pauseSession,
  recordCostCapReached,
  recordSessionCreated,
  reopenSession,
  resumeSession,
  transitionSession,
} from '@/app/api/v1/app/questionnaires/_lib/sessions';
import { NotFoundError } from '@/lib/api/errors';
import { SessionTransitionError } from '@/lib/app/questionnaire/session';

type Mock = ReturnType<typeof vi.fn>;

/** Set the status the in-transaction findUnique returns for the session. */
function currentStatus(status: string | null): void {
  (mocks.tx.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
    status === null ? null : { status }
  );
}

/** Set the status + invitationId the in-transaction findUnique returns for the session. */
function currentStatusWithInvitation(status: string, invitationId: string | null): void {
  (mocks.tx.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
    status,
    invitationId,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (mocks.tx.appQuestionnaireSession.update as Mock).mockResolvedValue({});
  (mocks.tx.appQuestionnaireSessionEvent.create as Mock).mockResolvedValue({});
  (mocks.tx.appQuestionnaireInvitation.updateMany as Mock).mockResolvedValue({ count: 0 });
  (mocks.prisma.appQuestionnaireSessionEvent.create as Mock).mockResolvedValue({});
});

describe('transitionSession — apply', () => {
  it('updates the status and writes exactly one event for a legal transition', async () => {
    currentStatus('active');

    const result = await transitionSession('sess-1', 'paused');

    expect(result).toBe('paused');
    expect(mocks.tx.appQuestionnaireSession.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: { status: 'paused' },
    });
    expect(mocks.tx.appQuestionnaireSessionEvent.create).toHaveBeenCalledTimes(1);
    expect(mocks.tx.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith({
      data: { sessionId: 'sess-1', eventType: 'paused', fromStatus: 'active', toStatus: 'paused' },
    });
  });

  it('records the event inside the same transaction as the status update', async () => {
    currentStatus('active');
    await transitionSession('sess-1', 'abandoned');
    // Both writes go through the tx mock $transaction handed the callback, never the
    // top-level prisma — so a status change can't be persisted without its audit row.
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.tx.appQuestionnaireSession.update).toHaveBeenCalledTimes(1);
    expect(mocks.tx.appQuestionnaireSessionEvent.create).toHaveBeenCalledTimes(1);
  });

  it('threads reason and metadata onto the event row when supplied', async () => {
    currentStatus('active');

    await transitionSession('sess-1', 'abandoned', {
      reason: 'respondent left',
      metadata: { source: 'timeout' },
    });

    expect(mocks.tx.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith({
      data: {
        sessionId: 'sess-1',
        eventType: 'abandoned',
        fromStatus: 'active',
        toStatus: 'abandoned',
        reason: 'respondent left',
        metadata: { source: 'timeout' },
      },
    });
  });
});

describe('transitionSession — noop', () => {
  it('writes nothing and returns the current status when already in the target status', async () => {
    currentStatus('completed');

    const result = await markSessionCompleted('sess-1');

    expect(result).toBe('completed');
    expect(mocks.tx.appQuestionnaireSession.update).not.toHaveBeenCalled();
    expect(mocks.tx.appQuestionnaireSessionEvent.create).not.toHaveBeenCalled();
  });
});

describe('transitionSession — illegal', () => {
  it('throws SessionTransitionError (carrying from/to) before any write', async () => {
    currentStatus('paused');

    await expect(markSessionCompleted('sess-1')).rejects.toMatchObject({
      name: 'SessionTransitionError',
      from: 'paused',
      to: 'completed',
    });
    expect(mocks.tx.appQuestionnaireSession.update).not.toHaveBeenCalled();
    expect(mocks.tx.appQuestionnaireSessionEvent.create).not.toHaveBeenCalled();
  });

  it('rejects resuming a terminal (completed) session', async () => {
    currentStatus('completed');
    const err = await resumeSession('sess-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionTransitionError);
    expect(err).toMatchObject({ from: 'completed', to: 'active' });
    expect(mocks.tx.appQuestionnaireSession.update).not.toHaveBeenCalled();
  });
});

describe('transitionSession — not found', () => {
  it('throws NotFoundError when the session id does not resolve', async () => {
    currentStatus(null);
    await expect(transitionSession('missing', 'paused')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('transitionSession — stored-status boundary guard', () => {
  it('narrows an unexpected stored status to active before classifying', async () => {
    // A stray DB value (not in SESSION_STATUSES) must not escape as an untyped `from`.
    // narrowToEnum defaults it to 'active', so active→paused applies normally.
    currentStatus('bogus');

    const result = await transitionSession('sess-1', 'paused');

    expect(result).toBe('paused');
    expect(mocks.tx.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromStatus: 'active', toStatus: 'paused' }),
      })
    );
  });
});

describe('lifecycle wrappers map to the right transition + event', () => {
  it('pauseSession: active → paused', async () => {
    currentStatus('active');
    const result = await pauseSession('sess-1');
    expect(result).toBe('paused');
    expect(mocks.tx.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'paused',
          fromStatus: 'active',
          toStatus: 'paused',
        }),
      })
    );
  });

  it('abandonSession from active: active → abandoned', async () => {
    currentStatus('active');
    const result = await abandonSession('sess-1');
    expect(result).toBe('abandoned');
    expect(mocks.tx.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'abandoned',
          fromStatus: 'active',
          toStatus: 'abandoned',
        }),
      })
    );
  });

  it('resumeSession: paused → active writes a `resumed` event (not `active`)', async () => {
    currentStatus('paused');
    const result = await resumeSession('sess-1');
    expect(result).toBe('active');
    expect(mocks.tx.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'resumed',
          fromStatus: 'paused',
          toStatus: 'active',
        }),
      })
    );
  });

  it('abandonSession from paused: paused → abandoned', async () => {
    currentStatus('paused');
    const result = await abandonSession('sess-1');
    expect(result).toBe('abandoned');
    expect(mocks.tx.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: 'abandoned' }) })
    );
  });

  it('abortSession from active: active → aborted writes an `aborted` event (distinct from abandoned)', async () => {
    // The seriousness/abuse-gate terminal — a separate status from admin/manual `abandoned` so
    // analytics can tell them apart. Exercises the real transition (not the mocked route).
    currentStatus('active');
    const result = await abortSession('sess-1');
    expect(result).toBe('aborted');
    expect(mocks.tx.appQuestionnaireSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'aborted' }) })
    );
    expect(mocks.tx.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'aborted',
          fromStatus: 'active',
          toStatus: 'aborted',
        }),
      })
    );
  });

  it('abortSession from paused: paused → aborted', async () => {
    currentStatus('paused');
    const result = await abortSession('sess-1');
    expect(result).toBe('aborted');
    expect(mocks.tx.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: 'aborted' }) })
    );
  });
});

describe('recordCostCapReached', () => {
  it('writes a non-transition cost_cap_reached event with the spend detail and no status change', async () => {
    await recordCostCapReached('sess-1', { spentUsd: 4.2, capUsd: 4, tier: 'hard' });

    expect(mocks.prisma.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith({
      data: {
        sessionId: 'sess-1',
        eventType: 'cost_cap_reached',
        metadata: { spentUsd: 4.2, capUsd: 4, tier: 'hard' },
      },
    });
    // It never touches the session status — it's a budget marker, not a transition.
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('records the tier on the event metadata (soft)', async () => {
    await recordCostCapReached('sess-1', { spentUsd: 3.6, capUsd: 4, tier: 'soft' });
    expect(mocks.prisma.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith({
      data: {
        sessionId: 'sess-1',
        eventType: 'cost_cap_reached',
        metadata: { spentUsd: 3.6, capUsd: 4, tier: 'soft' },
      },
    });
  });
});

describe('hasCostCapReachedEvent (F6.3)', () => {
  it('returns true when a matching tier event exists, querying by metadata path', async () => {
    (mocks.prisma.appQuestionnaireSessionEvent.findFirst as Mock).mockResolvedValue({ id: 'ev-1' });

    expect(await hasCostCapReachedEvent('sess-1', 'soft')).toBe(true);
    expect(mocks.prisma.appQuestionnaireSessionEvent.findFirst).toHaveBeenCalledWith({
      where: {
        sessionId: 'sess-1',
        eventType: 'cost_cap_reached',
        metadata: { path: ['tier'], equals: 'soft' },
      },
      select: { id: true },
    });
  });

  it('returns false when no matching event exists', async () => {
    (mocks.prisma.appQuestionnaireSessionEvent.findFirst as Mock).mockResolvedValue(null);
    expect(await hasCostCapReachedEvent('sess-1', 'hard')).toBe(false);
  });
});

describe('recordSessionCreated', () => {
  it('writes a created event (toStatus active, no fromStatus) via the top-level client', async () => {
    await recordSessionCreated('sess-1');
    expect(mocks.prisma.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith({
      data: { sessionId: 'sess-1', eventType: 'created', toStatus: 'active' },
    });
  });

  it('writes through the supplied transaction client and threads a reason', async () => {
    const tx = mocks.tx as unknown as NonNullable<Parameters<typeof recordSessionCreated>[1]>['tx'];
    await recordSessionCreated('sess-1', { tx, reason: 'invitation start' });
    expect(mocks.tx.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith({
      data: {
        sessionId: 'sess-1',
        eventType: 'created',
        toStatus: 'active',
        reason: 'invitation start',
      },
    });
    // Used the tx client, not the top-level prisma.
    expect(mocks.prisma.appQuestionnaireSessionEvent.create).not.toHaveBeenCalled();
  });
});

describe('loadSessionResumeState', () => {
  it('returns the status and the answered slots shaped by slot key', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
      status: 'paused',
      answers: [
        { value: 30, provenanceLabel: 'direct', confidence: 0.9, questionSlot: { key: 'age' } },
        { value: 'NY', provenanceLabel: 'bogus', confidence: null, questionSlot: { key: 'city' } },
      ],
    });

    const state = await loadSessionResumeState('sess-1');

    expect(state.status).toBe('paused');
    expect(state.answeredSlots).toEqual([
      { slotKey: 'age', value: 30, provenance: 'direct', confidence: 0.9 },
      // an unknown stored provenanceLabel narrows to 'direct' at the boundary
      { slotKey: 'city', value: 'NY', provenance: 'direct', confidence: null },
    ]);
  });

  it('throws NotFoundError when the session id does not resolve', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(null);
    await expect(loadSessionResumeState('missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('reopenSession (F-early-finish-reopen)', () => {
  it('writes a reopened event and flips the session status to active on a completed session', async () => {
    currentStatusWithInvitation('completed', null);

    const result = await reopenSession('sess-1');

    expect(result).toBe('active');
    expect(mocks.tx.appQuestionnaireSession.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: { status: 'active' },
    });
    expect(mocks.tx.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith({
      data: {
        sessionId: 'sess-1',
        eventType: 'reopened',
        fromStatus: 'completed',
        toStatus: 'active',
      },
    });
  });

  it('threads reason and metadata onto the reopened event when supplied', async () => {
    currentStatusWithInvitation('completed', null);

    await reopenSession('sess-1', {
      reason: 'respondent_reopen',
      metadata: { source: 'report_screen' },
    });

    expect(mocks.tx.appQuestionnaireSessionEvent.create).toHaveBeenCalledWith({
      data: {
        sessionId: 'sess-1',
        eventType: 'reopened',
        fromStatus: 'completed',
        toStatus: 'active',
        reason: 'respondent_reopen',
        metadata: { source: 'report_screen' },
      },
    });
  });

  it('reverts a completed invitation back to opened', async () => {
    currentStatusWithInvitation('completed', 'inv-1');
    (mocks.tx.appQuestionnaireInvitation.updateMany as Mock).mockResolvedValue({ count: 1 });

    await reopenSession('sess-1');

    expect(mocks.tx.appQuestionnaireInvitation.updateMany).toHaveBeenCalledWith({
      where: { id: 'inv-1', status: 'completed' },
      data: { status: 'opened' },
    });
  });

  it('never touches a revoked (or any non-completed) invitation — the where guard excludes it by status', async () => {
    currentStatusWithInvitation('completed', 'inv-1');
    // In real Postgres a revoked invitation row would not match `status: 'completed'`, so the
    // update would match zero rows — mirrored here by a zero-count resolve. The assertion that
    // matters is the exact `where` clause below: it is scoped to `status: 'completed'` alone, so a
    // revoked/expired row is structurally excluded rather than merely "unluckily not updated".
    (mocks.tx.appQuestionnaireInvitation.updateMany as Mock).mockResolvedValue({ count: 0 });

    await reopenSession('sess-1');

    expect(mocks.tx.appQuestionnaireInvitation.updateMany).toHaveBeenCalledWith({
      where: { id: 'inv-1', status: 'completed' },
      data: { status: 'opened' },
    });
    expect(mocks.tx.appQuestionnaireInvitation.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'revoked' }) })
    );
  });

  it('does not call the invitation update at all when the session has no linked invitation', async () => {
    currentStatusWithInvitation('completed', null);

    await reopenSession('sess-1');

    expect(mocks.tx.appQuestionnaireInvitation.updateMany).not.toHaveBeenCalled();
  });

  it('throws SessionTransitionError when the session is active, not completed', async () => {
    currentStatusWithInvitation('active', null);

    const err = await reopenSession('sess-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionTransitionError);
    expect(err).toMatchObject({ from: 'active', to: 'active' });
    expect(mocks.tx.appQuestionnaireSession.update).not.toHaveBeenCalled();
    expect(mocks.tx.appQuestionnaireSessionEvent.create).not.toHaveBeenCalled();
  });

  it('throws SessionTransitionError when the session is paused, not completed', async () => {
    currentStatusWithInvitation('paused', null);

    const err = await reopenSession('sess-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionTransitionError);
    expect(err).toMatchObject({ from: 'paused', to: 'active' });
    expect(mocks.tx.appQuestionnaireSession.update).not.toHaveBeenCalled();
    expect(mocks.tx.appQuestionnaireSessionEvent.create).not.toHaveBeenCalled();
  });

  it('has no noop self-edge — unlike transitionSession, a second call once the session is already active throws', async () => {
    // reopenSession does NOT call classifyTransition, so there is no `completed → completed`-style
    // no-op path for it to fall into; it only ever checks `status !== 'completed'` directly.
    currentStatusWithInvitation('completed', null);
    await expect(reopenSession('sess-1')).resolves.toBe('active');

    // The mock doesn't persist state between calls — simulate the session having actually moved to
    // 'active' by the time a second reopen is attempted.
    currentStatusWithInvitation('active', null);
    const err = await reopenSession('sess-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionTransitionError);
    expect(err).toMatchObject({ from: 'active', to: 'active' });
  });

  it('throws NotFoundError when the session id does not resolve', async () => {
    (mocks.tx.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(null);
    await expect(reopenSession('missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});

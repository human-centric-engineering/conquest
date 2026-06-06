/**
 * Integration test: the per-turn persistence seam (F6.1).
 *
 * The seam (`_lib/turns.ts`) is the DB write path for one respondent turn. Prisma is
 * mocked (the house convention for these suites), with `$transaction` invoking its
 * callback against a tx mock — so these assertions pin the seam's own logic: that
 * `recordTurn` derives the ordinal from the session's existing turn count, writes exactly
 * one turn row, and — in the same transaction — back-stamps `lastUpdatedTurnId` on the
 * answers the turn touched (scoped to the session). An unknown session throws before any
 * write; a turn with no side-effect answers skips the stamp.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    appQuestionnaireSession: { findUnique: vi.fn() },
    appQuestionnaireTurn: { count: vi.fn(), create: vi.fn() },
    appAnswerSlot: { updateMany: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  return { tx, prisma };
});
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

import { recordTurn, type TurnWriteInput } from '@/app/api/v1/app/questionnaires/_lib/turns';
import { NotFoundError } from '@/lib/api/errors';

type Mock = ReturnType<typeof vi.fn>;

/** A complete turn-write input; spread to override per case. */
function input(overrides: Partial<TurnWriteInput> = {}): TurnWriteInput {
  return {
    sessionId: 'sess-1',
    userMessage: 'I work in marketing',
    agentResponse: 'Got it. How large is your team?',
    targetedQuestionId: 'slot-team-size',
    toolCalls: [{ slug: 'app_extract_answer_slots', success: true, latencyMs: 120 }],
    sideEffectAnswerIds: ['ans-1', 'ans-2'],
    costUsd: 0.0042,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (mocks.tx.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({ id: 'sess-1' });
  (mocks.tx.appQuestionnaireTurn.count as Mock).mockResolvedValue(2);
  (mocks.tx.appQuestionnaireTurn.create as Mock).mockResolvedValue({ id: 'turn-3' });
  (mocks.tx.appAnswerSlot.updateMany as Mock).mockResolvedValue({ count: 2 });
});

describe('recordTurn — write', () => {
  it('derives the ordinal from the existing turn count and writes one turn row', async () => {
    const turnId = await recordTurn(input());

    expect(turnId).toBe('turn-3');
    expect(mocks.tx.appQuestionnaireTurn.count).toHaveBeenCalledWith({
      where: { sessionId: 'sess-1' },
    });
    expect(mocks.tx.appQuestionnaireTurn.create).toHaveBeenCalledTimes(1);
    expect(mocks.tx.appQuestionnaireTurn.create).toHaveBeenCalledWith({
      data: {
        sessionId: 'sess-1',
        ordinal: 3, // count (2) + 1
        userMessage: 'I work in marketing',
        agentResponse: 'Got it. How large is your team?',
        targetedQuestionId: 'slot-team-size',
        toolCalls: [{ slug: 'app_extract_answer_slots', success: true, latencyMs: 120 }],
        sideEffectAnswerIds: ['ans-1', 'ans-2'],
        costUsd: 0.0042,
      },
      select: { id: true },
    });
  });

  it('uses ordinal 1 for the first turn in a session', async () => {
    (mocks.tx.appQuestionnaireTurn.count as Mock).mockResolvedValue(0);
    (mocks.tx.appQuestionnaireTurn.create as Mock).mockResolvedValue({ id: 'turn-1' });

    await recordTurn(input());

    expect(mocks.tx.appQuestionnaireTurn.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ordinal: 1 }) })
    );
  });

  it('back-stamps lastUpdatedTurnId on the touched answers, scoped to the session', async () => {
    await recordTurn(input());

    expect(mocks.tx.appAnswerSlot.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.tx.appAnswerSlot.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['ans-1', 'ans-2'] }, sessionId: 'sess-1' },
      data: { lastUpdatedTurnId: 'turn-3' },
    });
  });

  it('writes the turn and stamps the answers inside one transaction', async () => {
    await recordTurn(input());

    // Both the create and the stamp go through the tx mock the $transaction handed the
    // callback — so a turn and its answer linkage are persisted atomically.
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.tx.appQuestionnaireTurn.create).toHaveBeenCalledTimes(1);
    expect(mocks.tx.appAnswerSlot.updateMany).toHaveBeenCalledTimes(1);
  });

  it('persists a null costUsd and an empty targetedQuestionId for a completion turn', async () => {
    await recordTurn(
      input({ targetedQuestionId: null, costUsd: null, toolCalls: [], sideEffectAnswerIds: [] })
    );

    expect(mocks.tx.appQuestionnaireTurn.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetedQuestionId: null,
          costUsd: null,
          toolCalls: [],
          sideEffectAnswerIds: [],
        }),
      })
    );
  });
});

describe('recordTurn — no side effects', () => {
  it('skips the answer stamp when the turn touched no answers', async () => {
    await recordTurn(input({ sideEffectAnswerIds: [] }));

    expect(mocks.tx.appQuestionnaireTurn.create).toHaveBeenCalledTimes(1);
    expect(mocks.tx.appAnswerSlot.updateMany).not.toHaveBeenCalled();
  });
});

describe('recordTurn — unknown session', () => {
  it('throws NotFoundError before writing anything', async () => {
    (mocks.tx.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(null);

    await expect(recordTurn(input())).rejects.toBeInstanceOf(NotFoundError);

    expect(mocks.tx.appQuestionnaireTurn.create).not.toHaveBeenCalled();
    expect(mocks.tx.appAnswerSlot.updateMany).not.toHaveBeenCalled();
  });
});

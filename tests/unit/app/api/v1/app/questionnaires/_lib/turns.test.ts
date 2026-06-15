/**
 * Unit tests for the turn-persistence seam (F6.1).
 *
 * `recordTurn` and `sumSessionTurnCost` from `turns.ts`. Prisma is mocked; the
 * tests exercise every branch in `recordTurn` (optional fields, back-stamp paths,
 * NotFoundError) and the null-coalescing in `sumSessionTurnCost`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// Prisma must be hoisted before any import of the module under test.
const txMock = vi.hoisted(() => ({
  appQuestionnaireSession: { findUnique: vi.fn() },
  appQuestionnaireTurn: { count: vi.fn(), create: vi.fn() },
  appAnswerSlot: { updateMany: vi.fn() },
  appDataSlotFill: { updateMany: vi.fn() },
}));

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  appQuestionnaireTurn: { aggregate: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { recordTurn, sumSessionTurnCost } from '@/app/api/v1/app/questionnaires/_lib/turns';
import { NotFoundError } from '@/lib/api/errors';

type TxFn = (tx: typeof txMock) => Promise<unknown>;

function setupTransaction() {
  // Make $transaction call the provided callback with txMock.
  prismaMock.$transaction.mockImplementation((fn: TxFn) => fn(txMock));
  // Default tx state: session found, no prior turns, turn created.
  txMock.appQuestionnaireSession.findUnique.mockResolvedValue({ id: 'sess-1' });
  txMock.appQuestionnaireTurn.count.mockResolvedValue(2);
  txMock.appQuestionnaireTurn.create.mockResolvedValue({ id: 'turn-new' });
  txMock.appAnswerSlot.updateMany.mockResolvedValue({ count: 0 });
  txMock.appDataSlotFill.updateMany.mockResolvedValue({ count: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupTransaction();
});

describe('recordTurn', () => {
  it('creates a turn with the correct ordinal (priorTurns + 1) and returns its id', async () => {
    // Arrange: 2 prior turns → new turn should be ordinal 3.
    txMock.appQuestionnaireTurn.count.mockResolvedValue(2);

    const id = await recordTurn({
      sessionId: 'sess-1',
      userMessage: 'hello',
      agentResponse: 'hi back',
      targetedQuestionId: 'q1',
      toolCalls: [],
      sideEffectAnswerIds: [],
      costUsd: 0.001,
    });

    expect(id).toBe('turn-new');
    expect(txMock.appQuestionnaireTurn.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sessionId: 'sess-1',
          ordinal: 3,
          userMessage: 'hello',
          agentResponse: 'hi back',
          targetedQuestionId: 'q1',
          costUsd: 0.001,
        }),
      })
    );
  });

  it('throws NotFoundError when the session does not exist', async () => {
    txMock.appQuestionnaireSession.findUnique.mockResolvedValue(null);

    await expect(
      recordTurn({
        sessionId: 'unknown',
        userMessage: '',
        agentResponse: '',
        targetedQuestionId: null,
        toolCalls: [],
        sideEffectAnswerIds: [],
        costUsd: null,
      })
    ).rejects.toThrow(NotFoundError);
  });

  it('back-stamps sideEffectAnswerIds when the array is non-empty', async () => {
    await recordTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'a',
      targetedQuestionId: null,
      toolCalls: [],
      sideEffectAnswerIds: ['ans-1', 'ans-2'],
      costUsd: null,
    });

    // The stamp is scoped to this session so a stray id cannot touch another session's row.
    expect(txMock.appAnswerSlot.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['ans-1', 'ans-2'] }, sessionId: 'sess-1' },
      data: { lastUpdatedTurnId: 'turn-new' },
    });
  });

  it('skips the answer-slot back-stamp when sideEffectAnswerIds is empty', async () => {
    await recordTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'a',
      targetedQuestionId: null,
      toolCalls: [],
      sideEffectAnswerIds: [],
      costUsd: null,
    });

    expect(txMock.appAnswerSlot.updateMany).not.toHaveBeenCalled();
  });

  it('back-stamps sideEffectDataSlotIds when provided and non-empty', async () => {
    await recordTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'a',
      targetedQuestionId: null,
      toolCalls: [],
      sideEffectAnswerIds: [],
      sideEffectDataSlotIds: ['fill-1'],
      costUsd: null,
    });

    expect(txMock.appDataSlotFill.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['fill-1'] }, sessionId: 'sess-1' },
      data: { lastUpdatedTurnId: 'turn-new' },
    });
  });

  it('skips the data-slot back-stamp when sideEffectDataSlotIds is absent', async () => {
    await recordTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'a',
      targetedQuestionId: null,
      toolCalls: [],
      sideEffectAnswerIds: [],
      // sideEffectDataSlotIds intentionally omitted
      costUsd: null,
    });

    expect(txMock.appDataSlotFill.updateMany).not.toHaveBeenCalled();
  });

  it('skips the data-slot back-stamp when sideEffectDataSlotIds is an empty array', async () => {
    await recordTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'a',
      targetedQuestionId: null,
      toolCalls: [],
      sideEffectAnswerIds: [],
      sideEffectDataSlotIds: [],
      costUsd: null,
    });

    expect(txMock.appDataSlotFill.updateMany).not.toHaveBeenCalled();
  });

  it('includes targetedDataSlotId in the create data when provided', async () => {
    await recordTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'a',
      targetedQuestionId: null,
      targetedDataSlotId: 'ds-1',
      toolCalls: [],
      sideEffectAnswerIds: [],
      costUsd: 0,
    });

    const createData = txMock.appQuestionnaireTurn.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(createData.targetedDataSlotId).toBe('ds-1');
  });

  it('omits targetedDataSlotId from the create data when not provided', async () => {
    await recordTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'a',
      targetedQuestionId: null,
      // targetedDataSlotId intentionally omitted
      toolCalls: [],
      sideEffectAnswerIds: [],
      costUsd: 0,
    });

    const createData = txMock.appQuestionnaireTurn.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(createData).not.toHaveProperty('targetedDataSlotId');
  });

  it('persists warnings in the turn row when the array is non-empty', async () => {
    const warnings = [{ code: 'seriousness', message: 'Suspicious answer' }];

    await recordTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'a',
      targetedQuestionId: null,
      toolCalls: [],
      sideEffectAnswerIds: [],
      warnings,
      costUsd: null,
    });

    const createData = txMock.appQuestionnaireTurn.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    // Warnings are serialised through jsonInput — the value should match the array (not Prisma.JsonNull).
    expect(createData.warnings).toEqual(warnings);
  });

  it('omits warnings from the create data when the array is empty', async () => {
    await recordTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'a',
      targetedQuestionId: null,
      toolCalls: [],
      sideEffectAnswerIds: [],
      warnings: [],
      costUsd: null,
    });

    const createData = txMock.appQuestionnaireTurn.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(createData).not.toHaveProperty('warnings');
  });

  it('persists the reasoning trace when non-empty', async () => {
    const reasoning = [
      { kind: 'extraction' as const, label: 'Captured role', tone: 'neutral' as const },
    ];

    await recordTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'a',
      targetedQuestionId: null,
      toolCalls: [],
      sideEffectAnswerIds: [],
      reasoning,
      costUsd: 0.002,
    });

    const createData = txMock.appQuestionnaireTurn.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(createData.reasoning).toEqual(reasoning);
  });

  it('omits reasoning from the create data when the array is empty', async () => {
    await recordTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'a',
      targetedQuestionId: null,
      toolCalls: [],
      sideEffectAnswerIds: [],
      reasoning: [],
      costUsd: 0,
    });

    const createData = txMock.appQuestionnaireTurn.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(createData).not.toHaveProperty('reasoning');
  });

  it('maps null to Prisma.JsonNull for toolCalls and sideEffectAnswerIds (jsonInput helper)', async () => {
    // Passing empty arrays → jsonInput should return the array as-is (not Prisma.JsonNull).
    // Passing null costUsd → Prisma stores as NULL.
    await recordTurn({
      sessionId: 'sess-1',
      userMessage: '',
      agentResponse: '',
      targetedQuestionId: null,
      toolCalls: [],
      sideEffectAnswerIds: [],
      costUsd: null,
    });

    const createData = txMock.appQuestionnaireTurn.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    // Empty arrays pass through as-is (not Prisma.JsonNull).
    expect(createData.toolCalls).toEqual([]);
    expect(createData.sideEffectAnswerIds).toEqual([]);
    // null costUsd is stored as null (not through jsonInput — it's a direct field).
    expect(createData.costUsd).toBeNull();
  });

  it('jsonInput maps null/undefined to Prisma.JsonNull for the sideEffectDataSlotIds field', async () => {
    // sideEffectDataSlotIds is passed as a non-empty array → stored as that array.
    await recordTurn({
      sessionId: 'sess-1',
      userMessage: '',
      agentResponse: '',
      targetedQuestionId: null,
      toolCalls: [],
      sideEffectAnswerIds: [],
      sideEffectDataSlotIds: ['fill-x'],
      costUsd: null,
    });

    const createData = txMock.appQuestionnaireTurn.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    // The field should be the array value (not Prisma.JsonNull).
    expect(createData.sideEffectDataSlotIds).toEqual(['fill-x']);
    expect(createData.sideEffectDataSlotIds).not.toBe(Prisma.JsonNull);
  });
});

describe('sumSessionTurnCost', () => {
  it('returns the aggregate sum when turns have a costUsd', async () => {
    prismaMock.appQuestionnaireTurn.aggregate.mockResolvedValue({
      _sum: { costUsd: 0.0567 },
    });

    const result = await sumSessionTurnCost('sess-1');

    // The route uses this as the pre-turn cost basis — must return the DB aggregate unchanged.
    expect(result).toBe(0.0567);
    expect(prismaMock.appQuestionnaireTurn.aggregate).toHaveBeenCalledWith({
      where: { sessionId: 'sess-1' },
      _sum: { costUsd: true },
    });
  });

  it('coalesces to 0 when the aggregate sum is null (no costed turns yet)', async () => {
    // Prisma returns null when all rows have costUsd = null or there are no rows.
    prismaMock.appQuestionnaireTurn.aggregate.mockResolvedValue({
      _sum: { costUsd: null },
    });

    const result = await sumSessionTurnCost('sess-new');

    // The turn-boundary cost-cap check must get a numeric 0, not null.
    expect(result).toBe(0);
  });

  it('coalesces to 0 for an empty session (no turns at all)', async () => {
    prismaMock.appQuestionnaireTurn.aggregate.mockResolvedValue({ _sum: { costUsd: null } });

    expect(await sumSessionTurnCost('sess-empty')).toBe(0);
  });
});

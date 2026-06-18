/**
 * Integration test: turn persistence helper (F6.1, PR4).
 *
 * The slot seam (`upsertAnswerSlot`) and turn seam (`recordTurn`) are mocked. Pins
 * persistTurn's mapping (slotKey → slotId, refined provenance, dedup, recordTurn args).
 * The offer streaming is covered in offer-stream.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const seamMock = vi.hoisted(() => ({
  upsertAnswerSlot: vi.fn(),
  loadAnswerSlot: vi.fn(),
  loadRespondentEditedSlotIds: vi.fn(),
  persistRefinement: vi.fn(),
  recordTurn: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/answer-slots', () => ({
  upsertAnswerSlot: seamMock.upsertAnswerSlot,
  loadAnswerSlot: seamMock.loadAnswerSlot,
  loadRespondentEditedSlotIds: seamMock.loadRespondentEditedSlotIds,
  persistRefinement: seamMock.persistRefinement,
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/turns', () => ({ recordTurn: seamMock.recordTurn }));

const dataSlotMock = vi.hoisted(() => ({
  upsertDataSlotFill: vi.fn(),
  reconcileChatDataSlotFills: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/data-slot-fills', () => dataSlotMock);

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireSession: { update: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { persistTurn } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-run';
import type { AnswerSlotIntent } from '@/lib/app/questionnaire/extraction/types';
import type {
  ExistingAnswerView,
  RefinementDecision,
} from '@/lib/app/questionnaire/refinement/types';

type Mock = ReturnType<typeof vi.fn>;

/** A loaded answer row, shaped as the answer-slots seam returns it. */
const loaded = (id: string, existing: Partial<ExistingAnswerView> = {}) => ({
  id,
  existing: {
    slotKey: 'role',
    value: 'first',
    provenance: 'direct' as const,
    confidence: 0.9,
    refinementHistory: [],
    ...existing,
  },
});

const intent = (slotKey: string, value: unknown): AnswerSlotIntent => ({
  slotKey,
  questionType: 'free_text',
  value,
  confidence: 0.9,
  provenance: 'direct',
  rationale: 'said so',
  isActiveQuestion: true,
});

const decision = (slotKey: string, newValue: unknown): RefinementDecision => ({
  slotKey,
  action: 'refine',
  questionType: 'free_text',
  newValue,
  rationale: 'reconciled',
  source: 'contradiction',
  confidence: 0.8,
});

beforeEach(() => {
  vi.clearAllMocks();
  (seamMock.recordTurn as Mock).mockResolvedValue('turn-1');
  // Default: no existing answer for a refinement (overridden per-test).
  (seamMock.loadAnswerSlot as Mock).mockResolvedValue(null);
  // Default: no respondent-edited slots (P-presentation protection; overridden per-test).
  (seamMock.loadRespondentEditedSlotIds as Mock).mockResolvedValue(new Set<string>());
  (dataSlotMock.upsertDataSlotFill as Mock).mockResolvedValue('ds-fill-1');
  // Default: the chat-mode gap-filler finds nothing to reconcile (its own behaviour is covered by
  // reconcile-chat-data-slot-fills.test.ts). Overridden in the wiring test below.
  (dataSlotMock.reconcileChatDataSlotFills as Mock).mockResolvedValue([]);
});

describe('persistTurn', () => {
  it('upserts each resolvable intent and records the turn with their ids', async () => {
    (seamMock.upsertAnswerSlot as Mock)
      .mockResolvedValueOnce('ans-q1')
      .mockResolvedValueOnce('ans-q2');

    const turnId = await persistTurn({
      sessionId: 'sess-1',
      userMessage: 'msg',
      agentResponse: 'reply',
      targetedQuestionId: 'q3',
      toolCalls: [],
      costUsd: 0.005,
      upserts: [intent('role', 'marketing'), intent('team', 5)],
      refinements: [],
      keyToSlotId: new Map([
        ['role', 'slot-q1'],
        ['team', 'slot-q2'],
      ]),
    });

    expect(turnId).toBe('turn-1');
    expect(seamMock.upsertAnswerSlot).toHaveBeenCalledWith(
      'sess-1',
      'slot-q1',
      expect.objectContaining({ value: 'marketing', provenance: 'direct' })
    );
    expect(seamMock.recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sideEffectAnswerIds: ['ans-q1', 'ans-q2'], costUsd: 0.005 })
    );
  });

  it('skips an intent whose slotKey does not resolve to a slot', async () => {
    (seamMock.upsertAnswerSlot as Mock).mockResolvedValue('ans-q1');
    await persistTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'r',
      targetedQuestionId: null,
      toolCalls: [],
      costUsd: 0,
      upserts: [intent('role', 'x'), intent('stale', 'y')],
      refinements: [],
      keyToSlotId: new Map([['role', 'slot-q1']]),
    });
    expect(seamMock.upsertAnswerSlot).toHaveBeenCalledTimes(1);
    // costUsd 0 → null on the turn record.
    expect(seamMock.recordTurn).toHaveBeenCalledWith(expect.objectContaining({ costUsd: null }));
  });

  it('refines through persistRefinement and dedupes a doubly-touched slot', async () => {
    // The same slot is both upserted and refined → loadAnswerSlot resolves to the
    // upserted row, persistRefinement writes it back, and the id appears once.
    (seamMock.upsertAnswerSlot as Mock).mockResolvedValue('ans-q1');
    (seamMock.loadAnswerSlot as Mock).mockResolvedValue(loaded('ans-q1'));

    await persistTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'r',
      targetedQuestionId: null,
      toolCalls: [],
      costUsd: 0,
      upserts: [intent('role', 'first')],
      refinements: [decision('role', 'corrected')],
      keyToSlotId: new Map([['role', 'slot-q1']]),
    });

    expect(seamMock.loadAnswerSlot).toHaveBeenCalledWith('sess-1', 'slot-q1');
    expect(seamMock.persistRefinement).toHaveBeenCalledWith(
      'ans-q1',
      expect.objectContaining({ value: 'corrected', provenance: 'refined' })
    );
    expect(seamMock.recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sideEffectAnswerIds: ['ans-q1'] })
    );
  });

  it('appends the prior value to refinementHistory on a live refinement (the gap this closes)', async () => {
    // An existing answer with one prior history entry; a refine should grow it to two,
    // capturing the pre-change value/provenance + the decision source.
    (seamMock.loadAnswerSlot as Mock).mockResolvedValue(
      loaded('ans-q1', {
        value: 'marketing',
        provenance: 'direct',
        refinementHistory: [
          {
            previousValue: null,
            previousProvenance: 'direct',
            newValue: 'marketing',
            rationale: 'initial capture',
            source: 'correction',
          },
        ],
      })
    );

    await persistTurn({
      sessionId: 'sess-1',
      userMessage: 'actually, sales',
      agentResponse: 'r',
      targetedQuestionId: null,
      toolCalls: [],
      costUsd: 0,
      upserts: [],
      refinements: [decision('role', 'sales')],
      keyToSlotId: new Map([['role', 'slot-q1']]),
    });

    expect(seamMock.upsertAnswerSlot).not.toHaveBeenCalled();
    const [, refined] = (seamMock.persistRefinement as Mock).mock.calls[0];
    expect(refined.refinementHistory).toHaveLength(2);
    expect(refined.refinementHistory[1]).toMatchObject({
      previousValue: 'marketing',
      previousProvenance: 'direct',
      newValue: 'sales',
      source: 'contradiction',
    });
  });

  it('falls back to a plain upsert when the refined slot has no existing answer', async () => {
    // Defensive path: loadAnswerSlot returns null (default) → value is persisted via
    // upsert with `refined` provenance rather than skipped or thrown.
    (seamMock.upsertAnswerSlot as Mock).mockResolvedValue('ans-q1');

    await persistTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'r',
      targetedQuestionId: null,
      toolCalls: [],
      costUsd: 0,
      upserts: [],
      refinements: [decision('role', 'corrected')],
      keyToSlotId: new Map([['role', 'slot-q1']]),
    });

    expect(seamMock.persistRefinement).not.toHaveBeenCalled();
    expect(seamMock.upsertAnswerSlot).toHaveBeenCalledWith(
      'sess-1',
      'slot-q1',
      expect.objectContaining({ value: 'corrected', provenance: 'refined' })
    );
    expect(seamMock.recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sideEffectAnswerIds: ['ans-q1'] })
    );
  });

  describe('respondent-edited protection (P-presentation)', () => {
    it('does not overwrite an extraction intent targeting a respondent-edited slot', async () => {
      (seamMock.loadRespondentEditedSlotIds as Mock).mockResolvedValue(new Set(['slot-q1']));

      await persistTurn({
        sessionId: 'sess-1',
        userMessage: 'I do sales',
        agentResponse: 'r',
        targetedQuestionId: null,
        toolCalls: [],
        costUsd: 0,
        upserts: [intent('role', 'sales'), intent('team', 5)],
        refinements: [],
        keyToSlotId: new Map([
          ['role', 'slot-q1'], // respondent-edited → protected
          ['team', 'slot-q2'],
        ]),
      });

      // Only the non-protected slot is written; the respondent's own answer is left intact.
      expect(seamMock.upsertAnswerSlot).toHaveBeenCalledTimes(1);
      expect(seamMock.upsertAnswerSlot).toHaveBeenCalledWith(
        'sess-1',
        'slot-q2',
        expect.anything()
      );
    });

    it('does not refine a respondent-edited slot', async () => {
      (seamMock.loadRespondentEditedSlotIds as Mock).mockResolvedValue(new Set(['slot-q1']));
      (seamMock.loadAnswerSlot as Mock).mockResolvedValue(loaded('ans-q1'));

      await persistTurn({
        sessionId: 'sess-1',
        userMessage: 'm',
        agentResponse: 'r',
        targetedQuestionId: null,
        toolCalls: [],
        costUsd: 0,
        upserts: [],
        refinements: [decision('role', 'corrected')],
        keyToSlotId: new Map([['role', 'slot-q1']]),
      });

      expect(seamMock.loadAnswerSlot).not.toHaveBeenCalled();
      expect(seamMock.persistRefinement).not.toHaveBeenCalled();
      expect(seamMock.recordTurn).toHaveBeenCalledWith(
        expect.objectContaining({ sideEffectAnswerIds: [] })
      );
    });
  });

  it('upserts data-slot fills (data-slot mode) and records their ids on the turn', async () => {
    await persistTurn({
      sessionId: 'sess-1',
      userMessage: 'I want to grow the team',
      agentResponse: 'r',
      targetedQuestionId: null,
      targetedDataSlotId: 'ds-1',
      toolCalls: [],
      costUsd: 0,
      upserts: [],
      refinements: [],
      keyToSlotId: new Map(),
      dataSlotFills: [
        {
          dataSlotKey: 'goal',
          value: 'grow',
          paraphrase: 'Grow the team',
          confidence: 0.9,
          provenance: 'direct',
        },
      ],
      dataSlotKeyToId: new Map([['goal', 'ds-1']]),
    });

    expect(dataSlotMock.upsertDataSlotFill).toHaveBeenCalledWith(
      'sess-1',
      'ds-1',
      expect.objectContaining({ paraphrase: 'Grow the team', confidence: 0.9 })
    );
    expect(seamMock.recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sideEffectDataSlotIds: ['ds-fill-1'], targetedDataSlotId: 'ds-1' })
    );
  });

  it('skips a data-slot fill whose key does not resolve', async () => {
    await persistTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'r',
      targetedQuestionId: null,
      toolCalls: [],
      costUsd: 0,
      upserts: [],
      refinements: [],
      keyToSlotId: new Map(),
      dataSlotFills: [
        {
          dataSlotKey: 'stale',
          value: 'x',
          paraphrase: 'x',
          confidence: 0.5,
          provenance: 'direct',
        },
      ],
      dataSlotKeyToId: new Map([['goal', 'ds-1']]),
    });
    expect(dataSlotMock.upsertDataSlotFill).not.toHaveBeenCalled();
    expect(seamMock.recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sideEffectDataSlotIds: [] })
    );
  });

  it('runs the chat-mode gap-filler over the answered slots and records the fills it synthesises', async () => {
    (seamMock.upsertAnswerSlot as Mock).mockResolvedValue('ans-q1');
    // The turn answered the `kpis` question; the gap-filler returns a synthesised fill id for a parent
    // slot that had no fill (it skips already-filled slots itself, via a DB read).
    (dataSlotMock.reconcileChatDataSlotFills as Mock).mockResolvedValue(['ds-fill-gap']);

    await persistTurn({
      sessionId: 'sess-1',
      userMessage: 'badly thought out KPIs',
      agentResponse: 'r',
      targetedQuestionId: null,
      toolCalls: [],
      costUsd: 0,
      upserts: [intent('kpis', false)],
      refinements: [],
      keyToSlotId: new Map([['kpis', 'slot-kpis']]),
      dataSlotFills: [
        {
          dataSlotKey: 'goal',
          value: 'grow',
          paraphrase: 'Grow the team',
          confidence: 0.9,
          provenance: 'direct',
        },
      ],
      dataSlotKeyToId: new Map([['goal', 'ds-1']]),
    });

    // Reconciler is handed the question slots answered this turn (it queries existing fills itself to
    // decide which parent slots are empty).
    expect(dataSlotMock.reconcileChatDataSlotFills).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      answeredQuestionSlotIds: ['slot-kpis'],
    });
    // Both the extractor's fill id and the gap-filler's synthesised id land on the turn.
    expect(seamMock.recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sideEffectDataSlotIds: ['ds-fill-1', 'ds-fill-gap'] })
    );
  });

  it('forwards the turn’s side-band warnings to recordTurn for persistence', async () => {
    await persistTurn({
      sessionId: 'sess-1',
      userMessage: 'lol the ceo',
      agentResponse: "Let's keep it genuine.",
      targetedQuestionId: 'q1',
      toolCalls: [],
      warnings: [{ code: 'seriousness', message: "That doesn't seem like a serious answer." }],
      costUsd: 0,
      upserts: [],
      refinements: [],
      keyToSlotId: new Map(),
    });

    expect(seamMock.recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        warnings: [{ code: 'seriousness', message: "That doesn't seem like a serious answer." }],
      })
    );
  });

  it('omits warnings from the recordTurn payload when the turn raised none', async () => {
    await persistTurn({
      sessionId: 'sess-1',
      userMessage: 'a real answer',
      agentResponse: 'Thanks.',
      targetedQuestionId: 'q1',
      toolCalls: [],
      warnings: [],
      costUsd: 0,
      upserts: [],
      refinements: [],
      keyToSlotId: new Map(),
    });

    expect(seamMock.recordTurn).toHaveBeenCalledTimes(1);
    expect((seamMock.recordTurn as Mock).mock.calls[0][0]).not.toHaveProperty('warnings');
  });

  it('skips a refinement whose slotKey does not resolve to a slot', async () => {
    await persistTurn({
      sessionId: 'sess-1',
      userMessage: 'm',
      agentResponse: 'r',
      targetedQuestionId: null,
      toolCalls: [],
      costUsd: 0,
      upserts: [],
      refinements: [decision('stale', 'x')],
      keyToSlotId: new Map([['role', 'slot-q1']]),
    });
    expect(seamMock.loadAnswerSlot).not.toHaveBeenCalled();
    expect(seamMock.persistRefinement).not.toHaveBeenCalled();
    expect(seamMock.upsertAnswerSlot).not.toHaveBeenCalled();
    expect(seamMock.recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sideEffectAnswerIds: [] })
    );
  });

  describe('pendingContradiction flow', () => {
    beforeEach(() => {
      (prismaMock.appQuestionnaireSession.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    });

    it('clears a resolved probe by writing DbNull when pendingContradiction is null', async () => {
      await persistTurn({
        sessionId: 'sess-1',
        userMessage: 'confirmed',
        agentResponse: 'Great.',
        targetedQuestionId: null,
        toolCalls: [],
        costUsd: 0,
        upserts: [],
        refinements: [],
        keyToSlotId: new Map(),
        pendingContradiction: null,
      });

      // The session must be updated to clear the contradiction probe.
      expect(prismaMock.appQuestionnaireSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sess-1' } })
      );
      // The turn is still recorded after the session update.
      expect(seamMock.recordTurn).toHaveBeenCalledTimes(1);
    });

    it('parks a raised probe on the session when pendingContradiction is an object', async () => {
      const probe = {
        slotKeys: ['role'],
        explanation: 'Conflicting roles detected.',
        statement: 'Actually I do sales.',
        raisedAtTurnIndex: 3,
      };

      await persistTurn({
        sessionId: 'sess-1',
        userMessage: 'Actually I do sales.',
        agentResponse: 'Could you clarify?',
        targetedQuestionId: null,
        toolCalls: [],
        costUsd: 0,
        upserts: [],
        refinements: [],
        keyToSlotId: new Map(),
        pendingContradiction: probe,
      });

      expect(prismaMock.appQuestionnaireSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sess-1' } })
      );
      expect(seamMock.recordTurn).toHaveBeenCalledTimes(1);
    });

    it('does NOT call session update when pendingContradiction is undefined (default)', async () => {
      // The common path — undefined means "leave untouched".
      await persistTurn({
        sessionId: 'sess-1',
        userMessage: 'm',
        agentResponse: 'r',
        targetedQuestionId: null,
        toolCalls: [],
        costUsd: 0,
        upserts: [],
        refinements: [],
        keyToSlotId: new Map(),
        // pendingContradiction intentionally omitted
      });

      expect(prismaMock.appQuestionnaireSession.update).not.toHaveBeenCalled();
    });
  });
});

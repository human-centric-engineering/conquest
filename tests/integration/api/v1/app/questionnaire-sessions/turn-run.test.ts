/**
 * Integration test: turn rendering + persistence helpers (F6.1, PR4).
 *
 * The slot seam (`upsertAnswerSlot`), turn seam (`recordTurn`), and capability dispatcher
 * are mocked. Pins persistTurn's mapping (slotKey → slotId, refined provenance, dedup,
 * recordTurn args) and renderOfferMessage's fail-soft fallback.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const seamMock = vi.hoisted(() => ({ upsertAnswerSlot: vi.fn(), recordTurn: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/answer-slots', () => ({
  upsertAnswerSlot: seamMock.upsertAnswerSlot,
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/turns', () => ({ recordTurn: seamMock.recordTurn }));

const dispatcherMock = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: dispatcherMock,
}));

const prismaMock = vi.hoisted(() => ({ aiAgent: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import {
  FALLBACK_OFFER_MESSAGE,
  persistTurn,
  renderOfferMessage,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-run';
import type { AnswerSlotIntent } from '@/lib/app/questionnaire/extraction/types';
import type { RefinementDecision } from '@/lib/app/questionnaire/refinement/types';

type Mock = ReturnType<typeof vi.fn>;

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

  it('persists a refinement with refined provenance and dedupes a doubly-touched slot', async () => {
    // The same slot is both upserted and refined → one id, not two.
    (seamMock.upsertAnswerSlot as Mock).mockResolvedValue('ans-q1');
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
    expect(seamMock.upsertAnswerSlot).toHaveBeenLastCalledWith(
      'sess-1',
      'slot-q1',
      expect.objectContaining({ value: 'corrected', provenance: 'refined' })
    );
    expect(seamMock.recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sideEffectAnswerIds: ['ans-q1'] })
    );
  });
});

describe('renderOfferMessage', () => {
  const input = {
    coverage: 1,
    answeredCount: 2,
    capReached: false,
    coveredSlots: [{ key: 'role', prompt: 'Role?' }],
    remainingSlots: [],
    recentMessages: [],
  };

  it('returns the composed offer message on success', async () => {
    (prismaMock.aiAgent.findUnique as Mock).mockResolvedValue({
      id: 'agent-1',
      provider: 'openai',
      model: 'gpt',
      fallbackProviders: [],
    });
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { offer: { offerMessage: 'Ready to submit your answers?', coveredSummary: '...' } },
    });
    expect(await renderOfferMessage({ input, userId: 'u', sessionId: 'sess-1' })).toBe(
      'Ready to submit your answers?'
    );
  });

  it('falls back when the completion agent is unconfigured', async () => {
    (prismaMock.aiAgent.findUnique as Mock).mockResolvedValue(null);
    expect(await renderOfferMessage({ input, userId: 'u', sessionId: 'sess-1' })).toBe(
      FALLBACK_OFFER_MESSAGE
    );
    expect(dispatcherMock.dispatch).not.toHaveBeenCalled();
  });

  it('falls back when the capability dispatch fails', async () => {
    (prismaMock.aiAgent.findUnique as Mock).mockResolvedValue({
      id: 'a',
      provider: 'p',
      model: 'm',
      fallbackProviders: [],
    });
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'composition_failed', message: 'x' },
    });
    expect(await renderOfferMessage({ input, userId: 'u', sessionId: 'sess-1' })).toBe(
      FALLBACK_OFFER_MESSAGE
    );
  });
});

/**
 * Integration test: the answer-panel DB read seam (F7.2).
 *
 * Prisma is mocked; the real pure {@link buildAnswerPanelView} runs. Pins the seam's
 * own responsibilities: the null-session → null return, the turn-id → 1-based-ordinal
 * resolution for `answeredAtTurnIndex`, the row → builder-input mapping (incl. the
 * slotKey re-key off `questionSlot.key`), the `refinementHistory` Json narrowing, the
 * `answerSlotPanelScope` narrowing + default fallback, and `status` narrowing.
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/answer-panel.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: { appQuestionnaireSession: { findUnique: vi.fn() } },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

import { loadAnswerPanelState } from '@/app/api/v1/app/questionnaire-sessions/_lib/answer-panel';

type Mock = ReturnType<typeof vi.fn>;
const findUnique = mocks.prisma.appQuestionnaireSession.findUnique as Mock;

/** A findUnique row matching the seam's `select`, with overridable parts. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    status: 'active',
    respondentUserId: 'user-1',
    version: {
      config: { answerSlotPanelScope: 'full_progress' },
      sections: [
        {
          id: 'sec-1',
          title: 'About you',
          questions: [
            {
              key: 'name',
              prompt: 'Your name?',
              type: 'free_text',
              typeConfig: null,
              required: true,
            },
            {
              key: 'colour',
              prompt: 'Favourite colour?',
              type: 'single_choice',
              typeConfig: {
                choices: [
                  { value: 'r', label: 'Red' },
                  { value: 'b', label: 'Blue' },
                ],
              },
              required: false,
            },
          ],
        },
      ],
    },
    answers: [
      {
        value: 'Ada',
        confidence: 0.9,
        provenanceLabel: 'direct',
        rationale: 'Stated directly.',
        lastUpdatedTurnId: 'turn-b',
        refinementHistory: [],
        questionSlot: { key: 'name' },
      },
    ],
    turns: [
      { id: 'turn-a', ordinal: 1 },
      { id: 'turn-b', ordinal: 2 },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadAnswerPanelState', () => {
  it('returns null when the session does not resolve', async () => {
    findUnique.mockResolvedValue(null);
    await expect(loadAnswerPanelState('missing')).resolves.toBeNull();
  });

  it('returns the access fields alongside the projected view', async () => {
    findUnique.mockResolvedValue(row());
    const loaded = await loadAnswerPanelState('sess-1');

    expect(loaded?.session).toEqual({ id: 'sess-1', respondentUserId: 'user-1' });
    expect(loaded?.view.status).toBe('active');
    expect(loaded?.view.scope).toBe('full_progress');
    expect(loaded?.view.answeredCount).toBe(1);
    expect(loaded?.view.totalCount).toBe(2);
  });

  it('resolves lastUpdatedTurnId to its 1-based turn ordinal', async () => {
    findUnique.mockResolvedValue(row());
    const loaded = await loadAnswerPanelState('sess-1');

    const slots = loaded!.view.sections[0].slots;
    const answered = slots.find((s) => s.slotKey === 'name')!;
    expect(answered.answered).toBe(true);
    expect(answered.answeredAtTurnIndex).toBe(2); // turn-b → ordinal 2
    expect(answered.value).toBe('Ada');
    expect(answered.provenance).toBe('direct');

    const pending = slots.find((s) => s.slotKey === 'colour')!;
    expect(pending.answered).toBe(false);
    expect(pending.answeredAtTurnIndex).toBeNull();
  });

  it('leaves answeredAtTurnIndex null when the turn id is absent or unmapped', async () => {
    findUnique.mockResolvedValue(
      row({
        answers: [
          {
            value: 'Ada',
            confidence: null,
            provenanceLabel: 'direct',
            rationale: null,
            lastUpdatedTurnId: null,
            refinementHistory: [],
            questionSlot: { key: 'name' },
          },
        ],
      })
    );
    const loaded = await loadAnswerPanelState('sess-1');
    const answered = loaded!.view.sections[0].slots.find((s) => s.slotKey === 'name')!;
    expect(answered.answered).toBe(true);
    expect(answered.answeredAtTurnIndex).toBeNull();
  });

  it('coerces a non-array refinementHistory Json to an empty array', async () => {
    findUnique.mockResolvedValue(
      row({
        answers: [
          {
            value: 'Ada',
            confidence: 0.5,
            provenanceLabel: 'direct',
            rationale: null,
            lastUpdatedTurnId: 'turn-a',
            refinementHistory: { not: 'an array' }, // malformed Json column
            questionSlot: { key: 'name' },
          },
        ],
      })
    );
    const loaded = await loadAnswerPanelState('sess-1');
    const answered = loaded!.view.sections[0].slots.find((s) => s.slotKey === 'name')!;
    expect(answered.refinementHistory).toEqual([]);
  });

  it('falls back to the default scope when the stored value is unknown or absent', async () => {
    findUnique.mockResolvedValue(row({ version: { ...row().version, config: null } }));
    const loaded = await loadAnswerPanelState('sess-1');
    expect(loaded?.view.scope).toBe('full_progress');
  });

  it('narrows an unrecognised session status to active', async () => {
    findUnique.mockResolvedValue(row({ status: 'bogus' }));
    const loaded = await loadAnswerPanelState('sess-1');
    expect(loaded?.view.status).toBe('active');
  });

  it('carries each slot typeConfig through for the form surface', async () => {
    findUnique.mockResolvedValue(row());
    const loaded = await loadAnswerPanelState('sess-1');
    const colour = loaded!.view.sections[0].slots.find((s) => s.slotKey === 'colour')!;
    expect(colour.typeConfig).toEqual({
      choices: [
        { value: 'r', label: 'Red' },
        { value: 'b', label: 'Blue' },
      ],
    });
    const name = loaded!.view.sections[0].slots.find((s) => s.slotKey === 'name')!;
    expect(name.typeConfig).toBeNull();
  });

  describe('forForm (P-presentation)', () => {
    it('forces full structure even when the version scope is answered_only', async () => {
      findUnique.mockResolvedValue(
        row({ version: { ...row().version, config: { answerSlotPanelScope: 'answered_only' } } })
      );
      const loaded = await loadAnswerPanelState('sess-1', false, true);
      // The chat panel would hide the pending `colour` slot under answered_only; the form must not.
      expect(loaded?.view.scope).toBe('full_progress');
      expect(loaded?.view.sections[0].slots).toHaveLength(2);
    });

    it('keeps question sections even when data-slot mode is on', async () => {
      findUnique.mockResolvedValue(
        row({
          version: {
            ...row().version,
            dataSlots: [
              { id: 'ds-1', key: 'goal', name: 'Goal', description: 'Why', theme: 'Goals' },
            ],
          },
          dataSlotFills: [],
        })
      );
      // dataSlotMode = true, but forForm = true → the form stays question-based.
      const loaded = await loadAnswerPanelState('sess-1', true, true);
      expect(loaded?.view.dataSlotGroups).toBeUndefined();
      expect(loaded?.view.sections[0].slots).toHaveLength(2);
    });
  });
});

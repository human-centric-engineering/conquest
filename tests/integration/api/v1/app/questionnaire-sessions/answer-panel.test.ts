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
      config: { answerSlotPanelScope: 'full_progress', presentationMode: 'chat' },
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
              // weight is part of the real select and read by weightedCoverage in data-slot mode.
              weight: 1,
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
              weight: 1,
            },
          ],
        },
      ],
      // Always present in the real select; the data-slot-mode tests override with real slots.
      dataSlots: [],
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
    // The real Prisma select always returns these; the data-slot-mode tests override them. Keeping
    // them on the base fixture matches the row shape the seam actually receives.
    dataSlotFills: [],
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
    // Average confidence is the mean over scored answers (one answer at 0.9 → 0.9).
    expect(loaded?.view.averageConfidence).toBeCloseTo(0.9);
  });

  it('omits averageConfidence when no answer carries a score', async () => {
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
    expect(loaded?.view.averageConfidence).toBeUndefined();
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

  describe('data-slot mode', () => {
    it('builds themed data-slot groups (paraphrase, filled, history) and suppresses question sections', async () => {
      findUnique.mockResolvedValue(
        row({
          version: {
            ...row().version,
            // Inline correction OFF so this test isolates the showSlotQuestions (both-mode) gate:
            // with neither gate on, chat mode ships no itemised questions at all.
            config: {
              answerSlotPanelScope: 'full_progress',
              presentationMode: 'chat',
              inlineCorrectionEnabled: false,
            },
            dataSlots: [
              {
                id: 'ds-1',
                key: 'goal',
                name: 'Goal',
                description: 'Why',
                theme: 'Goals',
                // Maps to both questions; only `name` is answered → breadth 1 of 2.
                questions: [{ questionSlot: { key: 'name' } }, { questionSlot: { key: 'colour' } }],
              },
              {
                id: 'ds-2',
                key: 'mood',
                name: 'Mood',
                description: 'How',
                theme: 'Goals',
                questions: [{ questionSlot: { key: 'colour' } }], // unanswered → breadth 0 of 1
              },
            ],
          },
          dataSlotFills: [
            {
              dataSlotId: 'ds-1',
              paraphrase: 'Grow the team',
              // provenanceLabel + rationale are part of the real Prisma select and read by the
              // seam (asProvenance / the fill map) — include them so the fixture matches the row shape.
              provenanceLabel: 'direct',
              rationale: 'They said growing the team is the priority.',
              confidence: 0.9,
              provisional: false,
              refinementHistory: [{ previousParaphrase: 'Hire', previousConfidence: 0.4 }],
            },
            // ds-2 has no fill → unfilled
          ],
        })
      );
      const loaded = await loadAnswerPanelState('sess-1', true); // dataSlotMode on, forForm off

      expect(loaded?.view.dataSlotGroups).toHaveLength(1); // one theme: "Goals"
      const group = loaded!.view.dataSlotGroups![0];
      expect(group.theme).toBe('Goals');
      const goal = group.slots.find((s) => s.key === 'goal')!;
      expect(goal.filled).toBe(true);
      expect(goal.paraphrase).toBe('Grow the team');
      // The provenance + rationale flow through the seam to the view.
      expect(goal.provenance).toBe('direct');
      expect(goal.rationale).toBe('They said growing the team is the priority.');
      // A legacy history entry (no per-change rationale/timestamp captured) projects those as null.
      expect(goal.history).toEqual([
        { paraphrase: 'Hire', confidence: 0.4, rationale: null, changedAt: null },
      ]);
      const mood = group.slots.find((s) => s.key === 'mood')!;
      expect(mood.filled).toBe(false);
      expect(mood.paraphrase).toBeNull();
      // Question rows are suppressed; a blended progress percent is shown instead. The fixture has
      // 1 of 2 equal-weight questions answered → weighted coverage 50%.
      expect(loaded?.view.sections).toEqual([]);
      expect(loaded?.view.progressPercent).toBe(50);
      // Average confidence in data-slot mode is the mean over the FILLS (ds-1 at 0.9; ds-2 unfilled
      // contributes nothing), matching the data-slot rows the respondent sees — not the question answers.
      expect(loaded?.view.averageConfidence).toBeCloseTo(0.9);
      // Breadth: ds-1 maps to name (answered) + colour (pending) → 1 of 2; ds-2 maps to colour → 0 of 1.
      expect(goal.coverage.total).toBe(2);
      expect(goal.coverage.answered).toBe(1);
      expect(mood.coverage).toEqual({ total: 1, answered: 0, questions: [] });
      // Chat mode never ships the raw prompts — the meter shows the summary alone.
      expect(loaded?.view.showSlotQuestions).toBe(false);
      expect(goal.coverage.questions).toEqual([]);
    });

    it('itemises a slot’s mapped questions (label + per-question completeness) in both mode', async () => {
      findUnique.mockResolvedValue(
        row({
          version: {
            ...row().version,
            config: { answerSlotPanelScope: 'full_progress', presentationMode: 'both' },
            dataSlots: [
              {
                id: 'ds-1',
                key: 'goal',
                name: 'Goal',
                description: 'Why',
                theme: 'Goals',
                // Join order is colour-then-name; the seam re-sorts to version order (name, colour).
                questions: [{ questionSlot: { key: 'colour' } }, { questionSlot: { key: 'name' } }],
              },
            ],
          },
          dataSlotFills: [],
        })
      );
      const loaded = await loadAnswerPanelState('sess-1', true);
      expect(loaded?.view.showSlotQuestions).toBe(true);
      const goal = loaded!.view.dataSlotGroups![0].slots[0];
      // Itemised in version order, each carrying its own answered/confidence state plus the editable
      // shape (key/type/typeConfig/value) the inline-correction editor (Variant B) needs.
      expect(goal.coverage.questions).toEqual([
        {
          key: 'name',
          label: 'Your name?',
          type: 'free_text',
          typeConfig: null,
          answered: true,
          confidence: 0.9,
          value: 'Ada',
        },
        {
          key: 'colour',
          label: 'Favourite colour?',
          type: 'single_choice',
          typeConfig: {
            choices: [
              { value: 'r', label: 'Red' },
              { value: 'b', label: 'Blue' },
            ],
          },
          answered: false,
          confidence: null,
          value: null,
        },
      ]);
    });

    it('itemises mapped questions in chat mode too when inline correction is on (Variant B)', async () => {
      findUnique.mockResolvedValue(
        row({
          version: {
            ...row().version,
            // Chat mode, but inline correction ON (the default) → the editor needs the mapped
            // questions, so coverage.questions is populated even though showSlotQuestions stays false.
            config: {
              answerSlotPanelScope: 'full_progress',
              presentationMode: 'chat',
              inlineCorrectionEnabled: true,
            },
            dataSlots: [
              {
                id: 'ds-1',
                key: 'goal',
                name: 'Goal',
                description: 'Why',
                theme: 'Goals',
                questions: [{ questionSlot: { key: 'name' } }],
              },
            ],
          },
          dataSlotFills: [],
        })
      );
      const loaded = await loadAnswerPanelState('sess-1', true);
      // The breadth-list DISPLAY stays gated on showSlotQuestions (both mode only)…
      expect(loaded?.view.showSlotQuestions).toBe(false);
      // …but the editable questions are shipped so the correction editor can render them.
      const goal = loaded!.view.dataSlotGroups![0].slots[0];
      expect(goal.coverage.questions).toEqual([
        {
          key: 'name',
          label: 'Your name?',
          type: 'free_text',
          typeConfig: null,
          answered: true,
          confidence: 0.9,
          value: 'Ada',
        },
      ]);
    });

    it('narrows an unrecognised fill provenanceLabel to null (drops the Inferred badge safely)', async () => {
      findUnique.mockResolvedValue(
        row({
          version: {
            ...row().version,
            dataSlots: [
              {
                id: 'ds-1',
                key: 'goal',
                name: 'Goal',
                description: 'd',
                theme: 'T',
                questions: [],
              },
            ],
          },
          dataSlotFills: [
            {
              dataSlotId: 'ds-1',
              paraphrase: 'maybe',
              provenanceLabel: 'garbage', // not in ANSWER_PROVENANCES → must narrow to null
              rationale: null,
              confidence: 0.9,
              provisional: false,
              lastUpdatedTurnId: null,
              refinementHistory: [],
            },
          ],
        })
      );
      const loaded = await loadAnswerPanelState('sess-1', true);
      expect(loaded!.view.dataSlotGroups![0].slots[0].provenance).toBeNull();
    });

    it('resolves a data-slot fill lastUpdatedTurnId to its 1-based turn ordinal', async () => {
      findUnique.mockResolvedValue(
        row({
          version: {
            ...row().version,
            dataSlots: [
              {
                id: 'ds-1',
                key: 'goal',
                name: 'Goal',
                description: 'Why',
                theme: 'Goals',
                // Maps to both questions; only `name` is answered → breadth 1 of 2.
                questions: [{ questionSlot: { key: 'name' } }, { questionSlot: { key: 'colour' } }],
              },
              {
                id: 'ds-2',
                key: 'mood',
                name: 'Mood',
                description: 'How',
                theme: 'Goals',
                questions: [{ questionSlot: { key: 'colour' } }], // unanswered → breadth 0 of 1
              },
            ],
          },
          dataSlotFills: [
            {
              dataSlotId: 'ds-1',
              paraphrase: 'Grow the team',
              provenanceLabel: 'direct',
              rationale: null,
              confidence: 0.9,
              provisional: false,
              lastUpdatedTurnId: 'turn-b', // → ordinal 2
              refinementHistory: [],
            },
            // ds-2 unfilled → answeredAtTurnIndex stays null
          ],
        })
      );
      const loaded = await loadAnswerPanelState('sess-1', true);
      const group = loaded!.view.dataSlotGroups![0];
      expect(group.slots.find((s) => s.key === 'goal')!.answeredAtTurnIndex).toBe(2);
      expect(group.slots.find((s) => s.key === 'mood')!.answeredAtTurnIndex).toBeNull();
    });

    it('leaves a data-slot answeredAtTurnIndex null when the turn id is absent or unmapped', async () => {
      findUnique.mockResolvedValue(
        row({
          version: {
            ...row().version,
            dataSlots: [
              {
                id: 'ds-1',
                key: 'goal',
                name: 'Goal',
                description: 'd',
                theme: 'T',
                questions: [],
              },
            ],
          },
          dataSlotFills: [
            {
              dataSlotId: 'ds-1',
              paraphrase: 'maybe',
              provenanceLabel: 'inferred',
              rationale: null,
              confidence: 0.9,
              provisional: false,
              lastUpdatedTurnId: 'turn-missing', // not in the turns map → null
              refinementHistory: [],
            },
          ],
        })
      );
      const loaded = await loadAnswerPanelState('sess-1', true);
      expect(loaded!.view.dataSlotGroups![0].slots[0].answeredAtTurnIndex).toBeNull();
    });

    it('counts a provisional fill as filled even below the confidence threshold', async () => {
      findUnique.mockResolvedValue(
        row({
          version: {
            ...row().version,
            dataSlots: [
              {
                id: 'ds-1',
                key: 'goal',
                name: 'Goal',
                description: 'd',
                theme: 'T',
                questions: [],
              },
            ],
          },
          dataSlotFills: [
            {
              dataSlotId: 'ds-1',
              paraphrase: 'maybe',
              provenanceLabel: 'inferred',
              rationale: null,
              confidence: 0.1,
              provisional: true,
              refinementHistory: [],
            },
          ],
        })
      );
      const loaded = await loadAnswerPanelState('sess-1', true);
      const slot = loaded!.view.dataSlotGroups![0].slots[0];
      expect(slot.filled).toBe(true);
      expect(slot.provisional).toBe(true);
    });
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
              {
                id: 'ds-1',
                key: 'goal',
                name: 'Goal',
                description: 'Why',
                theme: 'Goals',
                questions: [],
              },
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

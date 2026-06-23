import { describe, expect, it } from 'vitest';

import { buildReasoningTrace } from '@/lib/app/questionnaire/reasoning';
import type { TurnResult } from '@/lib/app/questionnaire/orchestrator/types';
import type { QuestionView } from '@/lib/app/questionnaire/selection/types';
import type { CompletionAssessment } from '@/lib/app/questionnaire/completion/types';
import type { AnswerSlotIntent } from '@/lib/app/questionnaire/extraction/types';

/** A minimal question slot the builder resolves labels against. */
function qv(over: Partial<QuestionView> & { id: string; key: string }): QuestionView {
  return {
    sectionId: 's1',
    sectionOrdinal: 0,
    ordinal: 0,
    weight: 1,
    required: false,
    type: 'free_text',
    tagIds: [],
    prompt: `Prompt for ${over.key}`,
    ...over,
  };
}

function intent(over: Partial<AnswerSlotIntent> & { slotKey: string }): AnswerSlotIntent {
  return {
    questionType: 'free_text',
    value: 'v',
    confidence: 0.9,
    provenance: 'direct',
    rationale: 'because',
    isActiveQuestion: true,
    ...over,
  };
}

function assessment(over: Partial<CompletionAssessment> = {}): CompletionAssessment {
  return {
    kind: 'not_ready',
    coverage: 0,
    answeredCount: 0,
    requiredUnansweredKeys: [],
    capReached: false,
    unmet: ['coverage_below_threshold'],
    rationale: 'not ready',
    ...over,
  };
}

/** A baseline result that selects a question; override per test. */
function result(over: Partial<TurnResult> = {}): TurnResult {
  return {
    response: { kind: 'question', questionId: 'q2', text: 'Prompt for q2' },
    targetedQuestionId: 'q2',
    selectionStrategy: 'sequential',
    sideEffects: { answerUpserts: [], answerRefinements: [] },
    events: [],
    toolCalls: [],
    costUsd: 0,
    contradictions: [],
    assessment: assessment(),
    ...over,
  };
}

const QUESTIONS = [qv({ id: 'q1', key: 'q1' }), qv({ id: 'q2', key: 'q2' })];

describe('buildReasoningTrace', () => {
  it('builds an extraction step from a question-mode answer upsert (provenance, confidence, quote)', () => {
    const steps = buildReasoningTrace(
      result({
        sideEffects: {
          answerUpserts: [
            intent({
              slotKey: 'q1',
              provenance: 'inferred',
              confidence: 0.6,
              sourceQuote: 'I earn 50k',
            }),
          ],
          answerRefinements: [],
        },
        assessment: assessment({ answeredCount: 1, coverage: 0.5 }),
      }),
      { questions: QUESTIONS }
    );

    const extraction = steps.find((s) => s.kind === 'extraction');
    expect(extraction).toBeDefined();
    expect(extraction?.label).toContain('Prompt for q1');
    expect(extraction?.provenance).toBe('inferred');
    expect(extraction?.confidence).toBe(0.6);
    expect(extraction?.sourceQuote).toBe('I earn 50k');
    // inferred is an "insight" moment, not neutral.
    expect(extraction?.tone).toBe('insight');
    expect(extraction?.detail).toMatch(/Inferred/);
    // 0.6 → canonical confidenceBand 'tentative' (moderate is now ≥0.65; matches the answer-panel chip).
    expect(extraction?.detail).toMatch(/tentative confidence/);
    // The extractor's own justification rides the separate rationale line.
    expect(extraction?.rationale).toBe('because');
  });

  it('surfaces the refiner rationale on a refinement step, with a source-phrase detail', () => {
    const steps = buildReasoningTrace(
      result({
        sideEffects: {
          answerUpserts: [],
          answerRefinements: [
            {
              slotKey: 'q1',
              action: 'refine',
              questionType: 'free_text',
              newValue: 'x',
              rationale: 'Earlier they rounded; the exact figure is 34.',
              source: 'contradiction',
              confidence: 0.8,
            },
          ],
        },
        assessment: assessment({ answeredCount: 1, coverage: 0.5 }),
      }),
      { questions: QUESTIONS }
    );
    const refinement = steps.find((s) => s.kind === 'refinement');
    expect(refinement?.detail).toMatch(/conflict with an earlier answer/);
    expect(refinement?.rationale).toBe('Earlier they rounded; the exact figure is 34.');
  });

  it('emits steps in pipeline order: extraction → contradiction → refinement → completion → selection', () => {
    const steps = buildReasoningTrace(
      result({
        sideEffects: {
          answerUpserts: [intent({ slotKey: 'q1' })],
          answerRefinements: [
            {
              slotKey: 'q1',
              action: 'refine',
              questionType: 'free_text',
              newValue: 'x',
              rationale: 'evolved',
              source: 'contradiction',
              confidence: 0.8,
            },
          ],
        },
        contradictions: [
          {
            slotKeys: ['q1', 'q2'],
            explanation: 'these conflict',
            severity: 'medium',
            confidence: 0.7,
          },
        ],
        assessment: assessment({ answeredCount: 1, coverage: 0.5 }),
      }),
      { questions: QUESTIONS }
    );

    expect(steps.map((s) => s.kind)).toEqual([
      'extraction',
      'contradiction',
      'refinement',
      'completion',
      'selection',
    ]);
  });

  it('uses data-slot fills in data-slot mode and skips provisional fills + background answers', () => {
    const steps = buildReasoningTrace(
      result({
        response: {
          kind: 'data_slot',
          dataSlotId: 'd2',
          dataSlotKey: 'budget',
          name: 'Budget',
          description: '...',
          theme: 'money',
          isReask: false,
          isTransition: false,
        },
        targetedQuestionId: null,
        selectionStrategy: undefined,
        selectionRationale: 'Staying with this topic to go a little deeper.',
        sideEffects: {
          answerUpserts: [intent({ slotKey: 'q1' })], // background — must NOT appear
          answerRefinements: [],
          dataSlotFills: [
            {
              dataSlotKey: 'timeline',
              value: 'soon',
              paraphrase: 'Wants to move quickly',
              confidence: 0.8,
              provenance: 'inferred',
            },
            {
              dataSlotKey: 'parked',
              value: null,
              paraphrase: 'tentative',
              confidence: 0.2,
              provenance: 'inferred',
              provisional: true, // parked — must NOT appear
            },
          ],
        },
      }),
      {
        questions: QUESTIONS,
        dataSlots: [
          {
            id: 'd1',
            key: 'timeline',
            name: 'Timeline',
            description: '',
            theme: 't',
            ordinal: 0,
            weight: 1,
          },
          {
            id: 'd2',
            key: 'budget',
            name: 'Budget',
            description: '',
            theme: 'money',
            ordinal: 1,
            weight: 1,
          },
          {
            id: 'd3',
            key: 'parked',
            name: 'Parked',
            description: '',
            theme: 'x',
            ordinal: 2,
            weight: 1,
          },
        ],
      }
    );

    const extraction = steps.filter((s) => s.kind === 'extraction');
    expect(extraction).toHaveLength(1);
    expect(extraction[0].label).toContain('Timeline');
    expect(extraction[0].detail).toBe('Wants to move quickly');
    // No question-label leak from the background upsert.
    expect(steps.some((s) => s.label.includes('Prompt for q1'))).toBe(false);

    const selection = steps.find((s) => s.kind === 'selection');
    expect(selection?.label).toContain('Budget');
    expect(selection?.detail).toBe('Staying with this topic to go a little deeper.');
  });

  it('phrases selection detail by strategy; adaptive uses the LLM rationale verbatim', () => {
    const seq = buildReasoningTrace(result({ selectionStrategy: 'sequential' }), {
      questions: QUESTIONS,
    });
    expect(seq.find((s) => s.kind === 'selection')?.detail).toMatch(/in order/);

    const adaptive = buildReasoningTrace(
      result({
        selectionStrategy: 'adaptive',
        selectionRationale: 'Your budget answer opens a financing question.',
      }),
      { questions: QUESTIONS }
    );
    expect(adaptive.find((s) => s.kind === 'selection')?.detail).toBe(
      'Your budget answer opens a financing question.'
    );
  });

  it('warms the opening turn and omits the completion step when nothing is answered yet', () => {
    const steps = buildReasoningTrace(result({ assessment: assessment({ answeredCount: 0 }) }), {
      questions: QUESTIONS,
      isOpening: true,
    });
    expect(steps.map((s) => s.kind)).toEqual(['selection']);
    expect(steps[0].label).toMatch(/Let's start with/);
  });

  it('shows a completion "have what we need" step on an offer turn', () => {
    const steps = buildReasoningTrace(
      result({
        response: { kind: 'offer', input: {} as never },
        targetedQuestionId: null,
        assessment: assessment({ kind: 'offer', coverage: 1, answeredCount: 4, unmet: [] }),
      }),
      { questions: QUESTIONS }
    );
    const completion = steps.find((s) => s.kind === 'completion');
    expect(completion?.label).toMatch(/have what we need/);
    expect(completion?.detail).toMatch(/100% covered/);
    // An offer turn selected nothing — no selection step.
    expect(steps.some((s) => s.kind === 'selection')).toBe(false);
  });

  it('returns no trace at all on an abuse-abandoned turn', () => {
    const steps = buildReasoningTrace(
      result({
        response: { kind: 'complete', text: 'bye' },
        targetedQuestionId: null,
        abuse: { flagged: true, newStrikeCount: 4, abandon: true, reason: 'abuse' },
      }),
      { questions: QUESTIONS }
    );
    expect(steps).toEqual([]);
  });

  it('never surfaces a sensitivity disclosure summary', () => {
    const steps = buildReasoningTrace(
      result({
        sideEffects: { answerUpserts: [intent({ slotKey: 'q1' })], answerRefinements: [] },
        assessment: assessment({ answeredCount: 1 }),
        sensitivity: {
          detected: true,
          severity: 'high',
          category: 'self-harm',
          summary: 'SECRET PII DISCLOSURE',
          newLevel: 'high',
          signpost: true,
        },
      }),
      { questions: QUESTIONS }
    );
    const blob = JSON.stringify(steps);
    expect(blob).not.toContain('SECRET PII DISCLOSURE');
    expect(blob).not.toContain('self-harm');
  });

  // ---------------------------------------------------------------------------
  // Provenance phrase variants (lines 49-65 in source)
  // ---------------------------------------------------------------------------

  it('uses "Directly from what you said" phrasing and neutral tone for direct provenance', () => {
    const steps = buildReasoningTrace(
      result({
        sideEffects: {
          answerUpserts: [intent({ slotKey: 'q1', provenance: 'direct', confidence: 0.9 })],
          answerRefinements: [],
        },
        assessment: assessment({ answeredCount: 1 }),
      }),
      { questions: QUESTIONS }
    );
    const extraction = steps.find((s) => s.kind === 'extraction');
    expect(extraction?.detail).toMatch(/Directly from what you said/);
    expect(extraction?.tone).toBe('neutral');
  });

  it('uses "Pieced together" phrasing and insight tone for synthesised provenance', () => {
    const steps = buildReasoningTrace(
      result({
        sideEffects: {
          answerUpserts: [intent({ slotKey: 'q1', provenance: 'synthesised', confidence: 0.85 })],
          answerRefinements: [],
        },
        assessment: assessment({ answeredCount: 1 }),
      }),
      { questions: QUESTIONS }
    );
    const extraction = steps.find((s) => s.kind === 'extraction');
    expect(extraction?.detail).toMatch(/Pieced together from the conversation/);
    expect(extraction?.tone).toBe('insight');
  });

  it('uses "Updated from later context" phrasing and insight tone for refined provenance', () => {
    const steps = buildReasoningTrace(
      result({
        sideEffects: {
          answerUpserts: [intent({ slotKey: 'q1', provenance: 'refined', confidence: 0.75 })],
          answerRefinements: [],
        },
        assessment: assessment({ answeredCount: 1 }),
      }),
      { questions: QUESTIONS }
    );
    const extraction = steps.find((s) => s.kind === 'extraction');
    expect(extraction?.detail).toMatch(/Updated from later context/);
    expect(extraction?.tone).toBe('insight');
  });

  // Confidence words come from the canonical confidenceBand (high ≥0.85, moderate ≥0.65,
  // tentative ≥0.45, low <0.45), so the trace detail agrees with the answer-panel chip — no
  // per-surface threshold drift.
  it.each([
    ['high', 0.85],
    ['moderate', 0.84],
    ['moderate', 0.65],
    ['tentative', 0.64],
    ['tentative', 0.45],
    ['low', 0.44],
    ['low', 0.3],
  ])(
    'labels confidence as "%s confidence" at %d (canonical band thresholds)',
    (word, confidence) => {
      const steps = buildReasoningTrace(
        result({
          sideEffects: {
            answerUpserts: [intent({ slotKey: 'q1', provenance: 'direct', confidence })],
            answerRefinements: [],
          },
          assessment: assessment({ answeredCount: 1 }),
        }),
        { questions: QUESTIONS }
      );
      expect(steps.find((s) => s.kind === 'extraction')?.detail).toMatch(
        new RegExp(`${word} confidence`)
      );
    }
  );

  // ---------------------------------------------------------------------------
  // Refinement source phrase variants (lines 69-80 in source)
  // ---------------------------------------------------------------------------

  it('phrases a clarification refinement correctly', () => {
    const steps = buildReasoningTrace(
      result({
        sideEffects: {
          answerUpserts: [],
          answerRefinements: [
            {
              slotKey: 'q1',
              action: 'refine',
              questionType: 'free_text',
              newValue: 'x',
              rationale: '  ', // whitespace-only — cleanRationale returns undefined
              source: 'clarification',
              confidence: 0.7,
            },
          ],
        },
        assessment: assessment({ answeredCount: 1 }),
      }),
      { questions: QUESTIONS }
    );
    const refinement = steps.find((s) => s.kind === 'refinement');
    expect(refinement?.detail).toBe('Clarified from later context');
    // No rationale was provided — the field should be absent.
    expect(refinement?.rationale).toBeUndefined();
  });

  it('phrases a correction refinement correctly', () => {
    const steps = buildReasoningTrace(
      result({
        sideEffects: {
          answerUpserts: [],
          answerRefinements: [
            {
              slotKey: 'q2',
              action: 'refine',
              questionType: 'free_text',
              newValue: 'y',
              rationale: 'Typo in original capture.',
              source: 'correction',
              confidence: 0.9,
            },
          ],
        },
        assessment: assessment({ answeredCount: 1 }),
      }),
      { questions: QUESTIONS }
    );
    const refinement = steps.find((s) => s.kind === 'refinement');
    expect(refinement?.detail).toBe('Corrected an earlier capture');
    expect(refinement?.rationale).toBe('Typo in original capture.');
  });

  it('phrases a manual refinement correctly', () => {
    const steps = buildReasoningTrace(
      result({
        sideEffects: {
          answerUpserts: [],
          answerRefinements: [
            {
              slotKey: 'q1',
              action: 'refine',
              questionType: 'free_text',
              newValue: 'z',
              rationale: '  ',
              source: 'manual',
              confidence: 1,
            },
          ],
        },
        assessment: assessment({ answeredCount: 1 }),
      }),
      { questions: QUESTIONS }
    );
    const refinement = steps.find((s) => s.kind === 'refinement');
    expect(refinement?.detail).toBe('You edited this directly');
    // Whitespace-only rationale should not appear.
    expect(refinement?.rationale).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Selection strategy variants — random and weighted (lines 98-100 in source)
  // ---------------------------------------------------------------------------

  it('phrases random strategy selection detail', () => {
    const steps = buildReasoningTrace(result({ selectionStrategy: 'random' }), {
      questions: QUESTIONS,
    });
    const selection = steps.find((s) => s.kind === 'selection');
    expect(selection?.detail).toMatch(/varied/);
  });

  it('phrases weighted strategy selection detail', () => {
    const steps = buildReasoningTrace(result({ selectionStrategy: 'weighted' }), {
      questions: QUESTIONS,
    });
    const selection = steps.find((s) => s.kind === 'selection');
    expect(selection?.detail).toMatch(/matter most/);
  });

  it('uses adaptive fallback phrasing when adaptive strategy has no rationale', () => {
    const steps = buildReasoningTrace(
      result({ selectionStrategy: 'adaptive', selectionRationale: undefined }),
      { questions: QUESTIONS }
    );
    const selection = steps.find((s) => s.kind === 'selection');
    expect(selection?.detail).toMatch(/most naturally/);
  });

  // ---------------------------------------------------------------------------
  // response.kind === 'none' — end-of-questions selection step (line 233 in source)
  // ---------------------------------------------------------------------------

  it('emits an end-of-questions selection step on a "none" response', () => {
    const steps = buildReasoningTrace(
      result({
        response: { kind: 'none', text: 'All done!' },
        targetedQuestionId: null,
        assessment: assessment({ answeredCount: 3, coverage: 0.9 }),
      }),
      { questions: QUESTIONS }
    );
    const selection = steps.find((s) => s.kind === 'selection');
    expect(selection?.label).toBe("We've reached the end of the questions");
    expect(selection?.tone).toBe('neutral');
    // A "none" selection carries no routing detail.
    expect(selection?.detail).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // completion step — blocked_on_required label (line 199-205 in source)
  // ---------------------------------------------------------------------------

  it('labels completion as "required questions still to go" when blocked_on_required', () => {
    const steps = buildReasoningTrace(
      result({
        assessment: assessment({
          kind: 'blocked_on_required',
          answeredCount: 2,
          coverage: 0.4,
          requiredUnansweredKeys: ['q2'],
          unmet: [],
        }),
      }),
      { questions: QUESTIONS }
    );
    const completion = steps.find((s) => s.kind === 'completion');
    expect(completion?.label).toMatch(/required questions/);
    expect(completion?.detail).toMatch(/40% covered so far/);
    expect(completion?.tone).toBe('neutral');
  });

  // ---------------------------------------------------------------------------
  // Data-slot fill with no rationale — rationale field should be absent
  // ---------------------------------------------------------------------------

  it('omits rationale from a data-slot extraction step when fill has no rationale', () => {
    const steps = buildReasoningTrace(
      result({
        response: {
          kind: 'data_slot',
          dataSlotId: 'd1',
          dataSlotKey: 'timeline',
          name: 'Timeline',
          description: '',
          theme: 't',
          isReask: false,
          isTransition: false,
        },
        targetedQuestionId: null,
        selectionStrategy: undefined,
        sideEffects: {
          answerUpserts: [],
          answerRefinements: [],
          dataSlotFills: [
            {
              dataSlotKey: 'timeline',
              value: 'soon',
              paraphrase: 'Wants to move quickly',
              confidence: 0.8,
              provenance: 'direct',
              // no rationale field
            },
          ],
        },
      }),
      {
        questions: QUESTIONS,
        dataSlots: [
          {
            id: 'd1',
            key: 'timeline',
            name: 'Timeline',
            description: '',
            theme: 't',
            ordinal: 0,
            weight: 1,
          },
        ],
      }
    );
    const extraction = steps.find((s) => s.kind === 'extraction');
    expect(extraction?.label).toContain('Timeline');
    expect(extraction?.rationale).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Data-slot fill with empty paraphrase — detail field should be absent
  // ---------------------------------------------------------------------------

  it('omits detail from a data-slot extraction step when paraphrase is blank', () => {
    const steps = buildReasoningTrace(
      result({
        response: {
          kind: 'data_slot',
          dataSlotId: 'd1',
          dataSlotKey: 'timeline',
          name: 'Timeline',
          description: '',
          theme: 't',
          isReask: false,
          isTransition: false,
        },
        targetedQuestionId: null,
        selectionStrategy: undefined,
        sideEffects: {
          answerUpserts: [],
          answerRefinements: [],
          dataSlotFills: [
            {
              dataSlotKey: 'timeline',
              value: 'soon',
              paraphrase: '   ', // blank — should not appear as detail
              confidence: 0.7,
              provenance: 'direct',
            },
          ],
        },
      }),
      {
        questions: QUESTIONS,
        dataSlots: [
          {
            id: 'd1',
            key: 'timeline',
            name: 'Timeline',
            description: '',
            theme: 't',
            ordinal: 0,
            weight: 1,
          },
        ],
      }
    );
    const extraction = steps.find((s) => s.kind === 'extraction');
    expect(extraction).toBeDefined();
    expect(extraction?.detail).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Data-slot fill — resolves the slot name from the dataSlots list, with an
  // "a detail" fallback when the fill's key isn't among the configured slots.
  // ---------------------------------------------------------------------------

  it('resolves the data-slot name when the fill key IS in the dataSlots list', () => {
    const steps = buildReasoningTrace(
      result({
        response: {
          kind: 'data_slot',
          dataSlotId: 'd9',
          dataSlotKey: 'unknown_slot',
          name: 'Unknown',
          description: '',
          theme: 'x',
          isReask: false,
          isTransition: false,
        },
        targetedQuestionId: null,
        selectionStrategy: undefined,
        sideEffects: {
          answerUpserts: [],
          answerRefinements: [],
          dataSlotFills: [
            {
              dataSlotKey: 'unknown_slot',
              value: 'v',
              paraphrase: 'some detail',
              confidence: 0.6,
              provenance: 'inferred',
            },
          ],
        },
      }),
      {
        questions: QUESTIONS,
        dataSlots: [
          {
            id: 'd9',
            key: 'unknown_slot',
            name: 'Unknown',
            description: '',
            theme: 'x',
            ordinal: 0,
            weight: 1,
          },
        ],
      }
    );
    const extraction = steps.find((s) => s.kind === 'extraction');
    expect(extraction?.label).toContain('Unknown');
  });

  it('falls back to "a detail" label when the fill key is absent from the dataSlots list', () => {
    // dataSlots is non-empty (so the extraction branch runs) but does NOT contain the fill's
    // key, so dataSlotNameByKey.get(...) misses and the `?? 'a detail'` fallback (L133) fires.
    const steps = buildReasoningTrace(
      result({
        response: {
          kind: 'data_slot',
          dataSlotId: 'd1',
          dataSlotKey: 'configured_slot',
          name: 'Configured',
          description: '',
          theme: 'x',
          isReask: false,
          isTransition: false,
        },
        targetedQuestionId: null,
        selectionStrategy: undefined,
        sideEffects: {
          answerUpserts: [],
          answerRefinements: [],
          dataSlotFills: [
            {
              dataSlotKey: 'orphan_slot', // not present in the dataSlots list below
              value: 'v',
              paraphrase: 'some detail',
              confidence: 0.6,
              provenance: 'inferred',
            },
          ],
        },
      }),
      {
        questions: QUESTIONS,
        dataSlots: [
          {
            id: 'd1',
            key: 'configured_slot',
            name: 'Configured',
            description: '',
            theme: 'x',
            ordinal: 0,
            weight: 1,
          },
        ],
      }
    );
    const extraction = steps.find((s) => s.kind === 'extraction');
    expect(extraction?.label).toContain('a detail');
  });

  // ---------------------------------------------------------------------------
  // Question label fallback — unknown slotKey resolves to 'your answer'
  // ---------------------------------------------------------------------------

  it('falls back to "your answer" when the slotKey is not in the questions list', () => {
    const steps = buildReasoningTrace(
      result({
        sideEffects: {
          answerUpserts: [
            intent({ slotKey: 'unknown_key', provenance: 'direct', confidence: 0.9 }),
          ],
          answerRefinements: [],
        },
        assessment: assessment({ answeredCount: 1 }),
      }),
      { questions: QUESTIONS }
    );
    const extraction = steps.find((s) => s.kind === 'extraction');
    expect(extraction?.label).toContain('your answer');
  });

  // ---------------------------------------------------------------------------
  // Opening turn — data_slot response uses "Let's start with" phrasing
  // ---------------------------------------------------------------------------

  it('uses "Let\'s start with" phrasing for data_slot response on opening turn', () => {
    const steps = buildReasoningTrace(
      result({
        response: {
          kind: 'data_slot',
          dataSlotId: 'd1',
          dataSlotKey: 'timeline',
          name: 'Timeline',
          description: '',
          theme: 't',
          isReask: false,
          isTransition: false,
        },
        targetedQuestionId: null,
        selectionStrategy: undefined,
        sideEffects: { answerUpserts: [], answerRefinements: [] },
        assessment: assessment({ answeredCount: 0 }),
      }),
      {
        questions: QUESTIONS,
        dataSlots: [
          {
            id: 'd1',
            key: 'timeline',
            name: 'Timeline',
            description: '',
            theme: 't',
            ordinal: 0,
            weight: 1,
          },
        ],
        isOpening: true,
      }
    );
    const selection = steps.find((s) => s.kind === 'selection');
    expect(selection?.label).toMatch(/Let's start with/);
    expect(selection?.label).toContain('Timeline');
  });

  // ---------------------------------------------------------------------------
  // Targeted question label — uses questionLabelById when targetedQuestionId is set
  // ---------------------------------------------------------------------------

  it('uses the targeted question label in the selection step when targetedQuestionId resolves', () => {
    const steps = buildReasoningTrace(
      result({
        response: { kind: 'question', questionId: 'q1', text: 'Prompt for q1' },
        targetedQuestionId: 'q1',
      }),
      { questions: QUESTIONS }
    );
    const selection = steps.find((s) => s.kind === 'selection');
    expect(selection?.label).toContain('Prompt for q1');
  });

  it('falls back to "the next question" label when targetedQuestionId is absent', () => {
    const steps = buildReasoningTrace(
      result({
        response: { kind: 'question', questionId: 'q2', text: 'Prompt for q2' },
        targetedQuestionId: null,
      }),
      { questions: QUESTIONS }
    );
    const selection = steps.find((s) => s.kind === 'selection');
    expect(selection?.label).toContain('the next question');
  });
});

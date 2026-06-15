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
    expect(extraction?.detail).toMatch(/medium confidence/);
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
});

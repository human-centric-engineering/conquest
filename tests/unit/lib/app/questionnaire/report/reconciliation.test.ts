/**
 * Unit test: open-vs-close reconciliation (C9 / G05).
 *
 * The feature exists because the report writer could not find the comparison unaided — the
 * transcript flattens the opening and closing answers into undifferentiated lines, and the scores
 * were never in the prompt at all. So these assert the two things that actually matter: that the
 * right statements are pulled out and kept attached to the questions that elicited them, and that
 * the prompt block instructs the writer to NAME a disagreement rather than smooth it.
 */

import { describe, it, expect } from 'vitest';

import {
  buildReconciliation,
  reconciliationRules,
  type BuildReconciliationParams,
} from '@/lib/app/questionnaire/report/reconciliation';
import type {
  PanelAnswerInput,
  PanelSectionInput,
} from '@/lib/app/questionnaire/panel/answer-panel';
import type { TopicPhase } from '@/lib/app/questionnaire/scope/types';

const sections: PanelSectionInput[] = [
  {
    sectionId: 's0',
    title: 'Opening',
    slots: [
      { slotKey: '0.2', prompt: 'What do you want to achieve?', type: 'free_text', required: true },
      { slotKey: '0.3', prompt: 'How urgent is it?', type: 'likert', required: false },
    ],
  },
  {
    sectionId: 's14',
    title: 'Data',
    slots: [{ slotKey: '14.1', prompt: 'We trust our numbers', type: 'likert', required: false }],
  },
  {
    sectionId: 's15',
    title: 'Close',
    slots: [
      {
        slotKey: '15.1',
        prompt: 'What would you like us to do?',
        type: 'free_text',
        required: true,
      },
    ],
  },
];

const answers: PanelAnswerInput[] = [
  {
    slotKey: '0.2',
    value: 'A predictable revenue engine',
    provenance: 'chat',
    confidence: 0.9,
    rationale: null,
    answeredAtTurnIndex: 1,
    refinementHistory: [],
  },
  {
    slotKey: '0.3',
    value: 4,
    provenance: 'form',
    confidence: null,
    rationale: null,
    answeredAtTurnIndex: 2,
    refinementHistory: [],
  },
  {
    slotKey: '14.1',
    value: 2,
    provenance: 'form',
    confidence: null,
    rationale: null,
    answeredAtTurnIndex: 3,
    refinementHistory: [],
  },
  {
    slotKey: '15.1',
    value: 'Fix our pipeline',
    provenance: 'chat',
    confidence: 0.8,
    rationale: null,
    answeredAtTurnIndex: 9,
    refinementHistory: [],
  },
];

const phases = new Map<string, TopicPhase>([
  ['0.2', 'opening'],
  ['0.3', 'opening'],
  ['14.1', 'conditional'],
  ['15.1', 'closing'],
]);

function params(over: Partial<BuildReconciliationParams> = {}): BuildReconciliationParams {
  return {
    statedGoalRefs: [],
    askedForRefs: [],
    sections,
    answers,
    dataSlots: [],
    phaseByQuestionKey: phases,
    phaseByDataSlotKey: new Map(),
    scores: null,
    scaleNames: new Map(),
    notAssessedLabels: [],
    ...over,
  };
}

describe('buildReconciliation', () => {
  it('pulls both ends from configured refs, keeping each answer with its question', () => {
    const out = buildReconciliation(params({ statedGoalRefs: ['0.2'], askedForRefs: ['15.1'] }));
    expect(out).not.toBeNull();
    expect(out?.statedGoal).toEqual([
      { prompt: 'What do you want to achieve?', text: 'A predictable revenue engine' },
    ]);
    expect(out?.askedForActions).toEqual([
      { prompt: 'What would you like us to do?', text: 'Fix our pipeline' },
    ]);
    expect(out?.goalSource).toBe('configured');
    expect(out?.askSource).toBe('configured');
  });

  it('derives from topic phases when no refs are configured', () => {
    const out = buildReconciliation(params());
    expect(out?.statedGoal).toHaveLength(1);
    expect(out?.statedGoal[0].text).toBe('A predictable revenue engine');
    expect(out?.goalSource).toBe('phase');
    expect(out?.askSource).toBe('phase');
  });

  it('derives free text only — a likert under an opening topic is a rating, not a stated goal', () => {
    const out = buildReconciliation(params());
    // 0.3 is a likert in the opening phase and answered. Quoting "4" as what they said they need
    // would be worse than saying nothing.
    expect(out?.statedGoal.map((s) => s.prompt)).not.toContain('How urgent is it?');
  });

  it('does NOT fall back to phases when a configured ref matched nothing', () => {
    // An admin who named a key meant that key. Silently substituting the whole opening phase would
    // produce a comparison they did not ask for and cannot see is wrong.
    const out = buildReconciliation(
      params({ statedGoalRefs: ['does_not_exist'], askedForRefs: ['15.1'] })
    );
    expect(out?.statedGoal).toEqual([]);
    expect(out?.goalSource).toBe('configured');
  });

  it('returns null when neither end produced anything', () => {
    expect(buildReconciliation(params({ answers: [], phaseByQuestionKey: new Map() }))).toBeNull();
  });

  it('survives one end being empty — a stated goal alone is still worth comparing', () => {
    const out = buildReconciliation(params({ statedGoalRefs: ['0.2'], askedForRefs: ['nope'] }));
    expect(out?.statedGoal).toHaveLength(1);
    expect(out?.askedForActions).toEqual([]);
  });

  it('reads a data slot by key', () => {
    const out = buildReconciliation(
      params({
        statedGoalRefs: ['primary_goal'],
        dataSlots: [{ key: 'primary_goal', name: 'Primary goal', value: 'Grow into enterprise' }],
      })
    );
    expect(out?.statedGoal).toEqual([{ prompt: 'Primary goal', text: 'Grow into enterprise' }]);
  });

  it("prefers the respondent's living paraphrase over the stored value", () => {
    // The paraphrase is what the panel showed them, so quoting anything else would have the report
    // arguing with a sentence they were told was theirs.
    const out = buildReconciliation(
      params({
        statedGoalRefs: ['0.2'],
        answers: [{ ...answers[0], paraphrase: 'You want revenue you can forecast' }],
      })
    );
    expect(out?.statedGoal[0].text).toBe('You want revenue you can forecast');
  });

  it('carries scores with their names, bands and partial flag', () => {
    const out = buildReconciliation(
      params({
        statedGoalRefs: ['0.2'],
        scores: {
          data: {
            raw: 2.1,
            normalised: null,
            band: 'Low',
            itemCount: 3,
            assessedItemCount: 3,
            totalItemCount: 8,
          },
        },
        scaleNames: new Map([['data', 'Data maturity']]),
      })
    );
    expect(out?.scored).toEqual([
      { name: 'Data maturity', raw: 2.1, band: 'Low', partiallyAssessed: true },
    ]);
  });

  it('has no scored leg when the version has no scoring schema', () => {
    const out = buildReconciliation(params({ statedGoalRefs: ['0.2'] }));
    expect(out?.scored).toEqual([]);
  });
});

describe('reconciliationRules', () => {
  const input = buildReconciliation(
    params({
      statedGoalRefs: ['0.2'],
      askedForRefs: ['15.1'],
      scores: {
        data: {
          raw: 2.1,
          normalised: null,
          band: 'Low',
          itemCount: 8,
          assessedItemCount: 8,
          totalItemCount: 8,
        },
      },
      scaleNames: new Map([['data', 'Data maturity']]),
    })
  );

  it('gives the writer all three views, each labelled', () => {
    const block = reconciliationRules(input!);
    expect(block).toContain('A predictable revenue engine');
    expect(block).toContain('Fix our pipeline');
    expect(block).toContain('Data maturity: 2.10 — Low');
  });

  it('tells the writer to name the disagreement rather than smooth it', () => {
    // The whole point. Every other rule in the writer's prompt pushes toward caution, and a writer
    // under that much restraint reconciles by finding agreement.
    const block = reconciliationRules(input!);
    expect(block).toContain('SAY SO PLAINLY');
  });

  it('forbids manufacturing a disagreement that is not there', () => {
    expect(reconciliationRules(input!)).toContain('Do NOT manufacture a disagreement');
  });

  it('forbids inventing a score when none was computed', () => {
    const noScores = buildReconciliation(params({ statedGoalRefs: ['0.2'] }));
    const block = reconciliationRules(noScores!);
    expect(block).toContain('Do NOT invent a score');
    expect(block).not.toContain('WHAT THE ASSESSMENT MEASURED');
  });

  it('warns that a partial scale is a weaker basis for contradicting the respondent', () => {
    const partial = buildReconciliation(
      params({
        statedGoalRefs: ['0.2'],
        scores: {
          data: {
            raw: 2.1,
            normalised: null,
            band: 'Low',
            itemCount: 3,
            assessedItemCount: 3,
            totalItemCount: 8,
          },
        },
        scaleNames: new Map([['data', 'Data maturity']]),
      })
    );
    const block = reconciliationRules(partial!);
    expect(block).toContain('PARTIAL');
    expect(block).toContain('must not lean on it to contradict');
  });

  it('stops an unassessed area being read as a bad result', () => {
    // The specific slip a comparison invites: an area with no score is not an area that scored
    // badly, and telling a respondent they did poorly on something nobody asked them about is the
    // worst thing this feature could produce.
    const withGaps = buildReconciliation(
      params({ statedGoalRefs: ['0.2'], notAssessedLabels: ['People & culture'] })
    );
    const block = reconciliationRules(withGaps!);
    expect(block).toContain('People & culture');
    expect(block).toContain('their absence is NOT a low');
  });
});

/**
 * questionSatisfactionFloor / unsatisfiedQuestions + the must-ask terminal block (P18 phase 2).
 *
 * The invariant under test is the safety one: **fidelity only ever RAISES the bar.** Turning the
 * feature on can never let a session complete on weaker evidence than it would have before, and
 * turning it off restores the previous behaviour exactly.
 *
 * @see lib/app/questionnaire/selection/context.ts
 */

import { describe, it, expect } from 'vitest';

import {
  questionSatisfactionFloor,
  selectableQuestions,
  terminalDecision,
  unsatisfiedQuestions,
} from '@/lib/app/questionnaire/selection/context';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import type { QuestionView, SelectionContext } from '@/lib/app/questionnaire/selection/types';

function question(over: Partial<QuestionView> = {}): QuestionView {
  return {
    id: 'q1',
    key: 'q_1',
    sectionId: 's1',
    sectionOrdinal: 0,
    ordinal: 0,
    weight: 1,
    required: false,
    type: 'free_text',
    tagIds: [],
    ...over,
  };
}

const GATE_ON = { enabled: true, defaultFidelity: 0.5 } as const;
const GATE_OFF = { enabled: false, defaultFidelity: 0.5 } as const;

function config(over: Partial<SelectionContext['config']> = {}): SelectionContext['config'] {
  return { ...DEFAULT_QUESTIONNAIRE_CONFIG, ...over };
}

function ctx(over: Partial<SelectionContext> = {}): SelectionContext {
  return {
    questions: [question()],
    answered: [],
    config: config(),
    round: 0,
    sessionId: 'sess-1',
    ...over,
  };
}

describe('questionSatisfactionFloor', () => {
  it('is the configured floor at free / loose / balanced', () => {
    const c = config({ answerConfidenceFloor: 0.5, questionFidelity: GATE_ON });
    for (const fidelity of [0, 0.25, 0.5]) {
      expect(questionSatisfactionFloor({ fidelity }, c)).toBe(0.5);
    }
  });

  it('raises the bar at close and must_ask', () => {
    const c = config({ answerConfidenceFloor: 0.5, questionFidelity: GATE_ON });
    expect(questionSatisfactionFloor({ fidelity: 0.75 }, c)).toBe(0.65);
    expect(questionSatisfactionFloor({ fidelity: 1 }, c)).toBe(0.85);
  });

  it('NEVER lowers the admin-configured floor', () => {
    // The safety invariant. An admin who set a strict 0.9 floor must not have it undercut by a
    // question marked `free` — fidelity is about how to ask, not about accepting weaker evidence.
    const c = config({ answerConfidenceFloor: 0.9, questionFidelity: GATE_ON });
    for (const fidelity of [0, 0.25, 0.5, 0.75, 1]) {
      expect(questionSatisfactionFloor({ fidelity }, c)).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('ignores the stored dial entirely while the gate is off', () => {
    const c = config({ answerConfidenceFloor: 0.5, questionFidelity: GATE_OFF });
    for (const fidelity of [0, 0.25, 0.5, 0.75, 1]) {
      expect(questionSatisfactionFloor({ fidelity }, c)).toBe(0.5);
    }
  });

  it('treats an absent dial as the neutral midpoint', () => {
    const c = config({ answerConfidenceFloor: 0.4, questionFidelity: GATE_ON });
    expect(questionSatisfactionFloor({}, c)).toBe(0.4);
  });
});

describe('unsatisfiedQuestions', () => {
  const c = config({ answerConfidenceFloor: 0.5, questionFidelity: GATE_ON });

  it('includes a never-answered question', () => {
    expect(unsatisfiedQuestions(ctx({ config: c })).map((q) => q.id)).toEqual(['q1']);
  });

  it('includes a must-ask question answered only below its raised bar', () => {
    // 0.75 clears the ordinary 0.5 floor but not must-ask's 0.85 — this is the tangential-inference
    // case the feature exists to catch. Note 0.75 is also the opportunistic typed cap, so a
    // background fill lands exactly here and must still be re-asked.
    const state = ctx({
      questions: [question({ fidelity: 1 })],
      answered: [{ questionId: 'q1', confidence: 0.75 }],
      config: c,
    });
    expect(unsatisfiedQuestions(state).map((q) => q.id)).toEqual(['q1']);
  });

  it('excludes a must-ask question already filled at high confidence', () => {
    // "…unless it has already been filled tangentially with HIGH confidence."
    const state = ctx({
      questions: [question({ fidelity: 1 })],
      answered: [{ questionId: 'q1', confidence: 0.9 }],
      config: c,
    });
    expect(unsatisfiedQuestions(state)).toEqual([]);
  });

  it('treats an unscored answer as authoritative', () => {
    // A respondent's own edit is never a guess, whatever the question's fidelity.
    const state = ctx({
      questions: [question({ fidelity: 1 })],
      answered: [{ questionId: 'q1', confidence: null }],
      config: c,
    });
    expect(unsatisfiedQuestions(state)).toEqual([]);
  });

  it('takes the BEST confidence when a question has several answer rows', () => {
    // A later corroborating row must never make an already-satisfied question look unsatisfied.
    const state = ctx({
      questions: [question({ fidelity: 1 })],
      answered: [
        { questionId: 'q1', confidence: 0.9 },
        { questionId: 'q1', confidence: 0.3 },
      ],
      config: c,
    });
    expect(unsatisfiedQuestions(state)).toEqual([]);
  });
});

describe('terminalDecision — the must-ask block', () => {
  // Thresholds that a single answered question already satisfies, so only the must-ask rule can
  // hold the session open.
  const base = config({
    answerConfidenceFloor: 0.5,
    coverageThreshold: 0.5,
    minQuestionsAnswered: 1,
    questionFidelity: GATE_ON,
  });

  it('holds the session open while a must-ask question sits below its bar', () => {
    const state = ctx({
      questions: [question({ fidelity: 1 }), question({ id: 'q2', key: 'q_2', ordinal: 1 })],
      answered: [
        { questionId: 'q1', confidence: 0.6 },
        { questionId: 'q2', confidence: 0.9 },
      ],
      config: base,
    });
    // Not `complete`, and not the terminal `none` either — there is still something to do: re-ask it.
    expect(terminalDecision(state)).toBeNull();
  });

  it('completes once the must-ask question clears its bar', () => {
    const state = ctx({
      questions: [question({ fidelity: 1 })],
      answered: [{ questionId: 'q1', confidence: 0.9 }],
      config: base,
    });
    expect(terminalDecision(state)?.kind).toBe('complete');
  });

  it('lets the per-session cap win over an outstanding must-ask', () => {
    // The cap is the explicit "stop here" and must stay the backstop against a question that can
    // never be satisfied — otherwise a vague respondent could never finish.
    const state = ctx({
      questions: [question({ fidelity: 1 })],
      answered: [{ questionId: 'q1', confidence: 0.3 }],
      config: config({ ...base, maxQuestionsPerSession: 1 }),
    });
    const decision = terminalDecision(state);
    expect(decision?.kind).toBe('complete');
    expect(decision?.rationale).toMatch(/cap/i);
  });

  it('does not hold the session open when the gate is off', () => {
    // The no-op guarantee at the terminal layer: same data, gate off, previous behaviour.
    const state = ctx({
      questions: [question({ fidelity: 1 })],
      answered: [{ questionId: 'q1', confidence: 0.6 }],
      config: config({ ...base, questionFidelity: GATE_OFF }),
    });
    expect(terminalDecision(state)?.kind).toBe('complete');
  });

  it('does not hold the session open for a close (non-must-ask) question below its bar', () => {
    // `close` raises the completion floor but is not a "you must be asked this" guarantee, so it
    // must not block the terminal decision.
    const state = ctx({
      questions: [question({ fidelity: 0.75 })],
      answered: [{ questionId: 'q1', confidence: 0.6 }],
      config: base,
    });
    expect(terminalDecision(state)?.kind).toBe('complete');
  });
});

describe('selectableQuestions — the pool/terminal invariant', () => {
  const base = config({
    answerConfidenceFloor: 0.5,
    coverageThreshold: 0.5,
    minQuestionsAnswered: 1,
    questionFidelity: GATE_ON,
  });

  it('re-admits a must-ask question answered below its bar', () => {
    // Without this the guarantee is empty: the question has an answer row, so the ordinary pool
    // drops it and no strategy could ever re-target it, however long terminalDecision held on.
    const state = ctx({
      questions: [question({ fidelity: 1 })],
      answered: [{ questionId: 'q1', confidence: 0.6 }],
      config: base,
    });
    expect(selectableQuestions(state).map((q) => q.id)).toEqual(['q1']);
  });

  it('does NOT re-admit a close question below its bar', () => {
    // `close` raises the completion floor but promises nothing about being asked; re-targeting it
    // could loop on a question the respondent has already answered as well as they are going to.
    const state = ctx({
      questions: [question({ fidelity: 0.75 })],
      answered: [{ questionId: 'q1', confidence: 0.5 }],
      config: base,
    });
    expect(selectableQuestions(state)).toEqual([]);
  });

  it('does not duplicate a never-answered must-ask question', () => {
    const state = ctx({ questions: [question({ fidelity: 1 })], answered: [], config: base });
    expect(selectableQuestions(state).map((q) => q.id)).toEqual(['q1']);
  });

  it('keeps document order when a re-admitted question is mixed in', () => {
    const state = ctx({
      questions: [
        question({ id: 'q1', key: 'q_1', ordinal: 0, fidelity: 1 }),
        question({ id: 'q2', key: 'q_2', ordinal: 1 }),
        question({ id: 'q3', key: 'q_3', ordinal: 2 }),
      ],
      answered: [{ questionId: 'q1', confidence: 0.6 }],
      config: base,
    });
    expect(selectableQuestions(state).map((q) => q.id)).toEqual(['q1', 'q2', 'q3']);
  });

  it('THE INVARIANT: terminalDecision returns null only when the pool is non-empty', () => {
    // Every strategy dereferences pool[0] on the strength of this. A disagreement between the two
    // is a crash in a live respondent turn, not a wrong answer — so assert it across the matrix of
    // states that can produce one.
    const cases: Array<{ fidelity: number; confidence: number | null }> = [];
    for (const fidelity of [0, 0.5, 0.75, 1]) {
      for (const confidence of [null, 0.3, 0.6, 0.9]) cases.push({ fidelity, confidence });
    }
    for (const { fidelity, confidence } of cases) {
      const state = ctx({
        questions: [question({ fidelity })],
        answered: [{ questionId: 'q1', confidence }],
        config: base,
      });
      if (terminalDecision(state) === null) {
        expect(selectableQuestions(state).length).toBeGreaterThan(0);
      }
    }
  });
});

import { describe, expect, it } from 'vitest';

import { assessCompletion, resolveCompletion } from '@/lib/app/questionnaire/completion';
import type { CompletionAssessment } from '@/lib/app/questionnaire/completion/types';
import { cctx, q } from '@/tests/unit/lib/app/questionnaire/completion/_fixtures';

describe('assessCompletion', () => {
  it('offers when coverage and min-answered thresholds are both met', () => {
    const c = cctx({
      questions: [q({ id: 'a' }), q({ id: 'b' })],
      answered: [
        { questionId: 'a', confidence: null },
        { questionId: 'b', confidence: null },
      ],
      // coverageThreshold defaults to 1; both answered → full coverage.
      config: { minQuestionsAnswered: 2 },
    });
    const a = assessCompletion(c);
    expect(a.kind).toBe('offer');
    expect(a.unmet).toEqual([]);
    expect(a.coverage).toBeCloseTo(1);
    expect(a.answeredCount).toBe(2);
    expect(a.capReached).toBe(false);
  });

  it('does not count a below-floor (tentative) answer toward coverage', () => {
    const c = cctx({
      questions: [q({ id: 'a' }), q({ id: 'b' })],
      answered: [
        { questionId: 'a', confidence: null }, // authoritative → counts
        { questionId: 'b', confidence: 0.45 }, // opportunistic guess below the 0.5 floor → ignored
      ],
      config: { coverageThreshold: 1, minQuestionsAnswered: 0, answerConfidenceFloor: 0.5 },
    });
    const a = assessCompletion(c);
    expect(a.kind).toBe('not_ready');
    expect(a.unmet).toContain('coverage_below_threshold');
    expect(a.answeredCount).toBe(1); // only the confirmed answer counts
  });

  it('counts the same answer once it is corroborated above the floor', () => {
    const c = cctx({
      questions: [q({ id: 'a' }), q({ id: 'b' })],
      answered: [
        { questionId: 'a', confidence: null },
        { questionId: 'b', confidence: 0.62 }, // strengthened past the floor → now counts
      ],
      config: { coverageThreshold: 1, minQuestionsAnswered: 2, answerConfidenceFloor: 0.5 },
    });
    const a = assessCompletion(c);
    expect(a.kind).toBe('offer');
    expect(a.answeredCount).toBe(2);
  });

  it('does not let a below-floor answer satisfy a required question', () => {
    const c = cctx({
      questions: [q({ id: 'req', key: 'req', required: true })],
      answered: [{ questionId: 'req', confidence: 0.4 }], // tentative guess on a required slot
      config: { coverageThreshold: 0, minQuestionsAnswered: 0, answerConfidenceFloor: 0.5 },
    });
    const a = assessCompletion(c);
    expect(a.kind).toBe('blocked_on_required');
    expect(a.requiredUnansweredKeys).toEqual(['req']);
  });

  it('floor of 0 disables gating (a low-confidence answer still counts)', () => {
    const c = cctx({
      questions: [q({ id: 'a' })],
      answered: [{ questionId: 'a', confidence: 0.1 }],
      config: { coverageThreshold: 1, minQuestionsAnswered: 1, answerConfidenceFloor: 0 },
    });
    const a = assessCompletion(c);
    expect(a.kind).toBe('offer');
    expect(a.answeredCount).toBe(1);
  });

  it('counts an answer whose confidence equals the floor (inclusive >= boundary)', () => {
    // The filter is `(a.confidence ?? 1) >= floor` — equality must pass, not be excluded.
    // A required question answered at exactly the floor must count as confirmed, satisfying
    // the required gate and contributing to coverage so the session can offer.
    const c = cctx({
      questions: [q({ id: 'req', key: 'req', required: true })],
      answered: [{ questionId: 'req', confidence: 0.5 }], // exactly at the floor
      config: { coverageThreshold: 1, minQuestionsAnswered: 1, answerConfidenceFloor: 0.5 },
    });
    const a = assessCompletion(c);
    expect(a.kind).toBe('offer');
    expect(a.requiredUnansweredKeys).toEqual([]);
    expect(a.answeredCount).toBe(1);
  });

  it('is not_ready with coverage_below_threshold when coverage is short', () => {
    const c = cctx({
      questions: [q({ id: 'a', weight: 1 }), q({ id: 'b', weight: 1 })],
      answered: [{ questionId: 'a', confidence: null }], // 50% coverage
      config: { coverageThreshold: 1, minQuestionsAnswered: 0 },
    });
    const a = assessCompletion(c);
    expect(a.kind).toBe('not_ready');
    expect(a.unmet).toContain('coverage_below_threshold');
    expect(a.unmet).not.toContain('below_min_answered');
  });

  it('is not_ready with below_min_answered when the count is short', () => {
    const c = cctx({
      // Zero-weight questions → coverage falls back to count ratio; 1 of 1 answered
      // gives full coverage, so only the min-answered floor is unmet.
      questions: [q({ id: 'a', weight: 0 })],
      answered: [{ questionId: 'a', confidence: null }],
      config: { coverageThreshold: 0, minQuestionsAnswered: 5 },
    });
    const a = assessCompletion(c);
    expect(a.kind).toBe('not_ready');
    expect(a.unmet).toEqual(['below_min_answered']);
  });

  it('blocks on a required question even when weighted coverage already meets the threshold', () => {
    // The headline gate `terminalDecision` lacks: a low-weight required slot is
    // unanswered, but the high-weight optional slot alone clears the coverage bar.
    const c = cctx({
      questions: [
        q({ id: 'big', key: 'big', weight: 100, required: false }),
        q({ id: 'req', key: 'req', weight: 1, required: true }),
      ],
      answered: [{ questionId: 'big', confidence: null }], // ~99% weighted coverage
      config: { coverageThreshold: 0.9, minQuestionsAnswered: 0 },
    });
    const a = assessCompletion(c);
    expect(a.coverage).toBeGreaterThan(0.9); // coverage alone would offer
    expect(a.kind).toBe('blocked_on_required');
    expect(a.unmet).toEqual(['required_unanswered']);
    expect(a.requiredUnansweredKeys).toEqual(['req']);
  });

  it('offers once the required question is answered', () => {
    const c = cctx({
      questions: [
        q({ id: 'big', key: 'big', weight: 100, required: false }),
        q({ id: 'req', key: 'req', weight: 1, required: true }),
      ],
      answered: [
        { questionId: 'big', confidence: null },
        { questionId: 'req', confidence: null },
      ],
      config: { coverageThreshold: 0.9, minQuestionsAnswered: 0 },
    });
    expect(assessCompletion(c).kind).toBe('offer');
  });

  it('offers when the per-session cap is reached, even with coverage and required unmet', () => {
    const c = cctx({
      questions: [
        q({ id: 'a', key: 'a', required: true }),
        q({ id: 'b', key: 'b', required: true }),
        q({ id: 'c', key: 'c', required: true }),
      ],
      answered: [{ questionId: 'a', confidence: null }],
      config: { maxQuestionsPerSession: 1, coverageThreshold: 1, minQuestionsAnswered: 3 },
    });
    const a = assessCompletion(c);
    expect(a.kind).toBe('offer');
    expect(a.capReached).toBe(true);
    expect(a.unmet).toEqual([]);
  });

  it('offers for an empty version (trivially fully covered)', () => {
    const a = assessCompletion(cctx({ questions: [] }));
    expect(a.kind).toBe('offer');
    expect(a.coverage).toBe(1);
  });

  it('treats a fully-answered weighted version at the epsilon boundary as offer', () => {
    // Fractional weights that sum-compare just under 1 must still clear a threshold of 1.
    const c = cctx({
      questions: [
        q({ id: 'a', weight: 0.1 }),
        q({ id: 'b', weight: 0.2 }),
        q({ id: 'c', weight: 0.7 }),
      ],
      answered: [
        { questionId: 'a', confidence: null },
        { questionId: 'b', confidence: null },
        { questionId: 'c', confidence: null },
      ],
      config: { coverageThreshold: 1, minQuestionsAnswered: 0 },
    });
    expect(assessCompletion(c).kind).toBe('offer');
  });
});

describe('assessCompletion — early finish (escape hatch)', () => {
  // Four equal-weight questions, two answered → 50% coverage, answeredCount 2.
  const fourQ = [q({ id: 'a' }), q({ id: 'b' }), q({ id: 'c' }), q({ id: 'd' })];
  const twoAnswered = [
    { questionId: 'a', confidence: null },
    { questionId: 'b', confidence: null },
  ];

  it('is unavailable when the feature is off, however much is covered', () => {
    const a = assessCompletion(
      cctx({
        questions: fourQ,
        answered: twoAnswered,
        config: { allowEarlyFinish: false, earlyFinishMinCoverage: 0, earlyFinishMinQuestions: 0 },
      })
    );
    expect(a.earlyFinishAvailable).toBe(false);
  });

  it('is available from the start when both minimums are 0', () => {
    const a = assessCompletion(
      cctx({
        questions: fourQ,
        answered: [],
        config: { allowEarlyFinish: true, earlyFinishMinCoverage: 0, earlyFinishMinQuestions: 0 },
      })
    );
    expect(a.earlyFinishAvailable).toBe(true);
  });

  it('gates on the coverage bar alone (questions bar 0 is not a criterion)', () => {
    const base = {
      allowEarlyFinish: true,
      earlyFinishMinCoverage: 0.5,
      earlyFinishMinQuestions: 0,
    };
    const below = assessCompletion(
      cctx({ questions: fourQ, answered: [{ questionId: 'a', confidence: null }], config: base })
    );
    expect(below.coverage).toBeCloseTo(0.25);
    expect(below.earlyFinishAvailable).toBe(false);

    const met = assessCompletion(cctx({ questions: fourQ, answered: twoAnswered, config: base }));
    expect(met.coverage).toBeCloseTo(0.5);
    expect(met.earlyFinishAvailable).toBe(true);
  });

  it('gates on the questions bar alone (coverage bar 0 is not a criterion)', () => {
    const base = { allowEarlyFinish: true, earlyFinishMinCoverage: 0, earlyFinishMinQuestions: 2 };
    const below = assessCompletion(
      cctx({ questions: fourQ, answered: [{ questionId: 'a', confidence: null }], config: base })
    );
    expect(below.earlyFinishAvailable).toBe(false);

    const met = assessCompletion(cctx({ questions: fourQ, answered: twoAnswered, config: base }));
    expect(met.answeredCount).toBe(2);
    expect(met.earlyFinishAvailable).toBe(true);
  });

  it('ORs the two bars — meeting EITHER unlocks', () => {
    // Coverage bar 0.9 is unmet at 50%, but the questions bar (2) is met → available.
    const a = assessCompletion(
      cctx({
        questions: fourQ,
        answered: twoAnswered,
        config: { allowEarlyFinish: true, earlyFinishMinCoverage: 0.9, earlyFinishMinQuestions: 2 },
      })
    );
    expect(a.coverage).toBeCloseTo(0.5);
    expect(a.earlyFinishAvailable).toBe(true);
  });

  it('bypasses the required-question gate (available even while blocked_on_required)', () => {
    const a = assessCompletion(
      cctx({
        questions: [
          q({ id: 'a' }),
          q({ id: 'b' }),
          q({ id: 'c' }),
          q({ id: 'req', required: true }),
        ],
        answered: twoAnswered,
        config: { allowEarlyFinish: true, earlyFinishMinCoverage: 0, earlyFinishMinQuestions: 2 },
      })
    );
    // The required slot is still open, so the agent's own gate blocks its offer…
    expect(a.kind).toBe('blocked_on_required');
    expect(a.requiredUnansweredKeys).toContain('req');
    // …but the respondent's escape hatch is independent and unlocked.
    expect(a.earlyFinishAvailable).toBe(true);
  });
});

describe('resolveCompletion', () => {
  const offer: CompletionAssessment = {
    kind: 'offer',
    unmet: [],
    rationale: 'ready',
    coverage: 1,
    answeredCount: 3,
    requiredUnansweredKeys: [],
    capReached: false,
    earlyFinishAvailable: false,
  };
  const blocked: CompletionAssessment = {
    ...offer,
    kind: 'blocked_on_required',
    unmet: ['required_unanswered'],
    requiredUnansweredKeys: ['req'],
    rationale: 'blocked',
  };

  it('continues on hold regardless of the sweep', () => {
    const r = resolveCompletion('hold', offer, { run: true, contradictionCount: 2 });
    expect(r.kind).toBe('continue');
  });

  it('submits on accept when the sweep did not run', () => {
    const r = resolveCompletion('accept', offer, { run: false, contradictionCount: 0 });
    expect(r.kind).toBe('submit');
  });

  it('submits on accept when the sweep ran clean', () => {
    const r = resolveCompletion('accept', offer, { run: true, contradictionCount: 0 });
    expect(r.kind).toBe('submit');
  });

  it('holds for review on accept when the sweep found contradictions', () => {
    const r = resolveCompletion('accept', offer, { run: true, contradictionCount: 3 });
    expect(r.kind).toBe('hold_for_review');
    if (r.kind === 'hold_for_review') expect(r.contradictionCount).toBe(3);
  });

  it('refuses to submit on accept when the assessment is not an offer', () => {
    const r = resolveCompletion('accept', blocked, { run: false, contradictionCount: 0 });
    expect(r.kind).toBe('continue');
  });

  it('submits on finish_early when the escape hatch is available — even while blocked', () => {
    const r = resolveCompletion(
      'finish_early',
      { ...blocked, earlyFinishAvailable: true },
      { run: false, contradictionCount: 0 }
    );
    expect(r.kind).toBe('submit');
  });

  it('does not run the sweep on finish_early (submits over contradictions)', () => {
    const r = resolveCompletion(
      'finish_early',
      { ...offer, earlyFinishAvailable: true },
      { run: true, contradictionCount: 5 }
    );
    expect(r.kind).toBe('submit');
  });

  it('continues on finish_early when the escape hatch is not available', () => {
    const r = resolveCompletion(
      'finish_early',
      { ...offer, earlyFinishAvailable: false },
      { run: false, contradictionCount: 0 }
    );
    expect(r.kind).toBe('continue');
  });
});

import { describe, it, expect } from 'vitest';

import {
  applyRoutingFallback,
  budgetConcludeDecision,
  concludeDecision,
  routeDecision,
} from '@/lib/app/questionnaire/experiences/routing/fallback';
import { EXPERIENCE_ROUTING_FALLBACKS } from '@/lib/app/questionnaire/experiences/types';
import type { CandidateStep } from '@/lib/app/questionnaire/experiences/routing/types';

function candidate(stepKey: string, ordinal: number): CandidateStep {
  return { stepKey, title: stepKey, purpose: null, selectionCriteria: null, ordinal };
}

const CANDIDATES = [candidate('deep-dive', 1), candidate('quick-check', 0)];

/**
 * The fallback is the safety net under every failure the selector can have. Its contract is that
 * it ALWAYS produces a complete decision — a caller must never be handed a null it has to invent a
 * meaning for — and that it never routes somewhere that does not exist.
 */
describe('applyRoutingFallback', () => {
  it('produces a complete decision for every fallback value', () => {
    // Guards the contract itself: adding a fallback to the tuple without handling it here would
    // otherwise surface as an undefined field at a respondent's fork.
    for (const fallback of EXPERIENCE_ROUTING_FALLBACKS) {
      const decision = applyRoutingFallback(fallback, CANDIDATES, 'a reason');
      expect(decision.decision).toMatch(/^(conclude|route)$/);
      expect(decision.rationale).toContain('a reason');
      expect(decision.respondentMessage.length).toBeGreaterThan(0);
      expect(decision.source).toBe('fallback');
      expect(decision.confidence).toBe(1);
      if (decision.decision === 'route') {
        expect(decision.selectedStepKey).not.toBeNull();
      } else {
        expect(decision.selectedStepKey).toBeNull();
      }
    }
  });

  it('concludes on the `conclude` fallback', () => {
    const decision = applyRoutingFallback('conclude', CANDIDATES, 'the selector failed');
    expect(decision.decision).toBe('conclude');
    expect(decision.selectedStepKey).toBeNull();
  });

  it('routes to the LOWEST-ORDINAL candidate on `first_candidate`, not the array head', () => {
    const decision = applyRoutingFallback('first_candidate', CANDIDATES, 'unsure');
    expect(decision.decision).toBe('route');
    expect(decision.selectedStepKey).toBe('quick-check');
  });

  it('routes to the nominated step on `default_step`', () => {
    const decision = applyRoutingFallback('default_step', CANDIDATES, 'unsure', 'deep-dive');
    expect(decision.selectedStepKey).toBe('deep-dive');
    expect(decision.rationale).toContain('nominated default step');
  });

  it('falls to the first candidate when the nominated default no longer exists', () => {
    // The author's intent was clearly "keep going", so concluding would be a worse reading of it
    // than picking the next best candidate.
    const decision = applyRoutingFallback('default_step', CANDIDATES, 'unsure', 'was-deleted');
    expect(decision.decision).toBe('route');
    expect(decision.selectedStepKey).toBe('quick-check');
    expect(decision.rationale).toContain('no usable default step');
  });

  it('falls to the first candidate when no default is nominated at all', () => {
    const decision = applyRoutingFallback('default_step', CANDIDATES, 'unsure', null);
    expect(decision.selectedStepKey).toBe('quick-check');
  });

  describe('with no candidates', () => {
    it('concludes on EVERY fallback, including the routing ones', () => {
      // An experience whose candidates were all deleted must not strand a respondent mid-journey.
      for (const fallback of EXPERIENCE_ROUTING_FALLBACKS) {
        const decision = applyRoutingFallback(fallback, [], 'nothing left');
        expect(decision.decision).toBe('conclude');
        expect(decision.selectedStepKey).toBeNull();
      }
    });

    it('explains that the absence of candidates forced the conclusion', () => {
      const decision = applyRoutingFallback('first_candidate', [], 'the selector failed');
      expect(decision.rationale).toContain('no candidate steps remain');
    });
  });

  it('does not mutate the candidates array while sorting', () => {
    const candidates = [candidate('a', 5), candidate('b', 1)];
    applyRoutingFallback('first_candidate', candidates, 'x');
    expect(candidates.map((c) => c.stepKey)).toEqual(['a', 'b']);
  });
});

describe('concludeDecision', () => {
  it('reports full confidence — a conclusion is certain by construction', () => {
    const decision = concludeDecision('because');
    expect(decision.confidence).toBe(1);
    expect(decision.decision).toBe('conclude');
    expect(decision.selectedStepKey).toBeNull();
  });

  it('defaults its source to fallback but accepts an override', () => {
    expect(concludeDecision('x').source).toBe('fallback');
    expect(concludeDecision('x', 'llm').source).toBe('llm');
  });
});

describe('routeDecision', () => {
  it('carries the step key, source and message', () => {
    const decision = routeDecision('deep-dive', 'matched a rule', 'rule', 'Let us go deeper.');
    expect(decision.decision).toBe('route');
    expect(decision.selectedStepKey).toBe('deep-dive');
    expect(decision.source).toBe('rule');
    expect(decision.respondentMessage).toBe('Let us go deeper.');
  });

  it('supplies a neutral respondent message when none is given', () => {
    expect(routeDecision('x', 'y', 'rule').respondentMessage.length).toBeGreaterThan(0);
  });
});

describe('budgetConcludeDecision', () => {
  it('concludes and attributes the stop to the budget, not to a judgement', () => {
    // The distinction matters in the audit trail: a budget stop is an operator's cap doing its
    // job, whereas a `fallback` source would suggest the selector failed.
    const decision = budgetConcludeDecision(2.5, 2.0);
    expect(decision.decision).toBe('conclude');
    expect(decision.source).toBe('budget');
    expect(decision.rationale).toContain('2.50');
  });
});

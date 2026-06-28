/**
 * Interviewer strategy — narrowing + the questioning-approach prompt builder.
 *
 * Anti-green-bar: asserts the narrower coerces garbage to a safe shape, the funnel phase resolves
 * from coverage (and the questionsAsked fallback) with the terse bias applied, and the builder emits
 * the RIGHT clauses per approach + tactic — and nothing at all when disabled.
 *
 * @see lib/app/questionnaire/chat/interviewer-strategy.ts
 */

import { describe, it, expect } from 'vitest';

import {
  narrowInterviewerStrategy,
  funnelPhase,
  buildInterviewerStrategyInstructions,
} from '@/lib/app/questionnaire/chat/interviewer-strategy';
import { DEFAULT_INTERVIEWER_STRATEGY } from '@/lib/app/questionnaire/types';

describe('narrowInterviewerStrategy', () => {
  it('returns the disabled default for garbage / missing input', () => {
    expect(narrowInterviewerStrategy(undefined)).toEqual(DEFAULT_INTERVIEWER_STRATEGY);
    expect(narrowInterviewerStrategy(null)).toEqual(DEFAULT_INTERVIEWER_STRATEGY);
    expect(narrowInterviewerStrategy('nope')).toEqual(DEFAULT_INTERVIEWER_STRATEGY);
    expect(narrowInterviewerStrategy({})).toEqual(DEFAULT_INTERVIEWER_STRATEGY);
  });

  it('coerces fields to strict booleans and a known approach', () => {
    expect(
      narrowInterviewerStrategy({
        enabled: true,
        approach: 'targeted',
        probeDepth: true,
        reflect: 'yes', // not strictly true → false
        batchRelated: 1, // not strictly true → false
      })
    ).toEqual({
      enabled: true,
      approach: 'targeted',
      probeDepth: true,
      reflect: false,
      batchRelated: false,
    });
  });

  it('falls back to the default approach for an unknown approach value', () => {
    expect(narrowInterviewerStrategy({ enabled: true, approach: 'sideways' }).approach).toBe(
      DEFAULT_INTERVIEWER_STRATEGY.approach
    );
  });
});

describe('funnelPhase', () => {
  it('resolves from coverage when present', () => {
    expect(funnelPhase({ coverage: 0.1, questionsAsked: 99 })).toBe('open');
    expect(funnelPhase({ coverage: 0.5, questionsAsked: 0 })).toBe('mixed');
    expect(funnelPhase({ coverage: 0.9, questionsAsked: 0 })).toBe('targeted');
  });

  it('falls back to questionsAsked when coverage is absent', () => {
    expect(funnelPhase({ questionsAsked: 1 })).toBe('open');
    expect(funnelPhase({ questionsAsked: 5 })).toBe('mixed');
    expect(funnelPhase({ questionsAsked: 12 })).toBe('targeted');
  });

  it('steps one notch toward targeted when the respondent is terse', () => {
    expect(funnelPhase({ coverage: 0.1, questionsAsked: 0, respondentTerse: true })).toBe('mixed');
    expect(funnelPhase({ coverage: 0.5, questionsAsked: 0, respondentTerse: true })).toBe(
      'targeted'
    );
    // Already targeted → stays targeted.
    expect(funnelPhase({ coverage: 0.9, questionsAsked: 0, respondentTerse: true })).toBe(
      'targeted'
    );
  });
});

describe('buildInterviewerStrategyInstructions', () => {
  const ctx = { coverage: 0.1, questionsAsked: 0 };

  it('returns empty string when disabled or undefined', () => {
    expect(buildInterviewerStrategyInstructions(undefined, ctx)).toBe('');
    expect(
      buildInterviewerStrategyInstructions({ ...DEFAULT_INTERVIEWER_STRATEGY, enabled: false }, ctx)
    ).toBe('');
  });

  it('funnel early → open clause; late → targeted clause', () => {
    const early = buildInterviewerStrategyInstructions(
      { ...DEFAULT_INTERVIEWER_STRATEGY, enabled: true, approach: 'funnel' },
      { coverage: 0.1, questionsAsked: 0 }
    );
    expect(early).toMatch(/EARLY in a funnel/i);
    expect(early).toMatch(/open/i);

    const late = buildInterviewerStrategyInstructions(
      { ...DEFAULT_INTERVIEWER_STRATEGY, enabled: true, approach: 'funnel' },
      { coverage: 0.9, questionsAsked: 20 }
    );
    expect(late).toMatch(/LATE in a funnel/i);
    expect(late).toMatch(/TARGETED/i);
  });

  it('open approach emits the open clause regardless of progress', () => {
    const out = buildInterviewerStrategyInstructions(
      { ...DEFAULT_INTERVIEWER_STRATEGY, enabled: true, approach: 'open' },
      { coverage: 0.95, questionsAsked: 50 }
    );
    expect(out).toMatch(/highly OPEN and general/i);
  });

  it('targeted approach emits the targeted clause', () => {
    const out = buildInterviewerStrategyInstructions(
      { ...DEFAULT_INTERVIEWER_STRATEGY, enabled: true, approach: 'targeted' },
      ctx
    );
    expect(out).toMatch(/TARGETED and efficient/i);
  });

  it('appends only the enabled tactics', () => {
    const out = buildInterviewerStrategyInstructions(
      {
        enabled: true,
        approach: 'open',
        probeDepth: true,
        reflect: false,
        batchRelated: true,
      },
      ctx
    );
    expect(out).toMatch(/PROBE FOR DEPTH/);
    expect(out).not.toMatch(/REFLECT AND CONFIRM/);
    expect(out).toMatch(/BATCH RELATED/);
  });
});

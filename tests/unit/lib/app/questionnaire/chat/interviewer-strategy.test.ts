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
  usesOpenOpening,
} from '@/lib/app/questionnaire/chat/interviewer-strategy';
import { DEFAULT_INTERVIEWER_STRATEGY } from '@/lib/app/questionnaire/types';

describe('narrowInterviewerStrategy', () => {
  /**
   * Narrowing fails SAFE (every tactic off), which is deliberately NOT the same as the config
   * default — that is now funnel + probeDepth + batchRelated, applied to new config rows via the
   * column default. Asserting the all-off shape literally keeps the two apart: a legacy row storing
   * `{}` must keep the built-in questioning prompt, never silently inherit today's default.
   */
  const ALL_OFF = {
    enabled: false,
    approach: DEFAULT_INTERVIEWER_STRATEGY.approach,
    probeDepth: false,
    reflect: false,
    batchRelated: false,
  };

  it('fails safe to all-off for garbage / missing input, not to the config default', () => {
    expect(narrowInterviewerStrategy(undefined)).toEqual(ALL_OFF);
    expect(narrowInterviewerStrategy(null)).toEqual(ALL_OFF);
    expect(narrowInterviewerStrategy('nope')).toEqual(ALL_OFF);
    expect(narrowInterviewerStrategy({})).toEqual(ALL_OFF);
    // Guard the distinction itself — if these ever converge, the assertion above is vacuous.
    expect(narrowInterviewerStrategy({})).not.toEqual(DEFAULT_INTERVIEWER_STRATEGY);
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

  it('funnel open phase, past the opening → ongoing broad clause; late → targeted clause', () => {
    // Past the opening window (questionsAsked >= OPENING_WINDOW) the open phase reverts to the
    // ongoing broad clause — coverage 0.1 keeps funnel in its open phase.
    const ongoing = buildInterviewerStrategyInstructions(
      { ...DEFAULT_INTERVIEWER_STRATEGY, enabled: true, approach: 'funnel' },
      { coverage: 0.1, questionsAsked: 2 }
    );
    expect(ongoing).toMatch(/highly OPEN and general/i);
    // The open clause must BROADEN past the single question (the bug fix), not just reword it.
    expect(ongoing).toMatch(/OVERRIDES the "ask the one question provided"/i);

    const late = buildInterviewerStrategyInstructions(
      { ...DEFAULT_INTERVIEWER_STRATEGY, enabled: true, approach: 'funnel' },
      { coverage: 0.9, questionsAsked: 20 }
    );
    expect(late).toMatch(/TARGETED and efficient/i);
    expect(late).not.toMatch(/OVERRIDES the "ask the one question provided"/i);
  });

  it('funnel mid-coverage → mixed-phase clause; open and targeted clauses absent', () => {
    // Coverage 0.5 is between FUNNEL_OPEN_BELOW (0.4) and FUNNEL_TARGETED_ABOVE (0.75) → 'mixed'.
    const out = buildInterviewerStrategyInstructions(
      { ...DEFAULT_INTERVIEWER_STRATEGY, enabled: true, approach: 'funnel' },
      { coverage: 0.5, questionsAsked: 0 }
    );
    expect(out).toMatch(/keep questions fairly open and conversational/);
    expect(out).not.toMatch(/highly OPEN and general/i);
    expect(out).not.toMatch(/TARGETED and efficient/i);
  });

  it('open approach emits the open broadening clause regardless of progress', () => {
    const out = buildInterviewerStrategyInstructions(
      { ...DEFAULT_INTERVIEWER_STRATEGY, enabled: true, approach: 'open' },
      { coverage: 0.95, questionsAsked: 50 }
    );
    expect(out).toMatch(/highly OPEN and general/i);
    expect(out).toMatch(/hint to the AREA/i);
  });

  it('names the topic area in the open clause when provided', () => {
    const out = buildInterviewerStrategyInstructions(
      { ...DEFAULT_INTERVIEWER_STRATEGY, enabled: true, approach: 'open' },
      { coverage: 0.1, questionsAsked: 0, topicArea: 'business execution' }
    );
    expect(out).toMatch(/the broad area of business execution/i);
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

  it('reflect: true emits the REFLECT AND CONFIRM clause', () => {
    // Positive assertion: the existing test only verified reflect:false excludes the clause;
    // this confirms enabling it causes the clause to appear.
    const out = buildInterviewerStrategyInstructions(
      {
        enabled: true,
        approach: 'open',
        probeDepth: false,
        reflect: true,
        batchRelated: false,
      },
      ctx
    );
    expect(out).toMatch(/REFLECT AND CONFIRM/);
    expect(out).toMatch(/play back the gist/);
  });
});

describe('buildInterviewerStrategyInstructions — open opening', () => {
  const open = { ...DEFAULT_INTERVIEWER_STRATEGY, enabled: true, approach: 'open' as const };

  it('first ask (open) → rich permission-giving opening, NOT the ongoing broad clause', () => {
    const out = buildInterviewerStrategyInstructions(open, { coverage: 0.1, questionsAsked: 0 });
    // The opening clause, not the ongoing "highly OPEN and general" broad clause.
    expect(out).toMatch(/this is the OPENING of the conversation/i);
    expect(out).not.toMatch(/highly OPEN and general/i);
    // Permission to speak freely + breadth-before-detail + framing menu + the override phrase.
    expect(out).toMatch(/no right or wrong answers/i);
    expect(out).toMatch(/breadth before detail/i);
    expect(out).toMatch(/story-first/i);
    expect(out).toMatch(/VARY it, do not recite a script/i);
    expect(out).toMatch(/OVERRIDES the "ask the one question provided"/i);
  });

  it('names the topic area in the opening clause when provided', () => {
    const out = buildInterviewerStrategyInstructions(open, {
      coverage: 0.1,
      questionsAsked: 0,
      topicArea: 'business execution',
    });
    expect(out).toMatch(/the broad area of business execution/i);
  });

  it('second ask, substantial answer → follow the thread and probe deeper', () => {
    const out = buildInterviewerStrategyInstructions(open, {
      coverage: 0.1,
      questionsAsked: 1,
      respondentTerse: false,
    });
    expect(out).toMatch(/this is the OPENING of the conversation/i);
    expect(out).toMatch(/FOLLOW that thread and probe it more deeply/i);
    expect(out).not.toMatch(/gently widen again and invite more breadth/i);
  });

  it('second ask, terse answer → widen again rather than narrowing', () => {
    const out = buildInterviewerStrategyInstructions(open, {
      coverage: 0.1,
      questionsAsked: 1,
      respondentTerse: true,
    });
    expect(out).toMatch(/gently widen again and invite more breadth/i);
    expect(out).not.toMatch(/FOLLOW that thread and probe it more deeply/i);
  });

  it('past the opening window → reverts to the ongoing broad clause', () => {
    const out = buildInterviewerStrategyInstructions(open, { coverage: 0.1, questionsAsked: 2 });
    expect(out).toMatch(/highly OPEN and general/i);
    expect(out).not.toMatch(/this is the OPENING of the conversation/i);
  });
});

describe('usesOpenOpening', () => {
  const base = { ...DEFAULT_INTERVIEWER_STRATEGY, enabled: true };

  it('is false when disabled or undefined', () => {
    expect(usesOpenOpening(undefined, { questionsAsked: 0 })).toBe(false);
    expect(
      usesOpenOpening({ ...base, enabled: false, approach: 'open' }, { questionsAsked: 0 })
    ).toBe(false);
  });

  it('open approach: true within the opening window, false past it', () => {
    expect(usesOpenOpening({ ...base, approach: 'open' }, { questionsAsked: 0 })).toBe(true);
    expect(usesOpenOpening({ ...base, approach: 'open' }, { questionsAsked: 1 })).toBe(true);
    expect(usesOpenOpening({ ...base, approach: 'open' }, { questionsAsked: 2 })).toBe(false);
  });

  it('funnel approach: true only while the resolved phase is open and within the window', () => {
    // Open phase (coverage < 0.4) within the window.
    expect(
      usesOpenOpening({ ...base, approach: 'funnel' }, { coverage: 0.1, questionsAsked: 0 })
    ).toBe(true);
    // Funnel pushed to mixed/targeted by coverage → not an open opening.
    expect(
      usesOpenOpening({ ...base, approach: 'funnel' }, { coverage: 0.9, questionsAsked: 0 })
    ).toBe(false);
    // A terse respondent bumps open→mixed, so it's no longer an open opening.
    expect(
      usesOpenOpening(
        { ...base, approach: 'funnel' },
        { coverage: 0.1, questionsAsked: 0, respondentTerse: true }
      )
    ).toBe(false);
  });

  it('targeted approach is never an open opening', () => {
    expect(usesOpenOpening({ ...base, approach: 'targeted' }, { questionsAsked: 0 })).toBe(false);
  });
});

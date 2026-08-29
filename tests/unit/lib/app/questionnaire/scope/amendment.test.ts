/**
 * Respondent amendment (P17.6) — the pure half.
 *
 * Three properties carry the feature and are pinned directly here:
 *
 * - **The cue gate is a cost control.** It runs on every respondent turn, so what it does NOT match
 *   matters more than what it does — an over-eager gate spends a model call on ordinary answers.
 * - **An ambiguous label match is not a match.** Picking the first of two plausible topics is a coin
 *   toss dressed as a decision, and the cost of getting it wrong is asking someone about something
 *   they did not raise.
 * - **An amendment only ever adds.** Nothing here may take a topic out of scope.
 */

import { describe, it, expect } from 'vitest';

import {
  amendableTopics,
  amendmentBriefingLine,
  applyAmendment,
  looksLikeTopicRequest,
  matchTopicByLabel,
  isEnglishLocale,
  candidateLabelHits,
  respondentReasonFor,
  topicSizeWording,
} from '@/lib/app/questionnaire/scope/amendment';
import type { InterviewPlan, Topic } from '@/lib/app/questionnaire/scope/types';

function topic(key: string, label: string, phase: Topic['phase'] = 'conditional'): Topic {
  return {
    id: `id-${key}`,
    key,
    label,
    description: null,
    phase,
    criteria: 'when it fits',
    depth: 'full',
    members: { questionKeys: [`${key}_q1`], dataSlotKeys: [] },
    ordinal: 0,
    source: 'manual',
    trigger: null,
  };
}

function plan(overrides: Partial<InterviewPlan> = {}): InterviewPlan {
  return {
    v: 1,
    topics: [{ key: 'pipeline', depth: 'full', source: 'llm', rationale: 'they named it' }],
    excluded: [{ key: 'talent', source: 'llm', rationale: 'nothing pointed at it' }],
    checkTopicKey: null,
    confidence: 0.8,
    source: 'llm',
    respondentMessage: 'I want to go deeper on pipeline.',
    decidedAtTurn: 3,
    decidedAt: '2026-08-12T10:00:00.000Z',
    ...overrides,
  };
}

describe('looksLikeTopicRequest', () => {
  it.each([
    'Actually, can we cover talent as well?',
    'Ask me about pricing too',
    'What about our operations?',
    "Don't forget the hiring side",
    'I would like to talk about retention',
    'You should also discuss forecasting',
  ])('matches a plain request: %s', (message) => {
    expect(looksLikeTopicRequest(message)).toBe(true);
  });

  it.each([
    'We hired four people last quarter and it went badly.',
    'Pricing is roughly £40 a seat, about what our competitors charge.',
    'It depends. Some months are fine, others are not.',
    'Talent is our biggest problem right now.',
    '',
    '   ',
  ])('does NOT match an ordinary answer: %s', (message) => {
    // This is the cost control. "Talent is our biggest problem" is an ANSWER — matching it would
    // spend a model call on nearly every turn of an interview that is going well.
    expect(looksLikeTopicRequest(message)).toBe(false);
  });

  it('ignores a request buried past the scan window', () => {
    const filler = 'x'.repeat(700);
    expect(looksLikeTopicRequest(`${filler} can we cover talent`)).toBe(false);
  });
});

describe('matchTopicByLabel', () => {
  const candidates = [topic('talent', 'Talent'), topic('pricing', 'Pricing & packaging')];

  it('resolves an exact label mention with no model call', () => {
    expect(matchTopicByLabel('Ask me about talent too', candidates)?.key).toBe('talent');
  });

  it('requires every content token of a multi-word label', () => {
    // "Pricing" alone must not claim "Pricing & packaging" — that label names a broader topic, and
    // the difference is exactly what the judgement tier exists to settle.
    expect(matchTopicByLabel('can we cover pricing and packaging', candidates)?.key).toBe(
      'pricing'
    );
    expect(matchTopicByLabel('can we cover packaging', candidates)).toBeNull();
  });

  it('returns null when two labels both appear', () => {
    expect(matchTopicByLabel('what about talent and pricing & packaging', candidates)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(matchTopicByLabel('what about the weather', candidates)).toBeNull();
  });
});

describe('amendableTopics', () => {
  const topics = [
    topic('pipeline', 'Pipeline'),
    topic('talent', 'Talent'),
    topic('always', 'Always asked', 'core'),
    topic('never_considered', 'Never considered'),
  ];

  it('offers only conditional topics the plan actually excluded', () => {
    expect(amendableTopics(plan(), topics).map((t) => t.key)).toEqual(['talent']);
  });

  it('never offers a topic already in scope', () => {
    // A respondent asking for something the interview is about to cover needs no amendment, and
    // recording one would report a planner correction that never happened.
    const p = plan({
      topics: [
        { key: 'pipeline', depth: 'full', source: 'llm', rationale: '' },
        { key: 'talent', depth: 'full', source: 'llm', rationale: '' },
      ],
    });
    expect(amendableTopics(p, topics)).toEqual([]);
  });

  it('returns nothing when the plan excluded nothing', () => {
    expect(amendableTopics(plan({ excluded: [] }), topics)).toEqual([]);
  });
});

describe('applyAmendment', () => {
  const at = {
    request: 'Actually, ask me about talent',
    atTurn: 5,
    at: '2026-08-12T11:00:00.000Z',
  };

  it('adds the topic at FULL depth, whatever the topic itself says', () => {
    // Someone who asks to be asked about something is asking to be assessed on it. Answering with a
    // two-question sample would be a worse response than the exclusion they objected to.
    const light: Topic = { ...topic('talent', 'Talent'), depth: 'light' };
    const { plan: next } = applyAmendment(plan(), light, at);
    expect(next.topics.find((t) => t.key === 'talent')?.depth).toBe('full');
  });

  it('marks the topic as the respondent’s, not the planner’s', () => {
    // The whole point for analytics: a correction is evidence ABOUT the planner, and counting it as
    // a successful selection would make the planner look better the worse it got.
    const { plan: next } = applyAmendment(plan(), topic('talent', 'Talent'), at);
    expect(next.topics.find((t) => t.key === 'talent')?.source).toBe('respondent');
  });

  it('moves the topic out of excluded rather than leaving it in both lists', () => {
    const { plan: next } = applyAmendment(plan(), topic('talent', 'Talent'), at);
    expect(next.excluded.map((t) => t.key)).not.toContain('talent');
    expect(next.topics.map((t) => t.key)).toContain('talent');
  });

  it('records the amendment with the respondent’s own words and the turn', () => {
    const { plan: next, amendment } = applyAmendment(plan(), topic('talent', 'Talent'), at);
    expect(amendment).toMatchObject({ key: 'talent', label: 'Talent', atTurn: 5 });
    expect(amendment.request).toBe('Actually, ask me about talent');
    expect(next.amendments).toHaveLength(1);
  });

  it('never removes a topic that was already in scope', () => {
    const { plan: next } = applyAmendment(plan(), topic('talent', 'Talent'), at);
    expect(next.topics.map((t) => t.key)).toContain('pipeline');
  });

  it('accumulates a second amendment rather than replacing the first', () => {
    const first = applyAmendment(plan(), topic('talent', 'Talent'), at);
    const second = applyAmendment(first.plan, topic('ops', 'Operations'), { ...at, atTurn: 8 });
    expect(second.plan.amendments?.map((a) => a.key)).toEqual(['talent', 'ops']);
  });

  it('leaves the original announcement and decision turn untouched', () => {
    // The plan's own record of what it decided, and what the respondent was told at the time, is
    // what makes a finished report defensible. An amendment adds to it; it must not rewrite it.
    const before = plan();
    const { plan: next } = applyAmendment(before, topic('talent', 'Talent'), at);
    expect(next.respondentMessage).toBe(before.respondentMessage);
    expect(next.decidedAtTurn).toBe(before.decidedAtTurn);
    expect(next.source).toBe(before.source);
  });
});

describe('isEnglishLocale — which gate a version gets', () => {
  it('treats an absent or blank locale as English', () => {
    // Most versions have no locale at all, and the English cue gate is what every one of them has
    // always run. A new field must not change their behaviour.
    expect(isEnglishLocale(undefined)).toBe(true);
    expect(isEnglishLocale(null)).toBe(true);
    expect(isEnglishLocale('  ')).toBe(true);
  });

  it('accepts every English tag, in any case, with either separator', () => {
    for (const tag of ['en', 'EN', 'en-GB', 'en_US', 'En-Au']) {
      expect(isEnglishLocale(tag)).toBe(true);
    }
  });

  it('rejects a language that merely starts with the letters "en"', () => {
    // A prefix test without the separator would read Estonian, Basque and Ewe as English and give
    // them a cue list that cannot fire.
    for (const tag of ['eng-Latn', 'et', 'eu', 'ee', 'es', 'sv-SE']) {
      expect(isEnglishLocale(tag)).toBe(false);
    }
  });
});

describe('candidateLabelHits — the non-English gate', () => {
  const topics = [
    topic('talent', 'Personal och kompetens'),
    topic('pricing', 'Prissättning'),
  ] as const;

  it('finds a label written in a non-English language', () => {
    const hits = candidateLabelHits('Kan vi prata om prissättning?', topics);
    expect(hits.map((t) => t.key)).toEqual(['pricing']);
  });

  it('tokenises an accented multi-word label instead of shredding it', () => {
    // The old ASCII split turned "Prissättning" into "priss" + "ttning", so a correctly spelled
    // message matched nothing.
    const hits = candidateLabelHits('personal och kompetens borde vi ta', topics);
    expect(hits.map((t) => t.key)).toEqual(['talent']);
  });

  it('returns every hit, including the ambiguous case matchTopicByLabel refuses', () => {
    // The gate asks "is anything named", not "which one" — the agent decides that, and an ambiguous
    // mention is exactly the case that needs it.
    const hits = candidateLabelHits('prissättning och personal och kompetens', topics);
    expect(hits.map((t) => t.key).sort()).toEqual(['pricing', 'talent']);
    expect(matchTopicByLabel('prissättning och personal och kompetens', topics)).toBeNull();
  });

  it('is empty for a message that names nothing', () => {
    expect(candidateLabelHits('Ja, det stämmer.', topics)).toEqual([]);
  });
});

/**
 * What the respondent is actually told (F17.33).
 *
 * An area appearing mid-conversation with no explanation is the moment someone starts wondering
 * what else is being decided about them, so the acknowledgement has to carry what, how much and
 * why. The two things pinned hardest are the two that would do harm: a size claim the interview
 * will not keep, and a reason the planner does not have the evidence to give.
 */
describe('topicSizeWording', () => {
  it('says "a couple" only for what really is a couple', () => {
    // A `light` topic IS two items. A respondent told "a couple" and then asked nine stops
    // believing the next thing the interviewer says about how long anything will take.
    expect(topicSizeWording(1)).toMatch(/couple/);
    expect(topicSizeWording(2)).toMatch(/couple/);
    expect(topicSizeWording(3)).not.toMatch(/couple/);
  });

  it('stays vague at the top end rather than promising a number', () => {
    // "About fourteen questions" is a commitment the run budget may not keep.
    expect(topicSizeWording(14)).toBe('a fair bit of ground');
    expect(topicSizeWording(14)).not.toMatch(/\d/);
  });
});

describe('respondentReasonFor', () => {
  it('gives the respondent their own words back', () => {
    expect(
      respondentReasonFor({ source: 'respondent', request: '  can we talk about hiring?  ' })
    ).toBe('can we talk about hiring?');
  });

  it('NEVER gives a reason for the blind-spot check', () => {
    // Its only honest reason is "you did not raise this", which converts a sampling decision into a
    // claim about what the respondent left out — evidence the planner does not have.
    expect(respondentReasonFor({ source: 'check', request: 'anything at all' })).toBeNull();
  });

  it('is null when there are no words to quote', () => {
    expect(respondentReasonFor({ source: 'llm' })).toBeNull();
    expect(respondentReasonFor({ source: 'respondent', request: '   ' })).toBeNull();
  });
});

describe('amendmentBriefingLine', () => {
  const amendment = {
    key: 'talent',
    label: 'People & capability',
    request: 'can we cover hiring?',
    atTurn: 6,
    at: '2026-08-29T00:00:00.000Z',
  };

  it('names the area, sizes it, and ties it to what they asked for', () => {
    const line = amendmentBriefingLine({ amendment, itemCount: 2 });

    expect(line).toContain('People & capability');
    expect(line).toContain('just a couple of questions');
    expect(line).toContain('can we cover hiring?');
  });

  it('makes no size claim when the count is unknown', () => {
    // A topic an author deleted while a live plan still named it. No size beats a wrong size.
    const line = amendmentBriefingLine({ amendment });
    expect(line).toContain('People & capability');
    expect(line).not.toMatch(/couple|handful|fair bit/);
  });

  it('keeps the implementation vocabulary off the screen', () => {
    // The vocabulary ban is what makes giving a reason safe: the interviewer may say what it will
    // cover and why, and nothing about how the interview decides.
    const line = amendmentBriefingLine({ amendment, itemCount: 4 });
    expect(line).toMatch(/do not use the words topic, section, plan, scope or depth/i);
    expect(line).toMatch(/do not explain how the interview decides/i);
  });
});

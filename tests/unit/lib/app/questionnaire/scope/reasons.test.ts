/**
 * Why an area is in this respondent's interview, in words for them (F17.33).
 *
 * The panel is where someone NOTICES their interview changing — the interviewer's announcement is
 * said once and scrolls away, while a group that appeared partway through is still on screen an
 * hour later. What this file pins is that the caption appears exactly where something appeared:
 * never on the always-run areas (nothing appeared, so there is nothing to explain), and never
 * invented for a plan that has no reason to give.
 *
 * @see lib/app/questionnaire/scope/reasons.ts
 */

import { describe, it, expect } from 'vitest';

import { respondentReasons, sharedReason } from '@/lib/app/questionnaire/scope/reasons';
import type { InterviewPlan, Topic, TopicPhase } from '@/lib/app/questionnaire/scope/types';

function topic(key: string, phase: TopicPhase, overrides: Partial<Topic> = {}): Topic {
  return {
    id: `id-${key}`,
    key,
    label: key,
    description: null,
    phase,
    criteria: null,
    depth: 'full',
    members: { dataSlotKeys: [`${key}_ds`], questionKeys: [`${key}_q1`, `${key}_q2`] },
    ordinal: 0,
    source: 'seeded',
    trigger: null,
    ...overrides,
  };
}

function plan(topics: InterviewPlan['topics']): InterviewPlan {
  return {
    v: 1,
    topics,
    excluded: [],
    checkTopicKey: null,
    confidence: 0.9,
    source: 'llm',
    respondentMessage: '',
    decidedAtTurn: 4,
    decidedAt: '2026-08-30T00:00:00.000Z',
  };
}

const TOPICS = [topic('core', 'core'), topic('talent', 'conditional')];

describe('respondentReasons', () => {
  it('captions every member of a conditional topic the plan seated', () => {
    const reasons = respondentReasons({
      plan: plan([
        {
          key: 'talent',
          depth: 'full',
          source: 'llm',
          rationale: 'admin-facing',
          respondentReason: 'You mentioned the team has doubled, so we’ll cover hiring.',
        },
      ]),
      topics: TOPICS,
    });

    expect(reasons.byQuestionKey.get('talent_q1')).toBe(
      'You mentioned the team has doubled, so we’ll cover hiring.'
    );
    expect(reasons.byDataSlotKey.get('talent_ds')).toBe(
      'You mentioned the team has doubled, so we’ll cover hiring.'
    );
  });

  it('captions nothing on an always-run topic — nothing appeared, so nothing needs explaining', () => {
    // Captioning these would turn an ordinary questionnaire into one that looks like it is
    // constantly justifying itself.
    const reasons = respondentReasons({
      plan: plan([
        { key: 'core', depth: 'full', source: 'llm', rationale: 'r', respondentReason: 'why' },
      ]),
      topics: TOPICS,
    });

    expect(reasons.byQuestionKey.size).toBe(0);
    expect(reasons.byDataSlotKey.size).toBe(0);
  });

  it('captions nothing when the plan carries no reason — a legacy plan invents no explanation', () => {
    const reasons = respondentReasons({
      plan: plan([{ key: 'talent', depth: 'full', source: 'llm', rationale: 'r' }]),
      topics: TOPICS,
    });

    expect(reasons.byQuestionKey.size).toBe(0);
  });

  it('captions nothing before a plan exists', () => {
    expect(respondentReasons({ plan: null, topics: TOPICS }).byQuestionKey.size).toBe(0);
  });

  it('follows depth, so it never captions a question this respondent will not see', () => {
    const wide = topic('talent', 'conditional', {
      members: { dataSlotKeys: [], questionKeys: ['a', 'b', 'c'] },
    });
    const reasons = respondentReasons({
      plan: plan([
        { key: 'talent', depth: 'light', source: 'check', rationale: 'r', respondentReason: 'why' },
      ]),
      topics: [wide],
      weightByQuestionKey: new Map([
        ['a', 1],
        ['b', 9],
        ['c', 5],
      ]),
    });

    // The two the interview will actually ask — a caption on a question nobody sees is a caption
    // that disagrees with the panel beside it about what this interview contains.
    expect([...reasons.byQuestionKey.keys()].sort()).toEqual(['b', 'c']);
  });

  it('follows depth for DATA SLOTS too, which is where the panel actually shows the line', () => {
    // In data-slot mode the group heading is the caption's home, so getting this pair wrong is not
    // a stray caption — it is a group that appeared mid-interview and explains itself to nobody.
    // The route must therefore hand the data-slot weights over; `buildSessionScope` loads them
    // itself, so omitting them here would silently caption a DIFFERENT pair than the panel renders.
    const wide = topic('talent', 'conditional', {
      members: { dataSlotKeys: ['ds_a', 'ds_b', 'ds_c'], questionKeys: [] },
    });
    const reasons = respondentReasons({
      plan: plan([
        { key: 'talent', depth: 'light', source: 'llm', rationale: 'r', respondentReason: 'why' },
      ]),
      topics: [wide],
      weightByDataSlotKey: new Map([
        ['ds_a', 1],
        ['ds_b', 9],
        ['ds_c', 5],
      ]),
    });

    expect([...reasons.byDataSlotKey.keys()].sort()).toEqual(['ds_b', 'ds_c']);
  });

  it('keeps the first reason when two seated topics claim the same key', () => {
    const shared = [
      topic('first', 'conditional', { members: { dataSlotKeys: [], questionKeys: ['x'] } }),
      topic('second', 'conditional', { members: { dataSlotKeys: [], questionKeys: ['x'] } }),
    ];
    const reasons = respondentReasons({
      plan: plan([
        { key: 'first', depth: 'full', source: 'llm', rationale: 'r', respondentReason: 'first' },
        { key: 'second', depth: 'full', source: 'llm', rationale: 'r', respondentReason: 'second' },
      ]),
      topics: shared,
    });

    // Plan order is best-first, so the winner is the topic that most explains why the key is here.
    expect(reasons.byQuestionKey.get('x')).toBe('first');
  });
});

describe('sharedReason', () => {
  it('returns the one reason a whole group agrees on', () => {
    expect(sharedReason(['why', 'why', 'why'])).toBe('why');
  });

  it('returns null for a group that MIXES added rows with always-asked ones', () => {
    // There is no single true thing to say about such a group, so it says nothing and the rows
    // caption themselves.
    expect(sharedReason(['why', null])).toBeNull();
    expect(sharedReason([null, 'why'])).toBeNull();
  });

  it('returns null for two different reasons', () => {
    expect(sharedReason(['one', 'two'])).toBeNull();
  });

  it('returns null for an empty group', () => {
    expect(sharedReason([])).toBeNull();
  });
});

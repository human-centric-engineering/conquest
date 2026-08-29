/**
 * The transcript re-read's pure half (F17.33 phase B).
 *
 * What is pinned here is the two decisions the runner must not be trusted to make inline: which
 * topics are outstanding (and therefore what to look for), and what may be kept of what comes back.
 * The ledger rules in particular are the difference between a pass that runs once per widening and
 * one that pays for the same read on every remaining turn.
 *
 * @see lib/app/questionnaire/scope/rescan.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildRescanPrompt,
  filterRescanIntents,
  pendingRescanTopics,
  selectRescanTargets,
  trimTranscript,
} from '@/lib/app/questionnaire/scope/rescan';
import type { AnswerSlotIntent } from '@/lib/app/questionnaire/extraction/types';
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
    decidedAt: '2026-08-12T00:00:00.000Z',
  };
}

const TOPICS = [
  topic('open', 'opening'),
  topic('core', 'core'),
  topic('talent', 'conditional'),
  topic('pipeline', 'conditional'),
];

function intent(slotKey: string, over: Partial<AnswerSlotIntent> = {}): AnswerSlotIntent {
  return {
    slotKey,
    value: 'something',
    confidence: 0.9,
    provenance: 'direct',
    rationale: 'they said so',
    questionType: 'free_text',
    isActiveQuestion: false,
    ...over,
  };
}

describe('pendingRescanTopics', () => {
  it('returns the seated conditional topics that have not been re-read', () => {
    const pending = pendingRescanTopics(
      plan([{ key: 'talent', depth: 'full', source: 'llm', rationale: 'r' }]),
      TOPICS,
      []
    );
    expect(pending.map((t) => t.key)).toEqual(['talent']);
  });

  it('ignores the always-run phases — they were never out of the extractor’s sight', () => {
    const pending = pendingRescanTopics(
      plan([
        { key: 'open', depth: 'full', source: 'rule', rationale: 'r' },
        { key: 'core', depth: 'full', source: 'rule', rationale: 'r' },
      ]),
      TOPICS,
      []
    );
    expect(pending).toEqual([]);
  });

  it('is the once-per-topic ledger: a re-read topic never comes back', () => {
    const p = plan([
      { key: 'talent', depth: 'full', source: 'llm', rationale: 'r' },
      { key: 'pipeline', depth: 'full', source: 'llm', rationale: 'r' },
    ]);
    // The plan-time pass took both...
    expect(pendingRescanTopics(p, TOPICS, []).map((t) => t.key)).toEqual(['talent', 'pipeline']);
    // ...so the amendment-time pass that follows sees only what the amendment added.
    expect(pendingRescanTopics(p, TOPICS, ['talent', 'pipeline'])).toEqual([]);
  });

  it('skips a planned key that resolves to no topic', () => {
    // An author may delete a topic a live plan still names. Unresolvable keys are skipped
    // everywhere in this feature; failing the pass would be a worse answer than a thinner one.
    const pending = pendingRescanTopics(
      plan([{ key: 'ghost', depth: 'full', source: 'llm', rationale: 'r' }]),
      TOPICS,
      []
    );
    expect(pending).toEqual([]);
  });
});

describe('selectRescanTargets', () => {
  it('collects the members of every outstanding topic', () => {
    expect(
      selectRescanTargets({
        plan: plan([{ key: 'talent', depth: 'full', source: 'llm', rationale: 'r' }]),
        topics: TOPICS,
        scanned: [],
      })
    ).toEqual({
      topicKeys: ['talent'],
      questionKeys: ['talent_q1', 'talent_q2'],
      dataSlotKeys: ['talent_ds'],
    });
  });

  it('returns nothing when there is no plan — the pre-planner state has widened nothing', () => {
    expect(selectRescanTargets({ plan: null, topics: TOPICS, scanned: [] })).toEqual({
      topicKeys: [],
      questionKeys: [],
      dataSlotKeys: [],
    });
  });

  it('honours depth, so a light topic is re-read for what it will actually ask', () => {
    const wide = topic('talent', 'conditional', {
      members: { dataSlotKeys: [], questionKeys: ['a', 'b', 'c', 'd'] },
    });
    const targets = selectRescanTargets({
      plan: plan([{ key: 'talent', depth: 'light', source: 'check', rationale: 'r' }]),
      topics: [wide],
      scanned: [],
      weightByQuestionKey: new Map([
        ['a', 1],
        ['b', 5],
        ['c', 9],
        ['d', 2],
      ]),
    });
    // The two highest-weight members — the same two the interview will show. Re-reading more would
    // write answers to questions this respondent is never asked.
    expect(targets.questionKeys).toEqual(['c', 'b']);
  });

  it('honours an explicit planned subset', () => {
    const targets = selectRescanTargets({
      plan: plan([
        {
          key: 'talent',
          depth: 'full',
          source: 'llm',
          rationale: 'r',
          members: { questionKeys: ['talent_q2'], dataSlotKeys: [] },
        },
      ]),
      topics: TOPICS,
      scanned: [],
    });
    expect(targets.questionKeys).toEqual(['talent_q2']);
  });

  it('de-duplicates members shared by two outstanding topics', () => {
    const shared = [
      topic('talent', 'conditional', { members: { dataSlotKeys: [], questionKeys: ['x', 'y'] } }),
      topic('pipeline', 'conditional', { members: { dataSlotKeys: [], questionKeys: ['y', 'z'] } }),
    ];
    const targets = selectRescanTargets({
      plan: plan([
        { key: 'talent', depth: 'full', source: 'llm', rationale: 'r' },
        { key: 'pipeline', depth: 'full', source: 'llm', rationale: 'r' },
      ]),
      topics: shared,
      scanned: [],
    });
    expect(targets.questionKeys).toEqual(['x', 'y', 'z']);
  });
});

describe('filterRescanIntents', () => {
  const candidateKeys = new Set(['a', 'b']);

  it('drops an intent naming a key that is not a candidate', () => {
    const kept = filterRescanIntents([intent('a'), intent('zzz')], {
      candidateKeys,
      answeredKeys: new Set(),
    });
    expect(kept.map((i) => i.slotKey)).toEqual(['a']);
  });

  it('gap-fills only — an already-answered question is never written', () => {
    // A model reading a whole transcript will happily answer something the respondent settled ten
    // turns ago, and overwriting a `direct` capture with an inference is a strict downgrade.
    const kept = filterRescanIntents([intent('a'), intent('b')], {
      candidateKeys,
      answeredKeys: new Set(['a']),
    });
    expect(kept.map((i) => i.slotKey)).toEqual(['b']);
  });

  it('caps confidence and re-labels provenance — nobody asked these questions', () => {
    const kept = filterRescanIntents(
      [
        intent('a', { confidence: 0.99 }),
        intent('b', { confidence: 0.99, questionType: 'single_choice' }),
      ],
      { candidateKeys, answeredKeys: new Set() }
    );
    // Free text keeps the flat Tentative ceiling; a typed answer may hold the resolver's clarity up
    // to the typed ceiling. Both stay below "Confident", which only corroboration earns.
    expect(kept[0].confidence).toBeCloseTo(0.45);
    expect(kept[1].confidence).toBeCloseTo(0.75);
    expect(kept.every((i) => i.provenance === 'inferred')).toBe(true);
  });
});

describe('trimTranscript', () => {
  it('keeps whole lines, oldest → newest, within the budget', () => {
    expect(trimTranscript(['aaaa', 'bbbb', 'cccc'], 100)).toEqual(['aaaa', 'bbbb', 'cccc']);
  });

  it('trims from the START when the session is too long to fit', () => {
    // The recent exchanges are kept: a topic seated by an amendment was usually prompted by
    // something said recently.
    expect(trimTranscript(['aaaa', 'bbbb', 'cccc'], 9)).toEqual(['bbbb', 'cccc']);
  });

  it('never returns nothing, even for a single over-budget line', () => {
    // A blank prompt would spend the call and read nothing; one long line is a usable read.
    expect(trimTranscript(['a very long line indeed'], 5)).toEqual(['a very long line indeed']);
  });
});

describe('buildRescanPrompt', () => {
  const prompt = () =>
    buildRescanPrompt({
      transcript: ['Respondent: we lost two engineers last quarter'],
      candidateSlots: [
        {
          key: 'attrition',
          type: 'single_choice',
          typeConfig: { options: [{ value: 'high' }, { value: 'low' }] },
          prompt: 'How would you describe attrition?',
          required: false,
        },
      ],
    }).system;

  it('tells the model that answering nothing is the expected result', () => {
    // Without this a whole transcript produces a confident answer for every candidate — there is
    // always something vaguely adjacent in an hour of conversation.
    expect(prompt()).toMatch(/empty list/i);
  });

  it('rules out answering from the interviewer’s own words', () => {
    expect(prompt()).toMatch(/RESPONDENT/);
  });

  it('renders the allowed values of a typed slot', () => {
    // A value the model invents is dropped by `normalizeAnswerIntents` — silently, and after we
    // have paid for the call.
    expect(prompt()).toContain('high | low');
  });

  it('omits the data-slot section entirely when there are none', () => {
    expect(prompt()).not.toContain('topics_to_check');
  });
});

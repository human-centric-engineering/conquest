/**
 * Unit tests: `buildPlanPreviewForm` — the plan preview's form shape (F17.14).
 *
 * The builder decides two things an author's dry-run depends on being right:
 *
 * 1. **Which boxes to offer.** The preview is only faithful if the questions it asks the author to
 *    answer are the ones a respondent would actually be asked before the plan is decided — the
 *    opening topics' questions, in interview order, and nothing else.
 * 2. **Which slots a veto watches.** A `not_exists` rule fires on ABSENCE, so the demonstration an
 *    author most needs is "leave this empty and watch the topic drop". If the marking is wrong they
 *    fill every box out of tidiness and never see the rule fire.
 */

import { describe, it, expect } from 'vitest';

import { buildPlanPreviewForm } from '@/lib/app/questionnaire/scope/views';
import { readProposedTopicKeys } from '@/lib/app/questionnaire/scope/planner';
import { type Topic, type TopicPhase } from '@/lib/app/questionnaire/scope/types';

function topic(key: string, phase: TopicPhase, questionKeys: string[], ordinal = 0): Topic {
  return {
    id: `t-${key}`,
    key,
    label: key,
    description: null,
    phase,
    criteria: phase === 'conditional' ? 'when it applies' : null,
    depth: 'full',
    members: { questionKeys, dataSlotKeys: [] },
    ordinal,
    source: 'manual',
    trigger: null,
  };
}

const PROMPTS = new Map([
  ['open_a', 'What brought you here?'],
  ['open_b', 'What is making it hard?'],
  ['core_a', 'Rate your confidence'],
]);

describe('buildPlanPreviewForm — which boxes the author is offered', () => {
  it('offers the opening topics questions and nothing from other phases', () => {
    const form = buildPlanPreviewForm(
      [topic('opening', 'opening', ['open_a', 'open_b'], 0), topic('spine', 'core', ['core_a'], 1)],
      [],
      PROMPTS
    );

    // A core question is asked, but never BEFORE the plan is decided — typing an answer to it would
    // suggest the planner reads evidence it has never seen.
    expect(form.openingQuestions.map((q) => q.key)).toEqual(['open_a', 'open_b']);
    expect(form.openingQuestions[0]?.prompt).toBe('What brought you here?');
  });

  it('orders questions the way the interview would ask them, across several opening topics', () => {
    const form = buildPlanPreviewForm(
      [topic('second', 'opening', ['open_b'], 5), topic('first', 'opening', ['open_a'], 1)],
      [],
      PROMPTS
    );

    // Topic ordinal decides, not array order — an author filling the form top to bottom is
    // reproducing a real opening rather than an arbitrary one.
    expect(form.openingQuestions.map((q) => q.key)).toEqual(['open_a', 'open_b']);
  });

  it('skips a member naming a question that no longer exists', () => {
    const form = buildPlanPreviewForm(
      [topic('opening', 'opening', ['open_a', 'deleted_q'], 0)],
      [],
      PROMPTS
    );

    // Unresolvable keys are skipped everywhere in this feature; offering a box for one would invite
    // the author to answer a question no respondent can ever be asked.
    expect(form.openingQuestions.map((q) => q.key)).toEqual(['open_a']);
  });

  it('offers one box per question when two opening topics claim the same key', () => {
    const form = buildPlanPreviewForm(
      [topic('one', 'opening', ['open_a'], 0), topic('two', 'opening', ['open_a', 'open_b'], 1)],
      [],
      PROMPTS
    );

    expect(form.openingQuestions.map((q) => q.key)).toEqual(['open_a', 'open_b']);
  });

  it('returns no questions when the version has no opening topic', () => {
    const form = buildPlanPreviewForm([topic('spine', 'core', ['core_a'], 0)], [], PROMPTS);

    expect(form.openingQuestions).toEqual([]);
  });
});

describe('readProposedTopicKeys — reading a recorded snapshot back', () => {
  it('returns the keys the model proposed, in its own order', () => {
    expect(
      readProposedTopicKeys({
        selected: [
          { topicKey: 'talent', rationale: 'they named hiring' },
          { topicKey: 'data', rationale: 'CRM complaints' },
        ],
        confidence: 0.7,
        respondentMessage: 'going deeper on two areas',
      })
    ).toEqual(['talent', 'data']);
  });

  it('reads null as "the model proposed nothing" rather than throwing', () => {
    // Every deterministic path — a rule-only plan, the fallback, nothing to decide — records a null
    // snapshot. The preview asks for the proposal on all of them.
    expect(readProposedTopicKeys(null)).toEqual([]);
  });

  it('degrades to empty on a snapshot it cannot interpret', () => {
    // A row written before the schema changed, or a truncated blob. The preview's trace goes thin;
    // it does not break.
    expect(readProposedTopicKeys({ selected: 'not-an-array' })).toEqual([]);
    expect(readProposedTopicKeys('nonsense')).toEqual([]);
    expect(readProposedTopicKeys({ selected: [{ rationale: 'no key here' }] })).toEqual([]);
  });
});

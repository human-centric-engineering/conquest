import { describe, expect, it } from 'vitest';

import {
  buildContradictionProbe,
  DEFAULT_RECONCILIATION_QUESTION,
} from '@/lib/app/questionnaire/contradiction/probe-flow';

import { contradiction } from '@/tests/unit/lib/app/questionnaire/contradiction/_fixtures';

const labels = (entries: Array<[string, string]>) => ({ questionLabels: new Map(entries) });

describe('buildContradictionProbe', () => {
  it('uses the finding probe and states the consequence with the topic name', () => {
    const { text, pending } = buildContradictionProbe({
      finding: contradiction({
        slotKeys: ['satisfaction'],
        explanation: 'hate vs love',
        suggestedProbe: 'Which reflects how you feel?',
      }),
      statement: 'I love my job',
      raisedAtTurnIndex: 2,
      labels: labels([['satisfaction', 'How satisfied are you with your role?']]),
      dataMode: false,
    });
    // The reconciliation question leads.
    expect(text).toContain('Which reflects how you feel?');
    // The consequence is explicit — confirming will CHANGE the earlier answer + the saved data.
    expect(text.toLowerCase()).toContain('update your earlier answer');
    expect(text).toContain('How satisfied are you with your role?');
    expect(text).toContain('your saved responses'); // question-mode noun
    // The pending record carries the finding + the triggering statement.
    expect(pending).toMatchObject({
      slotKeys: ['satisfaction'],
      explanation: 'hate vs love',
      suggestedProbe: 'Which reflects how you feel?',
      statement: 'I love my job',
      raisedAtTurnIndex: 2,
    });
  });

  it('falls back to the default question when the finding has no probe', () => {
    const { text } = buildContradictionProbe({
      finding: contradiction({ slotKeys: ['a'] }),
      statement: 's',
      raisedAtTurnIndex: 0,
      labels: labels([['a', 'Topic A']]),
      dataMode: false,
    });
    expect(text).toContain(DEFAULT_RECONCILIATION_QUESTION);
  });

  it('prefers the data-slot label and the data-mode noun in data-slot mode', () => {
    const { text } = buildContradictionProbe({
      finding: contradiction({ slotKeys: ['satisfaction'] }),
      statement: 's',
      raisedAtTurnIndex: 0,
      labels: {
        questionLabels: new Map([['satisfaction', 'How satisfied?']]),
        dataSlotLabels: new Map([['satisfaction', 'Role Satisfaction']]),
      },
      dataMode: true,
    });
    expect(text).toContain('Role Satisfaction'); // data-slot name preferred over the question prompt
    expect(text).not.toContain('How satisfied?');
    expect(text).toContain('the linked saved data'); // data-mode noun
  });

  it('lists multiple conflicting topics, de-duplicated', () => {
    const { text } = buildContradictionProbe({
      finding: contradiction({ slotKeys: ['a', 'b'] }),
      statement: 's',
      raisedAtTurnIndex: 0,
      labels: labels([
        ['a', 'Satisfaction'],
        ['b', 'Recommendation'],
      ]),
      dataMode: false,
    });
    expect(text).toContain('Satisfaction and Recommendation');
  });
});

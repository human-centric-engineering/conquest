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

  it('omits the topic clause when all slot keys trim to empty strings', () => {
    // affectedTopics filters out labels that trim to '' — when every slotKey trims to empty,
    // topics is [], humanJoin returns '', and the " about " clause is suppressed.
    const { text } = buildContradictionProbe({
      finding: contradiction({ slotKeys: ['   '] }), // whitespace-only key → trimmed = ''
      statement: 's',
      raisedAtTurnIndex: 0,
      labels: labels([['   ', '   ']]), // label also trims to '' → skipped
      dataMode: false,
    });
    // The consequence sentence should NOT contain " about " since no topics resolved.
    expect(text).not.toContain(' about ');
    // But the consequence sentence IS still present.
    expect(text.toLowerCase()).toContain('update your earlier answer');
  });

  it('falls back to the question label when dataSlotLabels map does not contain the key', () => {
    // dataSlotLabels exists but lacks the slot key → affectedTopics falls through to questionLabels.
    const { text } = buildContradictionProbe({
      finding: contradiction({ slotKeys: ['mood'] }),
      statement: 's',
      raisedAtTurnIndex: 0,
      labels: {
        questionLabels: new Map([['mood', 'How are you feeling?']]),
        dataSlotLabels: new Map([['other-key', 'Other Data Slot']]),
      },
      dataMode: false,
    });
    // The question label is the fallback when the data-slot map misses the key.
    expect(text).toContain('How are you feeling?');
    expect(text).not.toContain('Other Data Slot');
  });

  it('de-duplicates topics that resolve to the same trimmed, case-insensitive label', () => {
    // Two slot keys resolving to the same label (case-insensitive) must appear only once.
    const { text } = buildContradictionProbe({
      finding: contradiction({ slotKeys: ['q1', 'q2'] }),
      statement: 's',
      raisedAtTurnIndex: 0,
      labels: labels([
        ['q1', 'Satisfaction'],
        ['q2', 'satisfaction'], // lowercase duplicate — should be de-duplicated
      ]),
      dataMode: false,
    });
    // Only one "Satisfaction" in the topic clause — not "Satisfaction and satisfaction".
    const aboutClause = text.slice(text.indexOf(' about '));
    const occurrences = (aboutClause.toLowerCase().match(/satisfaction/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('formats three or more topics with Oxford-style "a, b and c" (no Oxford comma)', () => {
    // humanJoin: 3 items → "a, b and c"
    const { text } = buildContradictionProbe({
      finding: contradiction({ slotKeys: ['q1', 'q2', 'q3'] }),
      statement: 's',
      raisedAtTurnIndex: 0,
      labels: labels([
        ['q1', 'Alpha'],
        ['q2', 'Beta'],
        ['q3', 'Gamma'],
      ]),
      dataMode: false,
    });
    expect(text).toContain('Alpha, Beta and Gamma');
  });

  it('omits suggestedProbe from the pending record when the finding has none', () => {
    // The pending spread only includes suggestedProbe when finding.suggestedProbe !== undefined.
    const { pending } = buildContradictionProbe({
      finding: contradiction({ slotKeys: ['a'] }), // fixture has no suggestedProbe
      statement: 's',
      raisedAtTurnIndex: 1,
      labels: labels([['a', 'Topic A']]),
      dataMode: false,
    });
    // Confirm the property is absent (not just undefined — it must not be in the object).
    expect(Object.prototype.hasOwnProperty.call(pending, 'suggestedProbe')).toBe(false);
  });

  it('falls back to the raw slot key when neither label map has an entry for it', () => {
    // affectedTopics final fallback: if neither dataSlotLabels nor questionLabels has the key,
    // the key itself is used as the topic label.
    const { text } = buildContradictionProbe({
      finding: contradiction({ slotKeys: ['raw_slot_key'] }),
      statement: 's',
      raisedAtTurnIndex: 0,
      labels: {
        questionLabels: new Map(), // no entry
        dataSlotLabels: new Map(), // no entry
      },
      dataMode: false,
    });
    // The key itself appears in the topic clause.
    expect(text).toContain('raw_slot_key');
  });
});

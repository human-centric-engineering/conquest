import { describe, expect, it } from 'vitest';

import {
  buildContradictionProbe,
  buildContradictionNoticeMessage,
  DEFAULT_RECONCILIATION_QUESTION,
  HUMBLE_RECONCILIATION_QUESTION,
  CLEAR_CONTRADICTION_CONFIDENCE,
} from '@/lib/app/questionnaire/contradiction/probe-flow';

import { contradiction } from '@/tests/unit/lib/app/questionnaire/contradiction/_fixtures';

const labels = (entries: Array<[string, string]>) => ({ questionLabels: new Map(entries) });

describe('buildContradictionProbe (single finding)', () => {
  it('uses the finding probe and states the consequence with the topic name', () => {
    const { text, pending } = buildContradictionProbe({
      findings: [
        contradiction({
          slotKeys: ['satisfaction'],
          explanation: 'hate vs love',
          suggestedProbe: 'Which reflects how you feel?',
        }),
      ],
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
    // The pending record carries the finding + the triggering statement, and the per-conflict list.
    expect(pending).toMatchObject({
      slotKeys: ['satisfaction'],
      explanation: 'hate vs love',
      suggestedProbe: 'Which reflects how you feel?',
      statement: 'I love my job',
      raisedAtTurnIndex: 2,
      findings: [{ slotKeys: ['satisfaction'], explanation: 'hate vs love' }],
    });
  });

  it('falls back to the direct default question for a clear-cut (high-confidence) finding with no probe', () => {
    const { text } = buildContradictionProbe({
      // fixture defaults confidence to 0.8 = CLEAR_CONTRADICTION_CONFIDENCE → direct default
      findings: [contradiction({ slotKeys: ['a'] })],
      statement: 's',
      raisedAtTurnIndex: 0,
      labels: labels([['a', 'Topic A']]),
      dataMode: false,
    });
    expect(text).toContain(DEFAULT_RECONCILIATION_QUESTION);
    expect(text).not.toContain(HUMBLE_RECONCILIATION_QUESTION);
  });

  it('falls back to the HUMBLE default question for a subtle (low-confidence) finding with no probe', () => {
    const { text } = buildContradictionProbe({
      findings: [contradiction({ slotKeys: ['a'], confidence: 0.5 })],
      statement: 's',
      raisedAtTurnIndex: 0,
      labels: labels([['a', 'Topic A']]),
      dataMode: false,
    });
    expect(text).toContain(HUMBLE_RECONCILIATION_QUESTION);
    expect(text).toContain("Forgive me if I've misunderstood"); // the humility opener
    expect(text).not.toContain(DEFAULT_RECONCILIATION_QUESTION);
  });

  it('treats confidence exactly at the threshold as clear-cut (direct default)', () => {
    const { text } = buildContradictionProbe({
      findings: [contradiction({ slotKeys: ['a'], confidence: CLEAR_CONTRADICTION_CONFIDENCE })],
      statement: 's',
      raisedAtTurnIndex: 0,
      labels: labels([['a', 'Topic A']]),
      dataMode: false,
    });
    expect(text).toContain(DEFAULT_RECONCILIATION_QUESTION);
  });

  it('prefers the detector-authored probe over either default regardless of confidence', () => {
    const { text } = buildContradictionProbe({
      // low confidence would pick the humble default, but an explicit probe always wins
      findings: [
        contradiction({
          slotKeys: ['a'],
          confidence: 0.4,
          suggestedProbe: 'It seems these point different ways — which fits best?',
        }),
      ],
      statement: 's',
      raisedAtTurnIndex: 0,
      labels: labels([['a', 'Topic A']]),
      dataMode: false,
    });
    expect(text).toContain('It seems these point different ways — which fits best?');
    expect(text).not.toContain(HUMBLE_RECONCILIATION_QUESTION);
    expect(text).not.toContain(DEFAULT_RECONCILIATION_QUESTION);
  });

  it('prefers the data-slot label and the data-mode noun in data-slot mode', () => {
    const { text } = buildContradictionProbe({
      findings: [contradiction({ slotKeys: ['satisfaction'] })],
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

  it('lists multiple conflicting topics of a single finding, de-duplicated', () => {
    const { text } = buildContradictionProbe({
      findings: [contradiction({ slotKeys: ['a', 'b'] })],
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
      findings: [contradiction({ slotKeys: ['   '] })], // whitespace-only key → trimmed = ''
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
      findings: [contradiction({ slotKeys: ['mood'] })],
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
      findings: [contradiction({ slotKeys: ['q1', 'q2'] })],
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
      findings: [contradiction({ slotKeys: ['q1', 'q2', 'q3'] })],
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
    // The pending spread only includes suggestedProbe when a finding carries one.
    const { pending } = buildContradictionProbe({
      findings: [contradiction({ slotKeys: ['a'] })], // fixture has no suggestedProbe
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
      findings: [contradiction({ slotKeys: ['raw_slot_key'] })],
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

describe('buildContradictionProbe (several conflicts in one turn)', () => {
  it('raises each conflict as a numbered point, names every topic, and parks them all', () => {
    const { text, pending } = buildContradictionProbe({
      findings: [
        contradiction({ slotKeys: ['a'], explanation: 'A1 vs A2', suggestedProbe: 'Which on A?' }),
        contradiction({ slotKeys: ['b'], explanation: 'B1 vs B2', suggestedProbe: 'Which on B?' }),
      ],
      statement: 'both flipped',
      raisedAtTurnIndex: 3,
      labels: labels([
        ['a', 'Satisfaction'],
        ['b', 'Recommendation'],
      ]),
      dataMode: false,
    });
    // Both per-conflict probes appear, as numbered points.
    expect(text).toContain('1. Which on A?');
    expect(text).toContain('2. Which on B?');
    // One consequence, naming every affected topic and using the plural noun.
    expect(text).toContain('update your earlier answers about Satisfaction and Recommendation');
    // Exactly one consequence sentence.
    expect(text.match(/update your earlier answers/g)).toHaveLength(1);
    // The pending parks the UNION for the merged refiner trigger, plus each conflict separately.
    expect(pending.slotKeys).toEqual(['a', 'b']);
    expect(pending.findings).toEqual([
      { slotKeys: ['a'], explanation: 'A1 vs A2', suggestedProbe: 'Which on A?' },
      { slotKeys: ['b'], explanation: 'B1 vs B2', suggestedProbe: 'Which on B?' },
    ]);
  });
});

describe('buildContradictionNoticeMessage', () => {
  it('returns the lone explanation verbatim for a single finding', () => {
    const msg = buildContradictionNoticeMessage([
      contradiction({ slotKeys: ['a'], explanation: 'hate vs love' }),
    ]);
    expect(msg).toBe('hate vs love');
  });

  it('combines several explanations into one numbered notice box', () => {
    const msg = buildContradictionNoticeMessage([
      contradiction({ slotKeys: ['a'], explanation: 'A conflict' }),
      contradiction({ slotKeys: ['b'], explanation: 'B conflict' }),
    ]);
    expect(msg).toContain('might not quite line up');
    expect(msg).toContain('1. A conflict');
    expect(msg).toContain('2. B conflict');
  });

  it('returns an empty string for no findings (defensive)', () => {
    expect(buildContradictionNoticeMessage([])).toBe('');
  });
});

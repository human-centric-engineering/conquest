/**
 * Unit tests for the incremental "questions so far" scanner.
 *
 * The scanner underpins the live extraction count: fed the extractor's streamed
 * JSON deltas, it must report exactly how many complete `questions` array entries
 * have closed so far — regardless of chunk boundaries, key order, nested
 * containers, or brace/quote characters inside string values. These tests are the
 * regression net for that contract.
 *
 * @see lib/app/questionnaire/ingestion/question-count-scanner.ts
 */

import { describe, it, expect } from 'vitest';

import { createQuestionCountScanner } from '@/lib/app/questionnaire/ingestion/question-count-scanner';

/** Feed `text` to a fresh scanner in fixed-size chunks; return the final count. */
function scanInChunks(text: string, chunkSize: number): number {
  const scanner = createQuestionCountScanner();
  let last = 0;
  for (let i = 0; i < text.length; i += chunkSize) {
    last = scanner.push(text.slice(i, i + chunkSize));
  }
  return last;
}

/** Feed `text` and capture the running count after every single character. */
function countTimeline(text: string): number[] {
  const scanner = createQuestionCountScanner();
  const timeline: number[] = [];
  for (const ch of text) timeline.push(scanner.push(ch));
  return timeline;
}

// A realistic extraction payload: sections first, two questions (one with a
// nested config object holding an array of option objects, one endpoint-anchored
// likert), then a changes array — plus adversarial content (braces/brackets and
// an escaped quote inside string values).
const DOC = JSON.stringify({
  sections: [{ ordinal: 1, title: 'Section A {with braces}' }],
  questions: [
    {
      key: 'q1',
      prompt: 'How satisfied are you? [rate below]',
      suggestedType: 'single_choice',
      suggestedTypeConfig: {
        choices: [
          { value: 'never', label: 'Never' },
          { value: 'always', label: 'Always' },
        ],
        allowOther: true,
      },
    },
    {
      key: 'q2',
      prompt: 'Rate the "quality" of service',
      suggestedType: 'likert',
      suggestedTypeConfig: { min: 1, max: 5, minLabel: 'Low', maxLabel: 'High' },
    },
  ],
  changes: [{ changeType: 'infer_type', targetEntityType: 'question' }],
});

describe('createQuestionCountScanner', () => {
  it('counts exactly the top-level questions entries in a complete document', () => {
    const scanner = createQuestionCountScanner();
    expect(scanner.push(DOC)).toBe(2);
    expect(scanner.count).toBe(2);
  });

  it('does not count nested config objects, option objects, section or change objects', () => {
    // DOC has 2 questions but many other objects: 1 section, 2 choice objects,
    // 2 config objects, 1 change object. A naive brace-counter would overcount.
    expect(createQuestionCountScanner().push(DOC)).toBe(2);
  });

  it('is invariant to chunk size (split anywhere, including mid-string/mid-escape)', () => {
    for (const size of [1, 2, 3, 5, 7, 13, 50, 500]) {
      expect(scanInChunks(DOC, size)).toBe(2);
    }
  });

  it('reports a monotonically non-decreasing count that reaches 2', () => {
    const timeline = countTimeline(DOC);
    for (let i = 1; i < timeline.length; i += 1) {
      expect(timeline[i]).toBeGreaterThanOrEqual(timeline[i - 1]);
    }
    expect(timeline[timeline.length - 1]).toBe(2);
  });

  it('increments only when a question object actually closes', () => {
    const scanner = createQuestionCountScanner();
    // Open the document and the questions array with a partial first question.
    expect(scanner.push('{"questions":[{"key":"q1","prompt":"hi"')).toBe(0);
    // Close the first question → 1.
    expect(scanner.push('}')).toBe(1);
    // A nested object inside the second question must not tick the count.
    expect(scanner.push(',{"key":"q2","config":{"min":1,"max":5}')).toBe(1);
    // Closing the second question → 2.
    expect(scanner.push('}')).toBe(2);
    // Closing the array and document does not add phantom counts.
    expect(scanner.push(']}')).toBe(2);
  });

  it('is order-independent — counts questions emitted before sections', () => {
    const reordered = JSON.stringify({
      questions: [
        { key: 'a', prompt: 'first' },
        { key: 'b', prompt: 'second' },
        { key: 'c', prompt: 'third' },
      ],
      sections: [{ ordinal: 1, title: 'later' }],
    });
    expect(createQuestionCountScanner().push(reordered)).toBe(3);
  });

  it('does not over-count a nested array literally named "questions" inside a question', () => {
    // `suggestedTypeConfig` / `changes[].beforeJson` are open-ended in the schema,
    // so the model could emit a nested field named `questions`. Only the TOP-LEVEL
    // `questions` array counts — a nested same-named array must not inflate it.
    const doc = JSON.stringify({
      sections: [],
      questions: [
        {
          key: 'q1',
          prompt: 'P1',
          suggestedType: 'single_choice',
          suggestedTypeConfig: { questions: [{ x: 1 }, { y: 2 }] },
        },
      ],
      changes: [{ beforeJson: { questions: [{ a: 1 }] } }],
    });
    expect(createQuestionCountScanner().push(doc)).toBe(1);
    // Also holds when the tricky nesting straddles chunk boundaries.
    expect(scanInChunks(doc, 3)).toBe(1);
  });

  it('ignores objects in a different array even when its key contains "question"', () => {
    // A sibling array whose key merely resembles the anchor must not be counted;
    // only the exact top-level `questions` array elements count.
    const doc = JSON.stringify({
      questionGroups: [{ id: 1 }, { id: 2 }],
      questions: [{ key: 'q1' }],
    });
    expect(createQuestionCountScanner().push(doc)).toBe(1);
  });

  it('handles brace and bracket characters inside string values without miscounting', () => {
    const doc = JSON.stringify({
      questions: [
        { key: 'q1', prompt: 'use } and { and ] and [ literally' },
        { key: 'q2', prompt: 'JSON-ish: {"a":[1,2]}' },
      ],
    });
    expect(createQuestionCountScanner().push(doc)).toBe(2);
    // And the same holds when the tricky string straddles chunk boundaries.
    expect(scanInChunks(doc, 4)).toBe(2);
  });

  it('handles escaped quotes and backslashes in string values', () => {
    const doc = JSON.stringify({
      questions: [
        { key: 'q1', prompt: 'she said "hello" and left' },
        { key: 'q2', prompt: 'path C:\\temp\\file "quoted"' },
      ],
    });
    expect(createQuestionCountScanner().push(doc)).toBe(2);
    expect(scanInChunks(doc, 1)).toBe(2);
  });

  it('returns 0 for an empty questions array', () => {
    const doc = JSON.stringify({ sections: [{ ordinal: 1 }], questions: [], changes: [] });
    expect(createQuestionCountScanner().push(doc)).toBe(0);
  });

  it('returns 0 before the first question closes', () => {
    const scanner = createQuestionCountScanner();
    scanner.push('{"sections":[{"ordinal":1,"title":"A"}],"questions":[');
    expect(scanner.count).toBe(0);
  });

  it('counts a matrix question with a nested rows array of objects as one', () => {
    const doc = JSON.stringify({
      questions: [
        {
          key: 'grid',
          suggestedType: 'matrix',
          suggestedTypeConfig: {
            rows: [
              { key: 'fuel', label: 'Fuel efficiency' },
              { key: 'reliability', label: 'Reliability' },
            ],
            scale: { min: 1, max: 5, minLabel: 'Not important', maxLabel: 'Essential' },
          },
        },
      ],
    });
    expect(createQuestionCountScanner().push(doc)).toBe(1);
  });
});

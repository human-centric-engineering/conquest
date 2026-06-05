import { describe, expect, it } from 'vitest';

import {
  buildContradictionDetectionPrompt,
  buildContradictionDetectionRetryMessage,
} from '@/lib/app/questionnaire/contradiction/detection-prompt';
import type { LlmMessage } from '@/lib/orchestration/llm/types';

import {
  answered,
  choiceSlot,
  ctx,
  slot,
} from '@/tests/unit/lib/app/questionnaire/contradiction/_fixtures';

/** Narrow a message's `content` (string | ContentPart[]) to a plain string. */
function text(message: LlmMessage | undefined): string {
  return typeof message?.content === 'string' ? message.content : '';
}

describe('buildContradictionDetectionPrompt', () => {
  it('returns a system + user message pair', () => {
    const messages = buildContradictionDetectionPrompt(
      ctx({ answers: [answered({ slotKey: 'a' }), answered({ slotKey: 'b' })] })
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });

  it('lists each answered question with its key and value', () => {
    const context = ctx({
      slots: [
        slot({ key: 'has_children', prompt: 'Do you have children?' }),
        slot({ key: 'children_count', prompt: 'How many children?' }),
      ],
      answers: [
        answered({ slotKey: 'has_children', value: 'no' }),
        answered({ slotKey: 'children_count', value: 2 }),
      ],
    });
    const user = text(buildContradictionDetectionPrompt(context)[1]);
    expect(user).toContain('key: has_children');
    expect(user).toContain('Do you have children?');
    expect(user).toContain('answer: no');
    expect(user).toContain('answer: 2');
  });

  it('renders array values and choice options', () => {
    const context = ctx({
      slots: [choiceSlot('diet', 'multi_choice', 'vegan', 'meat')],
      answers: [answered({ slotKey: 'diet', value: ['vegan', 'meat'] })],
    });
    const user = text(buildContradictionDetectionPrompt(context)[1]);
    expect(user).toContain('answer: vegan, meat');
    expect(user).toContain('options: vegan (VEGAN), meat (MEAT)');
  });

  it('skips answers whose slot has no definition (defensive)', () => {
    const context = ctx({
      slots: [slot({ key: 'a', prompt: 'Question A' })],
      answers: [answered({ slotKey: 'a' }), answered({ slotKey: 'orphan' })],
    });
    const user = text(buildContradictionDetectionPrompt(context)[1]);
    expect(user).toContain('Question A');
    expect(user).not.toContain('orphan');
  });

  it('requests a suggestedProbe only under probe mode', () => {
    const base = { answers: [answered({ slotKey: 'a' }), answered({ slotKey: 'b' })] };
    const probeSystem = text(buildContradictionDetectionPrompt(ctx({ ...base, mode: 'probe' }))[0]);
    const flagSystem = text(buildContradictionDetectionPrompt(ctx({ ...base, mode: 'flag' }))[0]);
    expect(probeSystem).toContain('suggestedProbe');
    expect(flagSystem).not.toContain('suggestedProbe');
  });

  it('names the severity vocabulary in the system rules', () => {
    const system = text(
      buildContradictionDetectionPrompt(ctx({ answers: [answered({ slotKey: 'a' })] }))[0]
    );
    expect(system).toContain('low, medium, high');
  });

  it('renders likert scale + guidelines, and object / null / array-of-object values', () => {
    const context = ctx({
      slots: [
        slot({
          key: 'rating',
          type: 'likert',
          typeConfig: { min: 1, max: 5 },
          guidelines: '1=low',
        }),
        slot({ key: 'meta', prompt: 'Meta?' }),
        slot({ key: 'blank', prompt: 'Blank?' }),
        slot({ key: 'tags', prompt: 'Tags?' }),
      ],
      answers: [
        answered({ slotKey: 'rating', value: 4 }),
        // object value → renderValue JSON.stringify; confidence null → no confidence line
        answered({ slotKey: 'meta', value: { a: 1 }, confidence: null }),
        // null value built inline — the `answered` fixture would default it away
        { slotKey: 'blank', value: null, confidence: null },
        // array carrying an object → renderScalar JSON.stringify fallback
        answered({ slotKey: 'tags', value: ['vegan', { note: 'x' }] }),
      ],
    });
    const user = text(buildContradictionDetectionPrompt(context)[1]);
    expect(user).toContain('scale: 1–5');
    expect(user).toContain('guidelines: 1=low');
    expect(user).toContain('answer: {"a":1}');
    expect(user).toContain('answer: (none)');
    expect(user).toContain('answer: vegan, {"note":"x"}');
    // confidence line present for the numbered answer, absent for the null one
    expect(user).toContain('answer_confidence: 0.9');
  });
});

describe('buildContradictionDetectionRetryMessage', () => {
  it('names the failed field paths when present', () => {
    const message = buildContradictionDetectionRetryMessage([
      'contradictions.0.severity',
      'contradictions.0.confidence',
    ]);
    expect(message).toContain('contradictions.0.severity');
    expect(message).toContain('contradictions.0.confidence');
    expect(message).toContain('{ "contradictions": [ ... ] }');
  });

  it('falls back to a generic message when no paths are given', () => {
    const message = buildContradictionDetectionRetryMessage([]);
    expect(message).toContain('not valid JSON');
  });
});

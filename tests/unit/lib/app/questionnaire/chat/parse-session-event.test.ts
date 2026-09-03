/**
 * parseSessionEvent — narrowing the respondent `/messages` SSE subset.
 *
 * @see lib/app/questionnaire/chat/parse-session-event.ts
 */

import { describe, it, expect } from 'vitest';

import { parseSessionEvent } from '@/lib/app/questionnaire/chat/parse-session-event';

/** Build a well-formed SSE block (the parser is fed one block at a time). */
function block(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}`;
}

describe('parseSessionEvent', () => {
  it('parses a start frame', () => {
    expect(parseSessionEvent(block('start', { conversationId: 's1', messageId: 's1' }))).toEqual({
      type: 'start',
      conversationId: 's1',
      messageId: 's1',
    });
  });

  it('parses a status frame (the live turn stage)', () => {
    expect(parseSessionEvent(block('status', { message: 'Reading your answer…' }))).toEqual({
      type: 'status',
      message: 'Reading your answer…',
    });
  });

  it('drops a blank or whitespace-only status rather than blanking the indicator', () => {
    // An empty label would clear the wait cue mid-turn, which reads as the reply having arrived.
    expect(parseSessionEvent(block('status', { message: '' }))).toBeNull();
    expect(parseSessionEvent(block('status', { message: '   ' }))).toBeNull();
  });

  it('drops a status frame whose message is missing or the wrong type', () => {
    expect(parseSessionEvent(block('status', {}))).toBeNull();
    expect(parseSessionEvent(block('status', { message: 42 }))).toBeNull();
  });

  it('parses a content delta', () => {
    expect(parseSessionEvent(block('content', { delta: 'Hello' }))).toEqual({
      type: 'content',
      delta: 'Hello',
    });
  });

  it('parses a warning frame', () => {
    expect(
      parseSessionEvent(
        block('warning', { code: 'CONTRADICTION', message: 'That differs from earlier.' })
      )
    ).toEqual({ type: 'warning', code: 'CONTRADICTION', message: 'That differs from earlier.' });
  });

  it('parses a done frame and defaults a missing cost to 0', () => {
    expect(parseSessionEvent(block('done', { tokenUsage: {}, costUsd: 0.0021 }))).toEqual({
      type: 'done',
      costUsd: 0.0021,
    });
    expect(parseSessionEvent(block('done', {}))).toEqual({ type: 'done', costUsd: 0 });
  });

  it('parses an error frame with code/message fallbacks', () => {
    expect(parseSessionEvent(block('error', { code: 'BOOM', message: 'nope' }))).toEqual({
      type: 'error',
      code: 'BOOM',
      message: 'nope',
    });
    expect(parseSessionEvent(block('error', {}))).toEqual({
      type: 'error',
      code: 'STREAM_ERROR',
      message: 'Something went wrong.',
    });
  });

  it('parses a warning frame with an optional rationale detail', () => {
    expect(
      parseSessionEvent(
        block('warning', {
          code: 'seriousness',
          message: 'set aside',
          detail: 'reads as off-topic',
        })
      )
    ).toEqual({
      type: 'warning',
      code: 'seriousness',
      message: 'set aside',
      detail: 'reads as off-topic',
    });
    // A non-string detail is dropped, not propagated.
    expect(parseSessionEvent(block('warning', { code: 'c', message: 'm', detail: 42 }))).toEqual({
      type: 'warning',
      code: 'c',
      message: 'm',
    });
  });

  it('parses a reasoning frame, keeping optional fields and dropping malformed steps', () => {
    const parsed = parseSessionEvent(
      block('reasoning', {
        steps: [
          {
            kind: 'extraction',
            label: 'Captured "Budget"',
            tone: 'insight',
            detail: 'Inferred · medium confidence',
            confidence: 0.6,
            provenance: 'inferred',
          },
          { kind: 'not_a_kind', label: 'x', tone: 'insight' }, // bad kind — dropped
          { label: 'no kind or tone' }, // missing required — dropped
          null, // null element — typeof 'object' but === null guard drops it
          'just a string', // non-object primitive — dropped
        ],
      })
    );
    expect(parsed).toEqual({
      type: 'reasoning',
      steps: [
        {
          kind: 'extraction',
          label: 'Captured "Budget"',
          tone: 'insight',
          detail: 'Inferred · medium confidence',
          confidence: 0.6,
          provenance: 'inferred',
        },
      ],
    });
  });

  it('returns null for a reasoning frame with no valid steps', () => {
    expect(parseSessionEvent(block('reasoning', { steps: [{ kind: 'bogus' }] }))).toBeNull();
    expect(parseSessionEvent(block('reasoning', { steps: [] }))).toBeNull();
    expect(parseSessionEvent(block('reasoning', { notSteps: 1 }))).toBeNull();
  });

  it('parses an inspector frame (admin-only), keeping optional token fields', () => {
    const event = parseSessionEvent(
      block('inspector', {
        turnIndex: 2,
        calls: [
          {
            label: 'Answer extraction',
            model: 'gpt-4o-mini',
            provider: 'openai',
            latencyMs: 412,
            costUsd: 0.0013,
            tokensIn: 900,
            tokensOut: 40,
            prompt: [{ role: 'input', content: '{"userMessage":"..."}' }],
            response: '{"intents":[]}',
          },
          // Minimal call: missing optional model/provider/tokens → defaulted, not dropped.
          { label: 'Question selection', prompt: [], response: '' },
        ],
      })
    );
    expect(event).toEqual({
      type: 'inspector',
      turnIndex: 2,
      calls: [
        {
          label: 'Answer extraction',
          model: 'gpt-4o-mini',
          provider: 'openai',
          latencyMs: 412,
          costUsd: 0.0013,
          tokensIn: 900,
          tokensOut: 40,
          prompt: [{ role: 'input', content: '{"userMessage":"..."}' }],
          response: '{"intents":[]}',
        },
        {
          label: 'Question selection',
          model: '',
          provider: '',
          latencyMs: 0,
          costUsd: 0,
          prompt: [],
          response: '',
        },
      ],
    });
  });

  it('drops malformed inspector calls and returns null when none survive', () => {
    // A call with no label is dropped; with all dropped the frame is null.
    expect(parseSessionEvent(block('inspector', { calls: [{ model: 'x' }] }))).toBeNull();
    expect(parseSessionEvent(block('inspector', { calls: [] }))).toBeNull();
    expect(parseSessionEvent(block('inspector', { notCalls: 1 }))).toBeNull();
  });

  it('returns null for unknown event types', () => {
    expect(
      parseSessionEvent(block('capability_result', { capabilitySlug: 'x', result: 1 }))
    ).toBeNull();
  });

  it('returns null for keepalive comment blocks', () => {
    expect(parseSessionEvent(': keepalive')).toBeNull();
  });

  it('returns null when a content frame is missing its delta', () => {
    expect(parseSessionEvent(block('content', { notDelta: 'x' }))).toBeNull();
  });

  it('returns null when a content delta is the wrong type', () => {
    expect(parseSessionEvent(block('content', { delta: 42 }))).toBeNull();
  });

  it('returns null when a start frame is missing ids', () => {
    expect(parseSessionEvent(block('start', { conversationId: 's1' }))).toBeNull();
  });

  it('returns null for malformed JSON payloads', () => {
    expect(parseSessionEvent('event: content\ndata: {not json}')).toBeNull();
  });

  it('returns null for a warning frame missing message', () => {
    // code present, message absent — asString(undefined) returns null → guard fires
    expect(parseSessionEvent(block('warning', { code: 'C' }))).toBeNull();
  });

  it('returns null for a warning frame missing code', () => {
    // message present, code absent — asString(undefined) returns null → guard fires
    expect(parseSessionEvent(block('warning', { message: 'M' }))).toBeNull();
  });

  it('returns null for a warning frame with a non-string code', () => {
    // code is a number — asString(42) returns null → guard fires
    expect(parseSessionEvent(block('warning', { code: 42, message: 'M' }))).toBeNull();
  });
});

describe('question_card frames (P18)', () => {
  const frame = (data: unknown) => `event: question_card\ndata: ${JSON.stringify(data)}`;

  it('narrows a well-formed card', () => {
    const parsed = parseSessionEvent(
      frame({
        card: {
          questionKey: 'workload',
          prompt: 'How satisfied are you with your current workload?',
          type: 'likert',
          typeConfig: { min: 1, max: 5 },
          required: true,
          reason: 'must_ask',
        },
      })
    );
    expect(parsed).toEqual({
      type: 'question_card',
      card: {
        questionKey: 'workload',
        prompt: 'How satisfied are you with your current workload?',
        type: 'likert',
        typeConfig: { min: 1, max: 5 },
        required: true,
        reason: 'must_ask',
      },
    });
  });

  it('drops a card missing the fields its Submit needs', () => {
    // Rendering a half-formed card is worse than rendering none: the interviewer's prose still asked
    // the question, so the respondent can answer in the composer — but a card with no questionKey
    // would give them a control whose Submit has nowhere to write.
    expect(parseSessionEvent(frame({ card: { prompt: 'x', type: 'likert' } }))).toBeNull();
    expect(parseSessionEvent(frame({ card: { questionKey: 'w', type: 'likert' } }))).toBeNull();
    expect(parseSessionEvent(frame({ card: { questionKey: 'w', prompt: 'x' } }))).toBeNull();
    expect(parseSessionEvent(frame({}))).toBeNull();
  });

  it('preserves a last_resort reason', () => {
    // The two reasons drive different respondent-facing copy — collapsing them would label a
    // fallback as a deliberate design.
    const parsed = parseSessionEvent(
      frame({ card: { questionKey: 'w', prompt: 'x', type: 'likert', reason: 'last_resort' } })
    );
    expect(parsed).toMatchObject({ card: { reason: 'last_resort' } });
  });

  it('drops a card whose type is not a known question type', () => {
    expect(
      parseSessionEvent(frame({ card: { questionKey: 'w', prompt: 'x', type: 'slider' } }))
    ).toBeNull();
  });

  it('defaults required to false and an unknown reason to must_ask', () => {
    const parsed = parseSessionEvent(
      frame({ card: { questionKey: 'w', prompt: 'x', type: 'boolean' } })
    );
    expect(parsed).toMatchObject({
      card: { required: false, reason: 'must_ask', typeConfig: null },
    });
  });
});

describe('section_covered frames (P21)', () => {
  const frame = (data: unknown) => `event: section_covered\ndata: ${JSON.stringify(data)}`;

  it('narrows the handover the reply just announced', () => {
    expect(parseSessionEvent(frame({ sectionKey: 'about', nextLabel: 'Growth Strategy' }))).toEqual(
      {
        type: 'section_covered',
        sectionKey: 'about',
        nextLabel: 'Growth Strategy',
      }
    );
  });

  it('drops a frame missing either half of the move', () => {
    // Both are load-bearing. Without the key there is no part to finish; without the label the cue
    // would have to name the destination in the abstract, and the surface would be holding a beat
    // for a move it cannot describe. Dropping it leaves the respondent with the reply and their own
    // "Move on" control, which is a safe place to land.
    expect(parseSessionEvent(frame({ nextLabel: 'Growth Strategy' }))).toBeNull();
    expect(parseSessionEvent(frame({ sectionKey: 'about' }))).toBeNull();
    expect(parseSessionEvent(frame({}))).toBeNull();
  });

  it('drops a frame whose key or label is blank', () => {
    expect(parseSessionEvent(frame({ sectionKey: '', nextLabel: 'Growth Strategy' }))).toBeNull();
    expect(parseSessionEvent(frame({ sectionKey: 'about', nextLabel: '' }))).toBeNull();
  });
});

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

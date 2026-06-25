/**
 * Likert label backfill — pure helpers.
 *
 * Pins the deterministic generic fallback (one word per point, endpoints anchored), the prompt
 * shape (carries the question + point count), and the strict parse of the model's decision
 * (label-every-point vs declare-numeric, with bounds-checked validation).
 *
 * @see lib/app/questionnaire/ingestion/likert-labels.ts
 */

import { describe, it, expect } from 'vitest';

import {
  genericLikertLabels,
  buildLikertLabelMessages,
  parseLikertLabelDecision,
} from '@/lib/app/questionnaire/ingestion/likert-labels';

describe('genericLikertLabels', () => {
  it('returns one word per point, ordered low→high', () => {
    const five = genericLikertLabels(1, 5);
    expect(five).toHaveLength(5);
    expect(five[0]).toBe('Very low');
    expect(five[4]).toBe('Very high');
    five.forEach((l) => expect(l.trim().length).toBeGreaterThan(0));
  });

  it('handles a non-1 minimum and a 2-point scale', () => {
    expect(genericLikertLabels(0, 10)).toHaveLength(11);
    expect(genericLikertLabels(-1, 0)).toEqual(['Very low', 'Very high']);
  });
});

describe('buildLikertLabelMessages', () => {
  it('includes the prompt and the exact point count', () => {
    const [system, user] = buildLikertLabelMessages({
      prompt: 'How satisfied are you?',
      min: 1,
      max: 5,
    });
    expect(system.role).toBe('system');
    expect(system.content).toContain('5 entries');
    expect(user.content).toContain('How satisfied are you?');
    expect(user.content).toContain('1 to 5');
  });
});

describe('parseLikertLabelDecision', () => {
  const bounds = { min: 1, max: 5 };

  it('parses a complete labels array', () => {
    const raw = JSON.stringify({ numeric: false, labels: ['a', 'b', 'c', 'd', 'e'] });
    expect(parseLikertLabelDecision(raw, bounds)).toEqual({
      numeric: false,
      labels: ['a', 'b', 'c', 'd', 'e'],
    });
  });

  it('trims labels and tolerates a ```json fence', () => {
    const raw = '```json\n{"numeric": false, "labels": [" Low ", "Mid", "High"]}\n```';
    expect(parseLikertLabelDecision(raw, { min: 1, max: 3 })).toEqual({
      numeric: false,
      labels: ['Low', 'Mid', 'High'],
    });
  });

  it('returns the numeric decision', () => {
    expect(parseLikertLabelDecision('{"numeric": true}', bounds)).toEqual({ numeric: true });
  });

  it('returns null for the wrong label count, a blank label, or malformed JSON', () => {
    expect(parseLikertLabelDecision('{"numeric": false, "labels": ["a","b"]}', bounds)).toBeNull();
    expect(
      parseLikertLabelDecision('{"numeric": false, "labels": ["a","","c","d","e"]}', bounds)
    ).toBeNull();
    expect(parseLikertLabelDecision('not json', bounds)).toBeNull();
    expect(parseLikertLabelDecision('{"numeric": false}', bounds)).toBeNull();
  });
});

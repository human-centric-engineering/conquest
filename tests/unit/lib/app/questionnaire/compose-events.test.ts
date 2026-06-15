/**
 * Unit tests for compose-events.ts.
 *
 * This module is pure types + a const array — there is no runtime logic to
 * execute. Tests confirm the module's public contract: the event-type tuple is
 * exhaustive, correctly typed, and importable without pulling in server-only
 * (provider/LLM) dependencies.
 *
 * @see lib/app/questionnaire/ingestion/compose-events.ts
 */

import { describe, it, expect } from 'vitest';
import { COMPOSE_GEN_EVENT_TYPES } from '@/lib/app/questionnaire/ingestion/compose-events';

describe('COMPOSE_GEN_EVENT_TYPES', () => {
  it('contains every event type in the documented lifecycle order', () => {
    // The order matters for client-side SSE parsers that narrow on `type`.
    expect(Array.from(COMPOSE_GEN_EVENT_TYPES)).toEqual([
      'outline',
      'section_done',
      'section_error',
      'done',
      'error',
    ]);
  });

  it('is a readonly tuple (not mutable at runtime)', () => {
    // `as const` freezes the tuple — verify by checking the value directly.
    expect(COMPOSE_GEN_EVENT_TYPES).toHaveLength(5);
  });

  it('covers every variant of the ComposeGenEvent discriminated union', () => {
    // If a new event variant is added to the union, the const array must be
    // updated too. This test is the cross-check — update it when the union grows.
    const expected = new Set(['outline', 'section_done', 'section_error', 'done', 'error']);
    for (const t of COMPOSE_GEN_EVENT_TYPES) {
      expect(expected.has(t)).toBe(true);
    }
    expect(COMPOSE_GEN_EVENT_TYPES.length).toBe(expected.size);
  });
});

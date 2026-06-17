/**
 * Turn Inspector plaintext serialization tests.
 *
 * formatInspectorCall / formatInspectorTurn / formatInspectorTurns back the drawer's copy-call,
 * copy-turn, and copy-all clipboard affordances. These tests pin the readable shape that lands in
 * the clipboard: metrics, raw prompt roles + content, the response, turn headers with counts, and
 * the optional-token / empty-input edge cases.
 *
 * @see lib/app/questionnaire/inspector/serialize.ts
 */

import { describe, it, expect } from 'vitest';

import {
  formatInspectorCall,
  formatInspectorTurn,
  formatInspectorTurns,
} from '@/lib/app/questionnaire/inspector/serialize';
import type { AgentCallTrace, TurnInspectorData } from '@/lib/app/questionnaire/inspector/types';

const extraction: AgentCallTrace = {
  label: 'Answer extraction',
  model: 'gpt-4o-mini',
  provider: 'openai',
  latencyMs: 412,
  costUsd: 0.0013,
  tokensIn: 900,
  tokensOut: 40,
  prompt: [{ role: 'input', content: '{"userMessage":"I rent a flat"}' }],
  response: '{"intents":[{"slotKey":"housing"}]}',
};

const phrasing: AgentCallTrace = {
  label: 'Interviewer phrasing',
  model: 'gpt-4o-mini',
  provider: 'openai',
  latencyMs: 1500,
  costUsd: 0,
  prompt: [{ role: 'system', content: 'You are a warm interviewer.' }],
  response: 'And whereabouts is that?',
};

describe('formatInspectorCall', () => {
  it('includes the metrics, every prompt message (role + content), and the response', () => {
    const out = formatInspectorCall(extraction);

    expect(out).toContain('Answer extraction');
    expect(out).toContain('Model:      gpt-4o-mini');
    expect(out).toContain('Provider:   openai');
    expect(out).toContain('Latency:    412ms');
    expect(out).toContain('Est. cost:  $0.0013');
    expect(out).toContain('Tokens in:  900');
    expect(out).toContain('Tokens out: 40');
    expect(out).toContain('[input]');
    expect(out).toContain('{"userMessage":"I rent a flat"}');
    expect(out).toContain('Response:');
    expect(out).toContain('{"intents":[{"slotKey":"housing"}]}');
  });

  it('prefixes a 1-based padded index when one is given', () => {
    expect(formatInspectorCall(extraction, 0).startsWith('[01] Answer extraction')).toBe(true);
    expect(formatInspectorCall(extraction, 9).startsWith('[10] Answer extraction')).toBe(true);
  });

  it('omits token lines when the call did not expose them, and renders a no-spend cost as $0', () => {
    const out = formatInspectorCall(phrasing);
    expect(out).not.toContain('Tokens in:');
    expect(out).not.toContain('Tokens out:');
    expect(out).toContain('Est. cost:  $0');
    // Seconds formatting for >= 1000ms.
    expect(out).toContain('Latency:    1.5s');
  });
});

describe('formatInspectorTurn', () => {
  it('renders a header with call count, summed latency, and summed cost, then each call', () => {
    const turn: TurnInspectorData = { turnIndex: 0, calls: [extraction, phrasing] };
    const out = formatInspectorTurn(turn);

    // 1-based turn number, plural calls, summed latency 412 + 1500 = 1.9s, summed cost $0.0013.
    expect(out).toContain('Turn 1 — 2 calls · 1.9s · $0.0013');
    expect(out).toContain('[01] Answer extraction');
    expect(out).toContain('[02] Interviewer phrasing');
  });

  it('singularises the call noun for a one-call turn', () => {
    const out = formatInspectorTurn({ turnIndex: 4, calls: [extraction] });
    expect(out).toContain('Turn 5 — 1 call ·');
  });
});

describe('formatInspectorTurns', () => {
  it('renders a session header with turn + call totals, then every turn', () => {
    const turns: TurnInspectorData[] = [
      { turnIndex: 0, calls: [extraction, phrasing] },
      { turnIndex: 1, calls: [extraction] },
    ];
    const out = formatInspectorTurns(turns);

    expect(out).toContain('=== Turn Inspector — 2 turns, 3 agent calls ===');
    expect(out).toContain('Turn 1 —');
    expect(out).toContain('Turn 2 —');
  });

  it('returns just the (zeroed, singular-safe) header for no turns', () => {
    expect(formatInspectorTurns([])).toBe('=== Turn Inspector — 0 turns, 0 agent calls ===');
  });
});

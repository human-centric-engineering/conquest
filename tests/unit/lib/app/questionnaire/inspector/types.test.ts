import { describe, expect, it } from 'vitest';

import {
  totalInspectorCostUsd,
  totalInspectorLatencyMs,
  totalInspectorTokensIn,
  totalInspectorTokensOut,
  type AgentCallTrace,
} from '@/lib/app/questionnaire/inspector/types';

/** Minimal trace with overridable cost/latency — the two fields the reducers read. */
function trace(overrides: Partial<AgentCallTrace>): AgentCallTrace {
  return {
    label: 'Test call',
    model: 'gpt-4o-mini',
    provider: 'openai',
    latencyMs: 0,
    costUsd: 0,
    prompt: [],
    response: '',
    ...overrides,
  };
}

describe('totalInspectorCostUsd', () => {
  it('sums finite per-call costs', () => {
    const calls = [trace({ costUsd: 0.01 }), trace({ costUsd: 0.025 }), trace({ costUsd: 0 })];
    expect(totalInspectorCostUsd(calls)).toBeCloseTo(0.035, 10);
  });

  it('treats non-finite costs as 0 (NaN / Infinity guard)', () => {
    const calls = [
      trace({ costUsd: 0.02 }),
      trace({ costUsd: Number.NaN }),
      trace({ costUsd: Number.POSITIVE_INFINITY }),
    ];
    expect(totalInspectorCostUsd(calls)).toBeCloseTo(0.02, 10);
  });

  it('returns 0 for no calls', () => {
    expect(totalInspectorCostUsd([])).toBe(0);
  });
});

describe('totalInspectorLatencyMs', () => {
  it('sums finite per-call latencies', () => {
    const calls = [trace({ latencyMs: 120 }), trace({ latencyMs: 80 })];
    expect(totalInspectorLatencyMs(calls)).toBe(200);
  });

  it('treats non-finite latencies as 0 (NaN / Infinity guard)', () => {
    const calls = [
      trace({ latencyMs: 150 }),
      trace({ latencyMs: Number.NaN }),
      trace({ latencyMs: Number.POSITIVE_INFINITY }),
    ];
    expect(totalInspectorLatencyMs(calls)).toBe(150);
  });

  it('returns 0 for no calls', () => {
    expect(totalInspectorLatencyMs([])).toBe(0);
  });
});

describe('totalInspectorTokensIn', () => {
  it('sums per-call input tokens, treating missing/non-finite as 0', () => {
    const calls = [
      trace({ tokensIn: 100 }),
      trace({ tokensIn: 40 }),
      trace({}), // tokensIn undefined → 0
      trace({ tokensIn: Number.NaN }), // non-finite → 0
    ];
    expect(totalInspectorTokensIn(calls)).toBe(140);
  });

  it('returns 0 for no calls', () => {
    expect(totalInspectorTokensIn([])).toBe(0);
  });
});

describe('totalInspectorTokensOut', () => {
  it('sums per-call output tokens, treating missing/non-finite as 0', () => {
    const calls = [
      trace({ tokensOut: 20 }),
      trace({ tokensOut: 5 }),
      trace({}), // tokensOut undefined → 0
      trace({ tokensOut: Number.POSITIVE_INFINITY }), // non-finite → 0
    ];
    expect(totalInspectorTokensOut(calls)).toBe(25);
  });

  it('returns 0 for no calls', () => {
    expect(totalInspectorTokensOut([])).toBe(0);
  });
});

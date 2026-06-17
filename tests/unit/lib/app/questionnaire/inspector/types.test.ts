import { describe, expect, it } from 'vitest';

import {
  totalInspectorCostUsd,
  totalInspectorLatencyMs,
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

/**
 * buildEmbeddingTrace tests.
 *
 * The helper maps an `embedText` result + a ranking summary onto an `embedding`-kind AgentCallTrace
 * the inspector renders distinctly. These pin the contract the drawer/serializer rely on: the
 * discriminator, input tokens carried, completion tokens omitted, dimensions set, and the
 * embedded text + ranking surfaced as prompt/response.
 *
 * @see lib/app/questionnaire/inspector/embedding-trace.ts
 */

import { describe, it, expect } from 'vitest';

import { buildEmbeddingTrace } from '@/lib/app/questionnaire/inspector/embedding-trace';

describe('buildEmbeddingTrace', () => {
  const trace = buildEmbeddingTrace({
    label: 'Extraction candidate ranking',
    embedded: 'I just moved house',
    rankingSummary: 'Ranked 62 questions → kept 25.',
    model: 'text-embedding-3-small',
    provider: 'openai',
    dimensions: 1536,
    inputTokens: 12,
    costUsd: 0.0000012,
    latencyMs: 41,
  });

  it('tags the trace as an embedding and carries the provenance', () => {
    expect(trace.kind).toBe('embedding');
    expect(trace.label).toBe('Extraction candidate ranking');
    expect(trace.model).toBe('text-embedding-3-small');
    expect(trace.provider).toBe('openai');
    expect(trace.dimensions).toBe(1536);
    expect(trace.latencyMs).toBe(41);
    expect(trace.costUsd).toBeCloseTo(0.0000012);
  });

  it('carries input tokens but omits completion tokens (embeddings have none)', () => {
    expect(trace.tokensIn).toBe(12);
    expect(trace.tokensOut).toBeUndefined();
  });

  it('surfaces the embedded text as the prompt and the ranking as the response', () => {
    expect(trace.prompt).toEqual([
      { role: 'input', content: 'Embedded (query): "I just moved house"' },
    ]);
    expect(trace.response).toBe('Ranked 62 questions → kept 25.');
  });
});

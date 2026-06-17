/**
 * Preview Turn Inspector — building an {@link AgentCallTrace} for an embedding call.
 *
 * Embedding calls (ranking question/data slots by similarity to the respondent's last message) are
 * worth surfacing in the inspector — they cost money and tokens and explain why a turn narrowed its
 * candidates the way it did. But an embedding isn't a chat completion: it has input tokens and a
 * vector width, but no completion tokens and no human-readable "response". This helper maps the
 * `embedText` result + a one-line ranking summary onto the trace shape, tagging `kind: 'embedding'`
 * so the drawer/serializer render it distinctly (the vector itself is never shown — the *ranking*
 * is the meaningful output).
 *
 * Pure: callers measure latency around their `embedText` call and pass it in. Recording is always on
 * the success path of a fail-soft embed (a failed embed degrades the turn; it produces no trace).
 */

import type { AgentCallTrace } from '@/lib/app/questionnaire/inspector/types';

export interface EmbeddingTraceInput {
  /** Human label, e.g. "Extraction candidate ranking", "Adaptive data-slot ranking". */
  label: string;
  /** The text that was embedded (the respondent's last message). */
  embedded: string;
  /** A one-line summary of what the embedding was used to rank, e.g. "Ranked 62 → kept 25 slots". */
  rankingSummary: string;
  /** Resolved model id from the embedder. */
  model: string;
  /** Resolved provider slug from the embedder. */
  provider: string;
  /** Embedding width. */
  dimensions: number;
  /** Input tokens billed for the embedding. */
  inputTokens: number;
  /** Estimated USD cost (0 for local providers / rate-table misses). */
  costUsd: number;
  /** Wall-clock latency measured around the `embedText` call. */
  latencyMs: number;
}

/** Build an `embedding`-kind {@link AgentCallTrace}. `tokensOut` is intentionally omitted. */
export function buildEmbeddingTrace(input: EmbeddingTraceInput): AgentCallTrace {
  return {
    kind: 'embedding',
    label: input.label,
    model: input.model,
    provider: input.provider,
    latencyMs: input.latencyMs,
    costUsd: input.costUsd,
    tokensIn: input.inputTokens,
    dimensions: input.dimensions,
    prompt: [{ role: 'input', content: `Embedded (query): "${input.embedded}"` }],
    response: input.rankingSummary,
  };
}

/**
 * Unit tests for the streaming structured-extraction runner.
 *
 * This runner streams the FIRST attempt (surfacing text deltas live) and retries
 * ONCE non-streaming at temperature 0. The tests pin the behaviours the extractor
 * depends on: deltas are surfaced in order, token usage is captured from the
 * stream's `done` chunk, a parse miss triggers exactly one temp-0 retry that does
 * NOT echo the malformed output, tokens are summed across attempts, a
 * progress-sink throw can't abort the run, and a final parse miss throws the
 * caller's diagnostic.
 *
 * @see lib/app/questionnaire/ingestion/stream-structured-extraction.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  calculateCost: vi.fn(() => ({ totalCostUsd: 0.01 })),
}));

import { runStreamingStructuredExtraction } from '@/lib/app/questionnaire/ingestion/stream-structured-extraction';
import type { LlmMessage, LlmOptions, StreamChunk } from '@/lib/orchestration/llm/types';

/** Build an async iterable of stream chunks from a plain array. */
async function* streamOf(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) yield chunk;
}

/** A fake provider whose chatStream/chat are vi mocks. */
function makeProvider(opts: {
  streamChunks: StreamChunk[];
  chatContent?: string;
  chatUsage?: { inputTokens: number; outputTokens: number };
}) {
  const chatStream = vi.fn((_messages: LlmMessage[], _options: LlmOptions) =>
    streamOf(opts.streamChunks)
  );
  const chat = vi.fn(async (_messages: LlmMessage[], _options: LlmOptions) => ({
    content: opts.chatContent ?? '',
    usage: opts.chatUsage ?? { inputTokens: 0, outputTokens: 0 },
    model: 'test-model',
    finishReason: 'stop' as const,
  }));
  // Only the two methods the runner uses are needed; cast through unknown.
  return { chatStream, chat } as unknown as Parameters<
    typeof runStreamingStructuredExtraction
  >[0]['provider'] & { chatStream: typeof chatStream; chat: typeof chat };
}

const MESSAGES: LlmMessage[] = [{ role: 'user', content: 'extract' }];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runStreamingStructuredExtraction', () => {
  it('assembles streamed text, parses it, and returns usage from the done chunk', async () => {
    const provider = makeProvider({
      streamChunks: [
        { type: 'text', content: '{"ok"' },
        { type: 'text', content: ':true}' },
        { type: 'done', usage: { inputTokens: 100, outputTokens: 40 }, finishReason: 'stop' },
      ],
    });

    const result = await runStreamingStructuredExtraction<{ ok: boolean }>({
      provider,
      model: 'test-model',
      messages: MESSAGES,
      maxTokens: 1000,
      timeoutMs: 5000,
      parse: (raw) => (raw === '{"ok":true}' ? { ok: true } : null),
      retryUserMessage: 'retry',
    });

    expect(result.value).toEqual({ ok: true });
    expect(result.tokenUsage).toEqual({ input: 100, output: 40 });
    expect(result.attempts).toBe(1);
    // No retry on a first-attempt success.
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('surfaces each text delta to onTextDelta in order', async () => {
    const provider = makeProvider({
      streamChunks: [
        { type: 'text', content: 'a' },
        { type: 'text', content: 'b' },
        { type: 'text', content: 'c' },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      ],
    });

    const deltas: string[] = [];
    await runStreamingStructuredExtraction({
      provider,
      model: 'test-model',
      messages: MESSAGES,
      maxTokens: 1000,
      timeoutMs: 5000,
      parse: () => ({}),
      retryUserMessage: 'retry',
      onTextDelta: (d) => deltas.push(d),
    });

    expect(deltas).toEqual(['a', 'b', 'c']);
  });

  it('forwards maxTokens/timeoutMs and a timeout signal to chatStream', async () => {
    const provider = makeProvider({
      streamChunks: [
        { type: 'done', usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop' },
      ],
    });

    await runStreamingStructuredExtraction({
      provider,
      model: 'test-model',
      messages: MESSAGES,
      maxTokens: 32_000,
      timeoutMs: 300_000,
      parse: () => ({}),
      retryUserMessage: 'retry',
    });

    const options = provider.chatStream.mock.calls[0]?.[1];
    expect(options?.maxTokens).toBe(32_000);
    expect(options?.timeoutMs).toBe(300_000);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('defaults the streamed first attempt to temperature 0.2 (parity with the blocking helper)', async () => {
    // The blocking runStructuredCompletion this replaces on the streaming route
    // defaults to DEFAULT_TEMPERATURE = 0.2; the streamed path must match so the
    // two ingest surfaces sample the model identically for the same document.
    const provider = makeProvider({
      streamChunks: [
        { type: 'done', usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop' },
      ],
    });

    await runStreamingStructuredExtraction({
      provider,
      model: 'test-model',
      messages: MESSAGES,
      maxTokens: 1000,
      timeoutMs: 5000,
      parse: () => ({}),
      retryUserMessage: 'retry',
    });

    expect(provider.chatStream.mock.calls[0]?.[1]?.temperature).toBe(0.2);
  });

  it('retries once non-streaming at temp 0 without echoing the malformed output', async () => {
    // First (streamed) attempt yields unparseable text; retry yields valid JSON.
    const provider = makeProvider({
      streamChunks: [
        { type: 'text', content: 'not json' },
        { type: 'done', usage: { inputTokens: 60, outputTokens: 20 }, finishReason: 'stop' },
      ],
      chatContent: '{"ok":true}',
      chatUsage: { inputTokens: 55, outputTokens: 15 },
    });

    const result = await runStreamingStructuredExtraction<{ ok: boolean }>({
      provider,
      model: 'test-model',
      messages: MESSAGES,
      maxTokens: 1000,
      timeoutMs: 5000,
      parse: (raw) => (raw === '{"ok":true}' ? { ok: true } : null),
      retryUserMessage: 'return only JSON',
    });

    expect(result.value).toEqual({ ok: true });
    expect(result.attempts).toBe(2);
    // Tokens summed across both attempts.
    expect(result.tokenUsage).toEqual({ input: 115, output: 35 });

    // The retry sends the original messages + a stricter user message, and never
    // the malformed prior output.
    expect(provider.chat).toHaveBeenCalledTimes(1);
    const retryMessages = provider.chat.mock.calls[0]?.[0] ?? [];
    const retryOptions = provider.chat.mock.calls[0]?.[1];
    expect(retryMessages).toEqual([...MESSAGES, { role: 'user', content: 'return only JSON' }]);
    expect(retryMessages.some((m) => m.content === 'not json')).toBe(false);
    expect(retryOptions?.temperature).toBe(0);
  });

  it('does not call onTextDelta for the retry attempt', async () => {
    const provider = makeProvider({
      streamChunks: [
        { type: 'text', content: 'bad' },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      ],
      chatContent: 'good',
    });

    const deltas: string[] = [];
    await runStreamingStructuredExtraction({
      provider,
      model: 'test-model',
      messages: MESSAGES,
      maxTokens: 1000,
      timeoutMs: 5000,
      parse: (raw) => (raw === 'good' ? {} : null),
      retryUserMessage: 'retry',
      onTextDelta: (d) => deltas.push(d),
    });

    // Only the first (streamed) attempt's delta was surfaced.
    expect(deltas).toEqual(['bad']);
  });

  it('swallows a throwing progress sink and still completes', async () => {
    const provider = makeProvider({
      streamChunks: [
        { type: 'text', content: '{}' },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      ],
    });

    const result = await runStreamingStructuredExtraction({
      provider,
      model: 'test-model',
      messages: MESSAGES,
      maxTokens: 1000,
      timeoutMs: 5000,
      parse: () => ({ ok: true }),
      retryUserMessage: 'retry',
      onTextDelta: () => {
        throw new Error('sink boom');
      },
    });

    expect(result.value).toEqual({ ok: true });
  });

  it('throws the caller onFinalFailure error when both attempts fail to parse', async () => {
    const provider = makeProvider({
      streamChunks: [
        { type: 'text', content: 'bad1' },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      ],
      chatContent: 'bad2',
    });

    await expect(
      runStreamingStructuredExtraction({
        provider,
        model: 'test-model',
        messages: MESSAGES,
        maxTokens: 1000,
        timeoutMs: 5000,
        parse: () => null,
        retryUserMessage: 'retry',
        onFinalFailure: () => new Error('custom diagnostic'),
      })
    ).rejects.toThrow('custom diagnostic');
  });

  it('throws the default diagnostic when both attempts fail and no onFinalFailure is supplied', async () => {
    const provider = makeProvider({
      streamChunks: [
        { type: 'text', content: 'bad1' },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      ],
      chatContent: 'bad2',
    });

    await expect(
      runStreamingStructuredExtraction({
        provider,
        model: 'test-model',
        messages: MESSAGES,
        maxTokens: 1000,
        timeoutMs: 5000,
        parse: () => null,
        retryUserMessage: 'retry',
        // No onFinalFailure → the runner throws its own literal fallback message.
      })
    ).rejects.toThrow('Streaming structured extraction response was not valid JSON after retry');
  });
});

/**
 * Streaming counterpart to the evaluation runner's `runStructuredCompletion`,
 * specialised for the questionnaire extractor's "watch it extract" flow.
 *
 * The blocking `runStructuredCompletion` fires one non-streaming `provider.chat`
 * and only yields a result once the entire JSON is back — so there is nothing to
 * report mid-flight. This runner instead drives the **first** attempt through
 * `provider.chatStream`, surfacing each text delta to a caller-supplied
 * `onTextDelta` sink (the extractor feeds those to a
 * {@link file://./question-count-scanner.ts} to emit a live count) while the
 * response is still generating. It otherwise preserves the exact retry policy the
 * blocking helper established:
 *
 *   - parse the assembled first response; on success, return it;
 *   - on a parse miss, retry ONCE — non-streaming, at temperature 0, with a
 *     stricter user message, and WITHOUT echoing the malformed prior output
 *     (never trust output that just misbehaved);
 *   - sum input/output tokens across both attempts so cost accounting is honest.
 *
 * The retry is deliberately non-streaming: by then the admin has already watched
 * the first pass, a second pass is the rare corrective case, and there is no
 * count to show for it.
 *
 * Platform-agnostic and Prisma/Next-free — safe under `lib/app/**`. It composes
 * the stable provider interface (`chat` / `chatStream`) and the shared
 * `calculateCost`; it does not fork the platform's structured-completion helper.
 */

import { calculateCost } from '@/lib/orchestration/llm/cost-tracker';
import type { getProvider } from '@/lib/orchestration/llm/provider-manager';
import type { LlmMessage } from '@/lib/orchestration/llm/types';

type LlmProvider = Awaited<ReturnType<typeof getProvider>>;

export interface StreamingStructuredExtractionOptions<T> {
  provider: LlmProvider;
  model: string;
  messages: LlmMessage[];
  /** Parse the assembled response text; return `null` to trigger the retry. */
  parse: (raw: string) => T | null;
  /** Sent as a `user` message on the (non-streaming) retry. Describes the shape. */
  retryUserMessage: string;
  maxTokens: number;
  timeoutMs: number;
  /**
   * Sampling temperature for the FIRST (streamed) attempt. The retry always uses
   * 0 (determinism when the first pass produced unparseable output). Defaults to
   * 0.2 to match the blocking `runStructuredCompletion` this replaces on the
   * streaming route (`DEFAULT_TEMPERATURE`), so the streamed and non-streamed
   * ingest surfaces sample the model identically for the same document.
   */
  temperature?: number;
  /**
   * Called with each assistant text delta of the first (streamed) attempt, in
   * order. The extractor pipes these into the question-count scanner. Never
   * called for the retry. A throw here is swallowed so a progress-sink fault
   * can't abort the extraction the admin is waiting on.
   */
  onTextDelta?: (delta: string) => void;
  /** Error to throw when both attempts fail to parse. */
  onFinalFailure?: () => Error;
}

export interface StreamingStructuredExtractionResult<T> {
  value: T;
  tokenUsage: { input: number; output: number };
  costUsd: number;
  /** How many attempts ran (1 when the first stream parsed, 2 after a retry). */
  attempts: 1 | 2;
}

/**
 * Run the extractor as a streamed first attempt + non-streaming temp-0 retry.
 * See the module doc for the retry/cost contract.
 */
export async function runStreamingStructuredExtraction<T>(
  opts: StreamingStructuredExtractionOptions<T>
): Promise<StreamingStructuredExtractionResult<T>> {
  // Match the blocking helper's DEFAULT_TEMPERATURE (0.2) so the two ingest
  // surfaces don't diverge in sampling for the same document.
  const temperature = opts.temperature ?? 0.2;

  // ── Attempt 1: stream, accumulating text and surfacing deltas live. ──
  // A hard client-side deadline in addition to the provider timeout: the
  // in-stream `aborted` check trips on this even if the provider's own timeout
  // doesn't fire (belt-and-suspenders, matching the blocking helper).
  const firstSignal = AbortSignal.timeout(opts.timeoutMs);
  let firstText = '';
  let firstInputTokens = 0;
  let firstOutputTokens = 0;

  for await (const chunk of opts.provider.chatStream(opts.messages, {
    model: opts.model,
    temperature,
    maxTokens: opts.maxTokens,
    timeoutMs: opts.timeoutMs,
    signal: firstSignal,
  })) {
    if (chunk.type === 'text') {
      firstText += chunk.content;
      if (opts.onTextDelta) {
        try {
          opts.onTextDelta(chunk.content);
        } catch {
          // A progress-sink fault must never abort the extraction — drop it.
        }
      }
    } else if (chunk.type === 'done') {
      firstInputTokens = chunk.usage.inputTokens;
      firstOutputTokens = chunk.usage.outputTokens;
    }
  }

  const firstParsed = opts.parse(firstText);
  if (firstParsed !== null) {
    return {
      value: firstParsed,
      tokenUsage: { input: firstInputTokens, output: firstOutputTokens },
      costUsd: calculateCost(opts.model, firstInputTokens, firstOutputTokens).totalCostUsd,
      attempts: 1,
    };
  }

  // ── Attempt 2 (retry): non-streaming, temperature 0, stricter prompt. ──
  // We do NOT include the malformed prior response — never feed back output that
  // just misbehaved.
  const retrySignal = AbortSignal.timeout(opts.timeoutMs);
  const retry = await opts.provider.chat(
    [...opts.messages, { role: 'user', content: opts.retryUserMessage }],
    {
      model: opts.model,
      temperature: 0,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
      signal: retrySignal,
    }
  );

  const retryParsed = opts.parse(retry.content);
  if (retryParsed === null) {
    if (opts.onFinalFailure) throw opts.onFinalFailure();
    throw new Error('Streaming structured extraction response was not valid JSON after retry');
  }

  const inputTokens = firstInputTokens + retry.usage.inputTokens;
  const outputTokens = firstOutputTokens + retry.usage.outputTokens;
  return {
    value: retryParsed,
    tokenUsage: { input: inputTokens, output: outputTokens },
    costUsd: calculateCost(opts.model, inputTokens, outputTokens).totalCostUsd,
    attempts: 2,
  };
}

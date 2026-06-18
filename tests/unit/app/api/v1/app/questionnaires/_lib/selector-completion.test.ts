/**
 * Unit test: the shared selector-agent runner (`selector-completion.ts`).
 *
 * Covers the JSON envelope parser and the structured-completion runner that BOTH adaptive selectors
 * (question-mode + data-slot mode) call. The runner is a direct structured completion — no persisted
 * conversation, no real `user` — so it must work for anonymous/preview sessions. Mocks the agent
 * lookup, provider/model resolution, the provider, and `runStructuredCompletion` so no real I/O runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { aiAgent: { findUnique: vi.fn() } },
}));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({ logCost: vi.fn() }));
// Keep the real `tryParseJson` (parseSelectorOutput depends on it); only stub the completion runner.
vi.mock('@/lib/orchestration/evaluations/parse-structured', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runStructuredCompletion: vi.fn(),
}));

import {
  parseSelectorOutput,
  runSelectorCompletion,
} from '@/app/api/v1/app/questionnaires/_lib/selector-completion';
import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { runStructuredCompletion } from '@/lib/orchestration/evaluations/parse-structured';

type Mock = ReturnType<typeof vi.fn>;

describe('parseSelectorOutput', () => {
  it('parses a clean JSON envelope', () => {
    expect(parseSelectorOutput('{"choice": 2, "rationale": "flows"}')).toEqual({
      choice: 2,
      rationale: 'flows',
    });
  });

  it('parses a code-fenced JSON envelope', () => {
    expect(parseSelectorOutput('```json\n{"choice":1,"rationale":"x"}\n```')).toEqual({
      choice: 1,
      rationale: 'x',
    });
  });

  it('defaults a missing rationale to empty string', () => {
    expect(parseSelectorOutput('{"choice": 0}')).toEqual({ choice: 0, rationale: '' });
  });

  it('truncates a fractional choice to an integer', () => {
    expect(parseSelectorOutput('{"choice": 2.9, "rationale": "y"}')?.choice).toBe(2);
  });

  it('returns null when choice is missing or non-numeric', () => {
    expect(parseSelectorOutput('{"rationale": "x"}')).toBeNull();
    expect(parseSelectorOutput('{"choice": "two"}')).toBeNull();
    expect(parseSelectorOutput('not json')).toBeNull();
  });
});

describe('runSelectorCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.aiAgent.findUnique as unknown as Mock).mockResolvedValue({
      id: 'selector-agent',
      provider: '',
      model: '',
      fallbackProviders: [],
      systemInstructions: 'You are the selection brain.',
    });
    (resolveAgentProviderAndModel as unknown as Mock).mockResolvedValue({
      providerSlug: 'openai',
      model: 'gpt-4o',
      fallbacks: [],
    });
    (getProvider as unknown as Mock).mockResolvedValue({ chat: vi.fn() });
    (logCost as unknown as Mock).mockResolvedValue(undefined);
    (runStructuredCompletion as unknown as Mock).mockResolvedValue({
      value: { choice: 2, rationale: 'flows naturally' },
      tokenUsage: { input: 120, output: 14 },
      costUsd: 0.004,
    });
  });

  it('returns the parsed pick + cost/tokens on the happy path, with no user required', async () => {
    const result = await runSelectorCompletion({ userMessage: 'pick one', sessionId: 'sess-1' });
    expect(result).toEqual({
      parsed: { choice: 2, rationale: 'flows naturally' },
      model: 'gpt-4o',
      provider: 'openai',
      costUsd: 0.004,
      latencyMs: expect.any(Number),
      tokensIn: 120,
      tokensOut: 14,
    });
  });

  it('sends the agent persona as the system message and the prompt as the user message', async () => {
    await runSelectorCompletion({ userMessage: 'pick one', sessionId: 'sess-1' });
    const opts = (runStructuredCompletion as unknown as Mock).mock.calls[0][0];
    expect(opts.messages).toEqual([
      { role: 'system', content: 'You are the selection brain.' },
      { role: 'user', content: 'pick one' },
    ]);
  });

  it('attributes the cost to the selector agent + session', async () => {
    await runSelectorCompletion({ userMessage: 'pick one', sessionId: 'sess-1' });
    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'selector-agent',
        metadata: expect.objectContaining({ appQuestionnaireSessionId: 'sess-1' }),
      })
    );
  });

  it('omits the system message when the agent has no persona', async () => {
    (prisma.aiAgent.findUnique as unknown as Mock).mockResolvedValue({
      id: 'selector-agent',
      provider: '',
      model: '',
      fallbackProviders: [],
      systemInstructions: '',
    });
    await runSelectorCompletion({ userMessage: 'pick one', sessionId: 'sess-1' });
    const opts = (runStructuredCompletion as unknown as Mock).mock.calls[0][0];
    expect(opts.messages).toEqual([{ role: 'user', content: 'pick one' }]);
  });

  it('fails soft to errorCode "no_provider" when resolution throws', async () => {
    (resolveAgentProviderAndModel as unknown as Mock).mockRejectedValue(new Error('no provider'));
    const result = await runSelectorCompletion({ userMessage: 'x', sessionId: 'sess-1' });
    expect(result.parsed).toBeNull();
    expect(result.errorCode).toBe('no_provider');
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('fails soft to errorCode "provider_unavailable" when the provider cannot be loaded', async () => {
    (getProvider as unknown as Mock).mockRejectedValue(new Error('unavailable'));
    const result = await runSelectorCompletion({ userMessage: 'x', sessionId: 'sess-1' });
    expect(result.parsed).toBeNull();
    expect(result.errorCode).toBe('provider_unavailable');
  });

  it('fails soft to errorCode "completion_failed" when the completion throws', async () => {
    (runStructuredCompletion as unknown as Mock).mockRejectedValue(new Error('bad json twice'));
    const result = await runSelectorCompletion({ userMessage: 'x', sessionId: 'sess-1' });
    expect(result.parsed).toBeNull();
    expect(result.errorCode).toBe('completion_failed');
  });
});

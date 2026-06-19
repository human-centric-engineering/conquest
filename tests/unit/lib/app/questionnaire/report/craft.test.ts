/**
 * Respondent Report config assistant — unit tests (validation + one turn).
 *
 * @see lib/app/questionnaire/report/craft.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: { aiAgent: { findUnique: vi.fn() } } }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));

import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { validateCraftResult, craftReportConfig } from '@/lib/app/questionnaire/report/craft';
import { RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH as MAX } from '@/lib/app/questionnaire/types';

type Mock = ReturnType<typeof vi.fn>;

describe('validateCraftResult', () => {
  it('accepts a reply with suggestions', () => {
    expect(
      validateCraftResult({ reply: 'Sure.', suggestions: { instructions: 'Be warm.' } })
    ).toEqual({ reply: 'Sure.', suggestions: { instructions: 'Be warm.' } });
  });

  it('returns null without a usable reply', () => {
    expect(validateCraftResult({ suggestions: {} })).toBeNull();
    expect(validateCraftResult({ reply: '   ' })).toBeNull();
    expect(validateCraftResult('nope')).toBeNull();
  });

  it('defaults suggestions to empty and drops blank/oversized fields', () => {
    const result = validateCraftResult({
      reply: 'ok',
      suggestions: { instructions: '   ', structure: 'x'.repeat(MAX + 50) },
    });
    expect(result?.suggestions.instructions).toBeUndefined();
    expect(result?.suggestions.structure).toHaveLength(MAX);
  });

  it('omits suggestions entirely when none provided', () => {
    expect(validateCraftResult({ reply: 'Just a question for you.' })).toEqual({
      reply: 'Just a question for you.',
      suggestions: {},
    });
  });
});

function fakeProvider(responseJson: object) {
  const chat = vi.fn().mockResolvedValue({
    content: JSON.stringify(responseJson),
    usage: { inputTokens: 20, outputTokens: 10 },
    // Match the real LlmResponse contract (provider.chat returns these too).
    model: 'test-model',
    finishReason: 'stop',
  });
  return { provider: { chat }, chat };
}

describe('craftReportConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
      provider: 'openai',
      model: 'test-model',
      fallbackProviders: [],
      systemInstructions: 'You are the assistant.',
      temperature: 0.5,
      maxTokens: 2048,
    });
    (resolveAgentProviderAndModel as Mock).mockResolvedValue({
      providerSlug: 'openai',
      model: 'test-model',
      fallbacks: [],
    });
  });

  it('sends the transcript + current config and returns reply, suggestions, cost', async () => {
    const { provider, chat } = fakeProvider({
      reply: 'Here is a structure.',
      suggestions: { structure: 'Summary, themes, actions.' },
    });
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await craftReportConfig({
      messages: [{ role: 'user', content: 'Help me' }],
      current: { instructions: 'existing', structure: '', backgroundContext: '' },
    });

    expect(result.reply).toBe('Here is a structure.');
    expect(result.suggestions).toEqual({ structure: 'Summary, themes, actions.' });
    expect(typeof result.costUsd).toBe('number');

    const messages = chat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    // System carries the persona + the current config; the user turn is forwarded.
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('You are the assistant.');
    expect(system?.content).toContain('instructions: existing');
    expect(messages.some((m) => m.role === 'user' && m.content === 'Help me')).toBe(true);
  });

  it('throws when the assistant agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    const { provider } = fakeProvider({ reply: 'x', suggestions: {} });
    (getProvider as Mock).mockResolvedValue(provider);
    await expect(
      craftReportConfig({
        messages: [{ role: 'user', content: 'hi' }],
        current: { instructions: '', structure: '', backgroundContext: '' },
      })
    ).rejects.toThrow(/not seeded/i);
  });
});

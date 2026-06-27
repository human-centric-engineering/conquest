/**
 * Unit test: the "Explain with AI" orchestrator.
 *
 * Mocks every collaborator (evaluation, advisor row, provider resolution,
 * structured completion, cost log) and asserts the discriminated result: unknown
 * slug → agent_not_found, unseeded advisor → advisor_not_configured, provider
 * failure → provider_unavailable, success → the parsed value + a cost log.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/app/questionnaire/agent-advisory/evaluate', () => ({
  evaluateAgentSettings: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({
  prisma: { aiAgent: { findUnique: vi.fn() } },
}));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/orchestration/evaluations/parse-structured', () => ({
  runStructuredCompletion: vi.fn(),
}));

import { CostOperation } from '@/types/orchestration';
import { evaluateAgentSettings } from '@/lib/app/questionnaire/agent-advisory/evaluate';
import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { runStructuredCompletion } from '@/lib/orchestration/evaluations/parse-structured';
import { explainAgentSettings } from '@/lib/app/questionnaire/agent-advisory/explain';

type Mock = ReturnType<typeof vi.fn>;

const AGENT_EVAL = {
  slug: 'app-questionnaire-selector',
  agentId: 'a-sel',
  label: 'Selector',
  role: 'Picks the next question',
  taskTier: 'chat',
  current: {
    explicitModel: null,
    resolvedModel: 'gpt-5.4-mini',
    temperature: 0.2,
    maxTokens: 256,
    reasoningEffort: null,
  },
  recommended: {
    model: 'gpt-5.4-nano',
    isOverride: true,
    temperature: 0.2,
    maxTokens: 256,
    reasoningEffort: 'minimal',
  },
  cost: {
    currentModelPerMillionUsd: 2.625,
    recommendedModelPerMillionUsd: 0.725,
    currentEstPerCallUsd: 0.0007,
    recommendedEstPerCallUsd: 0.0002,
    deltaPerCallUsd: -0.0005,
    deltaPct: -72,
  },
  actuals: { windowDays: 30, spendUsd: 1.5, calls: 40 },
  flags: { temperatureIgnored: true, pricingUnknown: false, modelUnresolved: false },
  isOptimal: false,
  rationale: 'Override to nano.',
};

beforeEach(() => {
  vi.clearAllMocks();
  (evaluateAgentSettings as Mock).mockResolvedValue({
    generatedAt: '2026-06-27T00:00:00.000Z',
    taskTiers: [],
    infraDefaults: [],
    agents: [AGENT_EVAL],
  });
  (logCost as Mock).mockResolvedValue(null);
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
    id: 'advisor-1',
    provider: '',
    model: '',
    fallbackProviders: [],
  });
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-5.4',
  });
  (getProvider as Mock).mockResolvedValue({ chat: vi.fn() });
  (runStructuredCompletion as Mock).mockResolvedValue({
    value: { narrative: 'looks fine', suggestion: null },
    tokenUsage: { input: 100, output: 50 },
    costUsd: 0.01,
  });
});

describe('explainAgentSettings', () => {
  it('returns agent_not_found for an unknown slug', async () => {
    const res = await explainAgentSettings('ghost');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('agent_not_found');
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('returns advisor_not_configured when the advisor agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    const res = await explainAgentSettings('app-questionnaire-selector');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('advisor_not_configured');
  });

  it('returns no_provider_configured when resolution fails', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider'));
    const res = await explainAgentSettings('app-questionnaire-selector');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('no_provider_configured');
  });

  it('returns provider_unavailable when the provider cannot be loaded', async () => {
    (getProvider as Mock).mockRejectedValue(new Error('down'));
    const res = await explainAgentSettings('app-questionnaire-selector');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('provider_unavailable');
  });

  it('returns explain_failed when the completion throws', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(new Error('schema mismatch'));
    const res = await explainAgentSettings('app-questionnaire-selector');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('explain_failed');
  });

  it('returns the parsed explanation and logs cost on success', async () => {
    const res = await explainAgentSettings('app-questionnaire-selector');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ narrative: 'looks fine', suggestion: null });
    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'advisor-1',
        operation: CostOperation.CHAT,
        model: 'gpt-5.4',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
      })
    );
  });

  it('still succeeds when the cost-log write rejects', async () => {
    (logCost as Mock).mockRejectedValue(new Error('cost log down'));
    const res = await explainAgentSettings('app-questionnaire-selector');
    expect(res.ok).toBe(true);
  });
});

/**
 * Unit test: the deterministic agent-settings evaluation engine.
 *
 * Mocks the settings resolver, provider-model rows, agent rows and cost logs, and
 * asserts the engine resolves inherited models, detects optimal vs non-optimal,
 * computes the cost delta + per-call estimate, flags the gpt-5 "temperature
 * ignored" caveat and unresolved/unknown-pricing cases, and maps actual spend.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderModel: { findMany: vi.fn() },
    aiAgent: { findMany: vi.fn() },
  },
}));
vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTaskOrNull: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/cost-reports', () => ({
  getCostBreakdown: vi.fn(),
}));

import { prisma } from '@/lib/db/client';
import { getDefaultModelForTaskOrNull } from '@/lib/orchestration/llm/settings-resolver';
import { getCostBreakdown } from '@/lib/orchestration/llm/cost-reports';
import { evaluateAgentSettings } from '@/lib/app/questionnaire/agent-advisory/evaluate';
import {
  QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
  QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
  QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';

type Mock = ReturnType<typeof vi.fn>;

const PROVIDER_ROWS = [
  {
    modelId: 'gpt-5.4',
    name: 'GPT-5.4',
    providerSlug: 'openai',
    paramProfile: 'openai-reasoning',
    costPerMillionTokens: 8.75,
  },
  {
    modelId: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    providerSlug: 'openai',
    paramProfile: 'openai-reasoning',
    costPerMillionTokens: 2.625,
  },
  {
    modelId: 'gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    providerSlug: 'openai',
    paramProfile: 'openai-reasoning',
    costPerMillionTokens: 0.725,
  },
  {
    modelId: 'gpt-4o',
    name: 'GPT-4o',
    providerSlug: 'openai',
    paramProfile: null, // conversational (openai-legacy): honours temperature
    costPerMillionTokens: 6.25,
  },
  {
    modelId: 'gpt-4.1-nano',
    name: 'GPT-4.1 Nano',
    providerSlug: 'openai',
    paramProfile: null,
    costPerMillionTokens: 0.25,
  },
  {
    modelId: 'text-embedding-3-small',
    name: 'emb',
    providerSlug: 'openai',
    paramProfile: null,
    costPerMillionTokens: 0.02,
  },
  {
    modelId: 'gpt-4o-transcribe',
    name: 'transcribe',
    providerSlug: 'openai',
    paramProfile: null,
    costPerMillionTokens: null,
  },
];

function setDefaults(overrides: Partial<Record<string, string | null>> = {}) {
  const defaults: Record<string, string | null> = {
    reasoning: 'gpt-5.4',
    chat: 'gpt-5.4-mini',
    routing: 'gpt-4.1-nano',
    embeddings: 'text-embedding-3-small',
    audio: 'gpt-4o-transcribe',
    ...overrides,
  };
  // Return the value directly (not a Promise) — the engine `await`s it, which
  // coerces a plain value, and this keeps the mock impl a non-async function.
  // test-review:accept mock-realism — intentional sync return; awaited by the engine, avoids no-misused-promises lint
  (getDefaultModelForTaskOrNull as Mock).mockImplementation(
    (task: string) => defaults[task] ?? null
  );
}

const NOW = new Date('2026-06-27T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  setDefaults();
  (prisma.aiProviderModel.findMany as Mock).mockResolvedValue(PROVIDER_ROWS);
  (getCostBreakdown as Mock).mockResolvedValue({
    groupBy: 'agent',
    rows: [],
    totals: { totalCostUsd: 0, inputTokens: 0, outputTokens: 0, count: 0 },
  });
  (prisma.aiAgent.findMany as Mock).mockResolvedValue([]);
});

describe('evaluateAgentSettings', () => {
  it('marks a fully-aligned reasoning agent as optimal and flags temperature ignored', async () => {
    (prisma.aiAgent.findMany as Mock).mockResolvedValue([
      // Extractor recommendation: reasoning, temp 0.2, max 16384, effort 'high'.
      {
        id: 'a-ext',
        slug: QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
        model: '',
        temperature: 0.2,
        maxTokens: 16384,
        reasoningEffort: 'high',
      },
    ]);

    const result = await evaluateAgentSettings(NOW);
    const ext = result.agents.find((a) => a.slug === QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG);
    expect(ext).toBeDefined();
    expect(ext!.current.resolvedModel).toBe('gpt-5.4'); // inherited from reasoning default
    expect(ext!.current.explicitModel).toBeNull();
    expect(ext!.isOptimal).toBe(true);
    // gpt-5.4 uses the openai-reasoning profile → temperature is a no-op.
    expect(ext!.flags.temperatureIgnored).toBe(true);
    expect(ext!.flags.pricingUnknown).toBe(false);
  });

  it('uses an explicit per-agent model over the tier default', async () => {
    (prisma.aiAgent.findMany as Mock).mockResolvedValue([
      // Extractor pinned to an explicit model — should resolve to it, not the reasoning default.
      {
        id: 'a-ext',
        slug: QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
        model: 'gpt-5.4-nano',
        temperature: 0.2,
        maxTokens: 16384,
        reasoningEffort: 'high',
      },
    ]);
    const result = await evaluateAgentSettings(NOW);
    const ext = result.agents.find((a) => a.slug === QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG)!;
    expect(ext.current.explicitModel).toBe('gpt-5.4-nano');
    expect(ext.current.resolvedModel).toBe('gpt-5.4-nano'); // explicit pin wins over tier default
    expect(ext.recommended.model).toBe('gpt-5.4'); // reasoning tier default (no override for extractor)
    expect(ext.isOptimal).toBe(false); // pinned model differs from the recommendation
  });

  it('recommends the conversational chat default (no override) for a hot-path agent', async () => {
    (prisma.aiAgent.findMany as Mock).mockResolvedValue([
      // Selector: chat tier, currently inherits gpt-5.4-mini; recommendation is the
      // conversational chat default (gpt-4o) with no per-agent override.
      {
        id: 'a-sel',
        slug: QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
        model: '',
        temperature: 0.2,
        maxTokens: 256,
        reasoningEffort: null,
      },
    ]);

    const result = await evaluateAgentSettings(NOW);
    const sel = result.agents.find((a) => a.slug === QUESTIONNAIRE_SELECTOR_AGENT_SLUG)!;
    expect(sel.current.resolvedModel).toBe('gpt-5.4-mini'); // current (mocked) chat default
    expect(sel.recommended.model).toBe('gpt-4o'); // inherits the conversational chat tier
    expect(sel.recommended.isOverride).toBe(false);
    expect(sel.isOptimal).toBe(false); // current mini differs from the gpt-4o recommendation
    expect(sel.cost.currentModelPerMillionUsd).toBe(2.625);
    expect(sel.cost.recommendedModelPerMillionUsd).toBe(6.25);
  });

  it('treats an aligned chat agent (no override) as optimal', async () => {
    setDefaults({ chat: 'gpt-4o' }); // conversational chat default matches the recommendation
    (prisma.aiAgent.findMany as Mock).mockResolvedValue([
      // Answer extractor: chat, temp 0.2, max 4096, no reasoning effort — matches recommendation.
      {
        id: 'a-ans',
        slug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
        model: '',
        temperature: 0.2,
        maxTokens: 4096,
        reasoningEffort: null,
      },
    ]);
    const result = await evaluateAgentSettings(NOW);
    const ans = result.agents.find((a) => a.slug === QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG)!;
    expect(ans.recommended.isOverride).toBe(false);
    expect(ans.recommended.model).toBe('gpt-4o');
    expect(ans.isOptimal).toBe(true);
  });

  it('flags an unresolved model when the tier default is unset', async () => {
    setDefaults({ chat: null });
    (prisma.aiAgent.findMany as Mock).mockResolvedValue([
      {
        id: 'a-ans',
        slug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
        model: '',
        temperature: 0.2,
        maxTokens: 4096,
        reasoningEffort: 'low',
      },
    ]);
    const result = await evaluateAgentSettings(NOW);
    const ans = result.agents.find((a) => a.slug === QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG)!;
    expect(ans.current.resolvedModel).toBeNull();
    expect(ans.flags.modelUnresolved).toBe(true);
    expect(ans.cost.currentEstPerCallUsd).toBeNull();
  });

  it('maps actual 30-day spend onto the agent by id', async () => {
    (prisma.aiAgent.findMany as Mock).mockResolvedValue([
      {
        id: 'a-ext',
        slug: QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
        model: '',
        temperature: 0.2,
        maxTokens: 16384,
        reasoningEffort: 'high',
      },
    ]);
    (getCostBreakdown as Mock).mockResolvedValue({
      groupBy: 'agent',
      rows: [
        {
          key: 'a-ext',
          label: 'Extractor',
          totalCostUsd: 4.2,
          inputTokens: 1,
          outputTokens: 1,
          count: 7,
        },
      ],
      totals: { totalCostUsd: 4.2, inputTokens: 1, outputTokens: 1, count: 7 },
    });
    const result = await evaluateAgentSettings(NOW);
    const ext = result.agents.find((a) => a.slug === QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG)!;
    expect(ext.actuals.spendUsd).toBe(4.2);
    expect(ext.actuals.calls).toBe(7);
    expect(ext.actuals.windowDays).toBe(30);
  });

  it('reports task-tier and infra default optimality against current defaults', async () => {
    const result = await evaluateAgentSettings(NOW);
    const reasoning = result.taskTiers.find((t) => t.tier === 'reasoning')!;
    expect(reasoning.currentModel).toBe('gpt-5.4');
    expect(reasoning.recommendedModel).toBe('gpt-5.4');
    expect(reasoning.isOptimal).toBe(true);

    const audio = result.infraDefaults.find((t) => t.tier === 'audio')!;
    expect(audio.currentModel).toBe('gpt-4o-transcribe');
    expect(audio.isOptimal).toBe(true);
  });

  it('survives cost-log failures (actuals null, estimates still render)', async () => {
    (getCostBreakdown as Mock).mockRejectedValue(new Error('db down'));
    (prisma.aiAgent.findMany as Mock).mockResolvedValue([
      {
        id: 'a-ext',
        slug: QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
        model: '',
        temperature: 0.2,
        maxTokens: 16384,
        reasoningEffort: 'high',
      },
    ]);
    const result = await evaluateAgentSettings(NOW);
    const ext = result.agents.find((a) => a.slug === QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG)!;
    expect(ext.actuals.spendUsd).toBeNull();
    expect(ext.cost.currentModelPerMillionUsd).toBe(8.75);
  });
});

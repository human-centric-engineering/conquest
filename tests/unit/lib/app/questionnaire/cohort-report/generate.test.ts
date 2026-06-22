/**
 * Unit test: cohort-report generation (F14.3).
 *
 * Mocks the DB, agent/provider resolution, KB search, and client doc-id resolution; passes a
 * pre-built dataset (so `buildCohortDataset` isn't exercised here) and runs the real prompt build +
 * structured-completion runner against a fake provider. Asserts the digest reaches the prompt, the
 * success shape, KB grounding when enabled, and the error throw on a missing agent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireConfig: { findUnique: vi.fn() },
    appQuestionnaireRound: { findUnique: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/logging', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/knowledge/search', () => ({ searchKnowledge: vi.fn() }));
vi.mock('@/lib/app/questionnaire/report/client-knowledge', () => ({
  resolveClientKnowledgeDocumentIds: vi.fn(),
}));

import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import { resolveClientKnowledgeDocumentIds } from '@/lib/app/questionnaire/report/client-knowledge';
import { generateCohortReport } from '@/lib/app/questionnaire/cohort-report/generate';
import type { CohortDataset } from '@/lib/app/questionnaire/cohort-report/types';

type Mock = ReturnType<typeof vi.fn>;

function fakeProvider(responseJson: object) {
  const chat = vi.fn().mockResolvedValue({
    content: JSON.stringify(responseJson),
    usage: { inputTokens: 100, outputTokens: 50 },
    model: 'test-model',
    finishReason: 'stop',
  });
  return { provider: { chat }, chat };
}

const dataset: CohortDataset = {
  roundId: 'r1',
  roundName: 'Q1 Pulse',
  versionId: 'v1',
  totalSessions: 8,
  completedSessions: 7,
  kThreshold: 5,
  suppressed: false,
  anonymous: false,
  overall: [
    {
      questionId: 'q1',
      key: 'q1',
      prompt: 'How engaged are you?',
      type: 'likert',
      sectionTitle: 'S',
      required: false,
      tags: [],
      answeredCount: 7,
      unansweredCount: 1,
      responseRate: 0.875,
      avgConfidence: null,
      provenance: { direct: 0, inferred: 0, synthesised: 0, refined: 0 },
      detail: { kind: 'likert', min: 1, max: 5, buckets: [], mean: 4.1 },
    },
  ],
  segmentation: [],
};

const VALID_RESPONSE = {
  summary: 'Engagement is high.',
  sections: [{ heading: 'Engagement', body: 'Mean 4.1 across the cohort.', chartIds: [] }],
  charts: [],
  recommendations: ['Sustain the momentum'],
  actions: ['Share the results'],
};

const params = { roundId: 'r1', roundName: 'Q1 Pulse', versionId: 'v1', dataset };

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.appQuestionnaireConfig.findUnique as Mock).mockResolvedValue({
    cohortReport: { enabled: true, generation: { useClientKnowledge: false } },
  });
  (prisma.appQuestionnaireRound.findUnique as Mock).mockResolvedValue({
    cohort: { introBackground: null, demoClientId: null },
    contextEntries: [],
  });
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
    provider: 'openai',
    model: 'test-model',
    fallbackProviders: [],
    systemInstructions: 'You are the cohort analyst.',
    temperature: 0.3,
    maxTokens: 8192,
  });
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'openai',
    model: 'test-model',
    fallbacks: [],
  });
  (searchKnowledge as Mock).mockResolvedValue([]);
  (resolveClientKnowledgeDocumentIds as Mock).mockResolvedValue([]);
});

describe('generateCohortReport', () => {
  it('feeds the dataset digest into the prompt and returns the parsed content + cost', async () => {
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await generateCohortReport(params);

    expect(result.content.summary).toBe('Engagement is high.');
    expect(result.content.sections).toHaveLength(1);
    expect(typeof result.costUsd).toBe('number');

    const messages = chat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const user = messages.find((m) => m.role === 'user');
    expect(user?.content).toContain('Q1 Pulse');
    expect(user?.content).toContain('How engaged are you?');
    // The catalog (system) lists the chartable question id.
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('q1');
  });

  it('grounds in client KB when enabled and documents exist', async () => {
    (prisma.appQuestionnaireConfig.findUnique as Mock).mockResolvedValue({
      cohortReport: { enabled: true, generation: { useClientKnowledge: true } },
    });
    (prisma.appQuestionnaireRound.findUnique as Mock).mockResolvedValue({
      cohort: { introBackground: null, demoClientId: 'client-1' },
      contextEntries: [],
    });
    (resolveClientKnowledgeDocumentIds as Mock).mockResolvedValue(['doc-1']);
    (searchKnowledge as Mock).mockResolvedValue([
      { chunk: { content: 'Industry benchmark: 3.8' } },
    ]);
    const { provider, chat } = fakeProvider(VALID_RESPONSE);
    (getProvider as Mock).mockResolvedValue(provider);

    await generateCohortReport(params);

    expect(searchKnowledge).toHaveBeenCalled();
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    expect(system?.content).toContain('Industry benchmark: 3.8');
  });

  it('throws when the cohort-report agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    await expect(generateCohortReport(params)).rejects.toThrow(/not seeded/);
  });
});

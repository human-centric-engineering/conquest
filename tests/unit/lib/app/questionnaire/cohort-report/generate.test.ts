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
    appQuestionnaireSession: { findMany: vi.fn() },
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
import { roundScope } from '@/lib/app/questionnaire/cohort-report/scope';
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

const params = { scope: roundScope('r1', 'v1', 'Q1 Pulse'), dataset };

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.appQuestionnaireSession.findMany as Mock).mockResolvedValue([]);
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

    // Bodies are converted markdown→HTML at the boundary (F14.5), so the summary is wrapped.
    expect(result.content.summary).toContain('Engagement is high.');
    expect(result.content.summary).toContain('<p>');
    expect(result.content.sections).toHaveLength(1);
    expect(result.content.sections[0].format).toBe('html');
    expect(result.costUsd).toBeGreaterThanOrEqual(0);

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

    expect(searchKnowledge).toHaveBeenCalledWith(expect.any(String), { documentIds: ['doc-1'] }, 8);
    const system = (chat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'system'
    );
    expect(system?.content).toContain('Industry benchmark: 3.8');
  });

  it('throws when the cohort-report agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    await expect(generateCohortReport(params)).rejects.toThrow(/not seeded/);
  });

  it('resolves with content when KB search fails (the catch block swallows the error and generation continues ungrounded)', async () => {
    // Arrange: KB is enabled, doc ids resolve, but the KB search itself throws.
    (prisma.appQuestionnaireConfig.findUnique as Mock).mockResolvedValue({
      cohortReport: { enabled: true, generation: { useClientKnowledge: true } },
    });
    (prisma.appQuestionnaireRound.findUnique as Mock).mockResolvedValue({
      cohort: { introBackground: null, demoClientId: 'client-1' },
      contextEntries: [],
    });
    (resolveClientKnowledgeDocumentIds as Mock).mockResolvedValue(['doc-1']);
    (searchKnowledge as Mock).mockRejectedValue(new Error('KB service unavailable'));
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProvider as Mock).mockResolvedValue(provider);

    // The KB catch block logs a warning and generation continues without grounding.
    const result = await generateCohortReport(params);

    // The report was generated even though the KB call failed.
    expect(result.content.summary).toContain('Engagement is high.');
    expect(result.content.sections).toHaveLength(1);
  });

  it('rejects with "not valid JSON after retry" when the provider returns malformed JSON on both attempts', async () => {
    // Arrange: chat always returns non-JSON so both the initial call and retry fail.
    const chat = vi.fn().mockResolvedValue({
      content: 'not json',
      usage: { inputTokens: 100, outputTokens: 10 },
      model: 'test-model',
      finishReason: 'stop',
    });
    (getProvider as Mock).mockResolvedValue({ chat });

    // The onFinalFailure callback is reached and its Error is thrown.
    await expect(generateCohortReport(params)).rejects.toThrow(/not valid JSON after retry/);
    // The provider was called twice — once for the initial attempt, once for the retry.
    expect(chat).toHaveBeenCalledTimes(2);
  });
});

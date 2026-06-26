/**
 * Unit test: streamGenerateCohortReport (F14.3 streaming phase events).
 *
 * Drives the async generator with a mocked provider + pre-built dataset and asserts:
 *  - it yields the exact phase sequence (started → dataset_built → material_built → context_loaded →
 *    synthesizing) with sessionCount/segmentCount on dataset_built;
 *  - it RETURNS the parsed GeneratedCohortReport (content + costUsd) as the generator return value;
 *  - for a versionScope it does NOT call the round `findUnique` (no round context to load);
 *  - for a roundScope it DOES call the round `findUnique`.
 *
 * Reuses the same mocking approach as generate.test.ts.
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
import { streamGenerateCohortReport } from '@/lib/app/questionnaire/cohort-report/generate';
import { roundScope, versionScope } from '@/lib/app/questionnaire/cohort-report/scope';
import type { CohortDataset } from '@/lib/app/questionnaire/cohort-report/types';
import type { ReportGenProgressEvent } from '@/lib/app/questionnaire/cohort-report/report-events';

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

const VALID_RESPONSE = {
  summary: 'Cohort engagement strong.',
  sections: [{ heading: 'Engagement', body: 'Mean 4.1.', chartIds: [] }],
  charts: [],
  recommendations: ['Maintain pace'],
  actions: ['Share findings'],
};

/** A pre-built dataset so buildCohortDataset is bypassed and session/segmentation counts are known. */
const dataset: CohortDataset = {
  roundId: 'r1',
  roundName: 'Q1 Pulse',
  versionId: 'v1',
  totalSessions: 12,
  completedSessions: 10,
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
      answeredCount: 10,
      unansweredCount: 2,
      responseRate: 0.83,
      avgConfidence: null,
      provenance: { direct: 0, inferred: 0, synthesised: 0, refined: 0 },
      detail: { kind: 'likert', min: 1, max: 5, buckets: [], mean: 4.1 },
    },
  ],
  segmentation: [
    {
      dimension: { key: 'team', label: 'Team', source: 'profile', kind: 'select' },
      segments: [
        {
          value: 'Eng',
          label: 'Eng',
          totalSessions: 7,
          completedSessions: 6,
          suppressed: false,
          questions: [],
        },
      ],
    },
  ],
};

/** Drain an async generator and collect its yielded values + return value. */
async function drainGenerator<T, R>(
  gen: AsyncGenerator<T, R>
): Promise<{ yielded: T[]; returned: R }> {
  const yielded: T[] = [];
  let step = await gen.next();
  while (!step.done) {
    yielded.push(step.value);
    step = await gen.next();
  }
  return { yielded, returned: step.value };
}

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

describe('streamGenerateCohortReport', () => {
  it('yields the correct phase sequence and returns the parsed content + cost', async () => {
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProvider as Mock).mockResolvedValue(provider);

    const gen = streamGenerateCohortReport({
      scope: roundScope('r1', 'v1', 'Q1 Pulse'),
      dataset,
    });
    const { yielded, returned } = await drainGenerator(gen);

    // The generator must yield each phase in order — the UI relies on this sequence to update progress.
    const types = yielded.map((e) => e.type);
    expect(types).toEqual([
      'started',
      'dataset_built',
      'material_built',
      'context_loaded',
      'synthesizing',
    ]);

    // dataset_built carries session + segment counts derived from the pre-built dataset.
    const datasetBuilt = yielded.find(
      (e): e is ReportGenProgressEvent => e.type === 'dataset_built'
    )!;
    expect(datasetBuilt.sessionCount).toBe(12);
    expect(datasetBuilt.segmentCount).toBe(1);

    // The generator RETURNS the generated content (the route appends it as a revision).
    expect(returned.content.summary).toContain('Cohort engagement strong.');
    // Sections are markdown→HTML converted at the boundary.
    expect(returned.content.sections[0].format).toBe('html');
    expect(returned.costUsd).toBeGreaterThanOrEqual(0);
  });

  it('does NOT call the round findUnique for a version scope', async () => {
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProvider as Mock).mockResolvedValue(provider);

    const versionDataset: CohortDataset = { ...dataset, roundId: null, roundName: 'Version-wide' };

    const gen = streamGenerateCohortReport({
      scope: versionScope('v1', 'Version-wide'),
      dataset: versionDataset,
    });
    await drainGenerator(gen);

    // The round context lookup (round briefing, cohort background, KB) is round-only.
    // A version-wide report spans all rounds — no single briefing to inject.
    expect(prisma.appQuestionnaireRound.findUnique).not.toHaveBeenCalled();
  });

  it('DOES call the round findUnique for a round scope (to load round/cohort context)', async () => {
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProvider as Mock).mockResolvedValue(provider);

    const gen = streamGenerateCohortReport({
      scope: roundScope('r1', 'v1', 'Q1 Pulse'),
      dataset,
    });
    await drainGenerator(gen);

    expect(prisma.appQuestionnaireRound.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1' } })
    );
  });

  it('throws when the cohort-report agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);

    const gen = streamGenerateCohortReport({
      scope: roundScope('r1', 'v1', 'Q1 Pulse'),
      dataset,
    });
    await expect(drainGenerator(gen)).rejects.toThrow(/not seeded/);
  });

  it('skips the session findMany query when dataset.suppressed is true (k-anonymity gate)', async () => {
    const { provider } = fakeProvider(VALID_RESPONSE);
    (getProvider as Mock).mockResolvedValue(provider);

    const suppressedDataset: CohortDataset = { ...dataset, suppressed: true };

    const gen = streamGenerateCohortReport({
      scope: roundScope('r1', 'v1', 'Q1 Pulse'),
      dataset: suppressedDataset,
    });
    await drainGenerator(gen);

    // When suppressed, the k-anonymity gate (`if (!dataset.suppressed)`) prevents the
    // session findMany from firing — no individual session ids are safe to surface.
    expect(prisma.appQuestionnaireSession.findMany).not.toHaveBeenCalled();
  });
});

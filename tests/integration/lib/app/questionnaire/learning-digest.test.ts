/**
 * Integration: the Learning Mode digest builder (`refreshRoundLearningDigest`) + reader.
 *
 * Prisma, the composer-agent LLM chain, and cost logging are mocked at the module boundary. Tests
 * assert the privacy gates (k-anonymity at round + slot level, high-sensitivity exclusion), the
 * data-slot vs question aggregation, the wholesale rebuild, and the fail-soft branches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireRound: { findUnique: vi.fn() },
  appQuestionnaireSession: { findMany: vi.fn() },
  appDataSlot: { findMany: vi.fn() },
  appDataSlotFill: { findMany: vi.fn() },
  appAnswerSlot: { findMany: vi.fn() },
  appRoundLearningDigest: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
  aiAgent: { findUnique: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/evaluations/parse-structured', () => ({
  runStructuredCompletion: vi.fn(),
  tryParseJson: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  refreshRoundLearningDigest,
  loadRoundPeerDigest,
} from '@/lib/app/questionnaire/learning/digest';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { runStructuredCompletion } from '@/lib/orchestration/evaluations/parse-structured';

type Mock = ReturnType<typeof vi.fn>;

function sessions(n: number, over: Record<string, unknown> = {}) {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i}`, ...over }));
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({
    learningEnabled: true,
    learningConfig: { minRespondents: 3 },
  });
  prismaMock.appQuestionnaireSession.findMany.mockResolvedValue(sessions(4));
  prismaMock.appDataSlot.findMany.mockResolvedValue([
    { id: 'd1', key: 'workload', name: 'Workload' },
  ]);
  prismaMock.appDataSlotFill.findMany.mockResolvedValue([
    { dataSlotId: 'd1', paraphrase: 'feels heavy', value: null },
    { dataSlotId: 'd1', paraphrase: 'manageable', value: null },
    { dataSlotId: 'd1', paraphrase: 'too much', value: null },
    { dataSlotId: 'd1', paraphrase: 'fine', value: null },
  ]);
  prismaMock.appRoundLearningDigest.createMany.mockResolvedValue({ count: 1 });
  prismaMock.appRoundLearningDigest.deleteMany.mockResolvedValue({ count: 0 });
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt',
  });
  (getProvider as Mock).mockResolvedValue({ name: 'openai' });
  prismaMock.aiAgent.findUnique.mockResolvedValue({
    id: 'composer',
    provider: 'openai',
    model: 'gpt',
    fallbackProviders: [],
  });
  (runStructuredCompletion as Mock).mockResolvedValue({
    value: {
      themes: [{ key: 'workload', insight: 'Several mentioned heavy workload.', divergence: 0.7 }],
    },
    tokenUsage: { input: 100, output: 50 },
  });
});

describe('refreshRoundLearningDigest — gates', () => {
  it('skips + returns learning_disabled when the round toggle is off', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({
      learningEnabled: false,
      learningConfig: {},
    });
    const res = await refreshRoundLearningDigest('r1', 'v1');
    expect(res).toEqual({ built: false, reason: 'learning_disabled' });
    expect(prismaMock.appQuestionnaireSession.findMany).not.toHaveBeenCalled();
  });

  it('clears the digest + returns below_threshold when fewer than minRespondents completed', async () => {
    prismaMock.appQuestionnaireSession.findMany.mockResolvedValue(sessions(2));
    const res = await refreshRoundLearningDigest('r1', 'v1');
    expect(res.reason).toBe('below_threshold');
    expect(prismaMock.appRoundLearningDigest.deleteMany).toHaveBeenCalledWith({
      where: { roundId: 'r1', versionId: 'v1' },
    });
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('excludes high-sensitivity sessions from the corpus (where filter)', async () => {
    await refreshRoundLearningDigest('r1', 'v1');
    const where = prismaMock.appQuestionnaireSession.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('completed');
    expect(where.isPreview).toBe(false);
    expect(where.NOT).toEqual({ sensitivityLevel: 'high' });
  });
});

describe('refreshRoundLearningDigest — build', () => {
  it('builds data-slot themes and writes them in a transaction', async () => {
    const res = await refreshRoundLearningDigest('r1', 'v1');
    expect(res.built).toBe(true);
    expect(res.slotCount).toBe(1);
    expect(prismaMock.$transaction).toHaveBeenCalled();
    const rows = prismaMock.appRoundLearningDigest.createMany.mock.calls[0][0].data;
    expect(rows[0]).toMatchObject({
      roundId: 'r1',
      versionId: 'v1',
      slotKind: 'data_slot',
      slotKey: 'workload',
      divergence: 0.7,
      sessionsCovered: 4,
    });
  });

  it('drops a slot below the per-slot respondent threshold', async () => {
    // Only 2 fills for the slot, threshold is 3 → no qualifying slots.
    prismaMock.appDataSlotFill.findMany.mockResolvedValue([
      { dataSlotId: 'd1', paraphrase: 'a', value: null },
      { dataSlotId: 'd1', paraphrase: 'b', value: null },
    ]);
    const res = await refreshRoundLearningDigest('r1', 'v1');
    expect(res.reason).toBe('no_qualifying_slots');
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('falls back to question answers when the version has no data slots', async () => {
    prismaMock.appDataSlot.findMany.mockResolvedValue([]);
    prismaMock.appAnswerSlot.findMany.mockResolvedValue([
      { value: 'yes', questionSlot: { key: 'q1', prompt: 'Happy?' } },
      { value: 'no', questionSlot: { key: 'q1', prompt: 'Happy?' } },
      { value: 'maybe', questionSlot: { key: 'q1', prompt: 'Happy?' } },
    ]);
    (runStructuredCompletion as Mock).mockResolvedValue({
      value: { themes: [{ key: 'q1', insight: 'Mixed views on happiness.', divergence: 0.5 }] },
      tokenUsage: { input: 1, output: 1 },
    });
    const res = await refreshRoundLearningDigest('r1', 'v1');
    expect(res.built).toBe(true);
    const rows = prismaMock.appRoundLearningDigest.createMany.mock.calls[0][0].data;
    expect(rows[0].slotKind).toBe('question');
  });

  it('leaves the digest untouched on a generalisation failure (no wipe)', async () => {
    (runStructuredCompletion as Mock).mockRejectedValue(new Error('llm down'));
    const res = await refreshRoundLearningDigest('r1', 'v1');
    expect(res.reason).toBe('generalisation_failed');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    // Must NOT have cleared an existing (possibly-valid) digest on a transient error.
    expect(prismaMock.appRoundLearningDigest.deleteMany).not.toHaveBeenCalled();
  });
});

describe('loadRoundPeerDigest', () => {
  it('returns null when the round toggle is off', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({ learningEnabled: false });
    expect(await loadRoundPeerDigest('r1', 'v1')).toBeNull();
  });

  it('maps rows to PeerInsight when on', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue({ learningEnabled: true });
    prismaMock.appRoundLearningDigest.findMany.mockResolvedValue([
      { slotKind: 'question', slotKey: 'q1', insight: 'theme', divergence: 0.4 },
    ]);
    const res = await loadRoundPeerDigest('r1', 'v1');
    expect(res).toEqual([
      { slotKind: 'question', slotKey: 'q1', insight: 'theme', divergence: 0.4 },
    ]);
  });
});

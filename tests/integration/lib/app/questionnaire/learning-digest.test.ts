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
  // `recordAiRun` swallows its own failures by design, so omitting this model would not fail a
  // test — it would silently turn every provenance assertion below into a no-op.
  appAiRun: { create: vi.fn().mockResolvedValue({ id: 'run-1' }) },
  aiAgent: { findUnique: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/evaluations/parse-structured', () => ({
  tryParseJson: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: vi.fn(),
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
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { logger } from '@/lib/logging';

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
    // Atomic replace: deleteMany + createMany are issued as the two ops of ONE transaction.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction.mock.calls[0][0]).toHaveLength(2);
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

  it('records the build as an AI run so the wholesale replace stays explainable', async () => {
    // F14.15: the transaction above erases the previous digest, so the run log is the ONLY record
    // of how the current rows were produced. recordAiRun fail-softs, so this must be asserted
    // directly — a dropped call would otherwise leave every other assertion in this file green.
    await refreshRoundLearningDigest('r1', 'v1');

    expect(prismaMock.appAiRun.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.appAiRun.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      subjectKind: 'version',
      subjectId: 'v1',
      versionId: 'v1',
      kind: 'learning_digest',
      status: 'succeeded',
      provider: 'openai',
      model: 'gpt',
    });
    // The snapshot must carry the themes actually written, not a placeholder.
    expect(data.outputSnapshot).toEqual([
      expect.objectContaining({
        slotKind: 'data_slot',
        slotKey: 'workload',
        insight: 'Several mentioned heavy workload.',
        divergence: 0.7,
      }),
    ]);
    expect(data.detail).toMatchObject({ roundId: 'r1', slotCount: 1, sessionsCovered: 4 });
  });

  it('does not record an AI run when no themes survive filtering', async () => {
    // Pairs with the test above: provenance tracks BUILDS, not attempts. A run row for a cleared
    // digest would claim rows exist that the transaction never wrote.
    (runStructuredCompletion as Mock).mockResolvedValue({
      value: { themes: [{ key: 'HALLUCINATED', insight: 'made up', divergence: 0.5 }] },
      tokenUsage: { input: 1, output: 1 },
    });
    const res = await refreshRoundLearningDigest('r1', 'v1');
    expect(res.reason).toBe('no_themes');
    expect(prismaMock.appAiRun.create).not.toHaveBeenCalled();
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

  it('uses the value fallback when a fill has no paraphrase', async () => {
    // paraphrase null/empty → valueToSample(value); the slot still qualifies and builds.
    prismaMock.appDataSlotFill.findMany.mockResolvedValue([
      { dataSlotId: 'd1', paraphrase: null, value: 'heavy load' },
      { dataSlotId: 'd1', paraphrase: '', value: 'manageable' },
      { dataSlotId: 'd1', paraphrase: '  ', value: 'too much' },
    ]);
    const res = await refreshRoundLearningDigest('r1', 'v1');
    expect(res.built).toBe(true);
    // The samples handed to the model came from the value fallback, not paraphrase.
    const prompt = (runStructuredCompletion as Mock).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('heavy load');
  });

  it('returns no_themes when the model only returns keys for slots we never offered', async () => {
    // generaliseThemes filters out hallucinated keys → empty themes → no_themes (digest cleared).
    (runStructuredCompletion as Mock).mockResolvedValue({
      value: { themes: [{ key: 'HALLUCINATED', insight: 'made up', divergence: 0.5 }] },
      tokenUsage: { input: 1, output: 1 },
    });
    const res = await refreshRoundLearningDigest('r1', 'v1');
    expect(res.reason).toBe('no_themes');
    expect(prismaMock.appRoundLearningDigest.deleteMany).toHaveBeenCalled();
    expect(prismaMock.appRoundLearningDigest.createMany).not.toHaveBeenCalled();
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

  it('treats a missing composer agent as generalisation_failed (no wipe)', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    const res = await refreshRoundLearningDigest('r1', 'v1');
    expect(res.reason).toBe('generalisation_failed');
    expect(runStructuredCompletion).not.toHaveBeenCalled();
    expect(prismaMock.appRoundLearningDigest.deleteMany).not.toHaveBeenCalled();
  });

  it('treats an unresolvable provider as generalisation_failed (no wipe)', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider'));
    const res = await refreshRoundLearningDigest('r1', 'v1');
    expect(res.reason).toBe('generalisation_failed');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('clears + returns no_themes when the model returns an empty theme set', async () => {
    (runStructuredCompletion as Mock).mockResolvedValue({
      value: { themes: [] },
      tokenUsage: { input: 1, output: 1 },
    });
    const res = await refreshRoundLearningDigest('r1', 'v1');
    expect(res.reason).toBe('no_themes');
    expect(prismaMock.appRoundLearningDigest.deleteMany).toHaveBeenCalled();
  });

  it('returns early (no aggregation) when the round is gone', async () => {
    prismaMock.appQuestionnaireRound.findUnique.mockResolvedValue(null);
    const res = await refreshRoundLearningDigest('r1', 'v1');
    expect(res).toEqual({ built: false, reason: 'learning_disabled' });
  });

  it('still builds the digest when cost logging rejects, and logs the rejection', async () => {
    // Cost tracking is fire-and-forget: a logCost outage must not fail the digest (the whole
    // point of the `.catch`), but it must not be swallowed silently either — that would hide a
    // systematic cost-logging failure. Pins both halves of that contract.
    (logCost as Mock).mockRejectedValueOnce(new Error('cost sink unavailable'));

    const res = await refreshRoundLearningDigest('r1', 'v1');

    expect(res.built).toBe(true);
    expect(res.slotCount).toBe(1);
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        'learning digest: logCost rejected',
        expect.objectContaining({ error: 'cost sink unavailable' })
      );
    });
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

/**
 * Unit tests for enforceAppRetentionPolicies — the app-owned prune sweep for
 * AppQuestionnaireTurnEvaluation / AppQuestionnaireEvaluationRun / AppAiRun (F14.15).
 *
 * @see lib/app/questionnaire/retention.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireTurnEvaluation: { deleteMany: vi.fn() },
    appQuestionnaireEvaluationRun: { deleteMany: vi.fn() },
    appAiRun: { deleteMany: vi.fn() },
    aiOrchestrationSettings: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { enforceAppRetentionPolicies } from '@/lib/app/questionnaire/retention';

const findSettings = vi.mocked(prisma.aiOrchestrationSettings.findUnique);
const deleteTurnEvaluations = vi.mocked(prisma.appQuestionnaireTurnEvaluation.deleteMany);
const deleteEvaluationRuns = vi.mocked(prisma.appQuestionnaireEvaluationRun.deleteMany);
const deleteAiRuns = vi.mocked(prisma.appAiRun.deleteMany);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enforceAppRetentionPolicies — retention disabled', () => {
  it('returns zero counts and issues no deletes when evaluationRetentionDays is null', async () => {
    findSettings.mockResolvedValue({ evaluationRetentionDays: null } as never);

    const result = await enforceAppRetentionPolicies();

    expect(result).toEqual({
      turnEvaluationsDeleted: 0,
      evaluationRunsDeleted: 0,
      aiRunsDeleted: 0,
      retentionDays: null,
    });
    expect(deleteTurnEvaluations).not.toHaveBeenCalled();
    expect(deleteEvaluationRuns).not.toHaveBeenCalled();
    expect(deleteAiRuns).not.toHaveBeenCalled();
  });

  it('returns zero counts when the settings row itself is missing (findUnique resolves null)', async () => {
    findSettings.mockResolvedValue(null);

    const result = await enforceAppRetentionPolicies();

    expect(result.retentionDays).toBeNull();
    expect(deleteTurnEvaluations).not.toHaveBeenCalled();
  });

  it('returns zero counts when evaluationRetentionDays is 0 (not just null)', async () => {
    // days <= 0 is treated the same as "disabled" — a misconfigured 0 must not
    // become an unbounded delete via a negative/zero cutoff window.
    findSettings.mockResolvedValue({ evaluationRetentionDays: 0 } as never);

    const result = await enforceAppRetentionPolicies();

    expect(result.retentionDays).toBeNull();
    expect(deleteTurnEvaluations).not.toHaveBeenCalled();
    expect(deleteAiRuns).not.toHaveBeenCalled();
  });
});

describe('enforceAppRetentionPolicies — retention enabled', () => {
  it('deletes aged rows across all three models using a cutoff derived from the configured window', async () => {
    findSettings.mockResolvedValue({ evaluationRetentionDays: 45 } as never);
    deleteTurnEvaluations.mockResolvedValue({ count: 12 });
    deleteEvaluationRuns.mockResolvedValue({ count: 3 });
    deleteAiRuns.mockResolvedValue({ count: 7 });

    const beforeMs = Date.now();
    const result = await enforceAppRetentionPolicies();
    const afterMs = Date.now();

    // Counts map to the correct fields — distinct values catch a field swap.
    expect(result).toEqual({
      turnEvaluationsDeleted: 12,
      evaluationRunsDeleted: 3,
      aiRunsDeleted: 7,
      retentionDays: 45,
    });

    // Each model's deleteMany used the SAME 45-day-derived cutoff — the module
    // header's stated design ("all three reuse the platform's setting").
    const expectedMs = 45 * 24 * 60 * 60 * 1000;
    for (const mock of [deleteTurnEvaluations, deleteEvaluationRuns, deleteAiRuns]) {
      const call = mock.mock.calls[0][0] as { where: { createdAt: { lt: Date } } };
      const cutoff = call.where.createdAt.lt;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(beforeMs - expectedMs - 100);
      expect(cutoff.getTime()).toBeLessThanOrEqual(afterMs - expectedMs + 100);
    }
  });

  it('logs the sweep summary only when at least one row was deleted', async () => {
    findSettings.mockResolvedValue({ evaluationRetentionDays: 30 } as never);
    deleteTurnEvaluations.mockResolvedValue({ count: 0 });
    deleteEvaluationRuns.mockResolvedValue({ count: 0 });
    deleteAiRuns.mockResolvedValue({ count: 1 });

    await enforceAppRetentionPolicies();

    expect(logger.info).toHaveBeenCalledWith(
      'App retention sweep pruned aged evaluation/provenance rows',
      expect.objectContaining({ aiRunsDeleted: 1 })
    );
  });

  it('does not log the sweep summary when nothing matched the cutoff', async () => {
    findSettings.mockResolvedValue({ evaluationRetentionDays: 30 } as never);
    deleteTurnEvaluations.mockResolvedValue({ count: 0 });
    deleteEvaluationRuns.mockResolvedValue({ count: 0 });
    deleteAiRuns.mockResolvedValue({ count: 0 });

    const result = await enforceAppRetentionPolicies();

    expect(result).toEqual({
      turnEvaluationsDeleted: 0,
      evaluationRunsDeleted: 0,
      aiRunsDeleted: 0,
      retentionDays: 30,
    });
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('enforceAppRetentionPolicies — failure safety', () => {
  it('returns zero counts rather than throwing when the delete sweep rejects', async () => {
    // One model's deleteMany fails mid-Promise.all — the whole sweep must not
    // reject the caller (a maintenance task failing must not take the rest of
    // the tick's chain down with it, per the module contract).
    findSettings.mockResolvedValue({ evaluationRetentionDays: 30 } as never);
    deleteTurnEvaluations.mockResolvedValue({ count: 0 });
    deleteEvaluationRuns.mockResolvedValue({ count: 0 });
    deleteAiRuns.mockRejectedValue(new Error('connection reset'));

    const result = await enforceAppRetentionPolicies();

    expect(result).toEqual({
      turnEvaluationsDeleted: 0,
      evaluationRunsDeleted: 0,
      aiRunsDeleted: 0,
      retentionDays: null,
    });
    expect(logger.error).toHaveBeenCalledWith(
      'App retention sweep failed',
      expect.objectContaining({ error: 'connection reset' })
    );
  });

  it('does not propagate a rejection — the sweep is safe to call unawaited from a maintenance chain', async () => {
    findSettings.mockRejectedValue(new Error('settings table unreachable'));

    await expect(enforceAppRetentionPolicies()).resolves.toEqual({
      turnEvaluationsDeleted: 0,
      evaluationRunsDeleted: 0,
      aiRunsDeleted: 0,
      retentionDays: null,
    });
  });
});

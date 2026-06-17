/**
 * Unit test: persisted turn-evaluation read model (list + detail).
 *
 * Pins the WHERE construction from filters (flag/effectiveness/version/model/score-range/date),
 * the score-range refine, the fixed-budget version enrichment (one batched query, mapped onto
 * rows), the comment-preview trimming, and the detail null path. The DB seam is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireTurnEvaluation: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
  appQuestionnaireVersion: { findMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import {
  listTurnEvaluations,
  getTurnEvaluationDetail,
  listTurnEvaluationsQuerySchema,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-list';

type Mock = ReturnType<typeof vi.fn>;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'eval-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    turnOrdinal: 2,
    overallScore: 82,
    effectiveness: 'Good',
    evaluatorModel: 'claude-x',
    evaluatorProvider: 'anthropic',
    rubricVersion: '1.0.0',
    questionnaireVersionId: 'ver-1',
    flagStatus: 'flagged',
    comment: 'a'.repeat(200),
    datasetCaseId: null,
    costUsd: 0.004,
    createdAt: new Date('2026-06-17T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prismaMock.appQuestionnaireVersion.findMany as Mock).mockResolvedValue([
    { id: 'ver-1', versionNumber: 3, questionnaire: { id: 'q-1', title: 'Housing survey' } },
  ]);
});

describe('listTurnEvaluations', () => {
  beforeEach(() => {
    (prismaMock.appQuestionnaireTurnEvaluation.findMany as Mock).mockResolvedValue([row()]);
    (prismaMock.appQuestionnaireTurnEvaluation.count as Mock).mockResolvedValue(1);
  });

  it('builds the WHERE from every filter and enriches rows with the questionnaire title', async () => {
    const query = listTurnEvaluationsQuerySchema.parse({
      flagStatus: 'flagged',
      effectiveness: 'Good',
      questionnaireVersionId: 'ver-1',
      model: 'claude',
      minScore: '50',
      maxScore: '90',
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T00:00:00.000Z',
    });

    const result = await listTurnEvaluations(query);

    const [{ where }] = (prismaMock.appQuestionnaireTurnEvaluation.findMany as Mock).mock.calls[0];
    expect(where).toMatchObject({
      flagStatus: 'flagged',
      effectiveness: 'Good',
      questionnaireVersionId: 'ver-1',
      evaluatorModel: { contains: 'claude', mode: 'insensitive' },
      overallScore: { gte: 50, lte: 90 },
    });
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeInstanceOf(Date);

    // Enrichment: one batched version query, title + version mapped onto the row.
    expect(prismaMock.appQuestionnaireVersion.findMany).toHaveBeenCalledTimes(1);
    expect(result.items[0]).toMatchObject({
      questionnaireTitle: 'Housing survey',
      questionnaireId: 'q-1',
      versionNumber: 3,
    });
    expect(result.total).toBe(1);
  });

  it('trims the comment to a bounded preview with an ellipsis', async () => {
    const result = await listTurnEvaluations(listTurnEvaluationsQuerySchema.parse({}));
    expect(result.items[0].commentPreview).toHaveLength(141); // 140 chars + ellipsis
    expect(result.items[0].commentPreview?.endsWith('…')).toBe(true);
  });

  it('omits range filters when no score/date bounds are given', async () => {
    await listTurnEvaluations(listTurnEvaluationsQuerySchema.parse({}));
    const [{ where }] = (prismaMock.appQuestionnaireTurnEvaluation.findMany as Mock).mock.calls[0];
    expect(where).not.toHaveProperty('overallScore');
    expect(where).not.toHaveProperty('createdAt');
    expect(where).not.toHaveProperty('flagStatus');
  });

  it('leaves enrichment fields null when the version no longer resolves', async () => {
    (prismaMock.appQuestionnaireVersion.findMany as Mock).mockResolvedValue([]);
    const result = await listTurnEvaluations(listTurnEvaluationsQuerySchema.parse({}));
    expect(result.items[0].questionnaireTitle).toBeNull();
    expect(result.items[0].versionNumber).toBeNull();
  });

  it('rejects an inverted score range at the schema boundary', () => {
    expect(() =>
      listTurnEvaluationsQuerySchema.parse({ minScore: '90', maxScore: '10' })
    ).toThrow();
  });
});

describe('getTurnEvaluationDetail', () => {
  it('returns null when the row is missing', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findUnique as Mock).mockResolvedValue(null);
    const res = await getTurnEvaluationDetail('nope');
    expect(res).toBeNull();
    expect(prismaMock.appQuestionnaireVersion.findMany).not.toHaveBeenCalled();
  });

  it('returns the full detail with verdict/snapshot passthrough and ISO dates', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findUnique as Mock).mockResolvedValue({
      ...row(),
      evaluatorAgentId: 'agent-1',
      appVersion: '9.9.9',
      evaluatedByUserId: 'admin-1',
      verdict: { overallScore: 82 },
      evaluatedInput: { turn: { turnIndex: 1, calls: [] } },
      commentByUserId: 'admin-1',
      commentAt: new Date('2026-06-17T00:00:00Z'),
      flagReviewerId: 'admin-1',
      flagUpdatedAt: new Date('2026-06-17T00:00:00Z'),
      datasetId: null,
      updatedAt: new Date('2026-06-17T00:00:00Z'),
    });

    const res = await getTurnEvaluationDetail('eval-1');
    expect(res).not.toBeNull();
    expect(res?.verdict).toEqual({ overallScore: 82 });
    expect(res?.evaluatedInput).toMatchObject({ turn: { turnIndex: 1 } });
    expect(res?.questionnaireTitle).toBe('Housing survey');
    expect(res?.commentAt).toBe('2026-06-17T00:00:00.000Z');
    expect(typeof res?.createdAt).toBe('string');
  });
});

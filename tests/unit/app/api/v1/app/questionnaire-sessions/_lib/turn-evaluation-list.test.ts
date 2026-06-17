/**
 * Unit test: persisted turn-evaluation read model (list + detail).
 *
 * Pins the WHERE construction from filters (flag/effectiveness/version/model/score-range/date),
 * the score-range refine, the fixed-budget version enrichment (one batched query, mapped onto
 * rows), the comment-preview trimming, and the detail null path. The DB seam is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireTurnEvaluation: {
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
    groupBy: vi.fn(),
  },
  appQuestionnaireVersion: { findMany: vi.fn() },
  appQuestionnaireSession: { findUnique: vi.fn() },
  appQuestionnaireTurn: { findMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import {
  listTurnEvaluations,
  getTurnEvaluationDetail,
  lookupSessionByRef,
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

  it('applies only a minScore lower bound when maxScore is absent', async () => {
    const query = listTurnEvaluationsQuerySchema.parse({ minScore: '50' });
    await listTurnEvaluations(query);
    const [{ where }] = (prismaMock.appQuestionnaireTurnEvaluation.findMany as Mock).mock.calls[0];
    // Only the gte half should be present — no lte key.
    expect(where.overallScore).toMatchObject({ gte: 50 });
    expect(where.overallScore).not.toHaveProperty('lte');
  });

  it('applies only a maxScore upper bound when minScore is absent', async () => {
    const query = listTurnEvaluationsQuerySchema.parse({ maxScore: '80' });
    await listTurnEvaluations(query);
    const [{ where }] = (prismaMock.appQuestionnaireTurnEvaluation.findMany as Mock).mock.calls[0];
    expect(where.overallScore).toMatchObject({ lte: 80 });
    expect(where.overallScore).not.toHaveProperty('gte');
  });

  it('applies only a from date bound when to is absent', async () => {
    const query = listTurnEvaluationsQuerySchema.parse({ from: '2026-06-01T00:00:00.000Z' });
    await listTurnEvaluations(query);
    const [{ where }] = (prismaMock.appQuestionnaireTurnEvaluation.findMany as Mock).mock.calls[0];
    expect(where.createdAt).toMatchObject({ gte: expect.any(Date) });
    expect(where.createdAt).not.toHaveProperty('lte');
  });

  it('applies only a to date bound when from is absent', async () => {
    const query = listTurnEvaluationsQuerySchema.parse({ to: '2026-06-30T00:00:00.000Z' });
    await listTurnEvaluations(query);
    const [{ where }] = (prismaMock.appQuestionnaireTurnEvaluation.findMany as Mock).mock.calls[0];
    expect(where.createdAt).toMatchObject({ lte: expect.any(Date) });
    expect(where.createdAt).not.toHaveProperty('gte');
  });

  it('returns null commentPreview when comment is null', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findMany as Mock).mockResolvedValue([
      row({ comment: null }),
    ]);
    const result = await listTurnEvaluations(listTurnEvaluationsQuerySchema.parse({}));
    expect(result.items[0].commentPreview).toBeNull();
  });

  it('returns null commentPreview when comment is whitespace-only', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findMany as Mock).mockResolvedValue([
      row({ comment: '   ' }),
    ]);
    const result = await listTurnEvaluations(listTurnEvaluationsQuerySchema.parse({}));
    expect(result.items[0].commentPreview).toBeNull();
  });

  it('returns the full comment without ellipsis when it fits within the preview limit', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findMany as Mock).mockResolvedValue([
      row({ comment: 'Short comment' }),
    ]);
    const result = await listTurnEvaluations(listTurnEvaluationsQuerySchema.parse({}));
    expect(result.items[0].commentPreview).toBe('Short comment');
    expect(result.items[0].commentPreview?.endsWith('…')).toBe(false);
  });
});

describe('lookupSessionByRef', () => {
  beforeEach(() => {
    (prismaMock.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
      id: 'sess-1',
      publicRef: '7F3K9M2P',
      status: 'completed',
      isPreview: false,
      versionId: 'ver-1',
      createdAt: new Date('2026-06-17T00:00:00Z'),
    });
    (prismaMock.appQuestionnaireTurn.findMany as Mock).mockResolvedValue([
      {
        ordinal: 1,
        userMessage: 'I rent a flat',
        agentResponse: 'Whereabouts?',
        inspectorCalls: [{ label: 'a' }, { label: 'b' }],
        createdAt: new Date('2026-06-17T00:00:00Z'),
      },
      {
        ordinal: 2,
        userMessage: 'Central',
        agentResponse: 'Thanks',
        inspectorCalls: [],
        createdAt: new Date('2026-06-17T00:01:00Z'),
      },
    ]);
    (prismaMock.appQuestionnaireTurnEvaluation.groupBy as Mock).mockResolvedValue([
      { turnOrdinal: 1, _count: { _all: 2 } },
    ]);
  });

  it('returns null when no session matches the (normalised) ref', async () => {
    (prismaMock.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(null);
    expect(await lookupSessionByRef('nope')).toBeNull();
  });

  it('normalises the ref before the lookup (folds dashes + look-alikes)', async () => {
    await lookupSessionByRef('7f3k-9m2p');
    expect(prismaMock.appQuestionnaireSession.findUnique).toHaveBeenCalledWith({
      where: { publicRef: '7F3K9M2P' },
      select: expect.any(Object),
    });
  });

  it('returns the session + turns with hasTraces, callCount, and prior-evaluation counts', async () => {
    const result = await lookupSessionByRef('7F3K-9M2P');
    expect(result).not.toBeNull();
    expect(result?.session).toMatchObject({
      id: 'sess-1',
      ref: '7F3K9M2P',
      questionnaireTitle: 'Housing survey',
      versionNumber: 3,
    });
    // Turn 1 has traces + 2 prior verdicts; turn 2 has none.
    expect(result?.turns[0]).toMatchObject({
      ordinal: 1,
      hasTraces: true,
      callCount: 2,
      evaluationCount: 2,
    });
    expect(result?.turns[1]).toMatchObject({
      ordinal: 2,
      hasTraces: false,
      callCount: 0,
      evaluationCount: 0,
    });
  });

  it('returns null when normalizeSessionRef returns a falsy value for an invalid ref', async () => {
    // An empty string normalises to null/empty — no DB query should be made.
    const result = await lookupSessionByRef('');
    expect(result).toBeNull();
    expect(prismaMock.appQuestionnaireSession.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when the session row has no publicRef (publicRef is null)', async () => {
    (prismaMock.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
      id: 'sess-2',
      publicRef: null,
      status: 'active',
      isPreview: false,
      versionId: 'ver-1',
      createdAt: new Date('2026-06-17T00:00:00Z'),
    });
    expect(await lookupSessionByRef('7F3K9M2P')).toBeNull();
  });

  it('treats a non-array inspectorCalls field as 0 call-count with no traces', async () => {
    (prismaMock.appQuestionnaireTurn.findMany as Mock).mockResolvedValue([
      {
        ordinal: 1,
        userMessage: 'Hi',
        agentResponse: 'Hello',
        inspectorCalls: null, // non-array — DB null before capture column was added
        createdAt: new Date('2026-06-17T00:00:00Z'),
      },
    ]);

    const result = await lookupSessionByRef('7F3K9M2P');
    expect(result?.turns[0]).toMatchObject({
      callCount: 0,
      hasTraces: false,
    });
  });

  it('leaves questionnaireTitle and versionNumber null when the version is not resolved', async () => {
    (prismaMock.appQuestionnaireVersion.findMany as Mock).mockResolvedValue([]);
    const result = await lookupSessionByRef('7F3K9M2P');
    expect(result?.session.questionnaireTitle).toBeNull();
    expect(result?.session.versionNumber).toBeNull();
  });
});

describe('getTurnEvaluationDetail', () => {
  beforeEach(() => {
    // Self-contained: seed the version enrichment default this block relies on,
    // rather than depending on the outer seed (which is order-fragile).
    (prismaMock.appQuestionnaireVersion.findMany as Mock).mockResolvedValue([
      { id: 'ver-1', versionNumber: 3, questionnaire: { id: 'q-1', title: 'Housing survey' } },
    ]);
  });

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

  it('maps null commentAt and flagUpdatedAt to null in the returned detail', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findUnique as Mock).mockResolvedValue({
      ...row(),
      evaluatorAgentId: 'agent-1',
      appVersion: '1.0.0',
      evaluatedByUserId: 'admin-1',
      verdict: { overallScore: 70 },
      evaluatedInput: { turn: { turnIndex: 0, calls: [] } },
      commentByUserId: null,
      commentAt: null, // no comment timestamp
      flagReviewerId: null,
      flagUpdatedAt: null, // no flag timestamp
      datasetId: null,
      updatedAt: new Date('2026-06-17T00:00:00Z'),
    });

    const res = await getTurnEvaluationDetail('eval-1');
    expect(res?.commentAt).toBeNull();
    expect(res?.flagUpdatedAt).toBeNull();
  });

  it('leaves enrichment fields null when the version is not resolvable', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findUnique as Mock).mockResolvedValue({
      ...row(),
      evaluatorAgentId: 'agent-1',
      appVersion: '1.0.0',
      evaluatedByUserId: 'admin-1',
      verdict: {},
      evaluatedInput: {},
      commentByUserId: null,
      commentAt: null,
      flagReviewerId: null,
      flagUpdatedAt: null,
      datasetId: null,
      updatedAt: new Date('2026-06-17T00:00:00Z'),
    });
    // Override to simulate the version no longer being in DB.
    (prismaMock.appQuestionnaireVersion.findMany as Mock).mockResolvedValue([]);

    const res = await getTurnEvaluationDetail('eval-1');
    expect(res?.questionnaireTitle).toBeNull();
    expect(res?.questionnaireId).toBeNull();
    expect(res?.versionNumber).toBeNull();
  });
});

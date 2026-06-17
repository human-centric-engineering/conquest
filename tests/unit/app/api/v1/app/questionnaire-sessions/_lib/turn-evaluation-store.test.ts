/**
 * Unit test: turn-evaluation persistence store (create path).
 *
 * Pins the row-mapping the evaluate-turn route relies on: ordinal derivation (inspector
 * `turnIndex` is 0-based → turn `ordinal` is 1-based), best-effort `turnId` back-link, the
 * score rounded to the Int column, the rubric/app version stamp, and that optional fields are
 * omitted (not written as null) when absent. The DB seam is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireTurn: { findFirst: vi.fn() },
  appQuestionnaireTurnEvaluation: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  aiDataset: { findFirst: vi.fn() },
  aiDatasetCase: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/lib/app-version', () => ({ APP_VERSION: '9.9.9' }));
vi.mock('@/lib/app/questionnaire/turn-evaluation', () => ({ TURN_RUBRIC_VERSION: '1.0.0' }));

const appendMock = vi.hoisted(() => ({ appendCasesToDataset: vi.fn() }));
vi.mock('@/lib/orchestration/evaluations/datasets/append-cases', () => appendMock);

import {
  persistTurnEvaluation,
  updateTurnEvaluationReview,
  actionTurnEvaluationForLearning,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-store';

type Mock = ReturnType<typeof vi.fn>;

const VERDICT = { overallScore: 82.6, effectiveness: 'Good' } as never;
const INPUT = { turn: { turnIndex: 2, calls: [{ label: 'x' }] }, context: { goal: 'g' } } as never;

function baseParams() {
  return {
    sessionId: 'sess-1',
    questionnaireVersionId: 'ver-1',
    verdict: VERDICT,
    evaluatedInput: INPUT,
    evaluatorModel: 'claude-x',
    evaluatorProvider: 'anthropic',
    evaluatorAgentId: 'agent-1',
    costUsd: 0.004,
    evaluatedByUserId: 'admin-1',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prismaMock.appQuestionnaireTurn.findFirst as Mock).mockResolvedValue({ id: 'turn-7' });
  (prismaMock.appQuestionnaireTurnEvaluation.create as Mock).mockResolvedValue({
    id: 'eval-1',
    turnId: 'turn-7',
    turnOrdinal: 3,
    rubricVersion: '1.0.0',
    appVersion: '9.9.9',
    createdAt: new Date('2026-06-17T00:00:00Z'),
  });
});

describe('persistTurnEvaluation', () => {
  it('derives the 1-based ordinal and looks up the turn by (sessionId, ordinal)', async () => {
    await persistTurnEvaluation(baseParams());
    expect(prismaMock.appQuestionnaireTurn.findFirst).toHaveBeenCalledWith({
      where: { sessionId: 'sess-1', ordinal: 3 }, // turnIndex 2 → ordinal 3
      select: { id: true },
    });
    const [{ data }] = (prismaMock.appQuestionnaireTurnEvaluation.create as Mock).mock.calls[0];
    expect(data.turnOrdinal).toBe(3);
    expect(data.turnId).toBe('turn-7');
  });

  it('rounds the score to the Int column and stamps rubric/app versions + snapshot', async () => {
    await persistTurnEvaluation(baseParams());
    const [{ data }] = (prismaMock.appQuestionnaireTurnEvaluation.create as Mock).mock.calls[0];
    expect(data.overallScore).toBe(83); // 82.6 rounded
    expect(data.effectiveness).toBe('Good');
    expect(data.rubricVersion).toBe('1.0.0');
    expect(data.appVersion).toBe('9.9.9');
    expect(data.verdict).toBe(VERDICT);
    expect(data.evaluatedInput).toBe(INPUT);
    expect(data.questionnaireVersionId).toBe('ver-1');
    expect(data.evaluatedByUserId).toBe('admin-1');
  });

  it('leaves turnId null when no persisted turn matches', async () => {
    (prismaMock.appQuestionnaireTurn.findFirst as Mock).mockResolvedValue(null);
    await persistTurnEvaluation(baseParams());
    const [{ data }] = (prismaMock.appQuestionnaireTurnEvaluation.create as Mock).mock.calls[0];
    expect(data.turnId).toBeNull();
  });

  it('omits optional fields rather than writing null when absent', async () => {
    await persistTurnEvaluation({
      sessionId: 'sess-1',
      questionnaireVersionId: 'ver-1',
      verdict: VERDICT,
      evaluatedInput: INPUT,
      evaluatorModel: 'claude-x',
      evaluatorProvider: 'anthropic',
    });
    const [{ data }] = (prismaMock.appQuestionnaireTurnEvaluation.create as Mock).mock.calls[0];
    expect(data).not.toHaveProperty('evaluatorAgentId');
    expect(data).not.toHaveProperty('costUsd');
    expect(data).not.toHaveProperty('evaluatedByUserId');
  });
});

describe('updateTurnEvaluationReview', () => {
  beforeEach(() => {
    (prismaMock.appQuestionnaireTurnEvaluation.findFirst as Mock).mockResolvedValue({
      id: 'eval-1',
      flagStatus: 'none',
    });
    (prismaMock.appQuestionnaireTurnEvaluation.update as Mock).mockResolvedValue({
      id: 'eval-1',
      comment: 'note',
      commentByUserId: 'admin-1',
      commentAt: new Date('2026-06-17T00:00:00Z'),
      flagStatus: 'flagged',
      flagReviewerId: 'admin-1',
      flagUpdatedAt: new Date('2026-06-17T00:00:00Z'),
      updatedAt: new Date('2026-06-17T00:00:00Z'),
    });
  });

  it('returns not_found when the row does not belong to the session', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findFirst as Mock).mockResolvedValue(null);
    const res = await updateTurnEvaluationReview({
      id: 'eval-1',
      sessionId: 'sess-1',
      reviewerId: 'admin-1',
      flagStatus: 'flagged',
    });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
    expect(prismaMock.appQuestionnaireTurnEvaluation.update).not.toHaveBeenCalled();
  });

  it('refuses to re-flag an actioned row (locked)', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findFirst as Mock).mockResolvedValue({
      id: 'eval-1',
      flagStatus: 'actioned',
    });
    const res = await updateTurnEvaluationReview({
      id: 'eval-1',
      sessionId: 'sess-1',
      reviewerId: 'admin-1',
      flagStatus: 'flagged',
    });
    expect(res).toEqual({ ok: false, reason: 'locked' });
  });

  it('locks a both-fields patch on an actioned row (the supplied flag trips the guard)', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findFirst as Mock).mockResolvedValue({
      id: 'eval-1',
      flagStatus: 'actioned',
    });
    const res = await updateTurnEvaluationReview({
      id: 'eval-1',
      sessionId: 'sess-1',
      reviewerId: 'admin-1',
      comment: 'still useful context',
      flagStatus: 'reviewed',
    });
    expect(res).toEqual({ ok: false, reason: 'locked' });
    expect(prismaMock.appQuestionnaireTurnEvaluation.update).not.toHaveBeenCalled();
  });

  it('allows a comment-only patch on an actioned row (only the flag is locked)', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findFirst as Mock).mockResolvedValue({
      id: 'eval-1',
      flagStatus: 'actioned',
    });
    const res = await updateTurnEvaluationReview({
      id: 'eval-1',
      sessionId: 'sess-1',
      reviewerId: 'admin-1',
      comment: 'still useful context',
    });
    expect(res.ok).toBe(true);
    const [{ data }] = (prismaMock.appQuestionnaireTurnEvaluation.update as Mock).mock.calls[0];
    expect(data).not.toHaveProperty('flagStatus');
    expect(data.comment).toBe('still useful context');
  });

  it('stamps reviewer + timestamp on the comment, and clears on empty string', async () => {
    await updateTurnEvaluationReview({
      id: 'eval-1',
      sessionId: 'sess-1',
      reviewerId: 'admin-1',
      comment: '',
    });
    const [{ data }] = (prismaMock.appQuestionnaireTurnEvaluation.update as Mock).mock.calls[0];
    expect(data.comment).toBeNull(); // empty string clears
    expect(data.commentByUserId).toBe('admin-1');
    expect(data.commentAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty('flagStatus'); // untouched facet not written
  });

  it('stamps reviewer + timestamp on a flag transition', async () => {
    await updateTurnEvaluationReview({
      id: 'eval-1',
      sessionId: 'sess-1',
      reviewerId: 'admin-2',
      flagStatus: 'reviewed',
    });
    const [{ where, data }] = (prismaMock.appQuestionnaireTurnEvaluation.update as Mock).mock
      .calls[0];
    expect(where).toEqual({ id: 'eval-1' });
    expect(data.flagStatus).toBe('reviewed');
    expect(data.flagReviewerId).toBe('admin-2');
    expect(data.flagUpdatedAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty('comment');
  });
});

describe('actionTurnEvaluationForLearning', () => {
  function evalRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'eval-1',
      flagStatus: 'reviewed',
      evaluatedInput: {
        turn: { turnIndex: 1, calls: [] },
        context: { respondentMessage: 'I rent a flat', interviewerMessage: 'Whereabouts?' },
      },
      turnOrdinal: 2,
      overallScore: 82,
      effectiveness: 'Good',
      rubricVersion: '1.0.0',
      questionnaireVersionId: 'ver-1',
      evaluatorModel: 'claude-x',
      comment: 'great probe',
      ...overrides,
    };
  }

  beforeEach(() => {
    (prismaMock.appQuestionnaireTurnEvaluation.findFirst as Mock).mockResolvedValue(evalRow());
    (prismaMock.aiDataset.findFirst as Mock).mockResolvedValue({ id: 'ds-1' });
    appendMock.appendCasesToDataset.mockResolvedValue({
      datasetId: 'ds-1',
      appendedCount: 1,
      newCaseCount: 5,
      newContentHash: 'hash',
    });
    (prismaMock.aiDatasetCase.findFirst as Mock).mockResolvedValue({ id: 'case-9' });
    // The flip is a conditional updateMany (claim) followed by a read-back of the row.
    (prismaMock.appQuestionnaireTurnEvaluation.updateMany as Mock).mockResolvedValue({ count: 1 });
    (prismaMock.appQuestionnaireTurnEvaluation.findUniqueOrThrow as Mock).mockResolvedValue({
      id: 'eval-1',
      flagStatus: 'actioned',
      flagReviewerId: 'admin-1',
      flagUpdatedAt: new Date('2026-06-17T00:00:00Z'),
      datasetId: 'ds-1',
      datasetCaseId: 'case-9',
      updatedAt: new Date('2026-06-17T00:00:00Z'),
    });
  });

  it('appends a learning case, resolves its id, and stamps actioned + dataset ids', async () => {
    const res = await actionTurnEvaluationForLearning({
      id: 'eval-1',
      sessionId: 'sess-1',
      datasetId: 'ds-1',
      reviewerId: 'admin-1',
    });
    expect(res.ok).toBe(true);

    // The case framing: respondent → input, interviewer → expectedOutput, rich provenance metadata.
    const [appendArg] = appendMock.appendCasesToDataset.mock.calls[0];
    expect(appendArg.datasetId).toBe('ds-1');
    const learningCase = appendArg.cases[0];
    expect(learningCase.input).toBe('I rent a flat');
    expect(learningCase.expectedOutput).toBe('Whereabouts?');
    expect(learningCase.metadata).toMatchObject({
      source: 'flagged_turn',
      evaluationId: 'eval-1',
      sessionId: 'sess-1',
      overallScore: 82,
      effectiveness: 'Good',
      rubricVersion: '1.0.0',
      questionnaireVersionId: 'ver-1',
      flaggedByUserId: 'admin-1',
      reviewerComment: 'great probe',
    });

    // The target dataset is resolved scoped to the reviewer (no cross-user write).
    expect(prismaMock.aiDataset.findFirst).toHaveBeenCalledWith({
      where: { id: 'ds-1', userId: 'admin-1' },
      select: { id: true },
    });

    // Case id resolved from the last position (newCaseCount - 1).
    expect(prismaMock.aiDatasetCase.findFirst).toHaveBeenCalledWith({
      where: { datasetId: 'ds-1', position: 4 },
      select: { id: true },
    });
    // The flip is claimed conditionally: only a row that isn't already actioned (scoped to the
    // session) is flipped, so a concurrent re-action can't double-stamp it.
    const [claimArg] = (prismaMock.appQuestionnaireTurnEvaluation.updateMany as Mock).mock.calls[0];
    expect(claimArg.where).toEqual({
      id: 'eval-1',
      sessionId: 'sess-1',
      flagStatus: { not: 'actioned' },
    });
    expect(claimArg.data).toMatchObject({
      flagStatus: 'actioned',
      flagReviewerId: 'admin-1',
      datasetId: 'ds-1',
      datasetCaseId: 'case-9',
    });
  });

  it('returns already_actioned when a concurrent action claimed the flip first (updateMany count 0)', async () => {
    // The row was not actioned at the initial read, but the conditional claim flips nothing —
    // another in-flight request actioned it between the read and the claim.
    (prismaMock.appQuestionnaireTurnEvaluation.updateMany as Mock).mockResolvedValue({ count: 0 });

    const res = await actionTurnEvaluationForLearning({
      id: 'eval-1',
      sessionId: 'sess-1',
      datasetId: 'ds-1',
      reviewerId: 'admin-1',
    });

    expect(res).toEqual({ ok: false, reason: 'already_actioned' });
    // The row is not read back / re-stamped once the claim loses the race.
    expect(prismaMock.appQuestionnaireTurnEvaluation.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('returns not_found when the row does not belong to the session', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findFirst as Mock).mockResolvedValue(null);
    const res = await actionTurnEvaluationForLearning({
      id: 'eval-1',
      sessionId: 'sess-1',
      datasetId: 'ds-1',
      reviewerId: 'admin-1',
    });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
    expect(appendMock.appendCasesToDataset).not.toHaveBeenCalled();
  });

  it('returns already_actioned without appending', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findFirst as Mock).mockResolvedValue(
      evalRow({ flagStatus: 'actioned' })
    );
    const res = await actionTurnEvaluationForLearning({
      id: 'eval-1',
      sessionId: 'sess-1',
      datasetId: 'ds-1',
      reviewerId: 'admin-1',
    });
    expect(res).toEqual({ ok: false, reason: 'already_actioned' });
    expect(appendMock.appendCasesToDataset).not.toHaveBeenCalled();
  });

  it('returns dataset_not_found when the dataset is missing or owned by another reviewer', async () => {
    // findFirst is scoped to `userId: reviewerId`, so a dataset the reviewer does not own
    // resolves to null here — a foreign id can never become a cross-user write.
    (prismaMock.aiDataset.findFirst as Mock).mockResolvedValue(null);
    const res = await actionTurnEvaluationForLearning({
      id: 'eval-1',
      sessionId: 'sess-1',
      datasetId: 'ds-x',
      reviewerId: 'admin-1',
    });
    expect(res).toEqual({ ok: false, reason: 'dataset_not_found' });
    expect(prismaMock.aiDataset.findFirst).toHaveBeenCalledWith({
      where: { id: 'ds-x', userId: 'admin-1' },
      select: { id: true },
    });
    expect(appendMock.appendCasesToDataset).not.toHaveBeenCalled();
  });

  it('returns no_content when the snapshot has no respondent message', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findFirst as Mock).mockResolvedValue(
      evalRow({ evaluatedInput: { turn: { turnIndex: 1, calls: [] }, context: {} } })
    );
    const res = await actionTurnEvaluationForLearning({
      id: 'eval-1',
      sessionId: 'sess-1',
      datasetId: 'ds-1',
      reviewerId: 'admin-1',
    });
    expect(res).toEqual({ ok: false, reason: 'no_content' });
    expect(appendMock.appendCasesToDataset).not.toHaveBeenCalled();
  });

  it('maps any append failure to dataset_full and leaves the row unactioned', async () => {
    appendMock.appendCasesToDataset.mockRejectedValue(new Error('cap exceeded'));
    const res = await actionTurnEvaluationForLearning({
      id: 'eval-1',
      sessionId: 'sess-1',
      datasetId: 'ds-1',
      reviewerId: 'admin-1',
    });
    expect(res).toEqual({ ok: false, reason: 'dataset_full' });
    expect(prismaMock.appQuestionnaireTurnEvaluation.update).not.toHaveBeenCalled();
  });

  it('maps a non-cap append throw to dataset_full too (the catch is catch-all)', async () => {
    appendMock.appendCasesToDataset.mockRejectedValue(new TypeError('unexpected boom'));
    const res = await actionTurnEvaluationForLearning({
      id: 'eval-1',
      sessionId: 'sess-1',
      datasetId: 'ds-1',
      reviewerId: 'admin-1',
    });
    expect(res).toEqual({ ok: false, reason: 'dataset_full' });
    expect(prismaMock.appQuestionnaireTurnEvaluation.update).not.toHaveBeenCalled();
  });

  it('omits reviewerComment from metadata when there is no comment', async () => {
    (prismaMock.appQuestionnaireTurnEvaluation.findFirst as Mock).mockResolvedValue(
      evalRow({ comment: null })
    );
    await actionTurnEvaluationForLearning({
      id: 'eval-1',
      sessionId: 'sess-1',
      datasetId: 'ds-1',
      reviewerId: 'admin-1',
    });
    const [appendArg] = appendMock.appendCasesToDataset.mock.calls[0];
    expect(appendArg.cases[0].metadata).not.toHaveProperty('reviewerComment');
  });
});

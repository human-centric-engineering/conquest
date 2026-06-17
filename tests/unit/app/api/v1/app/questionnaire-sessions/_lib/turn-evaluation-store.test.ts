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
  appQuestionnaireTurnEvaluation: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/lib/app-version', () => ({ APP_VERSION: '9.9.9' }));
vi.mock('@/lib/app/questionnaire/turn-evaluation', () => ({ TURN_RUBRIC_VERSION: '1.0.0' }));

import {
  persistTurnEvaluation,
  updateTurnEvaluationReview,
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

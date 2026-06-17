/**
 * Unit test: runSavedTurnEvaluation — re-evaluate a turn from its persisted inspector traces.
 *
 * Pins the discriminated outcomes (session/turn missing, no/invalid saved traces, evaluator not
 * configured, evaluator threw) and the happy path: validated dump + context (respondent +
 * interviewer + recent history) → evaluate → persist. The evaluator/persist/agent seams are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireSession: { findUnique: vi.fn() },
  appQuestionnaireTurn: { findFirst: vi.fn(), findMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const evalMock = vi.hoisted(() => ({ evaluateTurn: vi.fn() }));
vi.mock('@/lib/app/questionnaire/turn-evaluation', () => ({ evaluateTurn: evalMock.evaluateTurn }));

const ctxMock = vi.hoisted(() => ({
  loadTurnEvaluatorAgent: vi.fn(),
  buildObjectivesContext: vi.fn(() => ({ goal: 'Understand housing' })),
}));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-context', () => ctxMock);

const storeMock = vi.hoisted(() => ({ persistTurnEvaluation: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-store', () => storeMock);

import { runSavedTurnEvaluation } from '@/app/api/v1/app/questionnaire-sessions/_lib/evaluate-saved-turn';

type Mock = ReturnType<typeof vi.fn>;

/** One valid AgentCallTrace (passes inspectorTurnSchema). */
const CALL = {
  label: 'Answer extraction',
  model: 'gpt-4o-mini',
  provider: 'openai',
  latencyMs: 400,
  costUsd: 0.001,
  prompt: [{ role: 'input', content: '{"userMessage":"I rent a flat"}' }],
  response: '{"intents":[]}',
};

const PARAMS = { sessionId: 'sess-1', ordinal: 2, adminId: 'admin-1' };

beforeEach(() => {
  vi.clearAllMocks();
  (prismaMock.appQuestionnaireSession.findUnique as Mock).mockResolvedValue({
    version: {
      id: 'ver-1',
      goal: 'Understand housing',
      audience: null,
      config: { selectionStrategy: 'adaptive', tone: null },
    },
  });
  (prismaMock.appQuestionnaireTurn.findFirst as Mock).mockResolvedValue({
    userMessage: 'I rent a flat',
    agentResponse: 'Whereabouts?',
    inspectorCalls: [CALL],
  });
  (prismaMock.appQuestionnaireTurn.findMany as Mock).mockResolvedValue([
    { userMessage: 'Hi', agentResponse: 'Tell me about your home' },
  ]);
  ctxMock.loadTurnEvaluatorAgent.mockResolvedValue({
    id: 'agent-1',
    provider: '',
    model: '',
    fallbackProviders: [],
  });
  evalMock.evaluateTurn.mockResolvedValue({
    verdict: { overallScore: 80, effectiveness: 'Good' },
    costUsd: 0.004,
    model: 'claude-x',
    provider: 'anthropic',
  });
  storeMock.persistTurnEvaluation.mockResolvedValue({ id: 'eval-1' });
});

describe('runSavedTurnEvaluation', () => {
  it('evaluates the saved dump and persists, returning the verdict + evaluationId', async () => {
    const res = await runSavedTurnEvaluation(PARAMS);
    expect(res).toMatchObject({ ok: true, evaluationId: 'eval-1', model: 'claude-x' });

    // The dump is built from the saved traces with turnIndex = ordinal - 1.
    const [input, agent, opts] = evalMock.evaluateTurn.mock.calls[0];
    expect(input.turn.turnIndex).toBe(1);
    expect(input.turn.calls).toHaveLength(1);
    // Context carries respondent + interviewer + recent history.
    expect(input.context).toMatchObject({
      goal: 'Understand housing',
      respondentMessage: 'I rent a flat',
      interviewerMessage: 'Whereabouts?',
    });
    expect(input.context.recentMessages).toContain('Respondent: Hi');
    expect(agent).toMatchObject({ provider: '', model: '' });
    expect(opts).toMatchObject({ agentId: 'agent-1', sessionId: 'sess-1' });

    // Persisted with the version id + evaluator provenance + admin.
    const [persistArg] = storeMock.persistTurnEvaluation.mock.calls[0];
    expect(persistArg).toMatchObject({
      sessionId: 'sess-1',
      questionnaireVersionId: 'ver-1',
      evaluatorModel: 'claude-x',
      evaluatorProvider: 'anthropic',
      evaluatedByUserId: 'admin-1',
    });
  });

  it('returns session_not_found when the session is missing', async () => {
    (prismaMock.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(null);
    expect(await runSavedTurnEvaluation(PARAMS)).toEqual({
      ok: false,
      reason: 'session_not_found',
    });
    expect(evalMock.evaluateTurn).not.toHaveBeenCalled();
  });

  it('returns turn_not_found when the ordinal has no turn', async () => {
    (prismaMock.appQuestionnaireTurn.findFirst as Mock).mockResolvedValue(null);
    expect(await runSavedTurnEvaluation(PARAMS)).toEqual({ ok: false, reason: 'turn_not_found' });
  });

  it('returns no_traces when the saved dump is empty/invalid', async () => {
    (prismaMock.appQuestionnaireTurn.findFirst as Mock).mockResolvedValue({
      userMessage: 'x',
      agentResponse: 'y',
      inspectorCalls: [], // fails inspectorTurnSchema (min 1 call)
    });
    expect(await runSavedTurnEvaluation(PARAMS)).toEqual({ ok: false, reason: 'no_traces' });
    expect(ctxMock.loadTurnEvaluatorAgent).not.toHaveBeenCalled();
  });

  it('returns not_configured when no evaluator agent is seeded', async () => {
    ctxMock.loadTurnEvaluatorAgent.mockResolvedValue(null);
    expect(await runSavedTurnEvaluation(PARAMS)).toEqual({ ok: false, reason: 'not_configured' });
    expect(evalMock.evaluateTurn).not.toHaveBeenCalled();
  });

  it('returns failed when the evaluator throws', async () => {
    evalMock.evaluateTurn.mockRejectedValue(new Error('provider down'));
    expect(await runSavedTurnEvaluation(PARAMS)).toEqual({ ok: false, reason: 'failed' });
    expect(storeMock.persistTurnEvaluation).not.toHaveBeenCalled();
  });

  it('still returns ok with a null evaluationId when persistence fails', async () => {
    storeMock.persistTurnEvaluation.mockRejectedValue(new Error('db down'));
    const res = await runSavedTurnEvaluation(PARAMS);
    expect(res).toMatchObject({ ok: true, evaluationId: null });
  });

  it('omits respondentMessage and interviewerMessage from context when turn messages are empty', async () => {
    (prismaMock.appQuestionnaireTurn.findFirst as Mock).mockResolvedValue({
      userMessage: '',
      agentResponse: '',
      inspectorCalls: [CALL],
    });

    const res = await runSavedTurnEvaluation(PARAMS);
    expect(res).toMatchObject({ ok: true });

    const [input] = evalMock.evaluateTurn.mock.calls[0];
    // Empty strings are falsy — neither field should appear in the context.
    expect(input.context).not.toHaveProperty('respondentMessage');
    expect(input.context).not.toHaveProperty('interviewerMessage');
  });

  it('omits recentMessages from context when there are no prior turns', async () => {
    (prismaMock.appQuestionnaireTurn.findMany as Mock).mockResolvedValue([]);

    const res = await runSavedTurnEvaluation(PARAMS);
    expect(res).toMatchObject({ ok: true });

    const [input] = evalMock.evaluateTurn.mock.calls[0];
    expect(input.context).not.toHaveProperty('recentMessages');
  });

  it('drops a blank side of a prior turn from recentMessages (no empty Interviewer/Respondent line)', async () => {
    // A prior turn with a respondent message but an empty agent reply (e.g. an aborted turn)
    // must NOT inject a bare "Interviewer: " line — the filter keys on the value, not the
    // prefixed-line length ("Respondent: " is 12 chars, "Interviewer: " is 13).
    (prismaMock.appQuestionnaireTurn.findMany as Mock).mockResolvedValue([
      { userMessage: 'I live alone', agentResponse: '' },
      { userMessage: '   ', agentResponse: 'And your postcode?' },
    ]);

    const res = await runSavedTurnEvaluation(PARAMS);
    expect(res).toMatchObject({ ok: true });

    const [input] = evalMock.evaluateTurn.mock.calls[0];
    expect(input.context.recentMessages).toEqual([
      'Respondent: I live alone',
      'Interviewer: And your postcode?',
    ]);
  });

  it('returns failed and logs the raw string when the evaluator throws a non-Error', async () => {
    evalMock.evaluateTurn.mockRejectedValue('quota exceeded');
    const res = await runSavedTurnEvaluation(PARAMS);
    expect(res).toEqual({ ok: false, reason: 'failed' });
  });

  it('still returns ok with a null evaluationId when persistence fails with a non-Error throw', async () => {
    storeMock.persistTurnEvaluation.mockRejectedValue('write timeout');
    const res = await runSavedTurnEvaluation(PARAMS);
    expect(res).toMatchObject({ ok: true, evaluationId: null });
  });
});

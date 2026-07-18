/**
 * Re-evaluate a SAVED turn by its session + ordinal.
 *
 * The counterpart to the live `evaluate-turn` route: instead of a client-supplied dump from a
 * preview session, it reads the turn's persisted inspector traces (`AppQuestionnaireTurn.inspectorCalls`,
 * captured for every session — F-phase B) and runs the same evaluator over them. This is what makes
 * a chat looked up by its `publicRef` re-evaluable: an admin picks a turn and judges the exact calls
 * it actually ran. NOT preview-gated — it operates on real respondent sessions.
 *
 * Returns a discriminated result the route maps to HTTP; the verdict is persisted via the same
 * store as the live path (history accumulates, the turn back-links by ordinal).
 */

import { logger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';
import { inspectorTurnSchema } from '@/lib/app/questionnaire/inspector/schema';
import {
  evaluateTurn,
  type TurnEvaluation,
  type TurnEvaluationContext,
  type TurnEvaluationInput,
} from '@/lib/app/questionnaire/turn-evaluation';
import {
  buildObjectivesContext,
  loadTurnEvaluatorAgent,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-context';
import { persistTurnEvaluation } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-store';

/** How many prior conversation lines to include as recent context. */
const RECENT_CONTEXT_LINES = 12;

export interface RunSavedTurnEvaluationParams {
  sessionId: string;
  /** 1-based turn ordinal (as shown in the ref lookup). */
  ordinal: number;
  /** The admin running it, stamped on the persisted verdict. */
  adminId: string;
}

export type RunSavedTurnEvaluationResult =
  | {
      ok: true;
      verdict: TurnEvaluation;
      costUsd: number;
      model: string;
      evaluationId: string | null;
      /**
       * F14.15: set when the verdict was produced but could not be saved. Surfaced to the
       * admin — a silently-unsaved verdict reads exactly like a saved one.
       */
      persistError: string | null;
    }
  | {
      ok: false;
      reason: 'session_not_found' | 'turn_not_found' | 'no_traces' | 'not_configured' | 'failed';
    };

/**
 * Load the saved turn + its session's objectives, validate the persisted traces, and run + persist
 * the evaluation. `no_traces` when the turn has no saved inspector dump (e.g. a turn predating the
 * capture column, or a malformed record); `failed` when the evaluator itself throws.
 */
export async function runSavedTurnEvaluation(
  params: RunSavedTurnEvaluationParams
): Promise<RunSavedTurnEvaluationResult> {
  const sessionRow = await prisma.appQuestionnaireSession.findUnique({
    where: { id: params.sessionId },
    select: {
      version: {
        select: {
          id: true,
          goal: true,
          audience: true,
          config: { select: { selectionStrategy: true, tone: true } },
        },
      },
    },
  });
  if (!sessionRow) return { ok: false, reason: 'session_not_found' };

  const turn = await prisma.appQuestionnaireTurn.findFirst({
    where: { sessionId: params.sessionId, ordinal: params.ordinal },
    select: { userMessage: true, agentResponse: true, inspectorCalls: true },
  });
  if (!turn) return { ok: false, reason: 'turn_not_found' };

  // The persisted traces are structurally untrusted at this read seam — validate with the SAME
  // schema the live POST uses. An empty/malformed dump can't be evaluated.
  const dump = inspectorTurnSchema.safeParse({
    turnIndex: params.ordinal - 1,
    calls: turn.inspectorCalls,
  });
  if (!dump.success) return { ok: false, reason: 'no_traces' };

  const agent = await loadTurnEvaluatorAgent();
  if (!agent) return { ok: false, reason: 'not_configured' };

  // Recent history (oldest first) from the prior turns, for stage/flow judgement.
  const priorTurns = await prisma.appQuestionnaireTurn.findMany({
    where: { sessionId: params.sessionId, ordinal: { lt: params.ordinal } },
    orderBy: { ordinal: 'asc' },
    select: { userMessage: true, agentResponse: true },
  });
  const recentMessages = priorTurns
    .flatMap((t) => [
      // Drop empty/blank sides — filter on the message value, not the prefixed-line length
      // ("Respondent: " is 12 chars and "Interviewer: " is 13, so a single length cutoff keeps
      // an empty interviewer line).
      ...(t.userMessage.trim() ? [`Respondent: ${t.userMessage}`] : []),
      ...(t.agentResponse.trim() ? [`Interviewer: ${t.agentResponse}`] : []),
    ])
    .slice(-RECENT_CONTEXT_LINES);

  const version = sessionRow.version;
  const context: TurnEvaluationContext = {
    ...buildObjectivesContext(version),
    ...(turn.userMessage ? { respondentMessage: turn.userMessage } : {}),
    ...(turn.agentResponse ? { interviewerMessage: turn.agentResponse } : {}),
    ...(recentMessages.length > 0 ? { recentMessages } : {}),
  };

  const input: TurnEvaluationInput = { turn: dump.data, context };

  let verdict: TurnEvaluation;
  let costUsd: number;
  let model: string;
  let provider: string;
  try {
    const result = await evaluateTurn(
      input,
      { provider: agent.provider, model: agent.model, fallbackProviders: agent.fallbackProviders },
      { agentId: agent.id, sessionId: params.sessionId }
    );
    ({ verdict, costUsd, model, provider } = result);
  } catch (err) {
    logger.error('evaluate_saved_turn: evaluation failed', {
      sessionId: params.sessionId,
      ordinal: params.ordinal,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: 'failed' };
  }

  let evaluationId: string | null = null;
  let persistError: string | null = null;
  try {
    const persisted = await persistTurnEvaluation({
      sessionId: params.sessionId,
      questionnaireVersionId: version.id,
      verdict,
      evaluatedInput: input,
      evaluatorModel: model,
      evaluatorProvider: provider,
      evaluatorAgentId: agent.id,
      costUsd,
      evaluatedByUserId: params.adminId,
    });
    evaluationId = persisted.id;
  } catch (err) {
    persistError = 'This verdict could not be saved — it will be lost when you close the drawer.';
    logger.error('evaluate_saved_turn: persist failed', {
      sessionId: params.sessionId,
      ordinal: params.ordinal,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { ok: true, verdict, costUsd, model, evaluationId, persistError };
}

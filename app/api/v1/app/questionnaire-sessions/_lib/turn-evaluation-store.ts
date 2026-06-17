/**
 * Persistence seam for {@link AppQuestionnaireTurnEvaluation} — the durable record of a Turn
 * Inspector verdict.
 *
 * The pure turn-evaluation core (`lib/app/questionnaire/turn-evaluation`) deliberately imports
 * no `@/lib/db`; the API tier owns DB access. This store concentrates every read/write of the
 * model so the evaluate-turn route (create), the comment/flag PATCH route (update), and the
 * list/search route (read) share one set of typed helpers instead of scattering `prisma`
 * calls. Inputs are already validated by their routes (Zod at the boundary) — this layer maps
 * them to rows.
 *
 * House style: `flagStatus` is a plain String validated here against {@link TURN_EVAL_FLAG_STATUSES}
 * rather than a Prisma enum (matching `status`/`selectionStrategy` elsewhere in this schema).
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { APP_VERSION } from '@/lib/app-version';
import { TURN_RUBRIC_VERSION, type TurnEvaluation } from '@/lib/app/questionnaire/turn-evaluation';
import type { TurnEvaluationInput } from '@/lib/app/questionnaire/turn-evaluation';

/**
 * The learning workflow a persisted verdict moves through. `none` is the resting state of a
 * freshly-run evaluation; an admin flags it, reviews it, then either actions it (appends it to
 * a learning dataset) or dismisses it. Validated at the seam, never a Prisma enum.
 */
export const TURN_EVAL_FLAG_STATUSES = [
  'none',
  'flagged',
  'reviewed',
  'actioned',
  'dismissed',
] as const;
export type TurnEvalFlagStatus = (typeof TURN_EVAL_FLAG_STATUSES)[number];

/** Everything the evaluate-turn route hands the store to persist one verdict. */
export interface PersistTurnEvaluationParams {
  sessionId: string;
  /** The denormalised version id (loaded from the session) so version-scoped search indexes. */
  questionnaireVersionId: string;
  /** The verdict to store, already validated against the schema. */
  verdict: TurnEvaluation;
  /** The exact dump + context that were judged — snapshotted because inspector data is live-only. */
  evaluatedInput: TurnEvaluationInput;
  /** Resolved evaluator binding that produced the verdict. */
  evaluatorModel: string;
  evaluatorProvider: string;
  /** The triggering judge agent's id, when known. */
  evaluatorAgentId?: string;
  /** Summed judge spend, when known. */
  costUsd?: number;
  /** The admin who ran the evaluation. */
  evaluatedByUserId?: string;
}

/** The persisted row fields the create path returns to the route (kept lean). */
export interface PersistedTurnEvaluation {
  id: string;
  turnId: string | null;
  turnOrdinal: number;
  rubricVersion: string;
  appVersion: string;
  createdAt: Date;
}

/**
 * Persist one turn evaluation. Best-effort links the verdict to its persisted
 * {@link AppQuestionnaireTurn} (inspector `turnIndex` is the 0-based selection round, which maps
 * to the turn's 1-based `ordinal`) so later surfaces can join back to the live turn; leaves
 * `turnId` null when no turn row exists (preview turns aren't always persisted).
 *
 * `overallScore` is rounded to the Int column from the schema's 0–100 (which permits decimals).
 * `rubricVersion`/`appVersion` are stamped from the running build so each row is self-describing.
 */
export async function persistTurnEvaluation(
  params: PersistTurnEvaluationParams
): Promise<PersistedTurnEvaluation> {
  const turnOrdinal = params.evaluatedInput.turn.turnIndex + 1;

  // Best-effort back-link to the live turn row, if this session persisted one for this ordinal.
  const turn = await prisma.appQuestionnaireTurn.findFirst({
    where: { sessionId: params.sessionId, ordinal: turnOrdinal },
    select: { id: true },
  });

  return prisma.appQuestionnaireTurnEvaluation.create({
    data: {
      sessionId: params.sessionId,
      turnId: turn?.id ?? null,
      turnOrdinal,
      // Our own validated, serializable shapes — cast to the Json input type (not external data).
      verdict: params.verdict,
      evaluatedInput: params.evaluatedInput as unknown as Prisma.InputJsonValue,
      overallScore: Math.round(params.verdict.overallScore),
      effectiveness: params.verdict.effectiveness,
      ...(params.evaluatorAgentId ? { evaluatorAgentId: params.evaluatorAgentId } : {}),
      evaluatorModel: params.evaluatorModel,
      evaluatorProvider: params.evaluatorProvider,
      rubricVersion: TURN_RUBRIC_VERSION,
      questionnaireVersionId: params.questionnaireVersionId,
      appVersion: APP_VERSION,
      ...(params.costUsd !== undefined ? { costUsd: params.costUsd } : {}),
      ...(params.evaluatedByUserId ? { evaluatedByUserId: params.evaluatedByUserId } : {}),
    },
    select: {
      id: true,
      turnId: true,
      turnOrdinal: true,
      rubricVersion: true,
      appVersion: true,
      createdAt: true,
    },
  });
}

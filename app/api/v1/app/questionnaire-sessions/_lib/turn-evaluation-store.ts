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

/**
 * The flag states an admin may set through the review PATCH. `actioned` is deliberately
 * excluded: it is owned by the dedicated learning-action endpoint, which must atomically append
 * a dataset case before the row may claim that state — so a stray PATCH can never produce an
 * `actioned` row with no backing case.
 */
export const TURN_EVAL_REVIEW_STATUSES = ['none', 'flagged', 'reviewed', 'dismissed'] as const;
export type TurnEvalReviewStatus = (typeof TURN_EVAL_REVIEW_STATUSES)[number];

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

/** A human-review patch: a comment, a flag transition, or both (the route enforces ≥1). */
export interface UpdateTurnEvaluationReviewParams {
  /** The evaluation row id. */
  id: string;
  /** The session the URL scopes to — the row must belong to it (defence against id-guessing). */
  sessionId: string;
  /** The admin making the change (stamped on whichever fields are touched). */
  reviewerId: string;
  /** New comment text; empty string clears the comment. Absent = leave comment untouched. */
  comment?: string;
  /** New flag state (review subset only). Absent = leave the flag untouched. */
  flagStatus?: TurnEvalReviewStatus;
}

/** The lean updated row the review PATCH returns. */
export interface TurnEvaluationReviewRow {
  id: string;
  comment: string | null;
  commentByUserId: string | null;
  commentAt: Date | null;
  flagStatus: string;
  flagReviewerId: string | null;
  flagUpdatedAt: Date | null;
  updatedAt: Date;
}

/** Discriminated outcome so the route can map cleanly to 404 / 409 / 200. */
export type UpdateTurnEvaluationReviewResult =
  | { ok: true; row: TurnEvaluationReviewRow }
  | { ok: false; reason: 'not_found' | 'locked' };

/**
 * Apply a human-review patch to one evaluation. Verifies the row belongs to `sessionId` (a
 * mismatched or missing id is `not_found`), refuses to mutate the flag of an already-`actioned`
 * row (`locked` — it is backed by a dataset case the action endpoint owns), then stamps the
 * toucher/timestamp on whichever facet changed. The DB write uses a `WHERE id AND sessionId`
 * guard so the scoping can't be raced.
 */
export async function updateTurnEvaluationReview(
  params: UpdateTurnEvaluationReviewParams
): Promise<UpdateTurnEvaluationReviewResult> {
  const existing = await prisma.appQuestionnaireTurnEvaluation.findFirst({
    where: { id: params.id, sessionId: params.sessionId },
    select: { id: true, flagStatus: true },
  });
  if (!existing) return { ok: false, reason: 'not_found' };

  // An actioned row is terminal for the flag: un-actioning here would orphan its dataset case.
  if (params.flagStatus !== undefined && existing.flagStatus === 'actioned') {
    return { ok: false, reason: 'locked' };
  }

  const now = new Date();
  const data: Prisma.AppQuestionnaireTurnEvaluationUpdateInput = {};
  if (params.comment !== undefined) {
    data.comment = params.comment.length > 0 ? params.comment : null;
    data.commentByUserId = params.reviewerId;
    data.commentAt = now;
  }
  if (params.flagStatus !== undefined) {
    data.flagStatus = params.flagStatus;
    data.flagReviewerId = params.reviewerId;
    data.flagUpdatedAt = now;
  }

  const row = await prisma.appQuestionnaireTurnEvaluation.update({
    where: { id: params.id },
    data,
    select: {
      id: true,
      comment: true,
      commentByUserId: true,
      commentAt: true,
      flagStatus: true,
      flagReviewerId: true,
      flagUpdatedAt: true,
      updatedAt: true,
    },
  });
  return { ok: true, row };
}

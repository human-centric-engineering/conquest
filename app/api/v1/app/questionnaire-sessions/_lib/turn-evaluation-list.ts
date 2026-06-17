/**
 * Persisted turn-evaluation read model (search surface).
 *
 * The enriched query behind `GET /api/v1/app/turn-evaluations` and the detail behind
 * `GET /api/v1/app/turn-evaluations/:id`. Filters/sorts on the denormalised columns the write
 * path stamped (`overallScore`, `effectiveness`, `flagStatus`, `evaluatorModel`,
 * `questionnaireVersionId`, `createdAt`), then enriches each page with the questionnaire title +
 * version number in **two extra queries regardless of page size** (no per-row N+1, per the
 * list-endpoint rule) — joined manually because `questionnaireVersionId` is a plain String
 * (UG-1), not a Prisma relation.
 *
 * Route-local DB seam: the `lib/app/questionnaire/**` domain module stays Prisma-free, so the
 * read query lives here next to the persistence store.
 */

import { z } from 'zod';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { TURN_EFFECTIVENESS } from '@/lib/app/questionnaire/turn-evaluation';
import type { TurnEvaluationListItem, TurnEvaluationDetail } from '@/lib/app/questionnaire/views';

import { TURN_EVAL_FLAG_STATUSES } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-store';

/** How much of a comment the list row ships as a preview. */
const COMMENT_PREVIEW_CHARS = 140;

/** Query-param schema for the list endpoint. Coerces page/limit/score, clamps ranges. */
export const listTurnEvaluationsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    flagStatus: z.enum(TURN_EVAL_FLAG_STATUSES).optional(),
    effectiveness: z.enum(TURN_EFFECTIVENESS).optional(),
    questionnaireVersionId: z.string().trim().min(1).max(200).optional(),
    /** Case-insensitive substring match on the resolved evaluator model id. */
    model: z.string().trim().min(1).max(200).optional(),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    maxScore: z.coerce.number().int().min(0).max(100).optional(),
    /** ISO datetime bounds on `createdAt`. */
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    sortBy: z.enum(['createdAt', 'overallScore']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  })
  .refine((q) => q.minScore === undefined || q.maxScore === undefined || q.minScore <= q.maxScore, {
    message: 'minScore must be ≤ maxScore',
    path: ['minScore'],
  });

export type ListTurnEvaluationsQuery = z.infer<typeof listTurnEvaluationsQuerySchema>;

export interface ListTurnEvaluationsResult {
  items: TurnEvaluationListItem[];
  total: number;
}

/** Trim a comment to its preview slice, or null when there's no comment. */
function commentPreview(comment: string | null): string | null {
  if (!comment) return null;
  const trimmed = comment.trim();
  if (!trimmed) return null;
  return trimmed.length > COMMENT_PREVIEW_CHARS
    ? `${trimmed.slice(0, COMMENT_PREVIEW_CHARS)}…`
    : trimmed;
}

/** Build the `createdAt`/`overallScore` WHERE filters shared by list + count. */
function buildWhere(
  query: ListTurnEvaluationsQuery
): Prisma.AppQuestionnaireTurnEvaluationWhereInput {
  const where: Prisma.AppQuestionnaireTurnEvaluationWhereInput = {};
  if (query.flagStatus) where.flagStatus = query.flagStatus;
  if (query.effectiveness) where.effectiveness = query.effectiveness;
  if (query.questionnaireVersionId) where.questionnaireVersionId = query.questionnaireVersionId;
  if (query.model) where.evaluatorModel = { contains: query.model, mode: 'insensitive' };
  if (query.minScore !== undefined || query.maxScore !== undefined) {
    where.overallScore = {
      ...(query.minScore !== undefined ? { gte: query.minScore } : {}),
      ...(query.maxScore !== undefined ? { lte: query.maxScore } : {}),
    };
  }
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
  }
  return where;
}

/**
 * Resolve `{ title, questionnaireId, versionNumber }` for a set of version ids in one query.
 * `questionnaireVersionId` is a plain String (UG-1), so this is a manual join, batched.
 */
async function enrichVersions(
  versionIds: string[]
): Promise<
  Map<string, { questionnaireId: string; questionnaireTitle: string; versionNumber: number }>
> {
  if (versionIds.length === 0) return new Map();
  const versions = await prisma.appQuestionnaireVersion.findMany({
    where: { id: { in: versionIds } },
    select: {
      id: true,
      versionNumber: true,
      questionnaire: { select: { id: true, title: true } },
    },
  });
  return new Map(
    versions.map((v) => [
      v.id,
      {
        questionnaireId: v.questionnaire.id,
        questionnaireTitle: v.questionnaire.title,
        versionNumber: v.versionNumber,
      },
    ])
  );
}

/**
 * Fetch one page of persisted turn evaluations.
 *
 * Query budget: 1 page query + 1 count + 1 version-enrichment query = 3 round-trips, independent
 * of page size.
 */
export async function listTurnEvaluations(
  query: ListTurnEvaluationsQuery
): Promise<ListTurnEvaluationsResult> {
  const where = buildWhere(query);
  const skip = (query.page - 1) * query.limit;

  const [rows, total] = await Promise.all([
    prisma.appQuestionnaireTurnEvaluation.findMany({
      where,
      orderBy: { [query.sortBy]: query.sortOrder },
      skip,
      take: query.limit,
      select: {
        id: true,
        sessionId: true,
        turnId: true,
        turnOrdinal: true,
        overallScore: true,
        effectiveness: true,
        evaluatorModel: true,
        evaluatorProvider: true,
        rubricVersion: true,
        questionnaireVersionId: true,
        flagStatus: true,
        comment: true,
        datasetCaseId: true,
        costUsd: true,
        createdAt: true,
      },
    }),
    prisma.appQuestionnaireTurnEvaluation.count({ where }),
  ]);

  const versionMap = await enrichVersions([...new Set(rows.map((r) => r.questionnaireVersionId))]);

  const items: TurnEvaluationListItem[] = rows.map((row) => {
    const v = versionMap.get(row.questionnaireVersionId) ?? null;
    return {
      id: row.id,
      sessionId: row.sessionId,
      turnId: row.turnId,
      turnOrdinal: row.turnOrdinal,
      overallScore: row.overallScore,
      effectiveness: row.effectiveness,
      evaluatorModel: row.evaluatorModel,
      evaluatorProvider: row.evaluatorProvider,
      rubricVersion: row.rubricVersion,
      questionnaireVersionId: row.questionnaireVersionId,
      questionnaireTitle: v?.questionnaireTitle ?? null,
      questionnaireId: v?.questionnaireId ?? null,
      versionNumber: v?.versionNumber ?? null,
      flagStatus: row.flagStatus,
      commentPreview: commentPreview(row.comment),
      datasetCaseId: row.datasetCaseId,
      costUsd: row.costUsd,
      createdAt: row.createdAt.toISOString(),
    };
  });

  return { items, total };
}

/** Fetch one persisted turn evaluation in full, or null when it doesn't exist. */
export async function getTurnEvaluationDetail(id: string): Promise<TurnEvaluationDetail | null> {
  const row = await prisma.appQuestionnaireTurnEvaluation.findUnique({
    where: { id },
    select: {
      id: true,
      sessionId: true,
      turnId: true,
      turnOrdinal: true,
      overallScore: true,
      effectiveness: true,
      evaluatorModel: true,
      evaluatorProvider: true,
      evaluatorAgentId: true,
      rubricVersion: true,
      appVersion: true,
      questionnaireVersionId: true,
      evaluatedByUserId: true,
      verdict: true,
      evaluatedInput: true,
      comment: true,
      commentByUserId: true,
      commentAt: true,
      flagStatus: true,
      flagReviewerId: true,
      flagUpdatedAt: true,
      datasetId: true,
      datasetCaseId: true,
      costUsd: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!row) return null;

  const versionMap = await enrichVersions([row.questionnaireVersionId]);
  const v = versionMap.get(row.questionnaireVersionId) ?? null;

  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    turnOrdinal: row.turnOrdinal,
    overallScore: row.overallScore,
    effectiveness: row.effectiveness,
    evaluatorModel: row.evaluatorModel,
    evaluatorProvider: row.evaluatorProvider,
    evaluatorAgentId: row.evaluatorAgentId,
    rubricVersion: row.rubricVersion,
    appVersion: row.appVersion,
    questionnaireVersionId: row.questionnaireVersionId,
    questionnaireTitle: v?.questionnaireTitle ?? null,
    questionnaireId: v?.questionnaireId ?? null,
    versionNumber: v?.versionNumber ?? null,
    evaluatedByUserId: row.evaluatedByUserId,
    verdict: row.verdict,
    evaluatedInput: row.evaluatedInput,
    comment: row.comment,
    commentByUserId: row.commentByUserId,
    commentAt: row.commentAt ? row.commentAt.toISOString() : null,
    flagStatus: row.flagStatus,
    flagReviewerId: row.flagReviewerId,
    flagUpdatedAt: row.flagUpdatedAt ? row.flagUpdatedAt.toISOString() : null,
    datasetId: row.datasetId,
    datasetCaseId: row.datasetCaseId,
    costUsd: row.costUsd,
    commentPreview: commentPreview(row.comment),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

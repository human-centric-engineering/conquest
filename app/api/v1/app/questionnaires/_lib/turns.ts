/**
 * Route-local per-turn persistence seam (F6.1).
 *
 * The DB write path for one respondent turn over a live session. The pure orchestrator
 * core (`lib/app/questionnaire/orchestrator/**`) decides what a turn did — which
 * capabilities ran, what answers changed, the assembled reply; this seam performs the
 * I/O: in one transaction it appends an {@link AppQuestionnaireTurn} row AND back-stamps
 * `AppAnswerSlot.lastUpdatedTurnId` on the answers that turn touched (the seam that
 * finally fires that column — null until F6.1). It sits alongside the session
 * (`sessions.ts`) and answer-slot (`answer-slots.ts`) seams.
 *
 * `recordTurn` only stamps the turn linkage; the answer **value** writes stay in
 * `answer-slots.ts` (`upsertAnswerSlot` / `persistRefinement`), so the two seams compose
 * without duplication. `ordinal` is derived `count+1` inside the same transaction (no
 * `@@unique([sessionId, ordinal])` — a unique can throw under a retried turn; rare gaps
 * are acceptable).
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { NotFoundError } from '@/lib/api/errors';

/**
 * Convert an arbitrary JSON value into a Prisma `Json` input — mirrors the answer-slot
 * seam's helper. Lets a typed array with optional fields (e.g. {@link ToolCallRecord}[])
 * satisfy `InputJsonValue`; `null`/`undefined` map to the DB-null sentinel.
 */
function jsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value;
}

/**
 * One capability outcome recorded on a turn's `toolCalls` (ordered by dispatch). Mirrors
 * the deterministic pipeline's per-step result, not the LLM tool-loop's trace.
 */
export interface ToolCallRecord {
  /** The capability slug dispatched (e.g. `app_extract_answer_slots`). */
  slug: string;
  /** Whether the capability succeeded (a fail-soft empty result counts as a failure). */
  success: boolean;
  /** Error code when `success` is false (the capability's `error.code`). */
  code?: string;
  /** Wall-clock dispatch latency in milliseconds, when measured. */
  latencyMs?: number;
}

/** Everything {@link recordTurn} persists for one turn. */
export interface TurnWriteInput {
  /** The session this turn belongs to. */
  sessionId: string;
  /** The respondent's message (`''` for the opening turn). */
  userMessage: string;
  /** The composed agent reply streamed back this turn. */
  agentResponse: string;
  /** The `AppQuestionSlot.id` this turn asked for; `null` for a completion/offer turn. */
  targetedQuestionId: string | null;
  /** The capabilities dispatched this turn, in order. */
  toolCalls: ToolCallRecord[];
  /** The `AppAnswerSlot.id`s this turn created or updated — back-stamped with the turn id. */
  sideEffectAnswerIds: string[];
  /** Summed per-turn LLM spend in USD; `null` until cost-summing is wired. */
  costUsd: number | null;
}

/**
 * Write one turn row and back-stamp `lastUpdatedTurnId` on the answers it touched, in one
 * transaction. The `ordinal` is the session's existing turn count + 1 (computed inside the
 * transaction). Returns the new turn id. Throws {@link NotFoundError} if the session id
 * doesn't resolve.
 */
export async function recordTurn(input: TurnWriteInput): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const session = await tx.appQuestionnaireSession.findUnique({
      where: { id: input.sessionId },
      select: { id: true },
    });
    if (!session) throw new NotFoundError('Session not found');

    const priorTurns = await tx.appQuestionnaireTurn.count({
      where: { sessionId: input.sessionId },
    });

    const turn = await tx.appQuestionnaireTurn.create({
      data: {
        sessionId: input.sessionId,
        ordinal: priorTurns + 1,
        userMessage: input.userMessage,
        agentResponse: input.agentResponse,
        targetedQuestionId: input.targetedQuestionId,
        toolCalls: jsonInput(input.toolCalls),
        sideEffectAnswerIds: jsonInput(input.sideEffectAnswerIds),
        costUsd: input.costUsd,
      },
      select: { id: true },
    });

    if (input.sideEffectAnswerIds.length > 0) {
      // Scope the stamp to this session so a stray id can't touch another session's row.
      await tx.appAnswerSlot.updateMany({
        where: { id: { in: input.sideEffectAnswerIds }, sessionId: input.sessionId },
        data: { lastUpdatedTurnId: turn.id },
      });
    }

    return turn.id;
  });
}

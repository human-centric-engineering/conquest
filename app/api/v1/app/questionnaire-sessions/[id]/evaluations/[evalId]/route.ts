/**
 * Human review of one persisted turn evaluation.
 *
 * PATCH /api/v1/app/questionnaire-sessions/:id/evaluations/:evalId
 *   body: { comment?: string, flagStatus?: 'none' | 'flagged' | 'reviewed' | 'dismissed' }
 *
 *   Admin-only, gated by the turn-evaluation flag (404 when off — the same gate as the route
 *   that produced the row). Sets the human comment and/or moves the learning flag through its
 *   review states, stamping the reviewer + timestamp on whichever facet changed. The row must
 *   belong to the `:id` session (a mismatched/guessed id reads as 404).
 *
 *   `actioned` is NOT settable here: that state is owned by the learning-action endpoint, which
 *   must append a dataset case atomically before a row may claim it — so a stray PATCH can never
 *   leave an `actioned` row with no backing case. An attempt to re-flag an already-actioned row
 *   is a 409 (it is terminal; un-actioning would orphan its dataset case).
 */

import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';

import { withTurnEvaluationEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  updateTurnEvaluationReview,
  TURN_EVAL_REVIEW_STATUSES,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-store';

/** A comment cap generous for a reviewer note, bounded against an abusive payload. */
const COMMENT_MAX = 5_000;

const bodySchema = z
  .object({
    comment: z.string().max(COMMENT_MAX).optional(),
    flagStatus: z.enum(TURN_EVAL_REVIEW_STATUSES).optional(),
  })
  .refine((b) => b.comment !== undefined || b.flagStatus !== undefined, {
    message: 'Provide a comment, a flagStatus, or both',
  });

const handlePatch = withAdminAuth<{ id: string; evalId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, evalId } = await params;

    const body = await validateRequestBody(request, bodySchema);

    const result = await updateTurnEvaluationReview({
      id: evalId,
      sessionId: id,
      reviewerId: session.user.id,
      ...(body.comment !== undefined ? { comment: body.comment } : {}),
      ...(body.flagStatus !== undefined ? { flagStatus: body.flagStatus } : {}),
    });

    if (!result.ok) {
      if (result.reason === 'locked') {
        return errorResponse('This evaluation is actioned and can no longer be re-flagged', {
          code: 'evaluation_actioned',
          status: 409,
        });
      }
      return errorResponse('Evaluation not found', { code: 'NOT_FOUND', status: 404 });
    }

    log.info('Turn evaluation review updated', {
      sessionId: id,
      evaluationId: evalId,
      flagStatus: result.row.flagStatus,
      commentChanged: body.comment !== undefined,
    });

    return successResponse({ evaluation: result.row });
  }
);

export const PATCH = withTurnEvaluationEnabled(handlePatch);

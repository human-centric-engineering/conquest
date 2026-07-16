/**
 * Action a flagged turn evaluation for learning — append it to an eval dataset.
 *
 * POST /api/v1/app/questionnaire-sessions/:id/evaluations/:evalId/action-learning
 *   body: { datasetId: string }
 *
 *   Admin-only, gated by the turn-evaluation flag. Appends the evaluation to the chosen eval
 *   dataset as a learning case (input = the respondent message, expectedOutput = the judged
 *   interviewer reply, with the verdict/score/comment in case metadata) and moves the flag to
 *   `actioned`, recording the dataset + case ids on the row.
 *
 *   This is the ONLY way a row reaches `actioned`. The dataset append and the status flip are two
 *   writes (not a transaction); the flip is claimed conditionally so a concurrent re-action is
 *   rejected as 409 rather than double-stamping the row — best-effort, not a hard atomic guarantee
 *   (see `actionTurnEvaluationForLearning`). Re-running on an already-actioned row is a 409. The
 *   row must belong to the `:id` session (404 on mismatch); a missing dataset is a 404; a dataset
 *   at its case cap is a 422.
 */

import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';

import { actionTurnEvaluationForLearning } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-evaluation-store';

const bodySchema = z.object({
  datasetId: z.string().min(1).max(200),
});

const handleAction = withAdminAuth<{ id: string; evalId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, evalId } = await params;

    const body = await validateRequestBody(request, bodySchema);

    const result = await actionTurnEvaluationForLearning({
      id: evalId,
      sessionId: id,
      datasetId: body.datasetId,
      reviewerId: session.user.id,
    });

    if (!result.ok) {
      switch (result.reason) {
        case 'already_actioned':
          return errorResponse('This evaluation has already been actioned for learning', {
            code: 'evaluation_actioned',
            status: 409,
          });
        case 'dataset_not_found':
          return errorResponse('Dataset not found', { code: 'dataset_not_found', status: 404 });
        case 'dataset_full':
          return errorResponse('The dataset has reached its case cap', {
            code: 'dataset_full',
            status: 422,
          });
        case 'no_content':
          return errorResponse('This evaluation has no respondent message to learn from', {
            code: 'no_learning_content',
            status: 422,
          });
        default:
          return errorResponse('Evaluation not found', { code: 'NOT_FOUND', status: 404 });
      }
    }

    log.info('Turn evaluation actioned for learning', {
      sessionId: id,
      evaluationId: evalId,
      datasetId: body.datasetId,
      datasetCaseId: result.row.datasetCaseId,
      datasetCaseCount: result.appendedCaseCount,
    });

    return successResponse({ evaluation: result.row });
  }
);

export const POST = handleAction;

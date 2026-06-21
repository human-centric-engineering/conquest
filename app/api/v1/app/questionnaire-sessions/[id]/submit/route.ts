/**
 * Respondent session submission (F7.3).
 *
 * POST /api/v1/app/questionnaire-sessions/:id/submit
 *   → { success: true, data: { sessionId, status: 'completed' } }
 *
 * The respondent's accept of the completion offer: transitions `active → completed` and
 * writes the `completed` event. This is the ONLY path that completes a live session — the
 * agent streams an offer ("Would you like to submit?"), the UI shows a Submit affordance
 * when `GET …/status` reports `completion.kind === 'offer'`, and this route records the
 * acceptance. Serves both respondent kinds (authenticated owner + no-login anonymous).
 *
 * The gate reuses the F4.5 pure resolver: it re-asserts the session is genuinely in an
 * `offer` state (a stale/forged client can't submit an ineligible session) and submits
 * with NO completion sweep — contradictions already surface live during the chat (F4.3),
 * so re-running that scan at submit would be redundant. A required question can't be
 * outstanding here: `assessCompletion` only returns `offer` once the required gate is
 * clear (the sole exception being a question-cap-reached session, the existing F4.5
 * "a capped session can always submit" behaviour, honoured as-is).
 *
 * Gate order: live-sessions flag (404 before auth) → load → access (401/403) → status
 * (idempotent on already-completed; 409 on paused/abandoned) → offer-eligibility (409) →
 * transition.
 */

import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { ConflictError, handleAPIError } from '@/lib/api/errors';
import {
  withLiveSessionsEnabled,
  isLearningModeEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import {
  assessCompletion,
  resolveCompletion,
} from '@/lib/app/questionnaire/completion/completion-logic';
import { SessionTransitionError } from '@/lib/app/questionnaire/session';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { buildTurnContext } from '@/app/api/v1/app/questionnaires/_lib/turn-context';
import { markSessionCompleted } from '@/app/api/v1/app/questionnaires/_lib/sessions';
import { enqueueRespondentReport } from '@/lib/app/questionnaire/report/enqueue';
import { refreshRoundLearningDigest } from '@/lib/app/questionnaire/learning/digest';

async function handleSubmit(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    const loaded = await buildTurnContext(sessionId);
    if (!loaded) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    const access = await resolveTurnAccess(request, loaded.session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    // Already completed → idempotent success (a double-submit / network race lands here).
    if (loaded.session.status === 'completed') {
      return successResponse({ sessionId, status: 'completed' as const });
    }
    // Paused/abandoned can't submit directly — the state machine forbids it (paused must
    // resume first). Surface a clean 409 rather than relying on the transition throw.
    if (loaded.session.status !== 'active') {
      return errorResponse(`Session is ${loaded.session.status}, not active`, {
        code: 'SESSION_NOT_ACTIVE',
        status: 409,
      });
    }

    // Re-assert eligibility through the F4.5 resolver — no sweep (contradictions surface live).
    const assessment = assessCompletion({
      questions: loaded.base.questions,
      answered: loaded.base.answered,
      config: loaded.base.config,
      sessionId: loaded.base.sessionId,
    });
    const resolution = resolveCompletion('accept', assessment, {
      run: false,
      contradictionCount: 0,
    });
    if (resolution.kind !== 'submit') {
      log.info('Submit refused — session not ready', { sessionId, completion: assessment.kind });
      return errorResponse(resolution.rationale, { code: 'SUBMIT_NOT_READY', status: 409 });
    }

    try {
      const status = await markSessionCompleted(sessionId, { reason: 'respondent_submit' });
      log.info('Respondent session submitted', { sessionId, status });
      // Queue the respondent report when the version is configured for an AI mode (raw_plus_insights
      // or narrative).
      // Best-effort — a queue failure must never fail the submission the respondent just made.
      await enqueueRespondentReport(sessionId).catch((err) => {
        log.error('Failed to enqueue respondent report', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // Learning Mode: rebuild this round's peer-theme digest so the NEXT respondent sees the
      // just-completed session folded in. Gated by the platform flag + the round having a roundId;
      // the builder itself re-checks the per-round toggle + k-anonymity. FIRE-AND-FORGET — the
      // rebuild makes an LLM call (up to DIGEST_TIMEOUT_MS), so awaiting it would block THIS
      // respondent's submit confirmation behind work that only benefits the next respondent. We let
      // it run after the response; a missed rebuild self-heals on the next completion (or a manual
      // admin Rebuild). Fail-soft: errors are logged, never surfaced. (Long-running server runtime;
      // not a per-request-killed serverless function.)
      if (loaded.session.roundId && (await isLearningModeEnabled())) {
        const roundId = loaded.session.roundId;
        void refreshRoundLearningDigest(roundId, loaded.session.versionId).catch((err) => {
          log.error('Failed to refresh round learning digest', {
            sessionId,
            roundId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return successResponse({ sessionId, status });
    } catch (err) {
      if (err instanceof SessionTransitionError) {
        throw new ConflictError(err.message, { from: err.from, to: err.to });
      }
      throw err;
    }
  } catch (err) {
    return handleAPIError(err);
  }
}

export const POST = withLiveSessionsEnabled(handleSubmit);

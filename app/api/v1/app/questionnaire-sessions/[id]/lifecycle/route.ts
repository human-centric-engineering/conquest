/**
 * Respondent session pause / resume (F7.3).
 *
 * POST /api/v1/app/questionnaire-sessions/:id/lifecycle
 *   body: { action: 'pause' | 'resume' | 'abandon' }
 *
 * The respondent-facing counterpart to the admin `/transition` route, driving the same
 * F4.6 state machine through the same `_lib/sessions.ts` seam — but authorised via
 * `resolveTurnAccess` (the session's owner) instead of `withAdminAuth`. `resume` returns
 * the resume state (status + answers so far) so the surface picks up where it left off.
 *
 * **`pause`/`resume` are signed-in respondents only.** A no-login anonymous session lives
 * entirely in the browser (its token is client-held), so a deliberate pause has nowhere
 * durable to resume from — the endpoint refuses anonymous callers those actions with 403.
 * `abandon` IS permitted for an anonymous token holder: it's terminal (nothing to resume),
 * and it backs the no-login "Start new" flow, which abandons the prior in-progress session
 * before minting a fresh one. Anonymous callers still see system-driven states (budget
 * pause, completed) via `GET …/status`.
 *
 * Gate order: live-sessions flag (404 before auth) → load → access (401/403) → parse →
 * anonymous-refusal for pause/resume (403) → transition. An illegal move (e.g. resuming an
 * active session, or abandoning a completed one) is a 409 via {@link SessionTransitionError}.
 * Completion is NOT an action here — accept→submit is the dedicated `/submit` route.
 */

import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { ConflictError, handleAPIError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { SessionTransitionError } from '@/lib/app/questionnaire/session';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { assertRoundAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/round-access';
import {
  abandonSession,
  loadSessionResumeState,
  pauseSession,
  resumeSession,
} from '@/app/api/v1/app/questionnaires/_lib/sessions';

const bodySchema = z.object({ action: z.enum(['pause', 'resume', 'abandon']) });

async function handleLifecycle(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    // Minimal load: pause/resume only need the access fields + the state machine handles
    // the current status, so there's no need for the full turn context here.
    const row = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        respondentUserId: true,
        versionId: true,
        roundId: true,
        cohortMemberId: true,
      },
    });
    if (!row) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    const access = await resolveTurnAccess(request, row);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    const body = await validateRequestBody(request, bodySchema);

    // Pause/resume is for signed-in respondents only — an anonymous session has no durable place
    // to resume from (see the header note). `abandon` IS permitted for an anonymous token holder:
    // it's terminal, so there's nothing to resume — it backs the no-login "Start new" flow, which
    // abandons the prior session before minting a fresh one.
    if (access.anonymous && body.action !== 'abandon') {
      return errorResponse('Pause is only available for signed-in respondents', {
        code: 'PAUSE_NOT_PERMITTED',
        status: 403,
      });
    }

    // Cohorts & Rounds: a respondent may only resume a round-scoped session while the round is
    // still open AND they're still an active member — a closed round / removed member can't be
    // re-entered. (A since-deleted round no longer gates.) Pausing stays available regardless.
    if (body.action === 'resume' && row.roundId) {
      const verdict = await assertRoundAccess({
        roundId: row.roundId,
        cohortMemberId: row.cohortMemberId,
        versionId: row.versionId,
        onMissingRound: 'allow',
      });
      if (!verdict.ok) {
        log.info('Resume refused: round access', { sessionId, code: verdict.code });
        return errorResponse(verdict.message, { code: verdict.code, status: verdict.status });
      }
    }

    try {
      if (body.action === 'resume') {
        await resumeSession(sessionId, { reason: 'respondent_resume' });
        const resumeState = await loadSessionResumeState(sessionId);
        log.info('Respondent session resumed', { sessionId, status: resumeState.status });
        return successResponse({ sessionId, ...resumeState });
      }

      if (body.action === 'abandon') {
        const status = await abandonSession(sessionId, { reason: 'respondent_abandon' });
        log.info('Respondent session abandoned', { sessionId, status });
        return successResponse({ sessionId, status });
      }

      const status = await pauseSession(sessionId, { reason: 'respondent_pause' });
      log.info('Respondent session paused', { sessionId, status });
      return successResponse({ sessionId, status });
    } catch (err) {
      // An illegal transition is a client conflict, not a 500 — surface the from/to.
      if (err instanceof SessionTransitionError) {
        log.warn('Illegal respondent session transition rejected', {
          sessionId,
          from: err.from,
          to: err.to,
        });
        throw new ConflictError(err.message, { from: err.from, to: err.to });
      }
      throw err;
    }
  } catch (err) {
    return handleAPIError(err);
  }
}

export const POST = handleLifecycle;

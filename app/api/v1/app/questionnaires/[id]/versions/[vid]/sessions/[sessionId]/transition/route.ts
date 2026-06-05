/**
 * Session lifecycle transition (F4.6).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/sessions/:sessionId/transition
 *   body: { action: 'pause' | 'resume' | 'abandon', reason?: string }
 *
 *   Admin-only. Drives the session state machine: validates the requested move against
 *   the deterministic transition rules and, on a legal change, updates the session's
 *   status AND appends one `AppQuestionnaireSessionEvent` audit row (both in one
 *   transaction, at the seam). `resume` also returns the session's resume state (status
 *   + the answers captured so far) so the caller picks up where it left off.
 *
 *   Completion is NOT an action here — accept→submit stays on the F4.5 `/complete`
 *   route, the single submit entrypoint. An illegal transition (e.g. resuming a
 *   completed session, or `paused → completed` without resuming first) is a 409; an
 *   unknown session/version is a 404. A self-edge (already in the target status) is an
 *   idempotent no-op that writes no event.
 *
 *   Gated by the master questionnaires flag only (F4.6 is deterministic — no LLM, no
 *   sub-flag). A single-transaction transition is cheap, so it takes no per-flow
 *   sub-cap: the platform's automatic 100/min section cap (proxy.ts) suffices.
 */

import { z } from 'zod';

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { ConflictError, NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';

import { prisma } from '@/lib/db/client';
import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { SessionTransitionError } from '@/lib/app/questionnaire/session';
import {
  abandonSession,
  loadSessionResumeState,
  pauseSession,
  resumeSession,
} from '@/app/api/v1/app/questionnaires/_lib/sessions';

const bodySchema = z.object({
  action: z.enum(['pause', 'resume', 'abandon']),
  reason: z.string().max(2000).optional(),
});

const handleTransition = withAdminAuth<{ id: string; vid: string; sessionId: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid, sessionId } = await params;

    const body = await validateRequestBody(request, bodySchema);

    // Scope: the session must belong to this version, and the version to this
    // questionnaire — otherwise the id triplet is forged or stale (404, before any write).
    //
    // `isPreview: false` deliberately excludes the F4.4/F4.5 preview session: it's a
    // single per-version admin-exercise singleton (reused by the refine/complete routes),
    // whose lifecycle is intentionally minimal (`active` → `completed` via `/complete`).
    // Letting `/transition` pause or abandon it would brick that version's `/complete`
    // submit (an abandoned session is terminal, and completion of a non-active session is
    // illegal). The lifecycle machine is for real respondent sessions (F6.1); until those
    // exist it's exercised by hand (Vitest), not against the preview singleton.
    const sessionRow = await prisma.appQuestionnaireSession.findFirst({
      where: { id: sessionId, versionId: vid, isPreview: false, version: { questionnaireId: id } },
      select: { id: true },
    });
    if (!sessionRow) {
      throw new NotFoundError('Session not found');
    }

    const opts = body.reason !== undefined ? { reason: body.reason } : {};

    try {
      if (body.action === 'resume') {
        await resumeSession(sessionId, opts);
        const resumeState = await loadSessionResumeState(sessionId);
        log.info('Session transition', {
          questionnaireId: id,
          versionId: vid,
          sessionId,
          action: body.action,
          status: resumeState.status,
        });
        return successResponse({ sessionId, ...resumeState });
      }

      const status =
        body.action === 'pause'
          ? await pauseSession(sessionId, opts)
          : await abandonSession(sessionId, opts);

      log.info('Session transition', {
        questionnaireId: id,
        versionId: vid,
        sessionId,
        action: body.action,
        status,
      });
      return successResponse({ sessionId, status });
    } catch (err) {
      // An illegal transition is a client conflict, not a 500 — surface the from/to.
      if (err instanceof SessionTransitionError) {
        log.warn('Illegal session transition rejected', {
          questionnaireId: id,
          versionId: vid,
          sessionId,
          from: err.from,
          to: err.to,
        });
        throw new ConflictError(err.message, { from: err.from, to: err.to });
      }
      throw err;
    }
  }
);

export const POST = withQuestionnairesEnabled(handleTransition);

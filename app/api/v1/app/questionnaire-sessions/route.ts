/**
 * Live respondent session — create (F6.1, PR3).
 *
 * POST /api/v1/app/questionnaire-sessions
 *   body (one of):
 *     { invitationToken: string }   // invitation-bound: resolve the respondent's invitation
 *     { versionId:       string }   // anonymous-direct: a launched anonymousMode questionnaire
 *
 * Creates (or resumes) a real respondent session for the authenticated user — the first
 * surface that mints non-preview `AppQuestionnaireSession` rows, binds `respondentUserId`,
 * and writes the reserved `created` event. The streaming turn loop is the messages route
 * (PR4); the no-login anonymous variant is PR5.
 *
 * Gate order: live-sessions flag (404 before auth, so a dark-launched surface looks like a
 * missing route) → `withAuth` → per-user session-start sub-cap → body validation → create.
 * Idempotent on re-entry: an existing non-terminal session for this user+version is returned.
 */

import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { withLiveSessionsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { recordQuestionnaireError } from '@/lib/app/questionnaire/diagnostics';
import { sessionStartLimiter } from '@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit';
import {
  createSessionForVersion,
  createSessionFromInvitation,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/create';

// Respondent profile submission (F8.3): a flat map of profile-field key → value. The
// creator validates it against the version's configured `profileFields`; here we only
// gate the coarse shape. Collected on the invitation (non-anonymous) surface only —
// the anonymous version-direct surface never carries it.
const profileValuesSchema = z.record(
  z.string().max(60),
  z.union([z.string().max(2000), z.number()])
);

// Cohorts & Rounds: a session's round context is NOT accepted from the request — it's derived
// server-side from the respondent's invitation (the trusted grant), so it can't be forged. The
// invitation-token body therefore needs no round fields; the version-direct (walk-up) body is
// never round-bound.
const bodySchema = z.union([
  z
    .object({
      invitationToken: z.string().min(10).max(512),
      profileValues: profileValuesSchema.optional(),
    })
    .strict(),
  z.object({ versionId: z.string().min(1).max(64) }).strict(),
]);

const handleCreateSession = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const respondentUserId = session.user.id;

  // Session-start sub-cap, keyed on the respondent who owns the session spend.
  const limit = sessionStartLimiter.check(respondentUserId);
  if (!limit.success) return createRateLimitResponse(limit);

  const body = await validateRequestBody(request, bodySchema);
  const mode = 'invitationToken' in body ? 'invitation' : 'version';

  let result: Awaited<ReturnType<typeof createSessionFromInvitation>>;
  try {
    result =
      'invitationToken' in body
        ? await createSessionFromInvitation(
            body.invitationToken,
            respondentUserId,
            body.profileValues
          )
        : await createSessionForVersion(body.versionId, respondentUserId);
  } catch (err) {
    // Diagnostics: an unexpected throw while creating the session (e.g. the create transaction
    // failed). The version is known only on the version-direct path; an invitation-path throw is
    // unattributable and self-drops in the helper. Re-throw so the guard still returns a 500.
    void recordQuestionnaireError({
      versionId: 'versionId' in body ? body.versionId : undefined,
      scope: 'session_create',
      stage: mode === 'invitation' ? 'from_invitation' : 'for_version',
      error: err,
    });
    throw err;
  }

  if (!result.ok) {
    log.info('Session create rejected', {
      code: result.code,
      mode,
      userId: respondentUserId,
    });
    // Diagnostics: record an attributable rejection (delivery/lifecycle insight — e.g. an invitee
    // hitting an expired/not-yet-launched questionnaire). `versionId` is set on invitation-path
    // failures once the invitation resolves; fall back to the version-direct body. Unattributable
    // rejections (bad token) carry no version and self-drop. Recorded as a `warning` — a clean refusal.
    void recordQuestionnaireError({
      versionId: result.versionId ?? ('versionId' in body ? body.versionId : undefined),
      invitationId: result.invitationId,
      scope: 'session_create',
      severity: 'warning',
      code: result.code,
      error: result.message,
      metadata: { status: result.status, mode },
    });
    return errorResponse(result.message, { code: result.code, status: result.status });
  }

  log.info('Session created', {
    sessionId: result.session.id,
    versionId: result.session.versionId,
    resumed: result.resumed,
    userId: respondentUserId,
  });

  return successResponse(
    { session: result.session },
    { resumed: result.resumed },
    { status: result.resumed ? 200 : 201 }
  );
});

export const POST = withLiveSessionsEnabled(handleCreateSession);

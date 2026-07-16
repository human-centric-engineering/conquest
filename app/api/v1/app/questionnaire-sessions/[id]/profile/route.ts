/**
 * Respondent profile capture — runtime read + write (respondent surface, F-capture).
 *
 * GET  /api/v1/app/questionnaire-sessions/:id/profile
 *   → { success: true, data: { capture: ResolvedSessionCapture | null } }
 * PUT  /api/v1/app/questionnaire-sessions/:id/profile
 *   { profileValues: Record<string, unknown> }
 *   → { success: true, data: { saved: true } }   |   400 INVALID_PROFILE { fieldErrors }
 *
 * The form-mode capture gate rides the carousel AFTER session creation (unlike the superseded
 * pre-session form), so the collected values are submitted here for the existing session. The
 * no-login anonymous surface boots client-side, so — like the intro route — it fetches its capture
 * config here on boot; the authenticated page resolves it server-side. Both respondent kinds are
 * served, so access reuses `resolveTurnAccess` (an authenticated owner OR a valid anonymous/preview
 * `X-Session-Token`).
 *
 * The SERVER is the enforcing boundary: PUT re-derives the fields from the stored config (never trusts
 * the client's field list) and re-runs validation authoritatively — including the best-effort agentic
 * normalise/plausibility pass — before persisting. `anonymousMode` versions are guarded in THREE
 * places (this route, the resolver, and the workspace `showCapture`); here GET returns `capture: null`
 * and PUT rejects with 409, and no snapshot is ever written.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { handleAPIError } from '@/lib/api/errors';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { withLiveSessionsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { profileCaptureLimiter } from '@/app/api/v1/app/questionnaire-sessions/_lib/rate-limit';
import { resolveSessionCapture } from '@/lib/app/questionnaire/profile/resolve-capture';
import { validateProfileSubmission } from '@/lib/app/questionnaire/profile/validate-profile-fields';
import { upsertProfileSnapshot } from '@/lib/app/questionnaire/profile/profile-snapshot';

async function handleGetProfile(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    const session = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: { id: true, respondentUserId: true },
    });
    if (!session) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    const access = await resolveTurnAccess(request, session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    // Null for an anonymous version (PII-free) — the client shows no gate.
    const capture = await resolveSessionCapture(sessionId);
    log.info('Session profile capture read', {
      sessionId,
      captureMode: capture?.captureMode ?? null,
      satisfied: capture?.satisfied ?? true,
    });
    return successResponse({ capture });
  } catch (err) {
    return handleAPIError(err);
  }
}

/** PUT body: the raw respondent submission, keyed by field `key`. Values coerced/validated server-side. */
const putProfileSchema = z.object({
  profileValues: z.record(z.string(), z.unknown()),
});

async function handlePutProfile(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const log = await getRouteLogger(request);
    const { id: sessionId } = await context.params;

    const session = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: { id: true, respondentUserId: true, status: true },
    });
    if (!session) return errorResponse('Session not found', { code: 'NOT_FOUND', status: 404 });

    const access = await resolveTurnAccess(request, session);
    if (!access.ok) {
      return errorResponse(access.message, { code: access.code, status: access.status });
    }

    // Profile-capture sub-cap: the agentic validation pass is a paid LLM call, and a rejected
    // submission writes no snapshot — so a token holder could otherwise re-submit garbage to burn
    // spend. Keyed on the same rateKey as the turn loop (user id, or client IP + session for no-login).
    const limit = profileCaptureLimiter.check(access.rateKey);
    if (!limit.success) return createRateLimitResponse(limit);

    // Status gate: only an active session accepts capture (matches the form-answers write). A
    // terminal session would never legitimately re-collect a profile.
    if (session.status !== 'active') {
      return errorResponse('This session is not active', {
        code: 'SESSION_NOT_ACTIVE',
        status: 409,
      });
    }

    // Re-derive the fields + applicability from stored config — never trust the client's field list.
    // Only the FORM subset is submitted here; a hybrid version's conversational fields are gathered
    // in-chat and never reach this route.
    const capture = await resolveSessionCapture(sessionId);
    if (!capture || capture.formFields.length === 0) {
      // Anonymous (resolver null), or an all-conversational / no-fields version → not applicable here.
      return errorResponse('Profile capture is not applicable for this session', {
        code: 'CAPTURE_NOT_APPLICABLE',
        status: 409,
      });
    }

    const parsed = putProfileSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse('Invalid request body', {
        code: 'VALIDATION_ERROR',
        status: 400,
        details: { issues: parsed.error.issues },
      });
    }

    // Authoritative validation — deterministic + (per field) the best-effort agentic normalise/flag.
    const result = await validateProfileSubmission({
      fields: capture.formFields,
      raw: parsed.data.profileValues,
      sessionId,
    });
    if (!result.ok) {
      return errorResponse(result.message, {
        code: 'INVALID_PROFILE',
        status: 400,
        details: { fieldErrors: result.fieldErrors },
      });
    }

    // `respondentUserId` is the authed owner (for the GDPR cascade) or null for a non-anonymous
    // no-login respondent (the version is NOT anonymousMode — the resolver already ruled that out).
    const respondentUserId = access.anonymous ? null : access.userId;
    await upsertProfileSnapshot(prisma, sessionId, respondentUserId, result.values);

    log.info('Session profile captured', {
      sessionId,
      fieldCount: Object.keys(result.values).length,
      anonymousRespondent: access.anonymous,
    });
    return successResponse({ saved: true });
  } catch (err) {
    return handleAPIError(err);
  }
}

export const GET = withLiveSessionsEnabled(handleGetProfile);
export const PUT = withLiveSessionsEnabled(handlePutProfile);

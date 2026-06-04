/**
 * Public invitation acceptance endpoint (F3.2 PR2).
 *
 * POST /api/v1/app/invitations/accept
 *   Token-gated (no auth guard). The respondent registers a real account and we
 *   bind it to the invitation (`userId`, status → `registered`). Mirrors the
 *   platform's `app/api/auth/accept-invite` machinery: create the user via
 *   better-auth, mark the email verified (accepting proves ownership), then sign in
 *   and forward the session cookies so the respondent is logged in.
 *
 * The email is taken from the invitation row, not the request — the token is the
 * sole credential. An already-registered email returns `409 ACCOUNT_EXISTS`
 * (claim-via-login is deferred to P7). Flag-gate first; `acceptInviteLimiter`
 * sub-cap guards against token brute force.
 */

import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { handleAPIError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { validateRequestBody } from '@/lib/api/validation';
import { prisma } from '@/lib/db/client';
import { auth } from '@/lib/auth/config';
import {
  acceptInviteLimiter,
  createRateLimitResponse,
  getRateLimitHeaders,
} from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

import { ensureQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  acceptInvitationSchema,
  isInvitationTransitionAllowed,
} from '@/lib/app/questionnaire/invitations';
import {
  resolveInvitationByToken,
  resolutionErrorResponse,
} from '@/app/api/v1/app/invitations/_lib/resolve';

export async function POST(request: NextRequest): Promise<Response> {
  const blocked = await ensureQuestionnairesEnabled();
  if (blocked) return blocked;

  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);

  const rateLimit = acceptInviteLimiter.check(clientIp);
  if (!rateLimit.success) {
    log.warn('Invitation accept rate limit exceeded', { ip: clientIp });
    return createRateLimitResponse(rateLimit);
  }

  // Bare route (no withAdminAuth wrapper) — catch thrown validation/domain errors
  // and map them to the standard envelope ourselves.
  try {
    return await acceptInvitation(request, log, rateLimit);
  } catch (error) {
    return handleAPIError(error);
  }
}

async function acceptInvitation(
  request: NextRequest,
  log: Awaited<ReturnType<typeof getRouteLogger>>,
  rateLimit: ReturnType<typeof acceptInviteLimiter.check>
): Promise<Response> {
  const body = await validateRequestBody(request, acceptInvitationSchema);

  const resolution = await resolveInvitationByToken(body.token);
  if (!resolution.ok) {
    return resolutionErrorResponse(resolution.reason);
  }

  const invitation = resolution.invitation;

  // Registration is legal only before the invitation is bound (sent | opened).
  if (!isInvitationTransitionAllowed(invitation.status, 'registered')) {
    return errorResponse('This invitation has already been used', {
      code: 'INVITATION_ALREADY_USED',
      status: 409,
    });
  }

  // The account is keyed on the invitation's email — an existing account can't be
  // claimed through this flow (deferred to P7).
  const existing = await prisma.user.findUnique({
    where: { email: invitation.email },
    select: { id: true },
  });
  if (existing) {
    return errorResponse('An account already exists for this email — please sign in', {
      code: 'ACCOUNT_EXISTS',
      status: 409,
    });
  }

  // 1. Create the user (better-auth, scrypt-hashed password).
  let newUserId: string;
  try {
    const signup = await auth.api.signUpEmail({
      body: {
        name: body.name ?? invitation.name ?? invitation.email,
        email: invitation.email,
        password: body.password,
      },
    });
    newUserId = signup.user.id;
  } catch (err) {
    // A racing signup (email taken between the check and here) lands here too.
    log.warn('Invitation signup failed', { invitationId: invitation.id, error: String(err) });
    return errorResponse('Could not create your account — it may already exist', {
      code: 'ACCOUNT_EXISTS',
      status: 409,
    });
  }

  // 2. Accepting the invitation proves email ownership.
  await prisma.user.update({ where: { id: newUserId }, data: { emailVerified: true } });

  // 3. Bind the invitation to the new account: registered.
  await prisma.appQuestionnaireInvitation.update({
    where: { id: invitation.id },
    data: {
      userId: newUserId,
      status: 'registered',
      registeredAt: new Date(),
      ...(invitation.openedAt ? {} : { openedAt: new Date() }),
    },
  });
  log.info('Invitation registered', { invitationId: invitation.id, userId: newUserId });

  // 4. Sign in and forward the session cookies (auto-login), as the platform flow does.
  const signInResponse = await auth.api.signInEmail({
    body: { email: invitation.email, password: body.password },
    asResponse: true,
  });
  if (!signInResponse.ok) {
    log.error('Sign-in after invitation accept failed', undefined, {
      invitationId: invitation.id,
      userId: newUserId,
    });
    return errorResponse('Account created but sign-in failed — please log in', {
      code: 'INTERNAL_ERROR',
      status: 500,
    });
  }

  const response = successResponse({ message: 'Registered. Redirecting…' }, undefined, {
    status: 200,
    headers: getRateLimitHeaders(rateLimit),
  });
  for (const cookie of signInResponse.headers.getSetCookie()) {
    response.headers.append('Set-Cookie', cookie);
  }
  return response;
}

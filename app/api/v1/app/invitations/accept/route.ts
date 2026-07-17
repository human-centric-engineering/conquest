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
 * sole credential. If the invited email **already has an account**, the respondent
 * claims the invitation by signing in: the supplied password is verified (a wrong one
 * is `401 INVALID_CREDENTIALS`) and the invitation is bound to that existing account —
 * no second account, no dead-end. Flag-gate first; `acceptInviteLimiter` sub-cap guards
 * against token / password brute force.
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

import {
  acceptInvitationSchema,
  isInvitationTransitionAllowed,
} from '@/lib/app/questionnaire/invitations';
import {
  resolveInvitationByToken,
  resolutionErrorResponse,
} from '@/app/api/v1/app/invitations/_lib/resolve';

export async function POST(request: NextRequest): Promise<Response> {
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

  // Registration is legal before the invitation is bound (sent | opened), OR as a frictionless
  // UPGRADE: a no-account invitee who already `started` may create an account so their in-flight
  // session resumes across devices. An invitation already bound to an account (userId set) is used.
  const isUpgrade = invitation.status === 'started' && invitation.userId === null;
  if (!isUpgrade && !isInvitationTransitionAllowed(invitation.status, 'registered')) {
    return errorResponse('This invitation has already been used', {
      code: 'INVITATION_ALREADY_USED',
      status: 409,
    });
  }

  // The account is keyed on the invitation's email. A fresh email registers a new
  // account; an existing one claims the invitation by signing in (verified below).
  const existing = await prisma.user.findUnique({
    where: { email: invitation.email },
    select: { id: true },
  });

  let userId: string;
  if (existing) {
    // Claim-via-existing-login: bind to the existing account. The password is proven
    // by the sign-in step below (which also issues the session), so we don't create or
    // mutate the user here.
    userId = existing.id;
  } else {
    // 1. Create the user (better-auth, scrypt-hashed password).
    try {
      const signup = await auth.api.signUpEmail({
        body: {
          name: body.name ?? invitation.name ?? invitation.email,
          email: invitation.email,
          password: body.password,
        },
      });
      userId = signup.user.id;
    } catch (err) {
      // A racing signup (email taken between the check and here) lands here too.
      log.warn('Invitation signup failed', { invitationId: invitation.id, error: String(err) });
      return errorResponse('Could not create your account — it may already exist', {
        code: 'ACCOUNT_EXISTS',
        status: 409,
      });
    }
    // 2. Accepting the invitation proves email ownership (fresh account only).
    await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
  }

  // 3. Sign in and forward the session cookies (auto-login), as the platform flow does.
  // For an existing account this is also the credential check — a wrong password is
  // the respondent's failure mode, surfaced as 401 so nothing gets bound.
  const signInResponse = await auth.api.signInEmail({
    body: { email: invitation.email, password: body.password },
    asResponse: true,
  });
  if (!signInResponse.ok) {
    if (existing) {
      log.warn('Invitation claim sign-in failed (bad credentials)', {
        invitationId: invitation.id,
      });
      return errorResponse(
        'That password is incorrect. Enter the password for your existing account to claim this invitation.',
        { code: 'INVALID_CREDENTIALS', status: 401 }
      );
    }
    log.error('Sign-in after invitation accept failed', undefined, {
      invitationId: invitation.id,
      userId,
    });
    return errorResponse('Account created but sign-in failed — please log in', {
      code: 'INTERNAL_ERROR',
      status: 500,
    });
  }

  // 4. Bind the invitation to the account. After sign-in, so a wrong password never binds.
  // A frictionless upgrade keeps `started` (the session is already in progress — don't rewind the
  // lifecycle); a fresh registration advances to `registered`.
  await prisma.appQuestionnaireInvitation.update({
    where: { id: invitation.id },
    data: {
      userId,
      ...(isUpgrade ? {} : { status: 'registered' }),
      registeredAt: new Date(),
      ...(invitation.openedAt ? {} : { openedAt: new Date() }),
    },
  });
  // 5. Cross-device resume: adopt any no-account session this invitation already booted (the
  // frictionless flow) into the new account, so signing in elsewhere resumes it. No-op otherwise.
  await prisma.appQuestionnaireSession.updateMany({
    where: { invitationId: invitation.id, respondentUserId: null },
    data: { respondentUserId: userId },
  });
  log.info('Invitation registered', {
    invitationId: invitation.id,
    userId,
    claimed: Boolean(existing),
    upgrade: isUpgrade,
  });

  const response = successResponse({ message: 'Registered. Redirecting…' }, undefined, {
    status: 200,
    headers: getRateLimitHeaders(rateLimit),
  });
  for (const cookie of signInResponse.headers.getSetCookie()) {
    response.headers.append('Set-Cookie', cookie);
  }
  return response;
}

/**
 * Public invitation metadata endpoint (F3.2 PR2).
 *
 * GET /api/v1/app/invitations/metadata?token=…
 *   Token-gated (no auth guard). Validates the token and returns just enough for
 *   the respondent landing page — the questionnaire title, their name, and the
 *   status — and marks the invitation `opened` on first valid view. Unknown token →
 *   404; expired / revoked → 410.
 *
 * Read-throughput is bounded by the `/api/v1/app` section rate limit (100/min, keyed
 * on IP for anonymous callers) — no sub-cap.
 */

import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { handleAPIError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { prisma } from '@/lib/db/client';

import {
  isInvitationTransitionAllowed,
  type AppInvitationStatus,
  type InvitationLandingView,
} from '@/lib/app/questionnaire/invitations';
import {
  resolveInvitationByToken,
  resolutionErrorResponse,
} from '@/app/api/v1/app/invitations/_lib/resolve';

/**
 * Bounds the only input this unauthenticated route accepts. Issued tokens are exactly 64 hex
 * chars, but the cap is deliberately loose rather than an exact-format regex: a strict match
 * would answer 400-vs-404 differently for malformed and unknown tokens, handing a guesser a
 * format oracle. The cap's job is simply to stop unbounded input reaching the hash + DB lookup.
 */
const tokenSchema = z.string().min(1).max(256);

export async function GET(request: NextRequest): Promise<Response> {
  const log = await getRouteLogger(request);
  const parsed = tokenSchema.safeParse(new URL(request.url).searchParams.get('token'));
  if (!parsed.success) {
    return errorResponse('A token is required', { code: 'VALIDATION_ERROR', status: 400 });
  }

  try {
    return await readMetadata(parsed.data, log);
  } catch (error) {
    return handleAPIError(error);
  }
}

async function readMetadata(
  token: string,
  log: Awaited<ReturnType<typeof getRouteLogger>>
): Promise<Response> {
  const resolution = await resolveInvitationByToken(token);
  if (!resolution.ok) {
    return resolutionErrorResponse(resolution.reason);
  }

  const invitation = resolution.invitation;
  let status: AppInvitationStatus = invitation.status;

  // First valid view flips sent → opened (idempotent: a re-view stays put).
  if (isInvitationTransitionAllowed(status, 'opened')) {
    await prisma.appQuestionnaireInvitation.update({
      where: { id: invitation.id },
      data: { status: 'opened', ...(invitation.openedAt ? {} : { openedAt: new Date() }) },
    });
    status = 'opened';
    log.info('Invitation opened', { invitationId: invitation.id });
  }

  // Whether the invited email already has an account — drives the "sign in to claim"
  // vs "set a password" branch on the landing form. Safe to disclose to a valid token
  // holder (they were invited to this exact email).
  const account = await prisma.user.findUnique({
    where: { email: invitation.email },
    select: { id: true },
  });

  const view: InvitationLandingView = {
    questionnaireTitle: invitation.questionnaireTitle,
    inviteeName: invitation.name,
    status,
    expiresAt: invitation.expiresAt.toISOString(),
    accountExists: account !== null,
  };
  return successResponse(view);
}

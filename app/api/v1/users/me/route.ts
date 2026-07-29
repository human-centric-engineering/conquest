/**
 * Current User Endpoint
 *
 * GET /api/v1/users/me - Get current authenticated user's profile
 * PATCH /api/v1/users/me - Update current user's profile
 * DELETE /api/v1/users/me - Delete current user's account (Phase 3.2)
 *
 * Authentication: Required (session-based via better-auth)
 */

import { cookies } from 'next/headers';
import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { UnauthorizedError, ErrorCodes } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { updateUserSchema, deleteAccountSchema } from '@/lib/validations/user';
import { auth } from '@/lib/auth/config';
import { withAuth } from '@/lib/auth/guards';
import { humanAdminWhere } from '@/lib/auth/account';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { eraseUser } from '@/lib/privacy/erase-user';
import { getRouteLogger } from '@/lib/api/context';
import { serverTrack } from '@/lib/analytics/server';
import { EVENTS } from '@/lib/analytics/events';

/**
 * GET /api/v1/users/me
 *
 * Returns the current authenticated user's profile.
 * Includes extended profile fields (bio, phone, timezone, location, preferences).
 * Password field is explicitly excluded from the response.
 *
 * @returns User profile with id, name, email, role, profile fields, etc.
 * @throws UnauthorizedError if not authenticated
 */
export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  log.info('Fetching current user profile');

  // Fetch user from database with all profile fields
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      image: true,
      role: true,
      createdAt: true,
      updatedAt: true,
      // Extended profile fields (Phase 3.2)
      bio: true,
      phone: true,
      timezone: true,
      location: true,
      preferences: true,
      // Explicitly exclude password
    },
  });

  if (!user) {
    throw new UnauthorizedError('User not found');
  }

  return successResponse(user);
});

/**
 * PATCH /api/v1/users/me
 *
 * Updates the current user's profile.
 * Supports updating name, email, and extended profile fields (bio, phone, timezone, location).
 *
 * Validates:
 * - Request body matches updateUserSchema
 * - Email is unique (if being changed)
 *
 * Changing the email address CLEARS `emailVerified` and re-triggers
 * verification — see the inline note below for why that matters.
 *
 * @param request - Request with JSON body { name?, email?, bio?, phone?, timezone?, location? }
 * @returns Updated user profile
 * @throws UnauthorizedError if not authenticated
 * @throws ValidationError if invalid data
 */
export const PATCH = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  log.info('Updating current user profile');

  // Validate request body
  const body = await validateRequestBody(request, updateUserSchema);

  // Changing the address that owns the account is an identity mutation, and must
  // come from a real browser session.
  //
  // `withAuth` also accepts an API key of ANY scope (see lib/auth/guards.ts), and
  // keys are self-service. Without this check a `chat`-scoped key — handed to a
  // third-party integration, or read out of a CI config — could move the account
  // to an attacker's address, and the verification mail sent below would deliver
  // them a live token. With `autoSignInAfterVerification` enabled that token
  // mints a real session, so a read-ish scope would escalate to full account
  // takeover. Non-identity profile fields stay available over a key.
  if (body.email !== undefined && isApiKeySession(session)) {
    log.warn('Rejected API-key attempt to change account email', {
      userId: session.user.id,
    });
    return errorResponse('Changing your email address requires a browser session', {
      code: ErrorCodes.FORBIDDEN,
      status: 403,
    });
  }

  // Check email uniqueness if changing email
  if (body.email) {
    const existingUser = await prisma.user.findUnique({
      where: { email: body.email },
    });

    if (existingUser && existingUser.id !== session.user.id) {
      return errorResponse('Email already in use', {
        code: ErrorCodes.EMAIL_TAKEN,
        status: 400,
      });
    }
  }

  // Is this request actually changing the address?
  //
  // Emails are stored lower-cased by the auth layer, but compare
  // case-insensitively anyway so a no-op re-submit of the same address (a form
  // that PATCHes every field) doesn't gratuitously unverify the account.
  const emailChanged =
    body.email !== undefined && body.email.toLowerCase() !== session.user.email.toLowerCase();

  // Clear `emailVerified` whenever the address changes.
  //
  // Without this, `user.email` stops meaning "an address this person
  // demonstrably controls" and becomes "any unused string this person typed",
  // while every downstream consumer still reads it as the former. An account
  // that verified mallory@example.com could become a *verified*
  // ceo@bigco.example in one request. That is a privilege-escalation primitive
  // for anything keyed on the address — invitation redemption that matches on
  // `user.email`, domain allowlists ("@company.com implies elevated access"),
  // and audit trails attributing actions to an address the actor never proved
  // they own. The attacker needs only an ordinary account, and the target
  // address must simply not already be registered.
  const updatedUser = await prisma.user.update({
    where: { id: session.user.id },
    data: { ...body, ...(emailChanged ? { emailVerified: false } : {}) },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      image: true,
      role: true,
      createdAt: true,
      updatedAt: true,
      // Extended profile fields (Phase 3.2)
      bio: true,
      phone: true,
      timezone: true,
      location: true,
      preferences: true,
    },
  });

  // Re-trigger verification for the new address so the flag can become true
  // again the only legitimate way. Best-effort: the address is already changed
  // and unverified at this point, so a mail failure must not fail the request —
  // it just means the user re-requests verification from the UI, which the
  // existing POST /api/auth/send-verification-email route already supports.
  if (emailChanged) {
    log.info('Email changed — cleared emailVerified, sending verification to the new address');
    try {
      await auth.api.sendVerificationEmail({ body: { email: updatedUser.email } });
    } catch (sendError) {
      log.error('Failed to send verification email after email change', sendError, {
        userId: session.user.id,
      });
    }
  }

  log.info('User profile updated');

  return successResponse(updatedUser);
});

/**
 * DELETE /api/v1/users/me
 *
 * Permanently deletes the current user's account.
 * Requires confirmation by sending { confirmation: "DELETE" } in request body.
 * Deletes avatar from storage, cascades deletion to sessions and accounts.
 * Clears the session cookie after deletion.
 *
 * @param request - Request with JSON body { confirmation: "DELETE" }
 * @returns Success message confirming deletion
 * @throws UnauthorizedError if not authenticated
 * @throws ValidationError if confirmation is missing or incorrect
 */
export const DELETE = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  try {
    // Validate confirmation (ensures user typed "DELETE")
    await validateRequestBody(request, deleteAccountSchema);

    // Block deletion of the last remaining admin — the system must always
    // retain an operator. Non-last admins and regular users may self-delete.
    // (Admin-deletes-other-admin is separately blocked in users/[id], which
    // requires demoting to USER first; self-delete has no such demotion gate,
    // so the last-admin check lives here.)
    //
    // Count only real human admins (`humanAdminWhere`) — the seeded SERVICE
    // config-owner has role ADMIN but cannot log in and is NOT a real operator.
    // Counting it would let the last human admin self-delete, leaving zero
    // operators and re-opening the first-user-is-admin bootstrap. See
    // lib/auth/account.ts and lib/auth/config.ts.
    if (session.user.role === 'ADMIN') {
      const adminCount = await prisma.user.count({ where: humanAdminWhere });
      if (adminCount <= 1) {
        return errorResponse(
          'Cannot delete the last admin account. Transfer admin access to another user first.',
          { status: 400, code: 'LAST_ADMIN' }
        );
      }
    }

    // Log the deletion for audit purposes
    log.info('User account deletion initiated', {
      email: session.user.email,
    });

    // Erase the user. Schema cascades remove personal data (sessions, accounts,
    // conversations, executions, user memory, evaluations, API keys, webhook
    // subscriptions); org config + audit rows are retained with their
    // creator/userId set null; residual PII is scrubbed; an erasure receipt is
    // written; and avatar blobs are removed. See lib/privacy/erase-user.ts.
    await eraseUser({
      userId: session.user.id,
      userEmail: session.user.email,
      actorUserId: session.user.id,
      reason: 'self_service',
    });

    // Clear all better-auth cookies (session, cached session data, CSRF, OAuth state)
    const cookieStore = await cookies();
    cookieStore.delete('better-auth.session_token');
    cookieStore.delete('better-auth.session_data');
    cookieStore.delete('better-auth.csrf_token');
    cookieStore.delete('better-auth.state');
    // __Secure- cookies require the Secure attribute in the Set-Cookie header,
    // otherwise browsers silently reject the deletion. Use set() with maxAge: 0
    // instead of delete() to include the required attributes.
    const secureCookieOptions = { path: '/', secure: true, maxAge: 0 } as const;
    cookieStore.set('__Secure-better-auth.session_token', '', secureCookieOptions);
    cookieStore.set('__Secure-better-auth.session_data', '', secureCookieOptions);
    cookieStore.set('__Secure-better-auth.csrf_token', '', secureCookieOptions);
    cookieStore.set('__Secure-better-auth.state', '', secureCookieOptions);

    // Track account deletion server-side (bypasses ad blockers for critical events)
    await serverTrack({
      event: EVENTS.ACCOUNT_DELETED,
      userId: session.user.id,
    });

    log.info('User account deleted successfully');

    return successResponse({
      deleted: true,
      message: 'Account deleted successfully',
    });
  } catch (error) {
    log.error('Failed to delete user account', error);
    throw error;
  }
});

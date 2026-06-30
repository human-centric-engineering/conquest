/**
 * Waitlist Sign-up Endpoint (Public)
 *
 * POST /api/v1/app/waitlist — join the ConQuest pre-launch waitlist.
 *
 * Authentication: None (public endpoint).
 *
 * Request body:
 *   - name: Sign-up's name (required)
 *   - email: Email address (required)
 *   - useCase: Optional "what you'd use ConQuest for"
 *   - source: Optional CTA/page marker (set by the page, not the user)
 *   - website: Honeypot field (must be empty)
 *
 * Rate limiting: 5 sign-ups per hour per IP (app-tier limiter below), on top of
 * the section backstop applied by the proxy.
 *
 * Flow: rate-limit → validate (+ honeypot) → store → notify admin → confirm to
 * the sign-up → return success. Mirrors the contact-form handler, but ConQuest-
 * owned rather than Sunrise-core.
 */

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ValidationError, handleAPIError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { waitlistWithHoneypotSchema } from '@/lib/app/waitlist/validation';
import {
  createRateLimiter,
  createRateLimitResponse,
  getRateLimitHeaders,
} from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { sendEmail } from '@/lib/email/send';
import WaitlistNotificationEmail from '@/emails/waitlist-notification';
import WaitlistConfirmationEmail from '@/emails/waitlist-confirmation';
import { isRecord } from '@/lib/utils';
import { getRouteLogger } from '@/lib/api/context';
import { env } from '@/lib/env';

/**
 * App-tier limiter: 5 sign-ups per hour per IP. Defined here (via the exported
 * `createRateLimiter` primitive) rather than in Sunrise's rate-limit module, so
 * this ConQuest feature doesn't edit platform-tracked code.
 */
const waitlistLimiter = createRateLimiter({
  interval: 60 * 60 * 1000, // 1 hour
  maxRequests: 5,
  uniqueTokenPerInterval: 500,
});

const SUCCESS_MESSAGE = 'You’re on the list. Check your inbox for a confirmation.';

export async function POST(request: NextRequest): Promise<Response> {
  const log = await getRouteLogger(request);

  try {
    // 1. Rate limit
    const clientIP = getClientIP(request);
    const rateLimitResult = waitlistLimiter.check(clientIP);

    if (!rateLimitResult.success) {
      log.warn('Waitlist rate limit exceeded', {
        ip: clientIP,
        remaining: rateLimitResult.remaining,
        reset: rateLimitResult.reset,
      });
      return createRateLimitResponse(rateLimitResult);
    }

    // 2. Validate (including honeypot)
    const body = await validateRequestBody(request, waitlistWithHoneypotSchema);

    // Honeypot filled → likely a bot. Return success without processing.
    if (body.website && body.website.length > 0) {
      log.warn('Waitlist honeypot triggered', { ip: clientIP, email: body.email });
      return successResponse({ message: SUCCESS_MESSAGE }, undefined, {
        headers: getRateLimitHeaders(rateLimitResult),
      });
    }

    // 3. Store
    const signup = await prisma.appWaitlistSignup.create({
      data: {
        name: body.name,
        email: body.email,
        useCase: body.useCase || null,
        source: body.source || null,
      },
    });

    log.info('Waitlist sign-up created', {
      id: signup.id,
      email: body.email,
      source: body.source,
    });

    // 4. Notify admin (awaited, non-fatal)
    const adminEmail = env.CONTACT_EMAIL || env.EMAIL_FROM;

    if (!adminEmail) {
      log.warn('No CONTACT_EMAIL or EMAIL_FROM configured, skipping waitlist notification', {
        signupId: signup.id,
      });
    } else {
      try {
        const result = await sendEmail({
          to: adminEmail,
          subject: `[ConQuest Waitlist] ${body.name}`,
          react: WaitlistNotificationEmail({
            name: body.name,
            email: body.email,
            useCase: body.useCase || undefined,
            source: body.source,
            submittedAt: signup.createdAt,
          }),
          replyTo: body.email,
        });

        if (!result.success) {
          log.warn('Failed to send waitlist notification email', {
            signupId: signup.id,
            error: result.error,
          });
        }
      } catch (emailError) {
        log.error('Error sending waitlist notification email', emailError, {
          signupId: signup.id,
        });
      }
    }

    // 5. Confirm to the sign-up (awaited, non-fatal)
    try {
      const result = await sendEmail({
        to: body.email,
        subject: 'You’re on the ConQuest waitlist',
        react: WaitlistConfirmationEmail({ name: body.name }),
      });

      if (!result.success) {
        log.warn('Failed to send waitlist confirmation email', {
          signupId: signup.id,
          error: result.error,
        });
      }
    } catch (emailError) {
      log.error('Error sending waitlist confirmation email', emailError, {
        signupId: signup.id,
      });
    }

    // 6. Success
    return successResponse({ message: SUCCESS_MESSAGE }, undefined, {
      headers: getRateLimitHeaders(rateLimitResult),
    });
  } catch (error) {
    // Don't reveal the honeypot field on validation failure.
    if (error instanceof ValidationError && error.details) {
      const details = error.details;
      if (
        Array.isArray(details.errors) &&
        details.errors.some((e: unknown) => isRecord(e) && e.path === 'website')
      ) {
        log.warn('Waitlist honeypot validation failed', { ip: getClientIP(request) });
        return successResponse({ message: SUCCESS_MESSAGE });
      }
    }

    return handleAPIError(error);
  }
}

/**
 * Unit Tests: POST /api/v1/app/waitlist Route
 *
 * Covers the core behaviors of the waitlist sign-up endpoint:
 * - Happy path: valid sign-up stores in DB, sends admin notification and
 *   confirmation emails, returns 200 with the expected message
 * - Optional fields: useCase and source stored when provided; absent/empty → null
 * - Honeypot triggered: returns 200 silently, no DB write, no emails
 * - Validation errors: missing required fields, invalid email, oversized useCase
 * - Rate limit exceeded: 429 with error envelope, no DB write, no emails
 * - Email send failure is non-fatal: admin notification and confirmation email
 *   failures (both { success: false } and thrown exceptions) handled gracefully
 * - No admin email configured: skips admin notification, still sends confirmation
 *   to the signup, returns 200
 *
 * @see app/api/v1/app/waitlist/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/v1/app/waitlist/route';
import type { NextRequest } from 'next/server';

/**
 * vi.hoisted — define mock fns that must be reachable inside vi.mock factories.
 *
 * The waitlist route creates its own limiter via createRateLimiter() at module
 * load time (not an exported singleton like contactLimiter). We mock
 * createRateLimiter to return a controlled limiter and capture check() here so
 * individual tests can set its return value.
 */
const { mockLimiterCheck } = vi.hoisted(() => ({
  mockLimiterCheck: vi.fn(),
}));

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    appWaitlistSignup: {
      create: vi.fn(),
    },
  },
}));

// Mock email sending
vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(),
}));

// Mock env module (CONTACT_EMAIL set by default — tests that need it absent
// mutate and restore via the finally pattern used in the contact test suite)
vi.mock('@/lib/env', () => ({
  env: {
    CONTACT_EMAIL: 'admin@example.com',
    EMAIL_FROM: 'noreply@example.com',
    NODE_ENV: 'test',
  },
}));

/**
 * The waitlist route creates its own limiter inline via createRateLimiter.
 * Mock the factory to return a limiter whose check fn we can control per test.
 */
vi.mock('@/lib/security/rate-limit', () => ({
  createRateLimiter: vi.fn(() => ({ check: mockLimiterCheck })),
  getRateLimitHeaders: vi.fn(() => ({
    'X-RateLimit-Limit': '5',
    'X-RateLimit-Remaining': '4',
    'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
  })),
  createRateLimitResponse: vi.fn(() =>
    Response.json(
      {
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please try again later.',
        },
      },
      {
        status: 429,
        headers: {
          'Retry-After': '3600',
          'X-RateLimit-Limit': '5',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      }
    )
  ),
}));

// Import mocked modules after vi.mock calls
import { prisma } from '@/lib/db/client';
import { sendEmail } from '@/lib/email/send';
import { env } from '@/lib/env';
import { mockEmailSuccess, mockEmailFailure, mockEmailError } from '@/tests/helpers/email';

// ---------------------------------------------------------------------------
// Type interfaces for type-safe assertions
// ---------------------------------------------------------------------------

interface SuccessResponseBody {
  success: true;
  data: { message: string };
}

interface ErrorResponseBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/app/waitlist');
  return {
    json: async () => body,
    headers: new Headers(headers),
    url: url.toString(),
    nextUrl: { searchParams: url.searchParams },
  } as unknown as NextRequest;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

function makeRateLimitResult(success: boolean, remaining = 4) {
  return {
    success,
    limit: 5,
    remaining,
    reset: Math.floor(Date.now() / 1000) + 3600,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The exact success message returned by the handler. */
const SUCCESS_MESSAGE = 'You’re on the list. Check your inbox for a confirmation.';

/** Minimal valid payload — name + email only (optional fields absent). */
const validPayload = {
  name: 'Jane Doe',
  email: 'jane@example.com',
};

/** Full valid payload with all optional fields. */
const fullPayload = {
  name: 'Jane Doe',
  email: 'jane@example.com',
  useCase: 'Running employee surveys for remote teams',
  source: 'home',
};

interface MockSignupOverrides {
  id?: string;
  name?: string;
  email?: string;
  useCase?: string | null;
  source?: string | null;
  createdAt?: Date;
  read?: boolean;
}

function makeMockSignup(overrides: MockSignupOverrides = {}) {
  return {
    id: 'signup-001',
    name: 'Jane Doe',
    email: 'jane@example.com',
    useCase: null,
    source: null,
    createdAt: new Date('2026-02-12T00:00:00.000Z'),
    read: false,
    ...overrides,
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('POST /api/v1/app/waitlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: rate limit allows the request
    mockLimiterCheck.mockReturnValue(makeRateLimitResult(true));
  });

  // ---------------------------------------------------------------------------
  // 1. Happy path
  // ---------------------------------------------------------------------------

  describe('Happy path', () => {
    it('should store signup with all fields, send both emails, and return 200', async () => {
      // Arrange
      const signup = makeMockSignup({
        useCase: fullPayload.useCase,
        source: fullPayload.source,
      });
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(signup);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-001');

      const request = createMockRequest(fullPayload);

      // Act
      const response = await POST(request);
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert: HTTP 200 with the canonical waitlist success message
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — body.success is the documented API envelope boolean ({ success: true, data }); structural, not a trivial check
      expect(body.success).toBe(true);
      expect(body.data.message).toBe(SUCCESS_MESSAGE);

      // Assert: DB write called with the correct mapped fields (this is what the
      // route computed — NOT merely the mock return value)
      expect(vi.mocked(prisma.appWaitlistSignup.create)).toHaveBeenCalledWith({
        data: {
          name: fullPayload.name,
          email: fullPayload.email,
          useCase: fullPayload.useCase,
          source: fullPayload.source,
        },
      });

      // Assert: exactly two emails dispatched (admin notification + confirmation)
      expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(2);

      // Assert: first call is admin notification — to admin, reply-to is the signup's email
      expect(vi.mocked(sendEmail)).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          to: 'admin@example.com',
          subject: `[ConQuest Waitlist] ${fullPayload.name}`,
          replyTo: fullPayload.email,
        })
      );

      // Assert: second call is confirmation — to the SIGNUP's email, not admin
      expect(vi.mocked(sendEmail)).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          to: fullPayload.email,
          subject: 'You’re on the ConQuest waitlist',
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Optional field mapping
  // ---------------------------------------------------------------------------

  describe('Optional field mapping', () => {
    it('should store useCase and source as null when absent from payload', async () => {
      // Arrange: minimal payload — no useCase, no source
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(makeMockSignup());
      mockEmailSuccess(vi.mocked(sendEmail), 'email-002');

      // Act
      await POST(createMockRequest(validPayload));

      // Assert: absent optional fields mapped to null (not undefined) before storage
      expect(vi.mocked(prisma.appWaitlistSignup.create)).toHaveBeenCalledWith({
        data: {
          name: validPayload.name,
          email: validPayload.email,
          useCase: null,
          source: null,
        },
      });
    });

    it('should store useCase as null when payload provides an empty string', async () => {
      // Arrange: body.useCase || null — empty string is falsy, route maps it to null
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(makeMockSignup());
      mockEmailSuccess(vi.mocked(sendEmail), 'email-003');

      // Act
      await POST(createMockRequest({ ...validPayload, useCase: '' }));

      // Assert: empty string coerced to null before DB write
      expect(vi.mocked(prisma.appWaitlistSignup.create)).toHaveBeenCalledWith({
        data: expect.objectContaining({ useCase: null }),
      });
    });

    it('should store source value when provided in payload', async () => {
      // Arrange
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(
        makeMockSignup({ source: 'pricing' })
      );
      mockEmailSuccess(vi.mocked(sendEmail), 'email-004');

      // Act
      await POST(createMockRequest({ ...validPayload, source: 'pricing' }));

      // Assert: source value passed through unchanged to DB
      expect(vi.mocked(prisma.appWaitlistSignup.create)).toHaveBeenCalledWith({
        data: expect.objectContaining({ source: 'pricing' }),
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Honeypot protection
  // ---------------------------------------------------------------------------

  describe('Honeypot protection', () => {
    it('should return 200 silently without storing or emailing when website field is populated', async () => {
      // Arrange: non-empty honeypot field signals a bot
      const request = createMockRequest({ ...validPayload, website: 'https://spam.example.com' });

      // Act
      const response = await POST(request);
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert: silent 200 to avoid tipping off the bot — same envelope as a
      // real sign-up, so the bot cannot distinguish the two paths
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — honeypot path must return the same envelope shape as a real submission
      expect(body.success).toBe(true);
      expect(body.data.message).toBe(SUCCESS_MESSAGE);

      // Assert: no DB write and no emails — honeypot was triggered
      expect(vi.mocked(prisma.appWaitlistSignup.create)).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Validation errors
  // ---------------------------------------------------------------------------

  describe('Validation errors', () => {
    it('should return 400 when name is missing', async () => {
      const { name: _name, ...withoutName } = validPayload;
      const response = await POST(createMockRequest(withoutName));
      const body = await parseResponse<ErrorResponseBody>(response);

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      // Guard: validation must short-circuit before any DB or email work
      expect(vi.mocked(prisma.appWaitlistSignup.create)).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
    });

    it('should return 400 when email is missing', async () => {
      const { email: _email, ...withoutEmail } = validPayload;
      const response = await POST(createMockRequest(withoutEmail));
      const body = await parseResponse<ErrorResponseBody>(response);

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when email is invalid', async () => {
      const response = await POST(createMockRequest({ ...validPayload, email: 'not-an-email' }));
      const body = await parseResponse<ErrorResponseBody>(response);

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when useCase exceeds 2000 characters', async () => {
      const response = await POST(
        createMockRequest({ ...validPayload, useCase: 'a'.repeat(2001) })
      );
      const body = await parseResponse<ErrorResponseBody>(response);

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      // Guard: oversized useCase must be rejected before DB write
      expect(vi.mocked(prisma.appWaitlistSignup.create)).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Rate limiting
  // ---------------------------------------------------------------------------

  describe('Rate limiting', () => {
    it('should return 429 when the rate limit is exceeded', async () => {
      // Arrange: rate limiter signals the request is over limit
      mockLimiterCheck.mockReturnValue(makeRateLimitResult(false, 0));

      const response = await POST(createMockRequest(validPayload));
      const body = await parseResponse<ErrorResponseBody>(response);

      // Assert: 429 with the standard error envelope
      expect(response.status).toBe(429);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');

      // Assert: rate limit must short-circuit before DB and email
      expect(vi.mocked(prisma.appWaitlistSignup.create)).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Email send failure is non-fatal
  //
  // The handler stores the row before sending emails. Both the admin notification
  // and the confirmation email are individually wrapped in try/catch so neither
  // failure can roll back the DB write or suppress the 200 response.
  // ---------------------------------------------------------------------------

  describe('Email send failure is non-fatal', () => {
    it('should return 200 when admin notification sendEmail returns { success: false }', async () => {
      // Arrange: all sendEmail calls return failure (including confirmation)
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(makeMockSignup());
      mockEmailFailure(vi.mocked(sendEmail), 'SMTP connection refused');

      const response = await POST(createMockRequest(validPayload));
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert: sign-up row stored despite email failure
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — non-fatal admin-email path returns the correct envelope shape
      expect(body.success).toBe(true);
      expect(vi.mocked(prisma.appWaitlistSignup.create)).toHaveBeenCalledOnce();
    });

    it('should return 200 when admin notification sendEmail throws', async () => {
      // Arrange: sendEmail throws for every call (exercises the catch block)
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(makeMockSignup());
      mockEmailError(vi.mocked(sendEmail), new Error('Network connection failed'));

      const response = await POST(createMockRequest(validPayload));
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert: thrown admin email error is caught and non-fatal
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — thrown-admin-email-error path returns the correct envelope shape
      expect(body.success).toBe(true);
      expect(vi.mocked(prisma.appWaitlistSignup.create)).toHaveBeenCalledOnce();
    });

    it('should return 200 when confirmation sendEmail returns { success: false }', async () => {
      // Arrange: admin notification succeeds; confirmation email returns failure
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(makeMockSignup());
      vi.mocked(sendEmail)
        .mockResolvedValueOnce({ success: true, status: 'sent', id: 'email-admin-001' })
        .mockResolvedValueOnce({ success: false, status: 'failed', error: 'Delivery rejected' });

      const response = await POST(createMockRequest(validPayload));
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert: confirmation email failure is non-fatal
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — non-fatal confirmation-email path returns the correct envelope shape
      expect(body.success).toBe(true);
      expect(vi.mocked(prisma.appWaitlistSignup.create)).toHaveBeenCalledOnce();
    });

    it('should return 200 when confirmation sendEmail throws', async () => {
      // Arrange: admin notification succeeds; confirmation email throws
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(makeMockSignup());
      vi.mocked(sendEmail)
        .mockResolvedValueOnce({ success: true, status: 'sent', id: 'email-admin-002' })
        .mockRejectedValueOnce(new Error('SMTP timeout'));

      const response = await POST(createMockRequest(validPayload));
      const body = await parseResponse<SuccessResponseBody>(response);

      // Assert: thrown confirmation error is caught and non-fatal
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — thrown-confirmation-email-error path returns the correct envelope shape
      expect(body.success).toBe(true);
      expect(vi.mocked(prisma.appWaitlistSignup.create)).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // 7. No admin email configured
  //
  // When both CONTACT_EMAIL and EMAIL_FROM are absent the handler skips the
  // admin notification (nothing to send to) but MUST still send the confirmation
  // to the signup and return 200.
  // ---------------------------------------------------------------------------

  describe('No admin email configured', () => {
    it('should skip admin notification, still send confirmation, and return 200', async () => {
      // Arrange: strip both admin email env vars
      const originalContactEmail = env.CONTACT_EMAIL;
      const originalEmailFrom = env.EMAIL_FROM;
      (env as Record<string, unknown>).CONTACT_EMAIL = undefined;
      (env as Record<string, unknown>).EMAIL_FROM = undefined;

      try {
        vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(makeMockSignup());
        mockEmailSuccess(vi.mocked(sendEmail), 'email-confirm-001');

        const response = await POST(createMockRequest(validPayload));
        const body = await parseResponse<SuccessResponseBody>(response);

        // Assert: handler succeeds without an admin recipient
        expect(response.status).toBe(200);
        // test-review:accept tobe_true — missing-admin-email path returns the correct envelope shape
        expect(body.success).toBe(true);

        // Assert: DB row stored
        expect(vi.mocked(prisma.appWaitlistSignup.create)).toHaveBeenCalledOnce();

        // Assert: exactly ONE email sent — the confirmation to the signup,
        // not the admin notification (which was skipped)
        expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
          expect.objectContaining({
            to: validPayload.email,
            subject: 'You’re on the ConQuest waitlist',
          })
        );
      } finally {
        // Restore so other tests are not affected
        (env as Record<string, unknown>).CONTACT_EMAIL = originalContactEmail;
        (env as Record<string, unknown>).EMAIL_FROM = originalEmailFrom;
      }
    });
  });
});

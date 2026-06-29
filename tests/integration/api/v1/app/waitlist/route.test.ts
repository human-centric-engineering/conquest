/**
 * Integration Tests: POST /api/v1/app/waitlist Route
 *
 * Adds depth beyond the unit suite: logger call assertions, IP extraction from
 * request headers, honeypot edge cases (empty-string and absent → allowed),
 * rate-limit header propagation, and DB failure → 500.
 *
 * Mocking strategy mirrors the contact integration test: Prisma, email sending,
 * env, and the rate-limit module are all mocked; the logger is the global mock
 * from tests/setup.ts (accessed via getMockLogger).
 *
 * @see app/api/v1/app/waitlist/route.ts
 * @see tests/unit/app/api/v1/app/waitlist/route.test.ts  (core behaviour tests)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/v1/app/waitlist/route';
import type { NextRequest } from 'next/server';

/**
 * vi.hoisted — mock check fn for the inline waitlistLimiter.
 *
 * The route creates its limiter via createRateLimiter() at module load; we
 * must capture the check fn before the factory runs.
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

// Mock env module
vi.mock('@/lib/env', () => ({
  env: {
    CONTACT_EMAIL: 'admin@sunrise.example.com',
    EMAIL_FROM: 'noreply@sunrise.example.com',
    NODE_ENV: 'test',
  },
}));

/**
 * The waitlist route creates its own limiter inline — mock createRateLimiter
 * to return a limiter whose check fn we control.
 */
vi.mock('@/lib/security/rate-limit', () => ({
  createRateLimiter: vi.fn(() => ({ check: mockLimiterCheck })),
  getRateLimitHeaders: vi.fn((result: { limit: number; remaining: number; reset: number }) => ({
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.reset),
  })),
  createRateLimitResponse: vi.fn((result: { limit: number; remaining: number; reset: number }) =>
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
          'Retry-After': String(Math.max(1, result.reset - Math.floor(Date.now() / 1000))),
          'X-RateLimit-Limit': String(result.limit),
          'X-RateLimit-Remaining': String(result.remaining),
          'X-RateLimit-Reset': String(result.reset),
        },
      }
    )
  ),
}));

// Import mocked modules
import { prisma } from '@/lib/db/client';
import { sendEmail } from '@/lib/email/send';
import { getRouteLogger } from '@/lib/api/context';
import { mockEmailSuccess, mockEmailFailure } from '@/tests/helpers/email';

// ---------------------------------------------------------------------------
// Logger access helper
//
// getRouteLogger is mocked globally in tests/setup.ts. Each call returns a
// fresh Promise<logger>; clearAllMocks() in beforeEach resets the results
// array, so getMockLogger() always retrieves the logger from the most recent
// POST() invocation.
// ---------------------------------------------------------------------------

type MockLogger = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  withContext: ReturnType<typeof vi.fn>;
};

function getMockLogger(): Promise<MockLogger> {
  const mockGetRouteLogger = vi.mocked(getRouteLogger);
  const lastCall = mockGetRouteLogger.mock.results[mockGetRouteLogger.mock.results.length - 1];
  return lastCall?.value as Promise<MockLogger>;
}

// ---------------------------------------------------------------------------
// Type interfaces
// ---------------------------------------------------------------------------

interface SuccessResponse {
  success: true;
  data: { message: string };
}

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRequest(body: unknown, headers?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/app/waitlist');
  return {
    json: async () => body,
    headers: new Headers(headers ?? {}),
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

const SUCCESS_MESSAGE = 'You’re on the list. Check your inbox for a confirmation.';

const validSignupData = {
  name: 'John Doe',
  email: 'john@example.com',
};

// =============================================================================
// Test Suite
// =============================================================================

describe('POST /api/v1/app/waitlist (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimiterCheck.mockReturnValue(makeRateLimitResult(true));
  });

  // ---------------------------------------------------------------------------
  // Success scenarios
  // ---------------------------------------------------------------------------

  describe('Success scenarios', () => {
    it('should create waitlist signup and emit info log with signup id', async () => {
      // Arrange
      const mockSignup = {
        id: 'waitlist-signup-123',
        name: validSignupData.name,
        email: validSignupData.email,
        useCase: null,
        source: null,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(mockSignup);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id-123');

      // Act
      const request = createMockRequest(validSignupData);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: response envelope
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — body.success is the API envelope field ({ success: true, data }); structural, not a degenerate check
      expect(body.success).toBe(true);
      expect(body.data.message).toBe(SUCCESS_MESSAGE);

      // Assert: signup stored with correct fields (route's DB call, not mock passthrough)
      expect(vi.mocked(prisma.appWaitlistSignup.create)).toHaveBeenCalledWith({
        data: {
          name: validSignupData.name,
          email: validSignupData.email,
          useCase: null,
          source: null,
        },
      });

      // Assert: logger recorded the signup id (proves the log comes from after
      // the DB write — the route extracted id from the Prisma result)
      const mockLogger = await getMockLogger();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Waitlist sign-up created',
        expect.objectContaining({
          id: mockSignup.id,
          email: validSignupData.email,
        })
      );
    });

    it('should send admin notification to CONTACT_EMAIL', async () => {
      // Arrange
      const mockSignup = {
        id: 'waitlist-signup-456',
        ...validSignupData,
        useCase: null,
        source: null,
        createdAt: new Date('2024-01-01T12:00:00Z'),
        read: false,
      };
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(mockSignup);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id-456');

      // Act
      const request = createMockRequest(validSignupData);
      await POST(request);

      // Assert: first sendEmail call routes to admin with the waitlist-specific subject
      expect(vi.mocked(sendEmail)).toHaveBeenNthCalledWith(1, {
        to: 'admin@sunrise.example.com',
        subject: `[ConQuest Waitlist] ${validSignupData.name}`,
        react: expect.any(Object),
        replyTo: validSignupData.email,
      });
    });

    it('should send confirmation email to the signup address', async () => {
      // Arrange
      const mockSignup = {
        id: 'waitlist-signup-789',
        ...validSignupData,
        useCase: null,
        source: null,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(mockSignup);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id-789');

      // Act
      const request = createMockRequest(validSignupData);
      await POST(request);

      // Assert: second sendEmail call is the confirmation — goes to the SIGNUP's
      // email, not the admin address
      expect(vi.mocked(sendEmail)).toHaveBeenNthCalledWith(2, {
        to: validSignupData.email,
        subject: 'You’re on the ConQuest waitlist',
        react: expect.any(Object),
      });
    });

    it('should fallback to EMAIL_FROM when CONTACT_EMAIL is not set', async () => {
      // Arrange: clear CONTACT_EMAIL so the handler falls through to EMAIL_FROM
      const envModule = await import('@/lib/env');
      const originalContactEmail = envModule.env.CONTACT_EMAIL;
      (envModule.env as Record<string, unknown>).CONTACT_EMAIL = undefined;

      try {
        const mockSignup = {
          id: 'waitlist-signup-fallback',
          ...validSignupData,
          useCase: null,
          source: null,
          createdAt: new Date(),
          read: false,
        };
        vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(mockSignup);
        mockEmailSuccess(vi.mocked(sendEmail), 'email-id-fallback');

        // Act
        const request = createMockRequest(validSignupData);
        await POST(request);

        // Assert: admin notification went to EMAIL_FROM fallback
        expect(vi.mocked(sendEmail)).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            to: 'noreply@sunrise.example.com',
          })
        );
      } finally {
        (envModule.env as Record<string, unknown>).CONTACT_EMAIL = originalContactEmail;
      }
    });

    it('should include rate-limit headers in a successful response', async () => {
      // Arrange
      const mockSignup = {
        id: 'waitlist-signup-headers',
        ...validSignupData,
        useCase: null,
        source: null,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(mockSignup);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id-headers');

      // Act
      const request = createMockRequest(validSignupData);
      const response = await POST(request);

      // Assert: rate-limit headers propagated from getRateLimitHeaders
      expect(response.headers.get('X-RateLimit-Limit')).toBeDefined();
      expect(response.headers.get('X-RateLimit-Remaining')).toBeDefined();
      expect(response.headers.get('X-RateLimit-Reset')).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Validation scenarios
  // ---------------------------------------------------------------------------

  describe('Validation scenarios', () => {
    it('should return 400 when name is missing', async () => {
      const invalidData = { email: validSignupData.email };

      const request = createMockRequest(invalidData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(vi.mocked(prisma.appWaitlistSignup.create)).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called
    });

    it('should return 400 when email is invalid', async () => {
      const invalidData = { ...validSignupData, email: 'not-an-email' };

      const request = createMockRequest(invalidData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when useCase exceeds 2000 characters', async () => {
      const invalidData = { ...validSignupData, useCase: 'a'.repeat(2001) };

      const request = createMockRequest(invalidData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // Honeypot protection
  // ---------------------------------------------------------------------------

  describe('Honeypot protection', () => {
    it('should return fake success and emit warn log when honeypot field is filled', async () => {
      // Arrange: non-empty honeypot field
      const dataWithHoneypot = {
        ...validSignupData,
        website: 'https://spam-bot.com',
      };

      // Act
      const request = createMockRequest(dataWithHoneypot);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: same success envelope as a real sign-up
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — body.success is the API envelope field; honeypot must return the same envelope shape
      expect(body.success).toBe(true);
      expect(body.data.message).toBe(SUCCESS_MESSAGE);

      // Assert: NO signup created
      expect(vi.mocked(prisma.appWaitlistSignup.create)).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called

      // Assert: warn logged via the catch block (the Zod max(0) schema rejects a
      // non-empty website BEFORE the inline honeypot check is reached, so the
      // catch block path runs and logs 'Waitlist honeypot validation failed' with
      // only the IP — not email — matching the contact route's behaviour)
      const mockLogger = await getMockLogger();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Waitlist honeypot validation failed',
        expect.objectContaining({
          ip: '127.0.0.1',
        })
      );
    });

    it('should allow submission when honeypot field is an empty string', async () => {
      // Arrange: empty string is not a filled honeypot
      const mockSignup = {
        id: 'waitlist-signup-honeypot-empty',
        ...validSignupData,
        useCase: null,
        source: null,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(mockSignup);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      const dataWithEmptyHoneypot = { ...validSignupData, website: '' };

      // Act
      const request = createMockRequest(dataWithEmptyHoneypot);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: real success (empty honeypot is valid for human users)
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — body.success is the API envelope field; structural
      expect(body.success).toBe(true);

      // Assert: signup WAS created
      // test-review:accept no_arg_called — presence check: empty-honeypot path must proceed to DB write
      expect(vi.mocked(prisma.appWaitlistSignup.create)).toHaveBeenCalled();
    });

    it('should allow submission when honeypot field is absent', async () => {
      // Arrange: no website field at all — the common real-user case
      const mockSignup = {
        id: 'waitlist-signup-no-honeypot',
        ...validSignupData,
        useCase: null,
        source: null,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(mockSignup);
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      // Act
      const request = createMockRequest(validSignupData);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: real success
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — body.success is the API envelope field; structural
      expect(body.success).toBe(true);

      // Assert: signup WAS created
      // test-review:accept no_arg_called — presence check: absent-honeypot path must proceed to DB write
      expect(vi.mocked(prisma.appWaitlistSignup.create)).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  describe('Rate limiting', () => {
    it('should block and log warn when rate limit is exceeded', async () => {
      // Arrange
      mockLimiterCheck.mockReturnValue(makeRateLimitResult(false, 0));

      // Act
      const request = createMockRequest(validSignupData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: 429 with error envelope
      expect(response.status).toBe(429);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');

      // Assert: no DB write
      expect(vi.mocked(prisma.appWaitlistSignup.create)).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called

      // Assert: warn logged with remaining count
      const mockLogger = await getMockLogger();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Waitlist rate limit exceeded',
        expect.objectContaining({ remaining: 0 })
      );
    });

    it('should use client IP from x-forwarded-for header', async () => {
      // Arrange
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue({
        id: 'waitlist-signup-ip',
        ...validSignupData,
        useCase: null,
        source: null,
        createdAt: new Date(),
        read: false,
      });
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      // Act
      const request = createMockRequest(validSignupData, {
        'x-forwarded-for': '192.168.1.100, 10.0.0.1',
      });
      await POST(request);

      // Assert: limiter keyed on the first (client-facing) IP in the chain
      expect(mockLimiterCheck).toHaveBeenCalledWith('192.168.1.100');
    });

    it('should use x-real-ip when x-forwarded-for is absent', async () => {
      // Arrange
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue({
        id: 'waitlist-signup-real-ip',
        ...validSignupData,
        useCase: null,
        source: null,
        createdAt: new Date(),
        read: false,
      });
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      // Act
      const request = createMockRequest(validSignupData, { 'x-real-ip': '203.0.113.45' });
      await POST(request);

      // Assert: limiter keyed on x-real-ip
      expect(mockLimiterCheck).toHaveBeenCalledWith('203.0.113.45');
    });

    it('should fallback to 127.0.0.1 when no IP headers are present', async () => {
      // Arrange
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue({
        id: 'waitlist-signup-unknown-ip',
        ...validSignupData,
        useCase: null,
        source: null,
        createdAt: new Date(),
        read: false,
      });
      mockEmailSuccess(vi.mocked(sendEmail), 'email-id');

      // Act
      const request = createMockRequest(validSignupData);
      await POST(request);

      // Assert: limiter keyed on the default fallback IP
      expect(mockLimiterCheck).toHaveBeenCalledWith('127.0.0.1');
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('Error handling', () => {
    it('should return 500 when database create fails', async () => {
      // Arrange
      vi.mocked(prisma.appWaitlistSignup.create).mockRejectedValue(
        new Error('Database connection failed')
      );

      // Act
      const request = createMockRequest(validSignupData);
      const response = await POST(request);
      const body = await parseResponse<ErrorResponse>(response);

      // Assert: unhandled DB errors bubble up to handleAPIError → 500
      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error.code).toBeDefined();
    });

    it('should skip admin email and still send confirmation when both env vars are absent', async () => {
      // Arrange: no admin recipient configured
      const envModule = await import('@/lib/env');
      const originalContactEmail = envModule.env.CONTACT_EMAIL;
      const originalEmailFrom = envModule.env.EMAIL_FROM;
      (envModule.env as Record<string, unknown>).CONTACT_EMAIL = undefined;
      (envModule.env as Record<string, unknown>).EMAIL_FROM = undefined;

      try {
        const mockSignup = {
          id: 'waitlist-signup-no-email',
          ...validSignupData,
          useCase: null,
          source: null,
          createdAt: new Date(),
          read: false,
        };
        vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(mockSignup);
        mockEmailSuccess(vi.mocked(sendEmail), 'email-confirm');

        // Act
        const request = createMockRequest(validSignupData);
        const response = await POST(request);
        const body = await parseResponse<SuccessResponse>(response);

        // Assert: handler succeeds
        expect(response.status).toBe(200);
        // test-review:accept tobe_true — body.success is the API envelope field; structural
        expect(body.success).toBe(true);

        // Assert: confirmation was still sent; admin email was skipped
        expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
          expect.objectContaining({ to: validSignupData.email })
        );

        // Assert: warn logged about missing config
        const mockLogger = await getMockLogger();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          'No CONTACT_EMAIL or EMAIL_FROM configured, skipping waitlist notification',
          expect.objectContaining({ signupId: mockSignup.id })
        );
      } finally {
        (envModule.env as Record<string, unknown>).CONTACT_EMAIL = originalContactEmail;
        (envModule.env as Record<string, unknown>).EMAIL_FROM = originalEmailFrom;
      }
    });

    it('should handle admin email exception and log error', async () => {
      // Arrange: DB succeeds; admin sendEmail throws
      const mockSignup = {
        id: 'waitlist-signup-email-error',
        ...validSignupData,
        useCase: null,
        source: null,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(mockSignup);
      vi.mocked(sendEmail).mockRejectedValue(new Error('Network timeout'));

      // Act
      const request = createMockRequest(validSignupData);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: still 200 (email is non-blocking)
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — body.success is the API envelope field; structural
      expect(body.success).toBe(true);

      // Assert: error logged with signup id (proves the log came from after the DB write)
      const mockLogger = await getMockLogger();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error sending waitlist notification email',
        expect.any(Error),
        expect.objectContaining({ signupId: mockSignup.id })
      );
    });

    it('should continue and return 200 when admin email returns failure result', async () => {
      // Arrange: admin notification returns { success: false }
      const mockSignup = {
        id: 'waitlist-signup-email-fail',
        ...validSignupData,
        useCase: null,
        source: null,
        createdAt: new Date(),
        read: false,
      };
      vi.mocked(prisma.appWaitlistSignup.create).mockResolvedValue(mockSignup);
      mockEmailFailure(vi.mocked(sendEmail), 'Resend delivery failed');

      // Act
      const request = createMockRequest(validSignupData);
      const response = await POST(request);
      const body = await parseResponse<SuccessResponse>(response);

      // Assert: non-fatal
      expect(response.status).toBe(200);
      // test-review:accept tobe_true — body.success is the API envelope field; structural
      expect(body.success).toBe(true);

      // Assert: warn logged with signup id and error detail
      const mockLogger = await getMockLogger();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to send waitlist notification email',
        expect.objectContaining({
          signupId: mockSignup.id,
          error: 'Resend delivery failed',
        })
      );
    });
  });
});

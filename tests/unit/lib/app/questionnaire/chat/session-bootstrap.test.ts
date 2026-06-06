/**
 * createOrResumeAuthedSession — server-side session bootstrap for the authenticated
 * respondent surface (F7.1).
 *
 * Mocks `serverFetch` and `parseApiResponse` to test the success, failure, and error-
 * catch branches without hitting the network.
 *
 * @see lib/app/questionnaire/chat/session-bootstrap.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that transitively touch the modules.
// ---------------------------------------------------------------------------

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports — after vi.mock() hoisting.
// ---------------------------------------------------------------------------

import { createOrResumeAuthedSession } from '@/lib/app/questionnaire/chat/session-bootstrap';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';
import type { APIResponse } from '@/types/api';

// Typed aliases to keep tests readable.
const mockServerFetch = vi.mocked(serverFetch);
const mockParseApiResponse = vi.mocked(parseApiResponse);
const mockLoggerError = vi.mocked(logger.error);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal fake Response that parseApiResponse would normally call .json() on. */
function fakeResponse(): Response {
  return {} as unknown as Response;
}

/** Build a success API body with an optional `meta.resumed` flag. */
function successBody(
  sessionId: string,
  resumed?: boolean
): APIResponse<{ session: { id: string; status: string; versionId: string } }> {
  return {
    success: true,
    data: { session: { id: sessionId, status: 'active', versionId: 'v1' } },
    meta: resumed !== undefined ? { resumed } : undefined,
  };
}

/** Build a failure API body. Omit `code` to produce an error object without a code field. */
function failureBody(
  code: string | undefined,
  message = 'Something went wrong'
): APIResponse<never> {
  const error: { code?: string; message: string } = { message };
  if (code !== undefined) {
    error.code = code;
  }
  return {
    success: false,
    error,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOrResumeAuthedSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockServerFetch.mockResolvedValue(fakeResponse());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Success paths
  // -------------------------------------------------------------------------

  describe('success — session created/resumed', () => {
    it('returns ok=true, the sessionId, and resumed=true when meta.resumed is truthy', async () => {
      // Arrange
      mockParseApiResponse.mockResolvedValue(successBody('sess1', true));

      // Act
      const result = await createOrResumeAuthedSession({ invitationToken: 'tok-abc' });

      // Assert: the function transforms the body into the typed bootstrap shape.
      expect(result).toEqual({ ok: true, sessionId: 'sess1', resumed: true });
    });

    it('returns resumed=false when meta.resumed is false', async () => {
      // Arrange
      mockParseApiResponse.mockResolvedValue(successBody('sess2', false));

      // Act
      const result = await createOrResumeAuthedSession({ versionId: 'v1' });

      // Assert
      expect(result).toEqual({ ok: true, sessionId: 'sess2', resumed: false });
    });

    it('returns resumed=false when meta is absent', async () => {
      // Arrange: success body with no meta field at all.
      mockParseApiResponse.mockResolvedValue({
        success: true,
        data: { session: { id: 'sess3', status: 'active', versionId: 'v1' } },
      });

      // Act
      const result = await createOrResumeAuthedSession({ invitationToken: 'tok-xyz' });

      // Assert: no meta → resumed must default to false, not undefined or true.
      expect(result).toEqual({ ok: true, sessionId: 'sess3', resumed: false });
    });

    it('returns resumed=false when meta exists but has no resumed key', async () => {
      // Arrange
      mockParseApiResponse.mockResolvedValue({
        success: true,
        data: { session: { id: 'sess4', status: 'active', versionId: 'v1' } },
        meta: { otherKey: 'value' },
      } as unknown as APIResponse<{ session: { id: string; status: string; versionId: string } }>);

      // Act
      const result = await createOrResumeAuthedSession({ versionId: 'v2' });

      // Assert
      expect(result).toEqual({ ok: true, sessionId: 'sess4', resumed: false });
    });
  });

  // -------------------------------------------------------------------------
  // Failure paths — body.success === false
  // -------------------------------------------------------------------------

  describe('failure — body.success === false', () => {
    it('returns ok=false with the error code and message from the body', async () => {
      // Arrange
      mockParseApiResponse.mockResolvedValue(failureBody('SESSION_LIMIT_REACHED', 'Limit hit'));

      // Act
      const result = await createOrResumeAuthedSession({ invitationToken: 'tok' });

      // Assert: the code and message are propagated unchanged.
      expect(result).toEqual({
        ok: false,
        code: 'SESSION_LIMIT_REACHED',
        message: 'Limit hit',
      });
    });

    it('falls back to SESSION_CREATE_FAILED when error.code is missing', async () => {
      // Arrange: no code on the error object.
      mockParseApiResponse.mockResolvedValue(failureBody(undefined, 'Unknown error'));

      // Act
      const result = await createOrResumeAuthedSession({ invitationToken: 'tok' });

      // Assert: the fallback code is applied so callers never see an empty string code.
      expect(result).toEqual({
        ok: false,
        code: 'SESSION_CREATE_FAILED',
        message: 'Unknown error',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Catch path — serverFetch throws
  // -------------------------------------------------------------------------

  describe('catch — serverFetch throws', () => {
    it('returns ok=false with SESSION_CREATE_FAILED when serverFetch throws', async () => {
      // Arrange
      mockServerFetch.mockRejectedValue(new Error('Network timeout'));

      // Act
      const result = await createOrResumeAuthedSession({ versionId: 'v-fail' });

      // Assert: the friendly failure shape is returned, not re-thrown.
      expect(result).toEqual({
        ok: false,
        code: 'SESSION_CREATE_FAILED',
        message: 'We could not start your questionnaire. Please try again.',
      });
    });

    it('calls logger.error with the thrown error when serverFetch throws', async () => {
      // Arrange
      const networkError = new Error('Network timeout');
      mockServerFetch.mockRejectedValue(networkError);

      // Act
      await createOrResumeAuthedSession({ invitationToken: 'tok-err' });

      // Assert: the error is logged so server-side traces capture it.
      expect(mockLoggerError).toHaveBeenCalledWith(
        'createOrResumeAuthedSession failed',
        networkError
      );
    });

    it('does NOT call logger.error on the happy path', async () => {
      // Arrange
      mockParseApiResponse.mockResolvedValue(successBody('sess-ok', false));

      // Act
      await createOrResumeAuthedSession({ invitationToken: 'tok-ok' });

      // Assert: logger.error is silent when there is no error.
      expect(mockLoggerError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Request forwarding — assert serverFetch is called with the correct args
  // -------------------------------------------------------------------------

  describe('request forwarding', () => {
    it('POSTs to QUESTIONNAIRE_SESSIONS.ROOT', async () => {
      // Arrange
      mockParseApiResponse.mockResolvedValue(successBody('s1'));

      // Act
      await createOrResumeAuthedSession({ invitationToken: 'my-token' });

      // Assert: the destination URL is the create/resume route, not a stale path.
      const [url] = mockServerFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(API.APP.QUESTIONNAIRE_SESSIONS.ROOT);
    });

    it('uses method POST', async () => {
      // Arrange
      mockParseApiResponse.mockResolvedValue(successBody('s1'));

      // Act
      await createOrResumeAuthedSession({ invitationToken: 'my-token' });

      // Assert
      const [, init] = mockServerFetch.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe('POST');
    });

    it('serialises an invitationToken request as the JSON body', async () => {
      // Arrange
      mockParseApiResponse.mockResolvedValue(successBody('s1'));
      const request = { invitationToken: 'inv-abc' };

      // Act
      await createOrResumeAuthedSession(request);

      // Assert: the exact request object appears in the body — nothing stripped or added.
      const [, init] = mockServerFetch.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual(request);
    });

    it('serialises a versionId request as the JSON body', async () => {
      // Arrange
      mockParseApiResponse.mockResolvedValue(successBody('s1'));
      const request = { versionId: 'ver-xyz' };

      // Act
      await createOrResumeAuthedSession(request);

      // Assert: the versionId path also produces the correct JSON body.
      const [, init] = mockServerFetch.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual(request);
    });
  });
});

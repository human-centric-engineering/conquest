/**
 * Unit Tests: GET /api/v1/users/me/export
 *
 * Covers the self-service subject-access route's contract:
 *   - API-key sessions are refused (an export is the whole account at once)
 *   - the per-flow export sub-cap is applied, keyed on the calling user
 *   - the bundle is returned under the standard envelope
 *   - the response is marked no-store and offered as a download
 *   - the export is attributed to the subject themselves
 *
 * @see app/api/v1/users/me/export/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockRequest } from '@/tests/helpers/api';
import { createMockLogger } from '@/tests/types/mocks';
import { createMockAuthSession } from '@/tests/helpers/auth';

type RouteHandler = (req: Request, session: unknown) => Promise<Response>;

// Auth guard — keep the error wrapper, skip the real session lookup.
vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));

const mockIsApiKeySession = vi.fn().mockReturnValue(false);
vi.mock('@/lib/auth/api-keys', () => ({
  isApiKeySession: (...args: unknown[]) => mockIsApiKeySession(...args),
}));

const mockExportUserData = vi.fn();
vi.mock('@/lib/privacy/export-user', () => ({
  exportUserData: (...args: unknown[]) => mockExportUserData(...args),
}));

const mockCheck = vi.fn().mockReturnValue({ success: true, remaining: 9, reset: 0 });
vi.mock('@/lib/security/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security/rate-limit')>(
    '@/lib/security/rate-limit'
  );
  return {
    ...actual,
    exportLimiter: { check: (...args: unknown[]) => mockCheck(...args) },
  };
});

const mockLog = createMockLogger();
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => mockLog),
}));

import * as exportRoute from '@/app/api/v1/users/me/export/route';

const GET = exportRoute.GET as unknown as RouteHandler;

const BUNDLE = {
  meta: { formatVersion: 1, subjectUserId: 'cmjbv4i3x00003wsloputgwul' },
  account: { id: 'cmjbv4i3x00003wsloputgwul' },
  personalData: { sessions: [] },
  attributions: {},
  erasureReceipts: [],
  app: {},
};

interface ErrorBody {
  success: false;
  error: { code: string; message: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsApiKeySession.mockReturnValue(false);
  mockCheck.mockReturnValue({ success: true, remaining: 9, reset: 0 });
  mockExportUserData.mockResolvedValue(BUNDLE);
});

function request() {
  return createMockRequest({ url: 'http://localhost:3000/api/v1/users/me/export' });
}

describe('GET /api/v1/users/me/export', () => {
  describe('API-key refusal', () => {
    it('returns 403 for an API-key session', async () => {
      mockIsApiKeySession.mockReturnValue(true);

      const response = await GET(request(), createMockAuthSession());
      const body = (await response.json()) as ErrorBody;

      expect(response.status).toBe(403);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('does not build the export for an API-key session', async () => {
      // The point of the refusal — a `chat`-scoped key must not read out the
      // owner's entire history, so the work must not happen at all.
      mockIsApiKeySession.mockReturnValue(true);

      await GET(request(), createMockAuthSession());

      expect(mockExportUserData).not.toHaveBeenCalled();
    });

    it('logs the refusal with the user id', async () => {
      mockIsApiKeySession.mockReturnValue(true);

      await GET(request(), createMockAuthSession());

      expect(mockLog.warn).toHaveBeenCalledWith(
        'Rejected API-key attempt to export account data',
        expect.objectContaining({ userId: 'cmjbv4i3x00003wsloputgwul' })
      );
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when the sub-cap is exhausted', async () => {
      mockCheck.mockReturnValue({ success: false, remaining: 0, reset: 0 });

      const response = await GET(request(), createMockAuthSession());

      expect(response.status).toBe(429);
      expect(mockExportUserData).not.toHaveBeenCalled();
    });

    it('keys the bucket on the calling user', async () => {
      await GET(request(), createMockAuthSession());

      expect(mockCheck).toHaveBeenCalledWith('export:user:cmjbv4i3x00003wsloputgwul');
    });
  });

  describe('the export', () => {
    it('returns the bundle under the standard envelope', async () => {
      const response = await GET(request(), createMockAuthSession());
      const body = (await response.json()) as { success: true; data: typeof BUNDLE };

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(BUNDLE);
    });

    it('attributes the export to the subject themselves', async () => {
      await GET(request(), createMockAuthSession());

      expect(mockExportUserData).toHaveBeenCalledWith({
        userId: 'cmjbv4i3x00003wsloputgwul',
        actorUserId: 'cmjbv4i3x00003wsloputgwul',
        reason: 'self_service',
      });
    });

    it('always exports the session user, never a caller-supplied id', async () => {
      const session = createMockAuthSession({
        user: { ...createMockAuthSession().user, id: 'other-user' },
      });

      await GET(request(), session);

      expect(mockExportUserData).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'other-user', actorUserId: 'other-user' })
      );
    });
  });

  describe('response headers', () => {
    it('forbids caching a copy of the whole account', async () => {
      const response = await GET(request(), createMockAuthSession());

      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('offers the bundle as a download', async () => {
      const response = await GET(request(), createMockAuthSession());

      expect(response.headers.get('Content-Disposition')).toBe(
        'attachment; filename="my-data-cmjbv4i3x00003wsloputgwul.json"'
      );
    });
  });

  describe('failure', () => {
    it('surfaces a service failure rather than an empty bundle', async () => {
      mockExportUserData.mockRejectedValue(new Error('sources offline'));

      const response = await GET(request(), createMockAuthSession());

      expect(response.status).toBe(500);
    });
  });
});

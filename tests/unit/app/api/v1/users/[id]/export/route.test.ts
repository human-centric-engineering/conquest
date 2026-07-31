/**
 * Unit Tests: GET /api/v1/users/:id/export
 *
 * Covers the admin subject-access route's contract:
 *   - the subject id is validated before any work happens
 *   - a missing subject is a 404, not a 500
 *   - the export is attributed to the acting admin, against the named subject
 *   - the per-flow sub-cap is keyed on the admin, not the subject
 *   - the response is marked no-store and offered as a download
 *
 * @see app/api/v1/users/[id]/export/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockRequest } from '@/tests/helpers/api';
import { createMockLogger } from '@/tests/types/mocks';
import { createMockAuthSession } from '@/tests/helpers/auth';

type RouteHandler = (
  req: Request,
  session: unknown,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;

vi.mock('@/lib/auth/guards', () => ({
  withAdminAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown, context: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session, context);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));

const mockExportUserData = vi.fn();
vi.mock('@/lib/privacy/export-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/privacy/export-user')>(
    '@/lib/privacy/export-user'
  );
  return {
    // The real error class — the route's `instanceof` check must be exercised
    // against the same constructor the service throws.
    SubjectNotFoundError: actual.SubjectNotFoundError,
    exportUserData: (...args: unknown[]) => mockExportUserData(...args),
  };
});

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

import * as exportRoute from '@/app/api/v1/users/[id]/export/route';
import { SubjectNotFoundError } from '@/lib/privacy/export-user';

const GET = exportRoute.GET as unknown as RouteHandler;

/** A valid CUID — `userIdSchema` rejects anything else. */
const SUBJECT_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wslopadmin1';

const BUNDLE = {
  meta: { formatVersion: 1, subjectUserId: SUBJECT_ID },
  account: { id: SUBJECT_ID },
  personalData: {},
  attributions: {},
  erasureReceipts: [],
  app: {},
};

interface ErrorBody {
  success: false;
  error: { code: string; message: string };
}

function adminSession() {
  const base = createMockAuthSession();
  return { ...base, user: { ...base.user, id: ADMIN_ID, role: 'ADMIN' as const } };
}

function request() {
  return createMockRequest({ url: `http://localhost:3000/api/v1/users/${SUBJECT_ID}/export` });
}

function context(id: string = SUBJECT_ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheck.mockReturnValue({ success: true, remaining: 9, reset: 0 });
  mockExportUserData.mockResolvedValue(BUNDLE);
});

describe('GET /api/v1/users/:id/export', () => {
  describe('subject id validation', () => {
    it('rejects a malformed id', async () => {
      const response = await GET(request(), adminSession(), context('not-a-cuid'));

      expect(response.status).toBe(400);
      expect(mockExportUserData).not.toHaveBeenCalled();
    });
  });

  describe('missing subject', () => {
    it('returns 404 rather than a 500', async () => {
      mockExportUserData.mockRejectedValue(new SubjectNotFoundError(SUBJECT_ID));

      const response = await GET(request(), adminSession(), context());
      const body = (await response.json()) as ErrorBody;

      expect(response.status).toBe(404);
      expect(body.error.message).toBe('User not found');
    });

    it('lets other service failures surface as 500', async () => {
      // A source being down is not "no such person" — collapsing the two would
      // tell an operator the subject does not exist when the export merely broke.
      mockExportUserData.mockRejectedValue(new Error('conversations offline'));

      const response = await GET(request(), adminSession(), context());

      expect(response.status).toBe(500);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when the sub-cap is exhausted', async () => {
      mockCheck.mockReturnValue({ success: false, remaining: 0, reset: 0 });

      const response = await GET(request(), adminSession(), context());

      expect(response.status).toBe(429);
      expect(mockExportUserData).not.toHaveBeenCalled();
    });

    it('keys the bucket on the acting admin, not the subject', async () => {
      // One operator working through a backlog must not be blocked by another,
      // and a subject must not be able to exhaust their own export budget.
      await GET(request(), adminSession(), context());

      expect(mockCheck).toHaveBeenCalledWith(`export:user:${ADMIN_ID}`);
    });
  });

  describe('the export', () => {
    it('returns the bundle under the standard envelope', async () => {
      const response = await GET(request(), adminSession(), context());
      const body = (await response.json()) as { success: true; data: typeof BUNDLE };

      expect(response.status).toBe(200);
      expect(body.data).toEqual(BUNDLE);
    });

    it('exports the named subject, attributed to the admin', async () => {
      await GET(request(), adminSession(), context());

      expect(mockExportUserData).toHaveBeenCalledWith({
        userId: SUBJECT_ID,
        actorUserId: ADMIN_ID,
        reason: 'admin_action',
      });
    });

    it('logs the subject being read', async () => {
      // Reading someone else's record is itself an event worth accounting for.
      await GET(request(), adminSession(), context());

      expect(mockLog.info).toHaveBeenCalledWith(
        'Generating admin subject data export',
        expect.objectContaining({ subjectUserId: SUBJECT_ID })
      );
    });
  });

  describe('response headers', () => {
    it('forbids caching', async () => {
      const response = await GET(request(), adminSession(), context());

      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('offers the bundle as a download named for the subject', async () => {
      const response = await GET(request(), adminSession(), context());

      expect(response.headers.get('Content-Disposition')).toBe(
        `attachment; filename="subject-data-${SUBJECT_ID}.json"`
      );
    });
  });
});

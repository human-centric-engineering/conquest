/**
 * Integration test: alpha session-ref browser route (GET …/questionnaire-sessions/refs).
 *
 * With the alpha switch + live-sessions on, the route is an admin-only paginated read. Covers the auth
 * boundary (401 unauth, 403 non-admin), the 200 list envelope + pagination meta, and that the parsed
 * query (page/limit/q/status) reaches the read model. The alpha-off 404 is covered by the gate's own
 * unit test (`alpha-gate.test.ts`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/app/release-stage', () => ({ IS_ALPHA: true }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listAdminSessionRefs: vi.fn(),
}));

import { GET } from '@/app/api/v1/app/questionnaire-sessions/refs/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { listAdminSessionRefs } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(qs = ''): NextRequest {
  return {
    url: `http://localhost/api/v1/app/questionnaire-sessions/refs${qs}`,
    headers: new Headers(),
  } as unknown as NextRequest;
}

const ITEM = {
  sessionId: 'sess-1',
  ref: '7F3K9M2P',
  refFormatted: '7F3K-9M2P',
  status: 'completed' as const,
  isPreview: false,
  createdAt: '2026-07-16T10:00:00.000Z',
  questionnaireId: 'q-1',
  questionnaireTitle: 'Onboarding',
  versionId: 'v-1',
  versionNumber: 3,
  turns: 4,
  answeredCount: 6,
  totalQuestions: 10,
  percentComplete: 60,
};

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  (listAdminSessionRefs as unknown as Mock).mockResolvedValue({ items: [ITEM], total: 1 });
});

describe('GET …/questionnaire-sessions/refs', () => {
  it('401s when unauthenticated', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockUnauthenticatedUser());
    expect((await GET(req(), {})).status).toBe(401);
  });

  it('403s an authenticated non-admin', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAuthenticatedUser('USER'));
    expect((await GET(req(), {})).status).toBe(403);
  });

  it('returns the paginated list envelope for an admin', async () => {
    const res = await GET(req(), {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual([ITEM]);
    expect(body.meta).toMatchObject({ page: 1, limit: 25, total: 1, totalPages: 1 });
  });

  it('threads parsed page/limit/q/status through to the read model', async () => {
    await GET(req('?page=2&limit=10&q=7F3K&status=active'), {});
    expect(listAdminSessionRefs).toHaveBeenCalledWith({
      page: 2,
      limit: 10,
      q: '7F3K',
      status: 'active',
    });
  });

  it('defaults pagination when no params are supplied', async () => {
    await GET(req(), {});
    expect(listAdminSessionRefs).toHaveBeenCalledWith({ page: 1, limit: 25 });
  });
});

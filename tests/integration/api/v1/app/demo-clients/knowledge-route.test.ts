/**
 * Integration test: demo-client knowledge base route.
 *
 * GET /api/v1/app/demo-clients/:id/knowledge — pins the gate order (flag → admin auth → 404 on
 * unknown id) and that the route returns the client-scoped view. The KB view builder is mocked (it's
 * unit-tested in client-knowledge.test.ts); `withAdminAuth` runs against a mocked session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: { appDemoClient: { findUnique: vi.fn() } },
}));

const kbMock = vi.hoisted(() => ({ getClientKnowledgeViewForClient: vi.fn() }));
vi.mock('@/lib/app/questionnaire/report/client-knowledge', () => kbMock);

import { GET } from '@/app/api/v1/app/demo-clients/[id]/knowledge/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;
const URL_ = 'http://localhost:3000/api/v1/app/demo-clients/clt-1/knowledge';

function req(): NextRequest {
  return { url: URL_, headers: new Headers() } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'clt-1' }) };
function setAuth(s: ReturnType<typeof mockAdminUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

const VIEW = { client: { id: 'clt-1', name: 'Acme' }, knowledgeTagId: 'tag-1', documents: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
  setAuth(mockAdminUser());
  (prisma.appDemoClient.findUnique as unknown as Mock).mockResolvedValue({ id: 'clt-1' });
  kbMock.getClientKnowledgeViewForClient.mockResolvedValue(VIEW);
});

describe('GET demo-clients/:id/knowledge', () => {
  it('404s when the questionnaires flag is off, before auth or load', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(kbMock.getClientKnowledgeViewForClient).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
  });

  it('403s a non-admin user', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(403);
  });

  it('404s when the demo client does not exist (no view built)', async () => {
    (prisma.appDemoClient.findUnique as unknown as Mock).mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(kbMock.getClientKnowledgeViewForClient).not.toHaveBeenCalled();
  });

  it('200s the client-scoped knowledge view', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual(VIEW);
    expect(kbMock.getClientKnowledgeViewForClient).toHaveBeenCalledWith('clt-1');
  });
});

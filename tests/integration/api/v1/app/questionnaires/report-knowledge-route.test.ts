/**
 * Integration test: Respondent Report client-knowledge route.
 *
 * Exercises `GET …/:id/report/knowledge` gate order (404 flag-off before auth), 401, the missing
 * questionnaire 404, and the success envelope. The client-knowledge resolution itself is unit-tested
 * separately (client-knowledge.test.ts); here it's mocked to focus on the route contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaire: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/lib/app/questionnaire/report/client-knowledge', () => ({
  getClientKnowledgeViewForQuestionnaire: vi.fn(),
}));

import { GET } from '@/app/api/v1/app/questionnaires/[id]/report/knowledge/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { getClientKnowledgeViewForQuestionnaire } from '@/lib/app/questionnaire/report/client-knowledge';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(): NextRequest {
  return {
    url: 'http://localhost:3000/api/v1/app/questionnaires/qn-1/report/knowledge',
    headers: new Headers(),
  } as unknown as NextRequest;
}

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

const PARAMS = { id: 'qn-1' };

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  prismaMock.appQuestionnaire.findUnique.mockResolvedValue({ id: 'qn-1' });
  (getClientKnowledgeViewForQuestionnaire as unknown as Mock).mockResolvedValue({
    client: { id: 'clt-1', name: 'Acme' },
    knowledgeTagId: 'tag-1',
    documents: [],
  });
});

describe('GET …/:id/report/knowledge', () => {
  it('404s when the questionnaires flag is off, before auth', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    const res = await GET(req(), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockUnauthenticatedUser());
    expect((await GET(req(), ctx(PARAMS))).status).toBe(401);
  });

  it('404s when the questionnaire does not exist', async () => {
    prismaMock.appQuestionnaire.findUnique.mockResolvedValue(null);
    const res = await GET(req(), ctx(PARAMS));
    expect(res.status).toBe(404);
    expect(getClientKnowledgeViewForQuestionnaire).not.toHaveBeenCalled();
  });

  it('returns the client knowledge view on success', async () => {
    (getClientKnowledgeViewForQuestionnaire as unknown as Mock).mockResolvedValue({
      client: { id: 'clt-1', name: 'Acme' },
      knowledgeTagId: 'tag-1',
      documents: [
        {
          id: 'doc-a',
          name: 'Playbook',
          fileName: 'playbook.md',
          status: 'ready',
          chunkCount: 12,
          sourceUrl: null,
          createdAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    });

    const res = await GET(req(), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.client).toEqual({ id: 'clt-1', name: 'Acme' });
    expect(body.data.knowledgeTagId).toBe('tag-1');
    expect(body.data.documents).toHaveLength(1);
    expect(getClientKnowledgeViewForQuestionnaire).toHaveBeenCalledWith('qn-1');
  });

  it('surfaces an unattributed questionnaire as client: null', async () => {
    (getClientKnowledgeViewForQuestionnaire as unknown as Mock).mockResolvedValue({
      client: null,
      knowledgeTagId: null,
      documents: [],
    });
    const res = await GET(req(), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.client).toBeNull();
  });
});

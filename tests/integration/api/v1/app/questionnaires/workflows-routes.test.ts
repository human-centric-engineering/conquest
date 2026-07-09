/**
 * Integration test: Behind-the-Scenes workflow read routes.
 *
 * Pins the route → flag-gate → auth → (optional lens) → enrichment wiring for the
 * two GET endpoints. The enrichment + applicability builders are DB-touching and
 * unit-tested separately, so here they're stubbed and the test exercises only the
 * route shell:
 *   - 404 when the master flag is off (before auth — the app looks absent)
 *   - 401 unauthenticated / 403 non-admin
 *   - list returns the real registry summaries; a ?versionId= lens annotates them
 *   - detail 200s with the enriched workflow, 404s on an unknown slug
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const enrichMock = vi.hoisted(() => ({ enrichWorkflow: vi.fn() }));
vi.mock('@/lib/app/questionnaire/workflows/enrich', () => enrichMock);

const applicabilityMock = vi.hoisted(() => ({
  buildApplicabilityContext: vi.fn(),
  evaluateApplicability: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/workflows/applicability', () => applicabilityMock);

import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { APP_QUESTIONNAIRES_FLAG } from '@/lib/app/questionnaire/constants';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

import { GET as getList } from '@/app/api/v1/app/questionnaires/workflows/route';
import { GET as getDetail } from '@/app/api/v1/app/questionnaires/workflows/[slug]/route';

type Mock = ReturnType<typeof vi.fn>;

const LIST_URL = 'http://localhost:3000/api/v1/app/questionnaires/workflows';
const DETAIL_URL = 'http://localhost:3000/api/v1/app/questionnaires/workflows/document-ingestion';

function listReq(search = ''): NextRequest {
  return new NextRequest(`${LIST_URL}${search}`);
}
// The flag wrapper types the list GET as (request, context) — pass an undefined
// context (there are no route params on the non-dynamic list route).
function runList(search = ''): Promise<Response> {
  return getList(listReq(search), undefined);
}
function detailReq(search = ''): NextRequest {
  return new NextRequest(`${DETAIL_URL}${search}`);
}
function detailCtx(slug: string): { params: Promise<{ slug: string }> } {
  return { params: Promise.resolve({ slug }) };
}
function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockImplementation((flag) =>
    Promise.resolve(flag === APP_QUESTIONNAIRES_FLAG)
  );
  setAuth(mockAdminUser());
  enrichMock.enrichWorkflow.mockResolvedValue({
    slug: 'document-ingestion',
    title: 'Document ingestion',
    description: 'desc',
    sourceModule: 'x.ts',
    definition: { steps: [], entryStepId: 'parse', errorStrategy: 'fail' },
    enrichment: {},
  });
});

describe('GET /workflows (list)', () => {
  it('404s when the master flag is off, before auth', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    setAuth(null);
    expect((await runList()).status).toBe(404);
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await runList()).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await runList()).status).toBe(403);
  });

  it('200s with the registry summaries and no applicability when no lens', async () => {
    const res = await runList();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.workflows.length).toBeGreaterThanOrEqual(9);
    expect(body.data.workflows[0].applicability).toBeUndefined();
    expect(applicabilityMock.buildApplicabilityContext).not.toHaveBeenCalled();
  });

  it('annotates each summary with applicability under a ?versionId= lens', async () => {
    applicabilityMock.buildApplicabilityContext.mockResolvedValue({ fake: 'ctx' });
    applicabilityMock.evaluateApplicability.mockReturnValue(
      new Proxy({}, { get: () => ({ status: 'applies', reason: 'ok' }) })
    );
    const res = await runList('?versionId=v1');
    const body = await res.json();
    expect(applicabilityMock.buildApplicabilityContext).toHaveBeenCalledWith('v1');
    expect(body.data.workflows[0].applicability).toEqual({ status: 'applies', reason: 'ok' });
  });

  it('ignores the lens when the version does not resolve', async () => {
    applicabilityMock.buildApplicabilityContext.mockResolvedValue(null);
    const res = await runList('?versionId=missing');
    const body = await res.json();
    expect(body.data.workflows[0].applicability).toBeUndefined();
  });
});

describe('GET /workflows/:slug (detail)', () => {
  it('404s when the master flag is off, before auth', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    setAuth(null);
    const res = await getDetail(detailReq(), detailCtx('document-ingestion'));
    expect(res.status).toBe(404);
    expect(enrichMock.enrichWorkflow).not.toHaveBeenCalled();
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await getDetail(detailReq(), detailCtx('document-ingestion'))).status).toBe(403);
  });

  it('200s with the enriched workflow', async () => {
    const res = await getDetail(detailReq(), detailCtx('document-ingestion'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.workflow.slug).toBe('document-ingestion');
    expect(enrichMock.enrichWorkflow).toHaveBeenCalledWith('document-ingestion', undefined);
  });

  it('404s with the error envelope on an unknown slug', async () => {
    enrichMock.enrichWorkflow.mockResolvedValue(null);
    const res = await getDetail(detailReq(), detailCtx('nope'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('NOT_FOUND');
  });

  it('passes the lens applicability into enrichment', async () => {
    applicabilityMock.buildApplicabilityContext.mockResolvedValue({ fake: 'ctx' });
    applicabilityMock.evaluateApplicability.mockReturnValue({
      'document-ingestion': { status: 'inactive', reason: 'composed' },
    });
    await getDetail(detailReq('?versionId=v1'), detailCtx('document-ingestion'));
    expect(enrichMock.enrichWorkflow).toHaveBeenCalledWith('document-ingestion', {
      status: 'inactive',
      reason: 'composed',
    });
  });
});

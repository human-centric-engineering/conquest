/**
 * Integration test: Respondent Report re-run — one revision's detail (GET …/report/revisions/:rev).
 *
 * The detail endpoint returns a single re-run revision's full content for the admin viewer dialog.
 * Covers the flag/auth gate, the success path, the 404 when the revision doesn't exist, and the
 * invalid-revision-number 400 (parsed before any load).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));
vi.mock('@/lib/app/questionnaire/report/revision', () => ({
  getRespondentReportRevisionDetail: vi.fn(),
}));

import { GET } from '@/app/api/v1/app/questionnaire-sessions/[id]/report/revisions/[rev]/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { getRespondentReportRevisionDetail } from '@/lib/app/questionnaire/report/revision';
import { mockAdminUser, mockAuthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(): NextRequest {
  return {
    url: 'http://localhost/api/v1/app/questionnaire-sessions/sess-1/report/revisions/2',
    headers: new Headers(),
  } as unknown as NextRequest;
}
const ctx = (rev: string) => ({ params: Promise.resolve({ id: 'sess-1', rev }) });

const DETAIL = {
  revisionNumber: 2,
  status: 'ready' as const,
  mode: 'narrative' as const,
  instructions: 'Warmer tone',
  content: { summary: 'hi' },
  formatted: true,
  completionPct: 100,
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  (getRespondentReportRevisionDetail as unknown as Mock).mockResolvedValue(DETAIL);
});

describe('GET …/report/revisions/:rev', () => {
  it('404s when the respondent-report flag is off (before auth)', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    const res = await GET(req(), ctx('2'));
    expect(res.status).toBe(404);
    expect(getRespondentReportRevisionDetail).not.toHaveBeenCalled();
  });

  it('403s a non-admin', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAuthenticatedUser('USER'));
    expect((await GET(req(), ctx('2'))).status).toBe(403);
  });

  it('returns the revision detail', async () => {
    const res = await GET(req(), ctx('2'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(DETAIL);
    expect(getRespondentReportRevisionDetail).toHaveBeenCalledWith('sess-1', 2);
  });

  it('404s when the revision does not exist', async () => {
    (getRespondentReportRevisionDetail as unknown as Mock).mockResolvedValue(null);
    const res = await GET(req(), ctx('9'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('400s an invalid revision number before loading', async () => {
    const res = await GET(req(), ctx('abc'));
    expect(res.status).toBe(400);
    expect(getRespondentReportRevisionDetail).not.toHaveBeenCalled();
  });

  it('400s a zero/negative revision number', async () => {
    const res = await GET(req(), ctx('0'));
    expect(res.status).toBe(400);
    expect(getRespondentReportRevisionDetail).not.toHaveBeenCalled();
  });

  it('400s a numeric-prefixed but non-numeric segment (does not coerce to 2)', async () => {
    const res = await GET(req(), ctx('2abc'));
    expect(res.status).toBe(400);
    expect(getRespondentReportRevisionDetail).not.toHaveBeenCalled();
  });
});

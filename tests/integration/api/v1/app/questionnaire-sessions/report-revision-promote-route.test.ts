/**
 * Integration test: Respondent Report re-run — promote route.
 *
 * The promote endpoint copies a `ready` revision onto the delivered report. Covers the flag/auth gate,
 * the success path, the 409 when the revision isn't ready (a no-op), and the invalid-revision 400.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));
vi.mock('@/lib/app/questionnaire/report/revision', () => ({
  promoteRespondentReportRevision: vi.fn(),
}));

import { POST } from '@/app/api/v1/app/questionnaire-sessions/[id]/report/revisions/[rev]/promote/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { promoteRespondentReportRevision } from '@/lib/app/questionnaire/report/revision';
import { mockAdminUser, mockAuthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(): NextRequest {
  return {
    url: 'http://localhost/api/v1/app/questionnaire-sessions/sess-1/report/revisions/2/promote',
    headers: new Headers(),
  } as unknown as NextRequest;
}
const ctx = (rev: string) => ({ params: Promise.resolve({ id: 'sess-1', rev }) });

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  (promoteRespondentReportRevision as unknown as Mock).mockResolvedValue({ promoted: true });
});

describe('POST …/report/revisions/:rev/promote', () => {
  it('403s a non-admin', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAuthenticatedUser('USER'));
    expect((await POST(req(), ctx('2'))).status).toBe(403);
  });

  it('promotes a ready revision', async () => {
    const res = await POST(req(), ctx('2'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ promoted: true });
    expect(promoteRespondentReportRevision).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      revisionNumber: 2,
    });
  });

  it('409s when the revision is not ready (no-op)', async () => {
    (promoteRespondentReportRevision as unknown as Mock).mockResolvedValue({ promoted: false });
    const res = await POST(req(), ctx('2'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('REPORT_REVISION_NOT_READY');
  });

  it('400s an invalid revision number', async () => {
    const res = await POST(req(), ctx('abc'));
    expect(res.status).toBe(400);
    expect(promoteRespondentReportRevision).not.toHaveBeenCalled();
  });

  it('400s a numeric-prefixed but non-numeric segment (does not coerce to 2)', async () => {
    const res = await POST(req(), ctx('2abc'));
    expect(res.status).toBe(400);
    expect(promoteRespondentReportRevision).not.toHaveBeenCalled();
  });
});

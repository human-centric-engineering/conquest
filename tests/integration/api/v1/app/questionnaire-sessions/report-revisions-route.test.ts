/**
 * Integration test: Respondent Report re-run route (admin history + enqueue).
 *
 * Exercises gate order (master flag → report flag → auth → rate-limit → validation → mode guard →
 * enqueue), the 202 enqueue envelope, the raw-mode rejection, the version-config fallback when no
 * `config` is sent, and the GET history read. The enqueue/view core is unit-tested separately + mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));
vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireSession: { findUnique: vi.fn() } },
}));
vi.mock('@/lib/app/questionnaire/report/revision', () => ({
  enqueueRespondentReportRevision: vi.fn(),
  getRespondentReportRevisionsView: vi.fn(),
}));

import { GET, POST } from '@/app/api/v1/app/questionnaire-sessions/[id]/report/revisions/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  enqueueRespondentReportRevision,
  getRespondentReportRevisionsView,
} from '@/lib/app/questionnaire/report/revision';
import { reportRerunLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(body: unknown): NextRequest {
  return {
    url: 'http://localhost/api/v1/app/questionnaire-sessions/sess-1/report/revisions',
    headers: new Headers(),
    json: async () => body,
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

/** The id `mockAdminUser()` mints — the rate-limit key + `adminId` the handler sees. */
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

beforeEach(() => {
  vi.clearAllMocks();
  reportRerunLimiter.reset(ADMIN_ID);
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  (prisma.appQuestionnaireSession.findUnique as unknown as Mock).mockResolvedValue({
    id: 'sess-1',
    version: { config: { respondentReport: { enabled: true, mode: 'narrative' } } },
  });
  (enqueueRespondentReportRevision as unknown as Mock).mockResolvedValue({
    revisionNumber: 1,
    revisionId: 'rev-1',
  });
  (getRespondentReportRevisionsView as unknown as Mock).mockResolvedValue({
    delivered: null,
    revisions: [],
  });
});

describe('POST …/report/revisions', () => {
  it('401s when unauthenticated', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockUnauthenticatedUser());
    expect((await POST(req({ config: { mode: 'narrative' } }), ctx)).status).toBe(401);
  });

  it('403s an authenticated non-admin', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAuthenticatedUser('USER'));
    expect((await POST(req({ config: { mode: 'narrative' } }), ctx)).status).toBe(403);
  });

  it('202s and enqueues a re-run with the supplied config', async () => {
    const res = await POST(
      req({ config: { enabled: true, mode: 'narrative' }, instructions: 'warmer' }),
      ctx
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, data: { revisionNumber: 1, status: 'queued' } });
    expect(enqueueRespondentReportRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        instructions: 'warmer',
        adminId: ADMIN_ID,
        settings: expect.objectContaining({ mode: 'narrative' }),
      })
    );
  });

  it('falls back to the version config when no config is sent', async () => {
    const res = await POST(req({}), ctx);
    expect(res.status).toBe(202);
    expect(enqueueRespondentReportRevision).toHaveBeenCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ mode: 'narrative' }) })
    );
  });

  it('400s a raw-mode config (nothing to generate)', async () => {
    const res = await POST(req({ config: { mode: 'raw' } }), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('REPORT_RERUN_MODE_UNSUPPORTED');
    expect(enqueueRespondentReportRevision).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist', async () => {
    (prisma.appQuestionnaireSession.findUnique as unknown as Mock).mockResolvedValue(null);
    const res = await POST(req({ config: { mode: 'narrative' } }), ctx);
    expect(res.status).toBe(404);
    expect(enqueueRespondentReportRevision).not.toHaveBeenCalled();
  });

  it('429s once the per-admin re-run cap is exhausted', async () => {
    for (let i = 0; i < 10; i++) {
      const ok = await POST(req({ config: { mode: 'narrative' } }), ctx);
      expect(ok.status).toBe(202);
    }
    const limited = await POST(req({ config: { mode: 'narrative' } }), ctx);
    expect(limited.status).toBe(429);
  });
});

describe('GET …/report/revisions', () => {
  it('returns the revisions view for an admin', async () => {
    (getRespondentReportRevisionsView as unknown as Mock).mockResolvedValue({
      delivered: {
        status: 'ready',
        hasContent: true,
        generatedAt: null,
        deliveredRevisionId: 'r2',
      },
      revisions: [{ id: 'r2', revisionNumber: 2, status: 'ready', delivered: true }],
    });
    const res = await GET(req(undefined), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.revisions).toHaveLength(1);
    expect(body.data.delivered.deliveredRevisionId).toBe('r2');
  });

  it('404s when the session does not exist', async () => {
    (prisma.appQuestionnaireSession.findUnique as unknown as Mock).mockResolvedValue(null);
    const res = await GET(req(undefined), ctx);
    expect(res.status).toBe(404);
  });
});

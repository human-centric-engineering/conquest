/**
 * Integration test: respondent report status endpoint.
 *
 * Exercises `GET …/questionnaire-sessions/:id/report` gate order (live-sessions flag → load →
 * access → view). The view assembly + access resolution are unit-tested separately and mocked here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireSession: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/turn-access', () => ({
  resolveTurnAccess: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/report/view', () => ({
  buildRespondentReportClientView: vi.fn(),
}));

import { GET } from '@/app/api/v1/app/questionnaire-sessions/[id]/report/route';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';
import { buildRespondentReportClientView } from '@/lib/app/questionnaire/report/view';

type Mock = ReturnType<typeof vi.fn>;

function req(): NextRequest {
  return {
    url: 'http://localhost/api/v1/app/questionnaire-sessions/s1/report',
    headers: new Headers(),
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 's1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue({
    id: 's1',
    respondentUserId: null,
  });
  (resolveTurnAccess as unknown as Mock).mockResolvedValue({
    ok: true,
    userId: 'anon:s1',
    rateKey: 'k',
    anonymous: true,
  });
  (buildRespondentReportClientView as unknown as Mock).mockResolvedValue({
    enabled: true,
    mode: 'raw_plus_insights',
    onScreen: true,
    download: true,
    insights: { status: 'queued', content: null, generatedAt: null, error: null },
  });
});

describe('GET …/:id/report', () => {
  it('404s when the session does not exist', async () => {
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(resolveTurnAccess).not.toHaveBeenCalled();
  });

  it('surfaces an access failure status', async () => {
    (resolveTurnAccess as unknown as Mock).mockResolvedValue({
      ok: false,
      status: 401,
      code: 'SESSION_TOKEN_REQUIRED',
      message: 'A session token is required',
    });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(buildRespondentReportClientView).not.toHaveBeenCalled();
  });

  it('returns the report view on success', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.mode).toBe('raw_plus_insights');
    expect(body.data.insights.status).toBe('queued');
  });
});

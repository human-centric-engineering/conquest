/**
 * Integration tests: respondent report retry + notify endpoints.
 *
 * POST …/:id/report/retry   — re-queue + kick a stuck report ("Check again")
 * POST …/:id/report/notify  — opt in to a report-ready email
 *
 * Both share the report GET route's gate order (live-sessions flag → load → access → action). The
 * retry lib, worker, and access resolution are unit-tested separately and mocked here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireSession: { findUnique: vi.fn() },
  appRespondentReport: { updateMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/turn-access', () => ({
  resolveTurnAccess: vi.fn(),
}));

// after() has no request scope in unit tests — capture the callback, don't auto-run it.
const afterMock = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: afterMock.after };
});

const retryMock = vi.hoisted(() => ({ requestRespondentReportRetry: vi.fn() }));
vi.mock('@/lib/app/questionnaire/report/retry', () => retryMock);

const workerMock = vi.hoisted(() => ({ processQueuedRespondentReports: vi.fn() }));
vi.mock('@/lib/app/questionnaire/report/worker', () => workerMock);

import { POST as RETRY } from '@/app/api/v1/app/questionnaire-sessions/[id]/report/retry/route';
import { POST as NOTIFY } from '@/app/api/v1/app/questionnaire-sessions/[id]/report/notify/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { resolveTurnAccess } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-access';

type Mock = ReturnType<typeof vi.fn>;

function req(body?: unknown): NextRequest {
  return {
    url: 'http://localhost/api/v1/app/questionnaire-sessions/s1/report/x',
    headers: new Headers(),
    text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 's1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue({
    id: 's1',
    respondentUserId: null,
  });
  prismaMock.appRespondentReport.updateMany.mockResolvedValue({ count: 1 });
  (resolveTurnAccess as unknown as Mock).mockResolvedValue({ ok: true, anonymous: true });
  retryMock.requestRespondentReportRetry.mockResolvedValue({ requeued: true });
  workerMock.processQueuedRespondentReports.mockResolvedValue({
    claimed: 0,
    succeeded: 0,
    failed: 0,
  });
});

describe('POST …/:id/report/retry', () => {
  it('404s when the live-sessions flag is off, before loading', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    const res = await RETRY(req(), ctx);
    expect(res.status).toBe(404);
    expect(prismaMock.appQuestionnaireSession.findUnique).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist', async () => {
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue(null);
    const res = await RETRY(req(), ctx);
    expect(res.status).toBe(404);
    expect(resolveTurnAccess).not.toHaveBeenCalled();
    expect(retryMock.requestRespondentReportRetry).not.toHaveBeenCalled();
  });

  it('surfaces an access failure status + error envelope', async () => {
    (resolveTurnAccess as unknown as Mock).mockResolvedValue({
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
      message: 'no',
    });
    const res = await RETRY(req(), ctx);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(retryMock.requestRespondentReportRetry).not.toHaveBeenCalled();
  });

  it('re-queues and schedules a worker kick on success', async () => {
    const res = await RETRY(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data.requeued).toBe(true);
    expect(retryMock.requestRespondentReportRetry).toHaveBeenCalledWith('s1');
    // The kick is scheduled via after(); running the captured callback drains the queue.
    expect(afterMock.after).toHaveBeenCalledTimes(1);
    await (afterMock.after.mock.calls[0][0] as () => Promise<void>)();
    expect(workerMock.processQueuedRespondentReports).toHaveBeenCalledTimes(1);
  });
});

describe('POST …/:id/report/notify', () => {
  it('400s on a missing/invalid email', async () => {
    const res = await NOTIFY(req({ email: 'not-an-email' }), ctx);
    expect(res.status).toBe(400);
    expect(prismaMock.appRespondentReport.updateMany).not.toHaveBeenCalled();
  });

  it('400s on a malformed (non-JSON) body', async () => {
    // Raw invalid JSON → the JSON.parse catch branch (distinct from the Zod-validation 400 above).
    const badReq = {
      url: 'http://localhost/api/v1/app/questionnaire-sessions/s1/report/notify',
      headers: new Headers(),
      text: () => Promise.resolve('{ not valid json'),
    } as unknown as NextRequest;
    const res = await NOTIFY(badReq, ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
    expect(prismaMock.appRespondentReport.updateMany).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist', async () => {
    prismaMock.appQuestionnaireSession.findUnique.mockResolvedValue(null);
    const res = await NOTIFY(req({ email: 'you@example.com' }), ctx);
    expect(res.status).toBe(404);
    expect(prismaMock.appRespondentReport.updateMany).not.toHaveBeenCalled();
  });

  it('surfaces an access failure status + error envelope', async () => {
    (resolveTurnAccess as unknown as Mock).mockResolvedValue({
      ok: false,
      status: 401,
      code: 'SESSION_TOKEN_REQUIRED',
      message: 'no',
    });
    const res = await NOTIFY(req({ email: 'you@example.com' }), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SESSION_TOKEN_REQUIRED');
    expect(prismaMock.appRespondentReport.updateMany).not.toHaveBeenCalled();
  });

  it('stores the email on an in-flight report and reports notifying: true', async () => {
    const res = await NOTIFY(req({ email: 'you@example.com' }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data.notifying).toBe(true);
    const call = prismaMock.appRespondentReport.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ sessionId: 's1', status: { in: ['queued', 'processing'] } });
    expect(call.data).toMatchObject({ notifyEmail: 'you@example.com' });
  });

  it('reports notifying: false when there is no in-flight report to attach to', async () => {
    prismaMock.appRespondentReport.updateMany.mockResolvedValue({ count: 0 });
    const res = await NOTIFY(req({ email: 'you@example.com' }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data.notifying).toBe(false);
  });
});

/**
 * Integration test: Respondent Report config-assistant route.
 *
 * Exercises gate order (flag → auth → rate-limit → validation → craft), the success envelope, and the
 * 502 on a craft failure. The craft turn itself is unit-tested separately and mocked here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));
vi.mock('@/lib/app/questionnaire/report/craft', () => ({ craftReportConfig: vi.fn() }));

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/report/craft/route';
import { auth } from '@/lib/auth/config';
import { craftReportConfig } from '@/lib/app/questionnaire/report/craft';
import { reportConfigAssistLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(body: unknown): NextRequest {
  return {
    url: 'http://localhost/api/v1/app/questionnaires/qn-1/versions/v1/report/craft',
    headers: new Headers(),
    json: async () => body,
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'qn-1', vid: 'v1' }) };

const validBody = {
  messages: [{ role: 'user', content: 'Help me craft this' }],
  current: { instructions: '', structure: '', backgroundContext: '' },
};

beforeEach(() => {
  vi.clearAllMocks();
  reportConfigAssistLimiter.reset?.('admin-user-id');
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  (craftReportConfig as unknown as Mock).mockResolvedValue({
    reply: 'Here you go.',
    suggestions: { instructions: 'Be warm.' },
    costUsd: 0.001,
  });
});

describe('POST …/report/craft', () => {
  it('401s when unauthenticated', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockUnauthenticatedUser());
    expect((await POST(req(validBody), ctx)).status).toBe(401);
  });

  it('400s an invalid body (empty messages)', async () => {
    const res = await POST(req({ messages: [], current: validBody.current }), ctx);
    expect(res.status).toBe(400);
    expect(craftReportConfig).not.toHaveBeenCalled();
  });

  it('returns the assistant reply + suggestions on success', async () => {
    const res = await POST(req(validBody), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.reply).toBe('Here you go.');
    expect(body.data.suggestions).toEqual({ instructions: 'Be warm.' });
    // The cost is internal — not leaked to the client.
    expect(body.data.costUsd).toBeUndefined();
  });

  it('502s when the craft turn throws', async () => {
    (craftReportConfig as unknown as Mock).mockRejectedValue(new Error('no provider'));
    const res = await POST(req(validBody), ctx);
    expect(res.status).toBe(502);
  });

  it('502s and stringifies a non-Error rejection', async () => {
    (craftReportConfig as unknown as Mock).mockRejectedValue('plain string failure');
    const res = await POST(req(validBody), ctx);
    expect(res.status).toBe(502);
  });

  it('429s when the per-admin assist rate limit is exceeded', async () => {
    const spy = vi
      .spyOn(reportConfigAssistLimiter, 'check')
      .mockReturnValue({ success: false, limit: 60, remaining: 0, reset: Date.now() + 1000 });
    const res = await POST(req(validBody), ctx);
    expect(res.status).toBe(429);
    expect(craftReportConfig).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

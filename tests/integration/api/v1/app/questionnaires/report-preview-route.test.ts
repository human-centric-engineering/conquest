/**
 * Integration test: Respondent Report preview route.
 *
 * Exercises gate order (flag → auth → rate-limit → validation → mode guard → load → generate), the
 * success envelope, the non-AI-mode rejection, the not-found version, and the 502 on generation
 * failure. The synthesiser + generator core are unit-tested separately and mocked here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));
vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireVersion: { findFirst: vi.fn() } },
}));
vi.mock('@/lib/app/questionnaire/report/preview-sample', () => ({
  synthesiseSampleReportInputs: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/report/generate', () => ({ generateReportFromInputs: vi.fn() }));

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/report/preview/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { synthesiseSampleReportInputs } from '@/lib/app/questionnaire/report/preview-sample';
import { generateReportFromInputs } from '@/lib/app/questionnaire/report/generate';
import { reportPreviewLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(body: unknown): NextRequest {
  return {
    url: 'http://localhost/api/v1/app/questionnaires/qn-1/versions/v1/report/preview',
    headers: new Headers(),
    json: async () => body,
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'qn-1', vid: 'v1' }) };

const validBody = { config: { enabled: true, mode: 'narrative' } };

const versionRow = {
  goal: 'Understand engagement',
  audience: { description: 'Employees' },
  questionnaire: { title: 'Pulse' },
  sections: [
    { id: 's1', title: 'Wellbeing', questions: [{ key: 'q1', prompt: 'Mood?', required: true }] },
  ],
  dataSlots: [{ key: 'ds1', name: 'Driver', description: null, theme: 'Motivation' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  reportPreviewLimiter.reset?.('admin-user-id');
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  (prisma.appQuestionnaireVersion.findFirst as unknown as Mock).mockResolvedValue(versionRow);
  (synthesiseSampleReportInputs as unknown as Mock).mockResolvedValue({
    transcript: 'Q: Mood?\nA: Positive',
    dataSlotContext: '## Motivation\nDriver: Career growth',
    costUsd: 0.02,
  });
  (generateReportFromInputs as unknown as Mock).mockResolvedValue({
    content: { summary: 'You are engaged.', sections: [], actions: [] },
    formatted: false,
    completionPct: 100,
    costUsd: 0.05,
  });
});

describe('POST …/report/preview', () => {
  it('401s when unauthenticated', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockUnauthenticatedUser());
    expect((await POST(req(validBody), ctx)).status).toBe(401);
  });

  it('403s an authenticated non-admin (USER) — the admin boundary is enforced', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await POST(req(validBody), ctx);
    expect(res.status).toBe(403);
    expect(synthesiseSampleReportInputs).not.toHaveBeenCalled();
  });

  it('400s an invalid body (config not an object)', async () => {
    const res = await POST(req({ config: 'nope' }), ctx);
    expect(res.status).toBe(400);
    expect(synthesiseSampleReportInputs).not.toHaveBeenCalled();
  });

  it('400s a non-AI (raw) mode, before loading the version', async () => {
    const res = await POST(req({ config: { enabled: true, mode: 'raw' } }), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('REPORT_PREVIEW_MODE_UNSUPPORTED');
    expect(prisma.appQuestionnaireVersion.findFirst).not.toHaveBeenCalled();
  });

  it('404s when the version is not found', async () => {
    (prisma.appQuestionnaireVersion.findFirst as unknown as Mock).mockResolvedValue(null);
    expect((await POST(req(validBody), ctx)).status).toBe(404);
    expect(synthesiseSampleReportInputs).not.toHaveBeenCalled();
  });

  it('400s a version with no questions and no data slots, before any LLM call', async () => {
    (prisma.appQuestionnaireVersion.findFirst as unknown as Mock).mockResolvedValue({
      ...versionRow,
      sections: [{ id: 's1', title: 'Empty', questions: [] }],
      dataSlots: [],
    });
    const res = await POST(req(validBody), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('REPORT_PREVIEW_EMPTY_VERSION');
    expect(synthesiseSampleReportInputs).not.toHaveBeenCalled();
  });

  it('returns the generated preview content on success, without leaking cost', async () => {
    const res = await POST(req(validBody), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.questionnaireTitle).toBe('Pulse');
    expect(body.data.mode).toBe('narrative');
    expect(body.data.content.summary).toBe('You are engaged.');
    expect(body.data.completionPct).toBe(100);
    // Internal cost is never returned to the client.
    expect(body.data.costUsd).toBeUndefined();
  });

  it('forces research + client-knowledge OFF on the config it generates from', async () => {
    await POST(
      req({
        config: {
          enabled: true,
          mode: 'narrative',
          generation: { useClientKnowledge: true },
          research: { enabled: true },
        },
      }),
      ctx
    );
    const call = (generateReportFromInputs as unknown as Mock).mock.calls[0][0];
    expect(call.settings.research.enabled).toBe(false);
    expect(call.settings.generation.useClientKnowledge).toBe(false);
    expect(call.demoClientId).toBeNull();
  });

  it('502s when generation throws', async () => {
    (generateReportFromInputs as unknown as Mock).mockRejectedValue(new Error('no provider'));
    expect((await POST(req(validBody), ctx)).status).toBe(502);
  });

  it('429s when the per-admin preview rate limit is exceeded', async () => {
    const spy = vi
      .spyOn(reportPreviewLimiter, 'check')
      .mockReturnValue({ success: false, limit: 20, remaining: 0, reset: Date.now() + 1000 });
    const res = await POST(req(validBody), ctx);
    expect(res.status).toBe(429);
    expect(synthesiseSampleReportInputs).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

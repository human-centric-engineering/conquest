/**
 * Integration test: Respondent Report streamed-preview route.
 *
 * The streamed sibling of `report-preview-route.test.ts`. Two things are specific to this transport
 * and worth pinning: the pre-stream guards must still refuse with an ordinary JSON status code
 * (once the response switches to `text/event-stream` there is no status left to fail with), and a
 * generation failure after that switch must arrive as a terminal `error` frame rather than
 * disappearing — a stream that just ends is exactly the silent hang this route exists to remove.
 *
 * The synthesiser + generator core are unit-tested separately and mocked here.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
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

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/report/preview/stream/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { parseSseBlock } from '@/lib/api/sse-parser';
import { synthesiseSampleReportInputs } from '@/lib/app/questionnaire/report/preview-sample';
import { generateReportFromInputs } from '@/lib/app/questionnaire/report/generate';
import { reportPreviewLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

function req(body: unknown): NextRequest {
  return {
    url: 'http://localhost/api/v1/app/questionnaires/qn-1/versions/v1/report/preview/stream',
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
    {
      id: 's1',
      title: 'Wellbeing',
      questions: [
        { key: 'q1', prompt: 'Mood?', required: true },
        { key: 'q2', prompt: 'Workload?', required: false },
      ],
    },
  ],
  dataSlots: [{ key: 'ds1', name: 'Driver', description: null, theme: 'Motivation' }],
};

/** Read the whole SSE body and parse every frame (keepalive comments are skipped by the parser). */
async function readEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((block) => parseSseBlock(block))
    .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null)
    .map((parsed) => parsed.data);
}

beforeEach(() => {
  vi.clearAllMocks();
  reportPreviewLimiter.reset?.(mockAdminUser().user.id);
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  (prisma.appQuestionnaireVersion.findFirst as unknown as Mock).mockResolvedValue(versionRow);
  (synthesiseSampleReportInputs as unknown as Mock).mockResolvedValue({
    transcript: 'Q: Mood?\nA: Positive',
    dataSlotContext: '## Motivation\nDriver: Career growth',
    coverage: { answered: 2, total: 2, unansweredBlock: '' },
    costUsd: 0.02,
  });
  (generateReportFromInputs as unknown as Mock).mockResolvedValue({
    content: { summary: 'You are engaged.', sections: [], actions: [] },
    formatted: false,
    completionPct: 100,
    costUsd: 0.05,
  });
});

describe('POST …/report/preview/stream — pre-stream guards', () => {
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

  it('400s a non-AI (raw) mode as JSON, before the response becomes a stream', async () => {
    const res = await POST(req({ config: { enabled: true, mode: 'raw' } }), ctx);
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).not.toContain('text/event-stream');
    expect((await res.json()).error.code).toBe('REPORT_PREVIEW_MODE_UNSUPPORTED');
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

  it('429s when the per-admin preview rate limit is exceeded', async () => {
    const spy = vi.spyOn(reportPreviewLimiter, 'check').mockReturnValue({
      success: false,
      limit: 20,
      remaining: 0,
      reset: Date.now() + 60_000,
    });
    const res = await POST(req(validBody), ctx);
    expect(res.status).toBe(429);
    expect(synthesiseSampleReportInputs).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('POST …/report/preview/stream — the stream itself', () => {
  it('streams an opening phase and closes with the rendered report', async () => {
    const res = await POST(req(validBody), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    const events = await readEvents(res);
    expect(events[0]).toEqual({ type: 'started', questionCount: 2, dataSlotCount: 1 });
    expect(events[events.length - 1]).toMatchObject({
      type: 'done',
      questionnaireTitle: 'Pulse',
      mode: 'narrative',
      completionPct: 100,
    });
  });

  it('never puts the internal USD cost on the wire', async () => {
    const events = await readEvents(await POST(req(validBody), ctx));
    for (const event of events) expect(event).not.toHaveProperty('costUsd');
  });

  it('forces research + client-knowledge OFF on the config it generates from', async () => {
    await readEvents(
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
      )
    );
    const call = (generateReportFromInputs as unknown as Mock).mock.calls[0][0];
    expect(call.settings.research.enabled).toBe(false);
    expect(call.settings.generation.useClientKnowledge).toBe(false);
    expect(call.demoClientId).toBeNull();
    expect(call.preview).toBe(true);
  });

  it('forwards each phase the core emits while the run is still in flight', async () => {
    (synthesiseSampleReportInputs as unknown as Mock).mockImplementation(
      async (_structure: unknown, opts: { onProgress?: (e: unknown) => void }) => {
        opts.onProgress?.({ type: 'persona' });
        opts.onProgress?.({ type: 'sampling', batchesDone: 0, batchesTotal: 2 });
        await new Promise((r) => setTimeout(r, 0));
        opts.onProgress?.({ type: 'sampling', batchesDone: 2, batchesTotal: 2 });
        return {
          transcript: 'Q: Mood?\nA: Positive',
          dataSlotContext: '',
          coverage: { answered: 2, total: 2, unansweredBlock: '' },
          costUsd: 0.02,
        };
      }
    );
    (generateReportFromInputs as unknown as Mock).mockImplementation(
      async (inputs: { onProgress?: (e: unknown) => void }) => {
        inputs.onProgress?.({ type: 'writing' });
        return {
          content: { summary: 'You are engaged.', sections: [], actions: [] },
          formatted: false,
          completionPct: 100,
          costUsd: 0.05,
        };
      }
    );

    const events = await readEvents(await POST(req(validBody), ctx));
    expect(events.map((e) => e.type)).toEqual([
      'started',
      'persona',
      'sampling',
      'sampling',
      'writing',
      'done',
    ]);
  });

  it('sends a terminal error frame when generation throws, rather than just ending', async () => {
    (generateReportFromInputs as unknown as Mock).mockRejectedValue(new Error('no provider'));

    const res = await POST(req(validBody), ctx);
    // Status is already 200 — the response became a stream before the failure happened.
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    const terminal = events[events.length - 1];
    expect(terminal.type).toBe('error');
    expect(terminal.code).toBe('REPORT_PREVIEW_FAILED');
    // The raw provider error never reaches the admin.
    expect(JSON.stringify(terminal)).not.toContain('no provider');
  });

  it('marks a timed-out sample synthesis as retry-worthy on the error frame', async () => {
    (synthesiseSampleReportInputs as unknown as Mock).mockRejectedValue(
      Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })
    );

    const events = await readEvents(await POST(req(validBody), ctx));
    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      code: 'REPORT_PREVIEW_TIMEOUT',
    });
    expect(generateReportFromInputs).not.toHaveBeenCalled();
  });
});

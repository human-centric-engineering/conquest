/**
 * Unit tests for the Structure Edit Agent API routes.
 *
 * Files under test:
 *   - app/api/v1/app/questionnaires/[id]/versions/[vid]/edit-agent/plan/route.ts  (POST)
 *   - app/api/v1/app/questionnaires/[id]/versions/[vid]/edit-agent/apply/route.ts (POST)
 *
 * Collaborators are mocked at the module boundary, but the REAL `resolveOps` runs so the precise
 * path is exercised end-to-end (instruction → ops → concrete changes). Tests assert what the routes
 * DO — status codes, envelope shapes, and which collaborators are called with what (anti-green-bar).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock('@/lib/app/questionnaire/feature-flag', () => ({
  withEditAgentEnabled: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/guards', () => ({ withAdminAuth: (handler: unknown) => handler }));
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));
vi.mock('@/lib/security/rate-limit', () => ({
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  composeLimiter: { check: vi.fn(() => ({ success: true })) },
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/edit-agent-pipeline', () => ({
  loadEditableStructure: vi.fn(),
  applyResolvedChanges: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/edit-agent/translate', () => ({ planEditOps: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/compose-pipeline', () => ({
  loadComposerAgent: vi.fn(),
  loadRefinableStructure: vi.fn(),
}));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@/lib/orchestration/capabilities', () => ({ registerBuiltInCapabilities: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/persist', () => ({
  assertPersistable: vi.fn(),
  IncoherentExtractionError: class IncoherentExtractionError extends Error {
    orphanSectionOrdinals: number[];
    constructor(ordinals: number[]) {
      super('Incoherent structure');
      this.name = 'IncoherentExtractionError';
      this.orphanSectionOrdinals = ordinals;
    }
  },
  replaceVersionStructure: vi.fn(async () => ({
    sectionCount: 2,
    questionCount: 3,
    changeCount: 0,
  })),
}));

// ─── Deferred imports ─────────────────────────────────────────────────────────

type AnyRouteHandler = (...args: unknown[]) => Promise<Response>;

const { POST: planPost } =
  (await import('@/app/api/v1/app/questionnaires/[id]/versions/[vid]/edit-agent/plan/route')) as {
    POST: AnyRouteHandler;
  };
const { POST: applyPost } =
  (await import('@/app/api/v1/app/questionnaires/[id]/versions/[vid]/edit-agent/apply/route')) as {
    POST: AnyRouteHandler;
  };

import { composeLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  loadEditableStructure,
  applyResolvedChanges,
} from '@/app/api/v1/app/questionnaires/_lib/edit-agent-pipeline';
import { planEditOps } from '@/lib/app/questionnaire/edit-agent/translate';
import {
  loadComposerAgent,
  loadRefinableStructure,
} from '@/app/api/v1/app/questionnaires/_lib/compose-pipeline';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { replaceVersionStructure } from '@/app/api/v1/app/questionnaires/_lib/persist';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import type { EditableStructure } from '@/lib/app/questionnaire/edit-agent/types';

const ADMIN_SESSION = { user: { id: 'admin-1' } };

function structure(): EditableStructure {
  return {
    versionId: 'v1',
    sections: [
      {
        id: 'sec-a',
        ordinal: 0,
        title: 'Background',
        description: null,
        questions: [
          {
            id: 'q1',
            key: 'name',
            ordinal: 0,
            prompt: 'Name?',
            type: 'free_text',
            required: true,
            weight: 0.5,
          },
          {
            id: 'q2',
            key: 'age',
            ordinal: 1,
            prompt: 'Age?',
            type: 'numeric',
            required: true,
            weight: 0.8,
          },
        ],
      },
    ],
  };
}

function call(handler: AnyRouteHandler, body: unknown): Promise<Response> {
  const req = new NextRequest(
    'http://localhost/api/v1/app/questionnaires/qn-1/versions/v1/edit-agent',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }
  );
  return handler(req, ADMIN_SESSION, { params: Promise.resolve({ id: 'qn-1', vid: 'v1' }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  (composeLimiter.check as Mock).mockReturnValue({ success: true });
  (loadEditableStructure as Mock).mockResolvedValue({ ok: true, value: structure() });
});

describe('POST edit-agent/plan — precise', () => {
  it('returns 429 when the rate limiter rejects', async () => {
    (composeLimiter.check as Mock).mockReturnValue({ success: false, reset: 1 });
    const res = await call(planPost, { instruction: 'x', mode: 'precise' });
    expect(res.status).toBe(429);
  });

  it('returns 400 on an empty instruction', async () => {
    const res = await call(planPost, { instruction: '', mode: 'precise' });
    expect(res.status).toBe(400);
  });

  it('passes through the loader guard (e.g. 409 non-draft)', async () => {
    (loadEditableStructure as Mock).mockResolvedValue({
      ok: false,
      response: new Response('conflict', { status: 409 }),
    });
    const res = await call(planPost, { instruction: 'do it', mode: 'precise' });
    expect(res.status).toBe(409);
    expect(planEditOps).not.toHaveBeenCalled();
  });

  it('maps a provider failure to 503', async () => {
    (planEditOps as Mock).mockResolvedValue({
      ok: false,
      code: 'provider_unavailable',
      message: 'down',
    });
    const res = await call(planPost, { instruction: 'do it', mode: 'precise' });
    expect(res.status).toBe(503);
  });

  it('resolves ops into a concrete change list (real resolveOps)', async () => {
    (planEditOps as Mock).mockResolvedValue({
      ok: true,
      value: {
        summary: 'Make free-text optional',
        operations: [
          {
            op: 'set_required',
            target: { scope: 'type', questionType: 'free_text' },
            value: false,
          },
        ],
      },
    });
    const res = await call(planPost, {
      instruction: 'remove required from free text',
      mode: 'precise',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.mode).toBe('precise');
    expect(body.data.summary).toBe('Make free-text optional');
    expect(body.data.changes).toHaveLength(1);
    expect(body.data.changes[0]).toMatchObject({
      entityId: 'q1',
      field: 'question.required',
      value: false,
    });
  });

  it('returns 422 when the planned ops are structurally impossible', async () => {
    (planEditOps as Mock).mockResolvedValue({
      ok: true,
      value: {
        summary: 'bad',
        operations: [{ op: 'move_question', key: 'does-not-exist', toSectionOrdinal: 0 }],
      },
    });
    const res = await call(planPost, { instruction: 'move it', mode: 'precise' });
    expect(res.status).toBe(422);
  });
});

describe('POST edit-agent/plan — rewrite', () => {
  beforeEach(() => {
    (loadRefinableStructure as Mock).mockResolvedValue({
      ok: true,
      value: { sections: [], questions: [] },
    });
    (loadComposerAgent as Mock).mockResolvedValue({
      ok: true,
      value: { id: 'agent-1', provider: 'openai', model: '', fallbackProviders: [] },
    });
  });

  it('returns the proposed structure + outline without persisting', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: {
        summary: 'Rewrote it',
        structure: {
          sections: [{ ordinal: 0, title: 'New' }],
          questions: [
            {
              sectionOrdinal: 0,
              key: 'k',
              prompt: 'P?',
              suggestedType: 'free_text',
              extractionConfidence: 1,
            },
          ],
          changes: [],
        },
      },
    });
    const res = await call(planPost, { instruction: 'rewrite the whole thing', mode: 'rewrite' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.mode).toBe('rewrite');
    expect(body.data.outline).toEqual([{ title: 'New', questionCount: 1 }]);
    expect(replaceVersionStructure).not.toHaveBeenCalled();
  });

  it('maps a dispatch failure to its status', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'rate_limited', message: 'slow down' },
    });
    const res = await call(planPost, { instruction: 'rewrite', mode: 'rewrite' });
    expect(res.status).toBe(429);
  });
});

describe('POST edit-agent/apply — precise', () => {
  it('applies the resolved changes and returns counts', async () => {
    (applyResolvedChanges as Mock).mockResolvedValue({
      changeCount: 1,
      sectionCount: 0,
      questionCount: 1,
    });
    const res = await call(applyPost, {
      mode: 'precise',
      operations: [
        { op: 'set_required', target: { scope: 'type', questionType: 'free_text' }, value: false },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ mode: 'precise', changeCount: 1, questionCount: 1 });

    // The change list handed to apply is the REAL resolved one (q1 only).
    const changes = (applyResolvedChanges as Mock).mock.calls[0][0];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ entityId: 'q1', field: 'question.required' });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire.edit_agent', entityName: 'precise' })
    );
  });

  it('passes through the loader guard', async () => {
    (loadEditableStructure as Mock).mockResolvedValue({
      ok: false,
      response: new Response('conflict', { status: 409 }),
    });
    const res = await call(applyPost, {
      mode: 'precise',
      operations: [{ op: 'set_required', target: { scope: 'all' }, value: false }],
    });
    expect(res.status).toBe(409);
    expect(applyResolvedChanges).not.toHaveBeenCalled();
  });

  it('returns 422 on a structurally-impossible op', async () => {
    const res = await call(applyPost, {
      mode: 'precise',
      operations: [{ op: 'reorder_sections', order: [5, 6] }],
    });
    expect(res.status).toBe(422);
    expect(applyResolvedChanges).not.toHaveBeenCalled();
  });

  it('returns 400 on a malformed op in the body', async () => {
    const res = await call(applyPost, { mode: 'precise', operations: [{ op: 'nope' }] });
    expect(res.status).toBe(400);
  });
});

describe('POST edit-agent/apply — rewrite', () => {
  it('persists via replaceVersionStructure and returns counts', async () => {
    const res = await call(applyPost, {
      mode: 'rewrite',
      structure: {
        sections: [{ ordinal: 0, title: 'New' }],
        questions: [
          {
            sectionOrdinal: 0,
            key: 'k',
            prompt: 'P?',
            suggestedType: 'free_text',
            extractionConfidence: 1,
          },
        ],
        changes: [],
      },
    });
    expect(res.status).toBe(200);
    expect(replaceVersionStructure).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({ sections: expect.any(Array) })
    );
    const body = await res.json();
    expect(body.data).toMatchObject({ mode: 'rewrite', sectionCount: 2, questionCount: 3 });
  });
});

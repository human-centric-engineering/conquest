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
vi.mock('@/app/api/v1/app/questionnaires/_lib/fork', () => ({ forkVersionIfLaunched: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/authoring-routes', () => ({
  loadScopedVersion: vi.fn(),
  // Keep the real (trivial) meta shaper so the response `meta` mirrors production.
  forkMeta: (r: { forked: boolean; versionId: string; versionNumber: number }) => ({
    forked: r.forked,
    versionId: r.versionId,
    versionNumber: r.versionNumber,
  }),
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
import {
  assertPersistable,
  IncoherentExtractionError,
  replaceVersionStructure,
} from '@/app/api/v1/app/questionnaires/_lib/persist';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
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
  // Default apply-path collaborators: version resolves, and it edits in place (no fork).
  (loadScopedVersion as Mock).mockResolvedValue({
    id: 'v1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
  });
  (forkVersionIfLaunched as Mock).mockResolvedValue({
    versionId: 'v1',
    forked: false,
    versionNumber: 1,
  });
});

describe('POST edit-agent/plan — precise', () => {
  it('returns 429 when the rate limiter rejects', async () => {
    (composeLimiter.check as Mock).mockReturnValue({ success: false, reset: 1 });
    const res = await call(planPost, { instruction: 'x', mode: 'precise' });
    expect(res.status).toBe(429);
    // No planning work happens under the rate-limit path.
    expect(planEditOps).not.toHaveBeenCalled();
  });

  it('returns 400 on an empty instruction', async () => {
    const res = await call(planPost, { instruction: '', mode: 'precise' });
    expect(res.status).toBe(400);
  });

  it('returns 400 VALIDATION_ERROR when the request body is malformed JSON', async () => {
    const req = new NextRequest(
      'http://localhost/api/v1/app/questionnaires/qn-1/versions/v1/edit-agent',
      { method: 'POST', body: 'not-valid-json{{{', headers: { 'Content-Type': 'application/json' } }
    );
    const res = await planPost(req, ADMIN_SESSION, {
      params: Promise.resolve({ id: 'qn-1', vid: 'v1' }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(planEditOps).not.toHaveBeenCalled();
  });

  it('forwards the loader error (e.g. 404 unknown version) without planning', async () => {
    (loadEditableStructure as Mock).mockResolvedValue({
      ok: false,
      response: new Response('not found', { status: 404 }),
    });
    const res = await call(planPost, { instruction: 'do it', mode: 'precise' });
    expect(res.status).toBe(404);
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

  describe('planErrorStatus mapping', () => {
    const cases = [
      { code: 'edit_agent_not_configured', expectedStatus: 503 },
      { code: 'no_provider_configured', expectedStatus: 503 },
      { code: 'some_unrecognised_code', expectedStatus: 502 },
    ];

    for (const { code, expectedStatus } of cases) {
      it(`maps translation error code '${code}' → HTTP ${expectedStatus}`, async () => {
        (planEditOps as Mock).mockResolvedValue({ ok: false, code, message: `Failed: ${code}` });
        const res = await call(planPost, { instruction: 'do it', mode: 'precise' });
        const body = await res.json();
        expect(res.status).toBe(expectedStatus);
        expect(body.error.code).toBe('EDIT_PLAN_FAILED');
        expect(body.error.details).toEqual({ reason: code });
      });
    }
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
    // Default: the previewed structure is coherent (no throw). Individual tests override.
    (assertPersistable as Mock).mockImplementation(() => undefined);
    // Default: the rewrite dispatch succeeds with a persistable structure. Individual tests override.
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

  it('sorts a multi-section outline by ordinal (real Array.sort comparator)', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
      success: true,
      data: {
        summary: 'Rewrote it',
        structure: {
          // Sections arrive out of order — the route sorts them before building the outline.
          sections: [
            { ordinal: 1, title: 'Second' },
            { ordinal: 0, title: 'First' },
          ],
          questions: [
            {
              sectionOrdinal: 0,
              key: 'k1',
              prompt: 'P1?',
              suggestedType: 'free_text',
              extractionConfidence: 1,
            },
            {
              sectionOrdinal: 1,
              key: 'k2',
              prompt: 'P2?',
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
    expect(body.data.outline).toEqual([
      { title: 'First', questionCount: 1 },
      { title: 'Second', questionCount: 1 },
    ]);
  });

  it('forwards the loader error from loadRefinableStructure without loading the agent', async () => {
    (loadRefinableStructure as Mock).mockResolvedValue({
      ok: false,
      response: new Response('not found', { status: 404 }),
    });
    const res = await call(planPost, { instruction: 'rewrite', mode: 'rewrite' });
    expect(res.status).toBe(404);
    expect(loadComposerAgent).not.toHaveBeenCalled();
  });

  it('returns the error response from loadComposerAgent when the composer is not configured', async () => {
    const errorResp = new Response(
      JSON.stringify({ success: false, error: { code: 'COMPOSER_NOT_CONFIGURED' } }),
      { status: 503 }
    );
    (loadComposerAgent as Mock).mockResolvedValue({ ok: false, response: errorResp });
    const res = await call(planPost, { instruction: 'rewrite', mode: 'rewrite' });
    expect(res.status).toBe(503);
    expect(capabilityDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('falls back to "Rewrite failed" when the dispatch error has no message', async () => {
    (capabilityDispatcher.dispatch as Mock).mockResolvedValue({ success: false });
    const res = await call(planPost, { instruction: 'rewrite', mode: 'rewrite' });
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.error.message).toBe('Rewrite failed');
  });

  it('returns 422 when the rewritten structure is incoherent (assertPersistable throws)', async () => {
    (assertPersistable as Mock).mockImplementation(() => {
      throw new IncoherentExtractionError([2]);
    });
    const res = await call(planPost, { instruction: 'rewrite', mode: 'rewrite' });
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error.code).toBe('EDIT_REWRITE_INCOHERENT');
    expect(body.error.details.orphanSectionOrdinals).toEqual([2]);
  });

  it('rethrows a non-IncoherentExtractionError from assertPersistable', async () => {
    (assertPersistable as Mock).mockImplementation(() => {
      throw new TypeError('boom');
    });
    await expect(call(planPost, { instruction: 'rewrite', mode: 'rewrite' })).rejects.toThrow(
      TypeError
    );
  });

  describe('dispatchStatus mapping', () => {
    const cases = [
      { code: 'invalid_args', expectedStatus: 400 },
      { code: 'no_provider_configured', expectedStatus: 503 },
      { code: 'provider_unavailable', expectedStatus: 503 },
      { code: 'capability_inactive', expectedStatus: 503 },
      { code: 'capability_disabled_for_agent', expectedStatus: 503 },
      { code: 'unknown_capability', expectedStatus: 503 },
      { code: 'capability_quarantined', expectedStatus: 503 },
      { code: 'requires_approval', expectedStatus: 503 },
      { code: 'some_unrecognised_code', expectedStatus: 502 },
    ];

    for (const { code, expectedStatus } of cases) {
      it(`maps dispatch error code '${code}' → HTTP ${expectedStatus}`, async () => {
        (capabilityDispatcher.dispatch as Mock).mockResolvedValue({
          success: false,
          error: { code, message: `Dispatch failed: ${code}` },
        });
        const res = await call(planPost, { instruction: 'rewrite', mode: 'rewrite' });
        const body = await res.json();
        expect(res.status).toBe(expectedStatus);
        expect(body.error.code).toBe('EDIT_REWRITE_FAILED');
      });
    }
  });
});

describe('POST edit-agent/apply — rate limit & malformed body', () => {
  it('returns 429 when the rate limiter rejects', async () => {
    (composeLimiter.check as Mock).mockReturnValue({ success: false, reset: 1 });
    const res = await call(applyPost, {
      mode: 'precise',
      operations: [{ op: 'set_required', target: { scope: 'all' }, value: false }],
    });
    expect(res.status).toBe(429);
    // Under the rate-limit path nothing downstream runs.
    expect(loadScopedVersion).not.toHaveBeenCalled();
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_ERROR when the request body is malformed JSON', async () => {
    const req = new NextRequest(
      'http://localhost/api/v1/app/questionnaires/qn-1/versions/v1/edit-agent',
      { method: 'POST', body: 'not-valid-json{{{', headers: { 'Content-Type': 'application/json' } }
    );
    const res = await applyPost(req, ADMIN_SESSION, {
      params: Promise.resolve({ id: 'qn-1', vid: 'v1' }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(loadScopedVersion).not.toHaveBeenCalled();
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
    // Edited in place (no fork) → meta reflects the same version.
    expect(body.meta).toMatchObject({ forked: false, versionId: 'v1' });
  });

  it('forks a new draft and applies to it when the version is session-pinned', async () => {
    (forkVersionIfLaunched as Mock).mockResolvedValue({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
    });
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
    // The ops re-resolve against the FORK's structure (loaded by the new draft id), then write to it.
    expect(loadEditableStructure).toHaveBeenCalledWith('qn-1', 'v2');
    expect(applyResolvedChanges).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.meta).toMatchObject({ forked: true, versionId: 'v2', versionNumber: 2 });
    // Audit + write are attributed to the fork, not the pinned original.
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'v2',
        metadata: expect.objectContaining({ forked: true }),
      })
    );
  });

  it('returns 404 when the version does not resolve under the questionnaire', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);
    const res = await call(applyPost, {
      mode: 'precise',
      operations: [{ op: 'set_required', target: { scope: 'all' }, value: false }],
    });
    expect(res.status).toBe(404);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(applyResolvedChanges).not.toHaveBeenCalled();
  });

  it('forwards the editable-structure loader error (e.g. fork target vanished → 404)', async () => {
    (loadEditableStructure as Mock).mockResolvedValue({
      ok: false,
      response: new Response('not found', { status: 404 }),
    });
    const res = await call(applyPost, {
      mode: 'precise',
      operations: [{ op: 'set_required', target: { scope: 'all' }, value: false }],
    });
    expect(res.status).toBe(404);
    expect(applyResolvedChanges).not.toHaveBeenCalled();
  });

  it('does not swallow the fork-confirmation error (withAdminAuth maps it to 409)', async () => {
    (forkVersionIfLaunched as Mock).mockRejectedValue(
      Object.assign(new Error('confirm required'), { code: 'VERSION_FORK_CONFIRMATION_REQUIRED' })
    );
    await expect(
      call(applyPost, {
        mode: 'precise',
        operations: [{ op: 'set_required', target: { scope: 'all' }, value: false }],
      })
    ).rejects.toThrow('confirm required');
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
  beforeEach(() => {
    // Default: the structure being applied is coherent (no throw). Individual tests override.
    (assertPersistable as Mock).mockImplementation(() => undefined);
  });

  const REWRITE_STRUCTURE = {
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
  };

  it('returns 422 when the structure is incoherent (assertPersistable throws)', async () => {
    (assertPersistable as Mock).mockImplementation(() => {
      throw new IncoherentExtractionError([3]);
    });
    const res = await call(applyPost, { mode: 'rewrite', structure: REWRITE_STRUCTURE });
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error.code).toBe('EDIT_REWRITE_INCOHERENT');
    expect(body.error.details.orphanSectionOrdinals).toEqual([3]);
    expect(replaceVersionStructure).not.toHaveBeenCalled();
  });

  it('rethrows a non-IncoherentExtractionError from assertPersistable', async () => {
    (assertPersistable as Mock).mockImplementation(() => {
      throw new TypeError('boom');
    });
    await expect(
      call(applyPost, { mode: 'rewrite', structure: REWRITE_STRUCTURE })
    ).rejects.toThrow(TypeError);
    expect(replaceVersionStructure).not.toHaveBeenCalled();
  });

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
    expect(body.meta).toMatchObject({ forked: false, versionId: 'v1' });
  });

  it('rewrites the fork (not the pinned original) when the version is session-pinned', async () => {
    (forkVersionIfLaunched as Mock).mockResolvedValue({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
    });
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
    expect(replaceVersionStructure).toHaveBeenCalledWith('v2', expect.any(Object));
    const body = await res.json();
    expect(body.meta).toMatchObject({ forked: true, versionId: 'v2', versionNumber: 2 });
  });
});

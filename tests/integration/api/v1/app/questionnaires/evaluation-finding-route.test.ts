/**
 * Integration tests: the design-evaluation finding review route (F5.3).
 *
 *   PATCH /api/v1/app/questionnaires/:id/versions/:vid/evaluations/:runId/findings/:findingId
 *     accept | decline | edit | mark_applied
 *
 * Gate order: master flag + design-eval sub-flag off → 404; non-admin → 403; unauthenticated → 401;
 * finding not found → 404; already-applied → 409. The four actions write the right `data`; mark_applied
 * validates the target version belongs to the questionnaire. The DB seam (`loadScopedFinding` /
 * `buildScopedFindingView`) and prisma writes are mocked; the Zod body validation stays real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireEvaluationFinding: { update: vi.fn() },
  appQuestionnaireVersion: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

vi.mock('@/app/api/v1/app/questionnaires/_lib/evaluation-run-routes', () => ({
  loadScopedFinding: vi.fn(),
  buildScopedFindingView: vi.fn(),
}));

import { PATCH } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/evaluations/[runId]/findings/[findingId]/route';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  loadScopedFinding,
  buildScopedFindingView,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-run-routes';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const PARAMS = { id: 'qn-1', vid: 'ver-1', runId: 'run-1', findingId: 'find-1' };

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function jsonReq(body: unknown): NextRequest {
  return {
    url: 'http://localhost:3000/api/v1',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function scopedFinding(status = 'pending') {
  return {
    row: { id: 'find-1', status },
    versionId: 'ver-1',
    questionnaireId: 'qn-1',
    snapshot: null,
  };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  (loadScopedFinding as Mock).mockResolvedValue(scopedFinding('pending'));
  (buildScopedFindingView as Mock).mockResolvedValue({ id: 'find-1', status: 'accepted' });
  prismaMock.appQuestionnaireEvaluationFinding.update.mockResolvedValue({ id: 'find-1' });
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({ id: 'ver-1' });
});

describe('PATCH finding — gate and auth', () => {
  it('returns 401 when unauthenticated', async () => {
    mockUnauthenticatedUser();
    setAuth(null);
    const res = await PATCH(jsonReq({ action: 'accept' }), ctx(PARAMS));
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is not an admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await PATCH(jsonReq({ action: 'accept' }), ctx(PARAMS));
    expect(res.status).toBe(403);
  });

  it('returns 404 when the finding does not resolve', async () => {
    (loadScopedFinding as Mock).mockResolvedValue(null);
    const res = await PATCH(jsonReq({ action: 'accept' }), ctx(PARAMS));
    expect(res.status).toBe(404);
  });

  it('returns 409 when the finding is already applied (terminal)', async () => {
    (loadScopedFinding as Mock).mockResolvedValue(scopedFinding('applied'));
    const res = await PATCH(jsonReq({ action: 'accept' }), ctx(PARAMS));
    expect(res.status).toBe(409);
  });
});

describe('PATCH finding — triage actions', () => {
  it('accept stamps status=accepted', async () => {
    await PATCH(jsonReq({ action: 'accept' }), ctx(PARAMS));
    expect(prismaMock.appQuestionnaireEvaluationFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'accepted' }) })
    );
  });

  it('decline stamps status=declined', async () => {
    await PATCH(jsonReq({ action: 'decline' }), ctx(PARAMS));
    expect(prismaMock.appQuestionnaireEvaluationFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'declined' }) })
    );
  });

  it('edit stores the editedOverride op (no status change)', async () => {
    await PATCH(
      jsonReq({ action: 'edit', editedOverride: { op: 'replace_prompt', prompt: 'Sharper?' } }),
      ctx(PARAMS)
    );
    const data = prismaMock.appQuestionnaireEvaluationFinding.update.mock.calls[0][0].data;
    expect(data.editedOverride).toEqual({ op: 'replace_prompt', prompt: 'Sharper?' });
    expect(data.status).toBeUndefined();
  });

  it('rejects an invalid body (unknown action)', async () => {
    const res = await PATCH(jsonReq({ action: 'nope' }), ctx(PARAMS));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(prismaMock.appQuestionnaireEvaluationFinding.update).not.toHaveBeenCalled();
  });
});

describe('PATCH finding — mark_applied', () => {
  it('stamps applied against a validated target version', async () => {
    await PATCH(jsonReq({ action: 'mark_applied', appliedToVersionId: 'ver-2' }), ctx(PARAMS));
    expect(prismaMock.appQuestionnaireVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ver-2', questionnaireId: 'qn-1' } })
    );
    expect(prismaMock.appQuestionnaireEvaluationFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'applied', appliedToVersionId: 'ver-2' }),
      })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_evaluation_finding.decide' })
    );
  });

  it('returns 404 when the target version is not part of this questionnaire', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await PATCH(
      jsonReq({ action: 'mark_applied', appliedToVersionId: 'other-version' }),
      ctx(PARAMS)
    );
    expect(res.status).toBe(404);
    expect(prismaMock.appQuestionnaireEvaluationFinding.update).not.toHaveBeenCalled();
  });

  it('rejects mark_applied without a target version id', async () => {
    const res = await PATCH(jsonReq({ action: 'mark_applied' }), ctx(PARAMS));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

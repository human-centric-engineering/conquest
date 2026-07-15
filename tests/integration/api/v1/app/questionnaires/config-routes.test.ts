/**
 * Integration test: questionnaire version configuration route (F3.1).
 *
 * Exercises `PATCH …/versions/:vid/config` with the DB seam (`prisma`) and the
 * fork writer mocked: gate order (404 flag-off before auth), 401/403, scope-404,
 * the fork preamble threading into `meta`, the upsert create-vs-update paths, and
 * audit emission. The config Zod contract is unit-tested separately
 * (config-schema.test.ts); the fork deep-copy in fork.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/orchestration/audit/admin-audit-logger')>();
  return { ...real, logAdminAction: vi.fn() };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/fork', () => ({ forkVersionIfLaunched: vi.fn() }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
  appQuestionnaireConfig: { findUnique: vi.fn(), upsert: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { PATCH as configPATCH } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/config/route';

import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(body?: unknown): NextRequest {
  return {
    url: 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/config',
    headers: new Headers(),
    json: async () => body,
  } as unknown as NextRequest;
}

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

function noFork(versionId = 'v1', versionNumber = 1) {
  return { versionId, forked: false, versionNumber };
}

/** A full config row as the upsert returns it (CONFIG_SELECT shape). */
function configRow(overrides: Record<string, unknown> = {}) {
  return {
    selectionStrategy: 'sequential',
    minQuestionsAnswered: 0,
    coverageThreshold: 1,
    costBudgetUsd: null,
    maxQuestionsPerSession: null,
    voiceEnabled: false,
    contradictionMode: 'off',
    contradictionWindowN: 0,
    anonymousMode: false,
    profileFields: [],
    ...overrides,
  };
}

const PARAMS = { id: 'qn-1', vid: 'v1' };

beforeEach(() => {
  vi.clearAllMocks();
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  setAuth(mockAdminUser());
  (forkVersionIfLaunched as unknown as Mock).mockResolvedValue(noFork());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
    id: 'v1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
  });
  prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue(null);
  prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue(configRow());
});

describe('gate order + auth', () => {
  it('404s when the flag is off, before auth', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    const res = await configPATCH(req({ voiceEnabled: true }), ctx(PARAMS));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await configPATCH(req({ voiceEnabled: true }), ctx(PARAMS));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser('USER'));
    const res = await configPATCH(req({ voiceEnabled: true }), ctx(PARAMS));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });
});

describe('validation + scope', () => {
  it('404s when the id/vid pair does not resolve', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await configPATCH(req({ voiceEnabled: true }), ctx(PARAMS));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionnaireConfig.upsert).not.toHaveBeenCalled();
  });

  it('400s on an empty body (at least one field required)', async () => {
    const res = await configPATCH(req({}), ctx(PARAMS));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error.code).toBe('string');
    expect(prismaMock.appQuestionnaireConfig.upsert).not.toHaveBeenCalled();
  });

  it('400s when maxDataSlotAttempts is out of range (1–10)', async () => {
    const low = await configPATCH(req({ maxDataSlotAttempts: 0 }), ctx(PARAMS));
    expect(low.status).toBe(400);
    expect((await low.json()).success).toBe(false);
    expect((await configPATCH(req({ maxDataSlotAttempts: 11 }), ctx(PARAMS))).status).toBe(400);
    expect(prismaMock.appQuestionnaireConfig.upsert).not.toHaveBeenCalled();
  });

  it('400s on an incoherent contradiction mode/N', async () => {
    const res = await configPATCH(
      req({ contradictionMode: 'flag', contradictionWindowN: 0 }),
      ctx(PARAMS)
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error.code).toBe('string');
    expect(prismaMock.appQuestionnaireConfig.upsert).not.toHaveBeenCalled();
  });
});

describe('upsert + response', () => {
  it('creates the config on first save and returns the view with saved:true', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue(null);
    prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue(configRow({ voiceEnabled: true }));

    const res = await configPATCH(req({ voiceEnabled: true }), ctx(PARAMS));
    const json = await res.json();

    expect(res.status).toBe(200);
    // upsert targets the version, with the create payload carrying the provided field.
    const call = prismaMock.appQuestionnaireConfig.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ versionId: 'v1' });
    expect(call.create).toMatchObject({ versionId: 'v1', voiceEnabled: true });
    expect(call.update).toMatchObject({ voiceEnabled: true });
    // The response is the resolved ConfigView — a persisted row is `saved: true`.
    expect(json.data.saved).toBe(true);
    expect(json.data.voiceEnabled).toBe(true);
    expect(json.meta).toMatchObject({ forked: false, versionId: 'v1' });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_config.update', entityId: 'v1' })
    );
  });

  it('round-trips maxDataSlotAttempts through the upsert payload', async () => {
    prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue(
      configRow({ maxDataSlotAttempts: 3 })
    );

    const res = await configPATCH(req({ maxDataSlotAttempts: 3 }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const call = prismaMock.appQuestionnaireConfig.upsert.mock.calls[0][0];
    expect(call.create).toMatchObject({ maxDataSlotAttempts: 3 });
    expect(call.update).toMatchObject({ maxDataSlotAttempts: 3 });
    expect((await res.json()).data.maxDataSlotAttempts).toBe(3);
  });

  it('updates an existing config and audits the before/after diff', async () => {
    // The update path: a config row already exists, so the audit diff is computed
    // against a real pre-edit row (not the empty first-save baseline).
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue(
      configRow({ voiceEnabled: false })
    );
    prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue(configRow({ voiceEnabled: true }));

    const res = await configPATCH(req({ voiceEnabled: true }), ctx(PARAMS));
    expect(res.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'questionnaire_config.update',
        entityId: 'v1',
        changes: expect.objectContaining({ voiceEnabled: { from: false, to: true } }),
      })
    );
  });

  it('writes profileFields through the JSON boundary', async () => {
    const fields = [{ key: 'role', label: 'Role', type: 'text', required: true }];
    prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue(
      configRow({ profileFields: fields })
    );

    const res = await configPATCH(req({ profileFields: fields }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const call = prismaMock.appQuestionnaireConfig.upsert.mock.calls[0][0];
    expect(call.update.profileFields).toEqual(fields);
  });

  it('writes the tone block through the JSON boundary and narrows it back on the response', async () => {
    const tone = {
      empathy: { enabled: true, level: 5 },
      mirroring: { enabled: false, level: 3 },
      formality: { enabled: true, level: 1 },
      mimicry: { enabled: false, level: 3 },
      verbosity: { enabled: false, level: 3 },
      warmth: { enabled: true, level: 4 },
      curiosity: { enabled: false, level: 3 },
      readingComplexity: { enabled: false, level: 3 },
      humour: { enabled: false, level: 3 },
      persona: { enabled: true, text: 'You are a supportive coach.' },
    };
    prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue(configRow({ tone }));

    const res = await configPATCH(req({ tone }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const call = prismaMock.appQuestionnaireConfig.upsert.mock.calls[0][0];
    // The JSON column is written on both create + update paths.
    expect(call.create.tone).toEqual(tone);
    expect(call.update.tone).toEqual(tone);
    // The response view carries the narrowed tone back to the editor.
    expect((await res.json()).data.tone).toEqual(tone);
  });

  it('writes the respondentReport block through the JSON boundary and narrows it back', async () => {
    const respondentReport = {
      enabled: true,
      mode: 'raw_plus_insights' as const,
      rawIncludes: { dataSlots: true, questionsAsPresented: true },
      generation: {
        narrativeStyle: 'flowing' as const,
        instructions: 'Warm and concise.',
        structure: 'Summary, themes, next steps.',
        backgroundContext: 'Quarterly engagement pulse.',
        useClientKnowledge: true,
        dataSlotInfluence: 60,
        discountLowConfidence: false,
      },
      delivery: { onScreen: true, download: true },
      research: {
        enabled: true,
        timing: 'before' as const,
        rounds: 1,
        maxResults: 5,
        before: { instructions: 'Find recent industry benchmarks.' },
        after: { instructions: 'Verify any cited figures.' },
        display: 'list' as const,
        informNarrative: true,
        appendix: false,
      },
    };
    prismaMock.appQuestionnaireConfig.upsert.mockResolvedValue(configRow({ respondentReport }));

    const res = await configPATCH(req({ respondentReport }), ctx(PARAMS));
    expect(res.status).toBe(200);
    const call = prismaMock.appQuestionnaireConfig.upsert.mock.calls[0][0];
    // The JSON column is written on both create + update paths.
    expect(call.create.respondentReport).toEqual(respondentReport);
    expect(call.update.respondentReport).toEqual(respondentReport);
    // The response view carries the narrowed block back to the editor.
    expect((await res.json()).data.respondentReport).toEqual(respondentReport);
  });

  it('forks a launched version and writes to the new draft', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      id: 'v1',
      questionnaireId: 'qn-1',
      versionNumber: 1,
      status: 'launched',
    });
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
    });

    const res = await configPATCH(req({ anonymousMode: true }), ctx(PARAMS));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.meta).toMatchObject({ forked: true, versionId: 'v2', versionNumber: 2 });
    // Writes target the forked draft, not the original.
    const call = prismaMock.appQuestionnaireConfig.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ versionId: 'v2' });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_config.update', entityId: 'v2' })
    );
  });
});

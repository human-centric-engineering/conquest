/**
 * Unit tests for the questionnaire definition import route (F14.9).
 *
 * File under test:
 *   app/api/v1/app/questionnaires/import/route.ts
 *
 * Every collaborator is mocked at the module boundary. Tests assert what the
 * route DOES — status codes, response envelope shapes, collaborator call
 * arguments — not just what mocks return (anti-green-bar).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('@/lib/app/questionnaire/feature-flag', () => ({
  withQuestionnairesEnabled: (handler: unknown) => handler,
}));

vi.mock('@/lib/auth/guards', () => ({
  withAdminAuth: (handler: unknown) => handler,
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '203.0.113.1'),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  createRateLimitResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/authoring', () => ({
  parseDefinitionImport: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/import-definition', () => ({
  persistDefinitionImport: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/slot-embeddings', () => ({
  embedVersionSlots: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings', () => ({
  embedVersionDataSlots: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/rate-limit', () => ({
  ingestLimiter: {
    check: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 })),
  },
}));

// ─── Deferred imports (after vi.mock) ─────────────────────────────────────────

// Using `any` here avoids fighting Next.js handler overload union types in tests.
type AnyRouteHandler = (...args: unknown[]) => Promise<Response>;

const { POST } = (await import('@/app/api/v1/app/questionnaires/import/route')) as {
  POST: AnyRouteHandler;
};

import { parseDefinitionImport } from '@/lib/app/questionnaire/authoring';
import { persistDefinitionImport } from '@/app/api/v1/app/questionnaires/_lib/import-definition';
import { embedVersionSlots } from '@/app/api/v1/app/questionnaires/_lib/slot-embeddings';
import { embedVersionDataSlots } from '@/app/api/v1/app/questionnaires/_lib/data-slot-embeddings';
import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { logger } from '@/lib/logging';

type Mock = ReturnType<typeof vi.fn>;

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const ADMIN_SESSION = { user: { id: 'admin-1' } };

const PERSIST_RESULT = {
  questionnaireId: 'qn-imported-1',
  versionId: 'ver-imported-1',
  sectionCount: 2,
  questionCount: 5,
  tagCount: 1,
  dataSlotCount: 3,
};

const PARSED_ENVELOPE = { questionnaire: { title: 'Health Survey' }, version: {} };

function makeRequest(body = '{"questionnaire":{"title":"Health Survey"},"version":{}}') {
  return new NextRequest('http://localhost/api/v1/app/questionnaires/import', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  // Rate limit passes by default
  (ingestLimiter.check as Mock).mockReturnValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: 0,
  });

  // Parse succeeds by default
  (parseDefinitionImport as Mock).mockReturnValue(PARSED_ENVELOPE);

  // Persist succeeds by default
  (persistDefinitionImport as Mock).mockResolvedValue(PERSIST_RESULT);

  // Embeddings succeed by default (no throws)
  (embedVersionSlots as Mock).mockResolvedValue(undefined);
  (embedVersionDataSlots as Mock).mockResolvedValue(undefined);
});

// ─── Feature-flag gate (withQuestionnairesEnabled mock wiring) ────────────────

describe('feature-flag gate (withQuestionnairesEnabled mock wiring)', () => {
  it('allows the handler to run when the flag mock is the identity function', async () => {
    // Drive the rate-limit path to prove the handler body ran, not a gate.
    (ingestLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: 0,
    });

    const req = makeRequest();
    await POST(req, ADMIN_SESSION);

    // createRateLimitResponse called → handler body executed → identity mock is transparent
    expect(createRateLimitResponse).toHaveBeenCalledOnce();
  });
});

// ─── Rate limit ───────────────────────────────────────────────────────────────

describe('POST /api/v1/app/questionnaires/import — rate limit', () => {
  it('returns the createRateLimitResponse result when ingestLimiter rejects', async () => {
    (ingestLimiter.check as Mock).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: 9_999_999_999,
    });

    const req = makeRequest();
    const res = await POST(req, ADMIN_SESSION);

    // The route must return exactly the value createRateLimitResponse produced — not a
    // hardcoded 429 — so we verify the reference equality.
    expect(createRateLimitResponse).toHaveBeenCalledOnce();
    expect(res).toBe(vi.mocked(createRateLimitResponse).mock.results[0]?.value);
    expect(res.status).toBe(429);

    // Rate limit key is the admin user id, not client IP
    expect(ingestLimiter.check).toHaveBeenCalledWith('admin-1');

    // No downstream work should have happened
    expect(parseDefinitionImport).not.toHaveBeenCalled();
    expect(persistDefinitionImport).not.toHaveBeenCalled();
  });
});

// ─── Payload size guard ───────────────────────────────────────────────────────

describe('POST /api/v1/app/questionnaires/import — payload size', () => {
  it('returns 413 PAYLOAD_TOO_LARGE when the body exceeds 5 MB', async () => {
    // 5 MB + 1 byte — just over the route's MAX_IMPORT_BYTES constant
    const oversizedBody = 'x'.repeat(5 * 1024 * 1024 + 1);
    const req = makeRequest(oversizedBody);
    const res = await POST(req, ADMIN_SESSION);
    const body = (await res.json()) as { success: boolean; error: { code: string } };

    expect(res.status).toBe(413);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');

    // No parse / persist should have run
    expect(parseDefinitionImport).not.toHaveBeenCalled();
    expect(persistDefinitionImport).not.toHaveBeenCalled();
  });

  it('accepts a body exactly at the 5 MB limit', async () => {
    // parseDefinitionImport throws for non-JSON content, so we get a validation error
    // rather than a size-guard 413 — proving the boundary is exclusive (> not >=).
    (parseDefinitionImport as Mock).mockImplementation(() => {
      throw new Error('Invalid JSON');
    });

    const atLimitBody = 'x'.repeat(5 * 1024 * 1024);
    const req = new NextRequest('http://localhost/api/v1/app/questionnaires/import', {
      method: 'POST',
      body: atLimitBody,
    });
    const res = await POST(req, ADMIN_SESSION);

    // The size guard did not fire; instead the parse error path ran (400, not 413)
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(413);
  });
});

// ─── Validation error ─────────────────────────────────────────────────────────

describe('POST /api/v1/app/questionnaires/import — validation error', () => {
  it('returns 400 VALIDATION_ERROR when parseDefinitionImport throws', async () => {
    (parseDefinitionImport as Mock).mockImplementation(() => {
      throw new Error('Missing required field: questionnaire.title');
    });

    const req = makeRequest('{"bad":"file"}');
    const res = await POST(req, ADMIN_SESSION);
    const body = (await res.json()) as {
      success: boolean;
      error: { code: string; message: string };
    };

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    // The route forwards the thrown message
    expect(body.error.message).toBe('Missing required field: questionnaire.title');

    // The bad payload never reached the persister
    expect(persistDefinitionImport).not.toHaveBeenCalled();
    expect(embedVersionSlots).not.toHaveBeenCalled();
  });

  it('uses a fallback message for non-Error throwables', async () => {
    (parseDefinitionImport as Mock).mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'not an error object';
    });

    const req = makeRequest('bad');
    const res = await POST(req, ADMIN_SESSION);
    const body = (await res.json()) as { success: boolean; error: { message: string } };

    expect(res.status).toBe(400);
    expect(body.error.message).toBe('Could not read that file.');
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('POST /api/v1/app/questionnaires/import — happy path', () => {
  it('returns 201 with the persist result wrapped in a success envelope', async () => {
    const req = makeRequest();
    const res = await POST(req, ADMIN_SESSION);
    const body = (await res.json()) as {
      success: boolean;
      data: typeof PERSIST_RESULT;
    };

    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    // The route wraps the persist result — not just any shape we made up.
    expect(body.data).toMatchObject({
      questionnaireId: PERSIST_RESULT.questionnaireId,
      versionId: PERSIST_RESULT.versionId,
      sectionCount: PERSIST_RESULT.sectionCount,
      questionCount: PERSIST_RESULT.questionCount,
      dataSlotCount: PERSIST_RESULT.dataSlotCount,
    });
  });

  it('passes the parsed envelope and admin id to persistDefinitionImport', async () => {
    const req = makeRequest();
    await POST(req, ADMIN_SESSION);

    expect(persistDefinitionImport).toHaveBeenCalledWith({
      envelope: PARSED_ENVELOPE,
      adminId: 'admin-1',
    });
  });

  it('regenerates question embeddings for the new version id', async () => {
    const req = makeRequest();
    await POST(req, ADMIN_SESSION);

    expect(embedVersionSlots).toHaveBeenCalledWith(PERSIST_RESULT.versionId);
    expect(embedVersionDataSlots).toHaveBeenCalledWith(PERSIST_RESULT.versionId);
  });

  it('invokes logAdminAction with the import action and correct metadata', async () => {
    const req = makeRequest();
    await POST(req, ADMIN_SESSION);

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        action: 'questionnaire.import',
        entityType: 'questionnaire',
        entityId: PERSIST_RESULT.questionnaireId,
        metadata: expect.objectContaining({
          versionId: PERSIST_RESULT.versionId,
          sectionCount: PERSIST_RESULT.sectionCount,
          questionCount: PERSIST_RESULT.questionCount,
          dataSlotCount: PERSIST_RESULT.dataSlotCount,
        }),
      })
    );
  });
});

// ─── Best-effort embedding (failure is swallowed) ─────────────────────────────

describe('POST /api/v1/app/questionnaires/import — embedding failure is best-effort', () => {
  it('still returns 201 when embedVersionSlots throws', async () => {
    (embedVersionSlots as Mock).mockRejectedValue(new Error('embedder not configured'));

    const req = makeRequest();
    const res = await POST(req, ADMIN_SESSION);

    // Import succeeds despite the embedder failure
    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    // The warning is logged (best-effort path), not re-thrown
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('embedding regeneration failed'),
      expect.objectContaining({ versionId: PERSIST_RESULT.versionId })
    );
  });

  it('still returns 201 when embedVersionDataSlots throws', async () => {
    (embedVersionDataSlots as Mock).mockRejectedValue(new Error('embedding quota exceeded'));

    const req = makeRequest();
    const res = await POST(req, ADMIN_SESSION);

    expect(res.status).toBe(201);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('embedding regeneration failed'),
      expect.objectContaining({ versionId: PERSIST_RESULT.versionId })
    );
  });

  it('still calls logAdminAction even when embeddings fail', async () => {
    (embedVersionSlots as Mock).mockRejectedValue(new Error('network error'));

    const req = makeRequest();
    await POST(req, ADMIN_SESSION);

    // Audit log is emitted after the try/catch block regardless of embedding outcome
    expect(logAdminAction).toHaveBeenCalledOnce();
  });
});

/**
 * Integration tests: the Routing Analyst's pending proposal — Adaptive Scope (P17.4).
 *
 *   POST   /api/v1/app/questionnaires/:id/versions/:vid/topics/draft  → accept the proposal
 *   DELETE /api/v1/app/questionnaires/:id/versions/:vid/topics/draft  → discard the proposal
 *
 * Gate order for both handlers: non-admin → 403; unauthenticated → 401; missing/cross-id
 * version → 404.
 *
 * Discard is documented as idempotent — a no-op success when nothing is pending.
 *
 * The deliberate asymmetry under test: `if (fork.forked) await discardTopicDraft(vid)` in the
 * accept handler clears the SOURCE version's draft ONLY when a fork actually happened.
 *   - Accept on a DRAFT version (no fork): must NOT touch a second draft row — the write already
 *     landed on the version whose draft it is.
 *   - Accept on a LAUNCHED version (forks): must fork AND clear the source's draft, so the source
 *     doesn't keep a review queue for work already applied to the fork.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({ prisma: {} }));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

vi.mock('@/app/api/v1/app/questionnaires/_lib/topic-draft', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/topic-draft')>();
  return {
    ...real,
    acceptTopicDraft: vi.fn(),
    discardTopicDraft: vi.fn(),
  };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/authoring-routes', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/authoring-routes')>();
  return { ...real, loadScopedVersion: vi.fn() };
});

vi.mock('@/app/api/v1/app/questionnaires/_lib/fork', () => ({
  forkVersionIfLaunched: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  POST,
  DELETE,
} from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/topics/draft/route';
import { auth } from '@/lib/auth/config';
import {
  acceptTopicDraft,
  discardTopicDraft,
} from '@/app/api/v1/app/questionnaires/_lib/topic-draft';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { DEFAULT_ADAPTIVE_SCOPE_SETTINGS } from '@/lib/app/questionnaire/scope/types';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const PARAMS = { id: 'qn-1', vid: 'ver-1' };

function ctx<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

function jsonReq(body: unknown, url = 'http://localhost:3000/api/v1'): NextRequest {
  return {
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function deleteReq(url = 'http://localhost:3000/api/v1'): NextRequest {
  return { url, headers: new Headers() } as unknown as NextRequest;
}

function scopedVersion(status: 'draft' | 'launched' | 'archived' = 'draft') {
  return { id: 'ver-1', questionnaireId: 'qn-1', versionNumber: 2, status };
}

function noForkResult() {
  return { versionId: 'ver-1', forked: false, versionNumber: 2 };
}

function forkResult() {
  return { versionId: 'ver-2', forked: true, versionNumber: 3 };
}

function sampleTopic(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'topic-1',
    key: 'wellbeing',
    label: 'Wellbeing',
    description: null,
    phase: 'conditional',
    criteria: 'Respondent mentions stress',
    depth: 'full',
    members: { questionKeys: ['q1'], dataSlotKeys: [] },
    ordinal: 0,
    source: 'analyst',
    ...overrides,
  };
}

function acceptResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    topics: [sampleTopic()],
    settings: { ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS, rules: [] },
    ...overrides,
  };
}

/** A minimal valid accept body: one conditional topic with criteria and one member. */
function validAcceptBody() {
  return {
    topics: [
      {
        key: 'wellbeing',
        label: 'Wellbeing',
        phase: 'conditional',
        criteria: 'Respondent mentions stress',
        questionKeys: ['q1'],
        dataSlotKeys: [],
      },
    ],
  };
}

function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

beforeEach(() => {
  vi.clearAllMocks();

  setAuth(mockAdminUser());
  (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('draft'));
  (forkVersionIfLaunched as Mock).mockResolvedValue(noForkResult());
  (acceptTopicDraft as Mock).mockResolvedValue(acceptResult());
  (discardTopicDraft as Mock).mockResolvedValue(undefined);
});

// ─── POST (accept) ─────────────────────────────────────────────────────────────

describe('POST /api/v1/app/questionnaires/:id/versions/:vid/topics/draft', () => {
  it('returns 401 when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await POST(jsonReq(validAcceptBody()), ctx(PARAMS));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code: expect.any(String) } });
  });

  it('returns 403 for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    const res = await POST(jsonReq(validAcceptBody()), ctx(PARAMS));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code: expect.any(String) } });
  });

  it('returns 404 with the full error envelope for a missing version, and never forks or accepts', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);
    const res = await POST(jsonReq(validAcceptBody()), ctx(PARAMS));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(acceptTopicDraft).not.toHaveBeenCalled();
  });

  it('rejects a malformed body before forking or accepting', async () => {
    const res = await POST(jsonReq({ topics: 'not-an-array' }), ctx(PARAMS));
    expect(res.status).toBe(400);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(acceptTopicDraft).not.toHaveBeenCalled();
  });

  it('accepts on a DRAFT version WITHOUT forking, and does NOT touch a second draft row', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('draft'));
    (forkVersionIfLaunched as Mock).mockResolvedValue(noForkResult());
    (acceptTopicDraft as Mock).mockResolvedValue(acceptResult());

    const res = await POST(jsonReq(validAcceptBody()), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.meta).toMatchObject({ forked: false, versionId: 'ver-1', versionNumber: 2 });

    // The write landed directly on ver-1 — its own draft was already cleared by acceptTopicDraft's
    // transaction, so the route must not additionally discard anything.
    expect(acceptTopicDraft).toHaveBeenCalledWith(
      'ver-1',
      expect.objectContaining({
        topics: expect.arrayContaining([
          expect.objectContaining({ key: 'wellbeing', phase: 'conditional' }),
        ]),
      })
    );
    expect(discardTopicDraft).not.toHaveBeenCalled();
  });

  it('forwards the two settings the analyst may now propose, and never `enabled` (F17.23)', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('draft'));
    (forkVersionIfLaunched as Mock).mockResolvedValue(noForkResult());
    (acceptTopicDraft as Mock).mockResolvedValue(acceptResult());

    const res = await POST(
      jsonReq({
        ...validAcceptBody(),
        fallbackTopicKeys: ['wellbeing'],
        checkTopicPreference: ['wellbeing'],
      }),
      ctx(PARAMS)
    );
    expect(res.status).toBe(200);

    const body = (acceptTopicDraft as Mock).mock.calls[0][1];
    expect(body.fallbackTopicKeys).toEqual(['wellbeing']);
    expect(body.checkTopicPreference).toEqual(['wellbeing']);
    // Still load-bearing after F17.22 Phase 4, and the naming is the reason. `enabled` — the
    // SETTING — remains unsettable through this route: only the one-way `enable` act below can
    // move it, and only to `true`. A caller that spread a settings object into an accept body
    // therefore cannot flip routing off for every respondent by accident.
    expect(body).not.toHaveProperty('enabled');
    expect(body).not.toHaveProperty('enable');
  });

  it('forwards `enable: true` when the admin ticked the accept-dialog offer (F17.22 Phase 4)', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('draft'));
    (forkVersionIfLaunched as Mock).mockResolvedValue(noForkResult());
    (acceptTopicDraft as Mock).mockResolvedValue(
      acceptResult({ settings: { ...DEFAULT_ADAPTIVE_SCOPE_SETTINGS, enabled: true } })
    );

    const res = await POST(jsonReq({ ...validAcceptBody(), enable: true }), ctx(PARAMS));
    expect(res.status).toBe(200);
    expect((acceptTopicDraft as Mock).mock.calls[0][1].enable).toBe(true);

    // Audited: this accept is the moment adaptive scope started deciding what respondents are
    // asked, which the audit log had no way to show while `enabled` moved only from the settings
    // PATCH.
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'questionnaire_topics.accept_draft',
        metadata: expect.objectContaining({ scopeEnabled: true, enabledByAccept: true }),
      })
    );
  });

  it('refuses `enable: false` — the route can turn the feature on and never off', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('draft'));
    (forkVersionIfLaunched as Mock).mockResolvedValue(noForkResult());

    const res = await POST(jsonReq({ ...validAcceptBody(), enable: false }), ctx(PARAMS));

    expect(res.status).toBe(400);
    expect(acceptTopicDraft).not.toHaveBeenCalled();
  });

  it('accepts on a LAUNCHED version — forks, writes to the fork, AND clears the source draft', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('launched'));
    (forkVersionIfLaunched as Mock).mockResolvedValue(forkResult());
    (acceptTopicDraft as Mock).mockResolvedValue(
      acceptResult({ topics: [sampleTopic({ id: 'topic-2' })] })
    );

    const res = await POST(jsonReq(validAcceptBody()), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toMatchObject({ forked: true, versionId: 'ver-2', versionNumber: 3 });

    // The accept writes land on the FORK (handler-derived id), not the vid the URL named.
    expect(acceptTopicDraft).toHaveBeenCalledWith(
      'ver-2',
      expect.objectContaining({
        topics: expect.arrayContaining([
          expect.objectContaining({ key: 'wellbeing', phase: 'conditional' }),
        ]),
      })
    );
    // The SOURCE's stranded proposal is cleared exactly because a fork happened.
    expect(discardTopicDraft).toHaveBeenCalledWith('ver-1');
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'ver-2' }));
  });
});

// ─── DELETE (discard) ───────────────────────────────────────────────────────────

describe('DELETE /api/v1/app/questionnaires/:id/versions/:vid/topics/draft', () => {
  it('returns 401 when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await DELETE(deleteReq(), ctx(PARAMS));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code: expect.any(String) } });
  });

  it('returns 403 for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    const res = await DELETE(deleteReq(), ctx(PARAMS));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code: expect.any(String) } });
  });

  it('returns 404 with the full error envelope for a missing version, and never discards', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(null);
    const res = await DELETE(deleteReq(), ctx(PARAMS));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
    expect(discardTopicDraft).not.toHaveBeenCalled();
  });

  it('discards the pending proposal — never forks, since discard is inert', async () => {
    const res = await DELETE(deleteReq(), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, data: { discarded: true } });
    expect(discardTopicDraft).toHaveBeenCalledWith('ver-1');
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it('is an idempotent no-op success when nothing is pending', async () => {
    // discardTopicDraft is a deleteMany — a no-match resolves to undefined either way. The claim
    // under test is that the ROUTE never distinguishes "something was deleted" from "nothing was".
    (discardTopicDraft as Mock).mockResolvedValue(undefined);
    const res = await DELETE(deleteReq(), ctx(PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, data: { discarded: true } });
  });

  it('discards on a LAUNCHED version too, without forking — a discard never forks', async () => {
    (loadScopedVersion as Mock).mockResolvedValue(scopedVersion('launched'));
    const res = await DELETE(deleteReq(), ctx(PARAMS));
    expect(res.status).toBe(200);
    expect(discardTopicDraft).toHaveBeenCalledWith('ver-1');
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });
});

/**
 * Integration test: questionnaire authoring mutation routes (F2.1 / PR2).
 *
 * Exercises the HTTP orchestration of the write surface with the DB seam (`prisma`)
 * and the fork writer mocked — gate order, auth, scope-404, the fork preamble
 * threading into `meta`, server-side provenance stamping, status-transition
 * legality + launch guard, per-type `typeConfig` validation, and key-collision
 * mapping. The fork deep-copy itself is unit-tested in fork.test.ts; the pure
 * validation/key/typeConfig logic in the authoring/* unit tests.
 *
 * Covers, across the routes:
 *   404 flag-off (before auth) · 401 · 403 · scope-404 · success + meta.forked ·
 *   provenance stamp · illegal/guarded status transitions · typeConfig 400 ·
 *   key-conflict 400 · audit emission.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/orchestration/audit/admin-audit-logger')>();
  return { ...real, logAdminAction: vi.fn() };
});

// Mock the fork writer — its deep copy is unit-tested separately. Default: no fork.
vi.mock('@/app/api/v1/app/questionnaires/_lib/fork', () => ({ forkVersionIfLaunched: vi.fn() }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  appQuestionnaireSection: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  appQuestionSlot: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  appQuestionnaireConfig: {
    // The launch gate reads the saved config via findUnique (null = never saved) and the
    // selectionStrategy it returns drives the adaptive-embedding requirement.
    findUnique: vi.fn(),
  },
  // Data Slots: the launch gate counts these when the flag is on (default 1 = satisfied).
  appDataSlot: {
    count: vi.fn(async () => 1),
  },
  // The launch gate counts conditional topics so it can WARN when conditional topics is off while
  // some exist (F17.22 Phase 4). Default 0 — no warning row — so the readiness assertions below
  // see only the checks they are about.
  appQuestionnaireTopic: {
    count: vi.fn(async () => 0),
    // Conditional Topics membership (F17.35): a created question joins the topic its section-mates
    // are in, and a deleted one is pruned from every topic that held it. Default to no topics —
    // the shape of a version that does not use the feature, which must stay untouched.
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    updateMany: vi.fn(async () => ({ count: 0 })),
    // Read only when the version was flagged as describing routing and has no proposal yet — the
    // "has an admin authored a topic since?" half of the auto-trigger eligibility rule.
    findFirst: vi.fn(async (): Promise<unknown> => null),
  },
  // The Routing Analyst's pending proposal. Default null — no unreviewed-proposal row — so the
  // readiness assertions below see only the checks they are about. Typed `unknown` rather than
  // inferred: an `async () => null` mock infers `Promise<null>`, and a test that stubs a real
  // proposal onto it then fails to type-check.
  appQuestionnaireTopicDraft: {
    findUnique: vi.fn(async (): Promise<unknown> => null),
  },
  // The durable "the analyst already ran" signal behind the same row.
  appAiRun: {
    findFirst: vi.fn(async (): Promise<unknown> => null),
    count: vi.fn(async () => 0),
  },
  // The route-local countLaunchBlockers reads these when leaving `launched`: live invitations
  // (F3.2) and real respondent sessions (isPreview:false) both pin the version.
  appQuestionnaireInvitation: {
    count: vi.fn(),
  },
  appQuestionnaireSession: {
    count: vi.fn(),
  },
  // Adaptive data-slot embedding coverage (raw SQL) feeds the launch gate when the
  // adaptive-data-slot flag is on. Default to fully embedded (total=1, embedded=1 → missing=0)
  // so it never wrongly blocks the core F3.1 readiness assertions.
  $queryRawUnsafe: vi.fn(async () => [{ total: 1n, embedded: 1n }]),
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// Reorder routes run applyReorder inside a transaction — run the callback against
// a fake tx whose updates are recorded by the same prisma mock methods.
vi.mock('@/lib/db/utils', () => ({
  executeTransaction: vi.fn((cb: (tx: typeof prismaMock) => unknown) => cb(prismaMock)),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { PATCH as versionMetaPATCH } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/route';
import { PATCH as statusPATCH } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/status/route';
import { POST as createSectionPOST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/sections/route';
import { PATCH as reorderSectionsPATCH } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/sections/reorder/route';
import {
  PATCH as sectionPATCH,
  DELETE as sectionDELETE,
} from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/sections/[sectionId]/route';
import { POST as createQuestionPOST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/sections/[sectionId]/questions/route';
import { PATCH as reorderQuestionsPATCH } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/sections/[sectionId]/questions/reorder/route';
import {
  PATCH as questionPATCH,
  DELETE as questionDELETE,
} from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/questions/[questionId]/route';

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
    url: 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1',
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

/** Default fork result: no fork, editable id == original. */
function noFork(versionId = 'v1', versionNumber = 1) {
  return { versionId, forked: false, versionNumber };
}

const VERSION_PARAMS = { id: 'qn-1', vid: 'v1' };

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAdminUser());
  (forkVersionIfLaunched as unknown as Mock).mockResolvedValue(noFork());
  // Default the likert-slot read (launch readiness + key-collision both hit this mock) to empty,
  // so no describe relies on an ancestor's leftover value; tests that need slots override locally.
  prismaMock.appQuestionSlot.findMany.mockResolvedValue([]);
  // Re-defaulted per test, not just declared once on the hoisted mock: `clearAllMocks` clears
  // calls but keeps implementations, so one test's pending proposal would otherwise block every
  // launch after it in file order.
  prismaMock.appQuestionnaireTopicDraft.findUnique.mockResolvedValue(null);
  prismaMock.appQuestionnaireTopic.count.mockResolvedValue(0);
  prismaMock.appQuestionnaireTopic.findFirst.mockResolvedValue(null);
  // Same reasoning, for the membership delegates (F17.35): a describe that sets a topic fixture
  // would otherwise leak it into every describe after it in file order — including the pre-existing
  // question-delete tests, which would then prune against a fixture their author never chose.
  prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([]);
  prismaMock.appQuestionnaireTopic.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.appAiRun.findFirst.mockResolvedValue(null);
  prismaMock.appAiRun.count.mockResolvedValue(0);
  // countLaunchBlockers defaults: no live invitations / respondent sessions (un-launch allowed).
  prismaMock.appQuestionnaireInvitation.count.mockResolvedValue(0);
  prismaMock.appQuestionnaireSession.count.mockResolvedValue(0);
  // loadScopedVersion succeeds by default.
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
    id: 'v1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
  });
});

// ─── Gate + auth matrix (representative routes) ───────────────────────────────

describe('gate order + auth', () => {
  const cases = [
    {
      name: 'version-meta PATCH',
      call: () => versionMetaPATCH(req({ goal: 'x' }), ctx(VERSION_PARAMS)),
    },
    {
      name: 'status PATCH',
      call: () => statusPATCH(req({ status: 'archived' }), ctx(VERSION_PARAMS)),
    },
    {
      name: 'section POST',
      call: () => createSectionPOST(req({ title: 'S' }), ctx(VERSION_PARAMS)),
    },
  ];

  for (const { name, call } of cases) {
    it(`${name}: 401s when unauthenticated`, async () => {
      setAuth(mockUnauthenticatedUser());
      expect((await call()).status).toBe(401);
    });

    it(`${name}: 403s for a non-admin`, async () => {
      setAuth(mockAuthenticatedUser('USER'));
      expect((await call()).status).toBe(403);
    });
  }
});

// ─── Scope 404 ────────────────────────────────────────────────────────────────

describe('scope 404', () => {
  it('version-meta PATCH 404s when the id/vid pair does not resolve', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await versionMetaPATCH(req({ goal: 'x' }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(404);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });
});

// ─── Version-meta PATCH ───────────────────────────────────────────────────────

describe('version-meta PATCH', () => {
  it('stamps admin-supplied provenance and returns meta.forked', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      id: 'v1',
      goal: null,
      audience: null,
    });
    prismaMock.appQuestionnaireVersion.update.mockResolvedValue({
      id: 'v1',
      versionNumber: 1,
      status: 'draft',
      goal: 'Understand churn',
      audience: { role: 'patient' },
      goalProvenance: 'admin-supplied',
      audienceProvenance: { role: 'admin-supplied' },
    });

    const res = await versionMetaPATCH(
      req({ goal: 'Understand churn', audience: { role: 'patient' } }),
      ctx(VERSION_PARAMS)
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.meta).toMatchObject({ forked: false, versionId: 'v1' });
    // Provenance is server-derived, not client-sent.
    const data = prismaMock.appQuestionnaireVersion.update.mock.calls[0][0].data;
    expect(data.goalProvenance).toBe('admin-supplied');
    expect(data.audienceProvenance).toEqual({ role: 'admin-supplied' });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_version.update', entityId: 'v1' })
    );
  });

  it('keeps an unchanged inferred audience field as inferred (no clobber)', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      id: 'v1',
      goal: 'g',
      audience: { role: 'patient', description: 'old' },
      goalProvenance: 'inferred',
      audienceProvenance: { role: 'inferred', description: 'inferred' },
    });
    prismaMock.appQuestionnaireVersion.update.mockResolvedValue({ id: 'v1' });

    // Admin edits only description; the editor re-submits role unchanged.
    await versionMetaPATCH(
      req({ audience: { role: 'patient', description: 'new blurb' } }),
      ctx(VERSION_PARAMS)
    );
    const data = prismaMock.appQuestionnaireVersion.update.mock.calls[0][0].data;
    expect(data.audienceProvenance).toEqual({ role: 'inferred', description: 'admin-supplied' });
  });

  it('clears the goal and its provenance when set to null', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({ id: 'v1', goal: 'old' });
    prismaMock.appQuestionnaireVersion.update.mockResolvedValue({ id: 'v1', goal: null });

    await versionMetaPATCH(req({ goal: null }), ctx(VERSION_PARAMS));
    const data = prismaMock.appQuestionnaireVersion.update.mock.calls[0][0].data;
    expect(data.goal).toBeNull();
    expect(data.goalProvenance).toBeNull();
  });
});

// ─── Status PATCH ─────────────────────────────────────────────────────────────

describe('status PATCH', () => {
  it('rejects an illegal transition (archived → launched)', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      id: 'v1',
      questionnaireId: 'qn-1',
      versionNumber: 1,
      status: 'archived',
    });
    const res = await statusPATCH(req({ status: 'launched' }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(400);
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });

  it('blocks launch when the version is not ready (F3.1 gate)', async () => {
    // draft → launched, but nothing populated: no goal / audience / sections /
    // questions / saved config.
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({ goal: null, audience: null });
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(0);
    prismaMock.appQuestionSlot.count.mockResolvedValue(0);
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue(null);

    const res = await statusPATCH(req({ status: 'launched' }), ctx(VERSION_PARAMS));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    // Every unmet condition is reported per-field.
    expect(json.error.details).toMatchObject({
      goal: expect.any(Array),
      audience: expect.any(Array),
      sections: expect.any(Array),
      questions: expect.any(Array),
      config: expect.any(Array),
    });
  });

  it('blocks launch when audience is an empty object (F3.1)', async () => {
    // Goal/sections/questions/config all present, but the editor persisted `{}`.
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      goal: 'A goal',
      audience: {},
    });
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(1);
    prismaMock.appQuestionSlot.count.mockResolvedValue(1);
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      selectionStrategy: 'sequential',
    });

    const res = await statusPATCH(req({ status: 'launched' }), ctx(VERSION_PARAMS));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error.details).toMatchObject({ audience: expect.any(Array) });
    expect(json.error.details.goal).toBeUndefined();
  });

  it('blocks launch when config has never been saved (F3.1)', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      goal: 'A goal',
      audience: { role: 'patient' },
    });
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(1);
    prismaMock.appQuestionSlot.count.mockResolvedValue(1);
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue(null);

    const res = await statusPATCH(req({ status: 'launched' }), ctx(VERSION_PARAMS));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error.details).toMatchObject({ config: expect.any(Array) });
    // Only config is unmet.
    expect(Object.keys(json.error.details)).toEqual(['config']);
  });

  it('launches a fully-ready version and audits the transition', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      goal: 'A goal',
      audience: { role: 'patient' },
    });
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(2);
    prismaMock.appQuestionSlot.count.mockResolvedValue(5);
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      selectionStrategy: 'sequential',
    });
    prismaMock.appQuestionnaireVersion.update.mockResolvedValue({
      id: 'v1',
      versionNumber: 1,
      status: 'launched',
    });

    const res = await statusPATCH(req({ status: 'launched' }), ctx(VERSION_PARAMS));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.status).toBe('launched');
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_version.status' })
    );
    // Status route never forks.
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it("blocks launch while the Routing Analyst's proposal is unreviewed", async () => {
    // The proposal is not live: the runtime scope resolver and every other launch check read only
    // the live topic set. Without this gate a version whose Topics tab was never opened launches
    // asking everyone everything, with a paid model call sitting unread beside it.
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      goal: 'A goal',
      audience: { role: 'patient' },
      conditionalTopicsCandidate: null,
    });
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(1);
    prismaMock.appQuestionSlot.count.mockResolvedValue(1);
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      selectionStrategy: 'sequential',
    });
    prismaMock.appQuestionnaireTopicDraft.findUnique.mockResolvedValue({
      topics: {
        v: 1,
        topics: [
          {
            key: 'franchisees',
            label: 'Franchise owners',
            phase: 'conditional',
            criteria: 'when they run a franchise',
            depth: 'full',
            // Nested, as `narrowProposedTopicSet` reads it (`t.members`).
            members: { questionKeys: [], dataSlotKeys: [] },
          },
        ],
        rules: [],
        gaps: [],
      },
    });

    const res = await statusPATCH(req({ status: 'launched' }), ctx(VERSION_PARAMS));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error.details).toMatchObject({ conditionalTopicsReview: expect.any(Array) });
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
  });

  it('records the warnings an admin launched over, without refusing the launch', async () => {
    // "Ask everyone everything" is a legitimate choice, so the row is a warning. But launching past
    // one is a decision somebody made, and the audit entry is where that stops being deniable.
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      goal: 'A goal',
      audience: { role: 'patient' },
      conditionalTopicsCandidate: null,
    });
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(1);
    prismaMock.appQuestionSlot.count.mockResolvedValue(1);
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      selectionStrategy: 'sequential',
    });
    // Conditional topics exist; the feature is off (no `conditionalTopics` on the config blob).
    prismaMock.appQuestionnaireTopic.count.mockResolvedValue(3);
    prismaMock.appQuestionnaireVersion.update.mockResolvedValue({
      id: 'v1',
      versionNumber: 1,
      status: 'launched',
    });

    const res = await statusPATCH(req({ status: 'launched' }), ctx(VERSION_PARAMS));

    expect(res.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'questionnaire_version.status',
        metadata: { launchedOverWarnings: ['conditionalTopicsOff'] },
      })
    );
  });

  it('leaves the metadata off a clean launch', async () => {
    // An empty array on every launch would make the field noise; its absence already reads as
    // "the checklist was clean".
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      goal: 'A goal',
      audience: { role: 'patient' },
      conditionalTopicsCandidate: null,
    });
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(1);
    prismaMock.appQuestionSlot.count.mockResolvedValue(1);
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      selectionStrategy: 'sequential',
    });
    prismaMock.appQuestionnaireVersion.update.mockResolvedValue({
      id: 'v1',
      versionNumber: 1,
      status: 'launched',
    });

    const res = await statusPATCH(req({ status: 'launched' }), ctx(VERSION_PARAMS));

    expect(res.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.not.objectContaining({ metadata: expect.anything() })
    );
  });

  it('blocks launch when a likert scale is unlabelled (scaleLabels gate)', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({
      goal: 'A goal',
      audience: { role: 'patient' },
    });
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(1);
    prismaMock.appQuestionSlot.count.mockResolvedValue(1);
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      selectionStrategy: 'sequential',
    });
    // One likert with bounds but no per-point labels → not launch-ready.
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([
      { type: 'likert', typeConfig: { min: 1, max: 5 } },
    ]);

    const res = await statusPATCH(req({ status: 'launched' }), ctx(VERSION_PARAMS));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error.details).toMatchObject({ scaleLabels: expect.any(Array) });
  });

  // F3.2: a sent invitation pins a launched version — un-launching is refused.
  it('un-launches a launched version with no live invitations', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      id: 'v1',
      questionnaireId: 'qn-1',
      versionNumber: 1,
      status: 'launched',
    });
    prismaMock.appQuestionnaireInvitation.count.mockResolvedValue(0);
    prismaMock.appQuestionnaireVersion.update.mockResolvedValue({
      id: 'v1',
      versionNumber: 1,
      status: 'draft',
    });

    const res = await statusPATCH(req({ status: 'draft' }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionnaireVersion.update).toHaveBeenCalled();
  });

  it('refuses to leave launched while a live invitation pins the version (409)', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      id: 'v1',
      questionnaireId: 'qn-1',
      versionNumber: 1,
      status: 'launched',
    });
    prismaMock.appQuestionnaireInvitation.count.mockResolvedValue(1);

    const res = await statusPATCH(req({ status: 'archived' }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(409);
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
    // The blocker count must be scoped to THIS version and the live-status set —
    // a missing status filter or wrong version would silently allow the un-launch.
    expect(prismaMock.appQuestionnaireInvitation.count).toHaveBeenCalledWith({
      where: {
        versionId: 'v1',
        status: { in: expect.arrayContaining(['pending', 'sent', 'opened', 'registered']) },
      },
    });
  });

  it('refuses to leave launched while a real respondent session pins the version (409)', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      id: 'v1',
      questionnaireId: 'qn-1',
      versionNumber: 1,
      status: 'launched',
    });
    // No invitations, but a real respondent session exists → still pinned.
    prismaMock.appQuestionnaireInvitation.count.mockResolvedValue(0);
    prismaMock.appQuestionnaireSession.count.mockResolvedValue(2);

    const res = await statusPATCH(req({ status: 'draft' }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(409);
    expect(prismaMock.appQuestionnaireVersion.update).not.toHaveBeenCalled();
    // Session blockers count only real respondents (isPreview:false), scoped to this version.
    expect(prismaMock.appQuestionnaireSession.count).toHaveBeenCalledWith({
      where: { versionId: 'v1', isPreview: false },
    });
  });
});

// ─── Question create: typeConfig + key ────────────────────────────────────────

describe('question create', () => {
  const QUESTION_PARAMS = { id: 'qn-1', vid: 'v1', sectionId: 'sec-1' };

  beforeEach(() => {
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({ id: 'sec-1' });
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([]); // no existing keys
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue(null); // no key clash by default
    prismaMock.appQuestionSlot.count.mockResolvedValue(0);
  });

  it('rejects an invalid typeConfig before writing', async () => {
    const res = await createQuestionPOST(
      req({ prompt: 'Pick one', type: 'single_choice', typeConfig: { choices: [] } }),
      ctx(QUESTION_PARAMS)
    );
    expect(res.status).toBe(400);
    expect(prismaMock.appQuestionSlot.create).not.toHaveBeenCalled();
  });

  it('rejects an explicit key collision before forking', async () => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue({ id: 'other' }); // clash
    const res = await createQuestionPOST(
      req({ prompt: 'Name?', type: 'free_text', key: 'taken' }),
      ctx(QUESTION_PARAMS)
    );
    expect(res.status).toBe(400);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionSlot.create).not.toHaveBeenCalled();
  });

  it('derives a concise key from the prompt and creates the question (201)', async () => {
    prismaMock.appQuestionSlot.create.mockResolvedValue({
      id: 'q-1',
      key: 'smoke',
      sectionId: 'sec-1',
    });

    const res = await createQuestionPOST(
      req({ prompt: 'Do you smoke?', type: 'boolean' }),
      ctx(QUESTION_PARAMS)
    );
    expect(res.status).toBe(201);
    const data = prismaMock.appQuestionSlot.create.mock.calls[0][0].data;
    // slugifyKey drops grammatical stopwords ("do", "you") → the meaningful word only.
    expect(data.key).toBe('smoke');
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_question.create' })
    );
  });

  it("starts a new question on the version's configured fidelity level", async () => {
    // The Settings-tab "level for new questions" only means something if the create path reads it.
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      questionFidelity: { enabled: true, defaultFidelity: 0.75 },
    });
    prismaMock.appQuestionSlot.create.mockResolvedValue({
      id: 'q-1',
      key: 'k',
      sectionId: 'sec-1',
    });

    await createQuestionPOST(req({ prompt: 'Rate it', type: 'free_text' }), ctx(QUESTION_PARAMS));

    expect(prismaMock.appQuestionSlot.create.mock.calls[0][0].data.fidelity).toBe(0.75);
  });

  it('falls back to the neutral midpoint when the fidelity gate is off', async () => {
    // While the gate is off the stored value is inert either way, so the midpoint is the honest
    // default — it is exactly how the question will behave.
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      questionFidelity: { enabled: false, defaultFidelity: 1 },
    });
    prismaMock.appQuestionSlot.create.mockResolvedValue({
      id: 'q-1',
      key: 'k',
      sectionId: 'sec-1',
    });

    await createQuestionPOST(req({ prompt: 'Rate it', type: 'free_text' }), ctx(QUESTION_PARAMS));

    expect(prismaMock.appQuestionSlot.create.mock.calls[0][0].data.fidelity).toBe(0.5);
  });

  it('lets an explicit fidelity in the body win over the configured default', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue({
      questionFidelity: { enabled: true, defaultFidelity: 0.25 },
    });
    prismaMock.appQuestionSlot.create.mockResolvedValue({
      id: 'q-1',
      key: 'k',
      sectionId: 'sec-1',
    });

    await createQuestionPOST(
      req({ prompt: 'Rate it', type: 'free_text', fidelity: 1 }),
      ctx(QUESTION_PARAMS)
    );

    expect(prismaMock.appQuestionSlot.create.mock.calls[0][0].data.fidelity).toBe(1);
  });

  it('falls back to the neutral midpoint when the version has no config row', async () => {
    prismaMock.appQuestionnaireConfig.findUnique.mockResolvedValue(null);
    prismaMock.appQuestionSlot.create.mockResolvedValue({
      id: 'q-1',
      key: 'k',
      sectionId: 'sec-1',
    });

    await createQuestionPOST(req({ prompt: 'Rate it', type: 'free_text' }), ctx(QUESTION_PARAMS));

    expect(prismaMock.appQuestionSlot.create.mock.calls[0][0].data.fidelity).toBe(0.5);
  });

  it('maps a duplicate explicit key (P2002) to a 400', async () => {
    prismaMock.appQuestionSlot.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );

    const res = await createQuestionPOST(
      req({ prompt: 'Name?', type: 'free_text', key: 'full_name' }),
      ctx(QUESTION_PARAMS)
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error.details).toMatchObject({ key: expect.any(Array) });
  });

  it('persists all optional fields (guidelines, rationale, weight, explicit ordinal/key)', async () => {
    prismaMock.appQuestionSlot.create.mockResolvedValue({
      id: 'q-1',
      key: 'k',
      sectionId: 'sec-1',
    });
    const res = await createQuestionPOST(
      req({
        prompt: 'Rate it',
        type: 'likert',
        key: 'rating',
        guidelines: '1–5',
        rationale: 'satisfaction',
        required: true,
        weight: 1,
        ordinal: 0,
        typeConfig: { min: 1, max: 5, labels: ['Awful', 'Poor', 'Okay', 'Good', 'Great'] },
      }),
      ctx(QUESTION_PARAMS)
    );
    expect(res.status).toBe(201);
    const data = prismaMock.appQuestionSlot.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      key: 'rating',
      ordinal: 0,
      required: true,
      weight: 1,
      guidelines: '1–5',
      rationale: 'satisfaction',
      typeConfig: { min: 1, max: 5, labels: ['Awful', 'Poor', 'Okay', 'Good', 'Great'] },
    });
    expect(prismaMock.appQuestionSlot.count).not.toHaveBeenCalled(); // explicit ordinal
  });
});

// ─── Conditional Topics membership on the manual question routes (F17.35) ─────

describe('question create + delete — topic membership', () => {
  const QUESTION_PARAMS = { id: 'qn-1', vid: 'v1', sectionId: 'sec-1' };

  const TOPICS = [
    {
      id: 't-1',
      key: 'background',
      ordinal: 0,
      members: { questionKeys: ['q_a'], dataSlotKeys: [] },
    },
    { id: 't-2', key: 'other', ordinal: 1, members: { questionKeys: ['q_z'], dataSlotKeys: [] } },
  ];

  function topicWrites() {
    return (prismaMock.appQuestionnaireTopic.updateMany as Mock).mock.calls.map(
      (c: unknown[]) =>
        c[0] as { where: { id: string }; data: { members: { questionKeys: string[] } } }
    );
  }

  beforeEach(() => {
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({ id: 'sec-1' });
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue(null);
    prismaMock.appQuestionSlot.count.mockResolvedValue(0);
  });

  it('puts a newly created question in the topic its section-mates are in', async () => {
    // Without this the question belongs to nothing, and with Conditional Topics on it is never
    // asked — with the launch gate the only thing that would ever say so, and only once the
    // feature is turned on.
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q_a' }]);
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue(TOPICS);
    prismaMock.appQuestionSlot.create.mockResolvedValue({ id: 'q-new', key: 'how_is_it_going' });

    const res = await createQuestionPOST(
      req({ prompt: 'How is it going?', type: 'free_text' }),
      ctx(QUESTION_PARAMS)
    );

    expect(res.status).toBe(201);
    expect(topicWrites()).toHaveLength(1);
    expect(topicWrites()[0].where.id).toBe('t-1');
    expect(topicWrites()[0].data.members.questionKeys).toEqual(['q_a', 'how_is_it_going']);
  });

  it('writes no membership when the version has no topics', async () => {
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([]);
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([]);
    prismaMock.appQuestionSlot.create.mockResolvedValue({ id: 'q-new', key: 'k' });

    const res = await createQuestionPOST(
      req({ prompt: 'Anything?', type: 'free_text' }),
      ctx(QUESTION_PARAMS)
    );

    expect(res.status).toBe(201);
    expect(prismaMock.appQuestionnaireTopic.updateMany).not.toHaveBeenCalled();
  });

  it('still returns 201 when no topic claims any section-mate', async () => {
    // The question is created and uncovered. That is worth reporting, not worth failing: the
    // Topics tab and the launch gate both already name it.
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q_unclaimed' }]);
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue(TOPICS);
    prismaMock.appQuestionSlot.create.mockResolvedValue({ id: 'q-new', key: 'k' });

    const res = await createQuestionPOST(
      req({ prompt: 'Anything?', type: 'free_text' }),
      ctx(QUESTION_PARAMS)
    );

    expect(res.status).toBe(201);
    expect(prismaMock.appQuestionnaireTopic.updateMany).not.toHaveBeenCalled();
  });

  it('still deletes the question when the prune fails', async () => {
    // The mirror of the create-path case below: the question is already gone by the time the prune
    // runs, so failing the request would report a delete that DID happen as an error. The stale key
    // it leaves behind is exactly what the Topics tab's coverage count already reports.
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue({
      id: 'q-1',
      key: 'q_a',
      sectionId: 'sec-1',
    });
    prismaMock.appQuestionSlot.delete.mockResolvedValue({ id: 'q-1' });
    prismaMock.appQuestionnaireTopic.findMany.mockRejectedValue(new Error('topic read exploded'));

    const res = await questionDELETE(req(), ctx({ id: 'qn-1', vid: 'v1', questionId: 'q-1' }));

    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionSlot.delete).toHaveBeenCalledWith({ where: { id: 'q-1' } });
  });

  it('still creates the question when the membership write fails', async () => {
    // Best-effort by design: inheritance runs outside the create's transaction, so a failure has to
    // leave the question in place. The alternative — failing the request — would report a create
    // that DID happen as an error, and the resulting orphan is already reported by the Topics tab
    // and the launch gate. This is the branch that was silently swallowing a TypeError before the
    // mock carried `appQuestionnaireTopic.findMany` at all.
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q_a' }]);
    prismaMock.appQuestionnaireTopic.findMany.mockRejectedValue(new Error('topic read exploded'));
    prismaMock.appQuestionSlot.create.mockResolvedValue({ id: 'q-new', key: 'k' });

    const res = await createQuestionPOST(
      req({ prompt: 'How is it going?', type: 'free_text' }),
      ctx(QUESTION_PARAMS)
    );

    expect(res.status).toBe(201);
    expect(prismaMock.appQuestionSlot.create).toHaveBeenCalled();
  });

  it('prunes a deleted question from every topic that held it', async () => {
    // A dead key is not a crash, but `empty_topic` counts raw member keys — so a topic emptied by
    // deletions reads as non-empty and warns about nothing.
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue({
      id: 'q-1',
      key: 'q_a',
      sectionId: 'sec-1',
    });
    prismaMock.appQuestionSlot.delete.mockResolvedValue({ id: 'q-1' });
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue(TOPICS);

    const res = await questionDELETE(req(), ctx({ id: 'qn-1', vid: 'v1', questionId: 'q-1' }));

    expect(res.status).toBe(200);
    expect(topicWrites()).toHaveLength(1);
    expect(topicWrites()[0].where.id).toBe('t-1');
    expect(topicWrites()[0].data.members.questionKeys).toEqual([]);
  });
});

// ─── Section create ───────────────────────────────────────────────────────────

describe('section create', () => {
  it('appends a section (ordinal = current count) and audits it', async () => {
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(2);
    prismaMock.appQuestionnaireSection.create.mockResolvedValue({
      id: 'sec-new',
      ordinal: 2,
      title: 'About you',
      description: null,
    });

    const res = await createSectionPOST(req({ title: 'About you' }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(201);
    const data = prismaMock.appQuestionnaireSection.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ versionId: 'v1', ordinal: 2, title: 'About you' });
    expect(data).not.toHaveProperty('description'); // omitted, not written as null
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_section.create' })
    );
  });

  it('honours an explicit ordinal and description', async () => {
    prismaMock.appQuestionnaireSection.create.mockResolvedValue({
      id: 'sec-new',
      ordinal: 0,
      title: 'Intro',
      description: 'Up front',
    });
    await createSectionPOST(
      req({ title: 'Intro', description: 'Up front', ordinal: 0 }),
      ctx(VERSION_PARAMS)
    );
    const data = prismaMock.appQuestionnaireSection.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ ordinal: 0, description: 'Up front' });
    expect(prismaMock.appQuestionnaireSection.count).not.toHaveBeenCalled();
  });
});

// ─── Fork retarget (editing a launched version) ───────────────────────────────

describe('fork retarget', () => {
  const SECTION_PARAMS = { id: 'qn-1', vid: 'v1', sectionId: 'sec-1' };

  it('writes to the copied section and reports meta.forked when a launched version forks', async () => {
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
      sectionIdMap: new Map([['sec-1', 'newsec']]),
      questionIdMap: new Map(),
    });
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({
      id: 'sec-1',
      ordinal: 0,
      title: 'Old',
      description: null,
    });
    prismaMock.appQuestionnaireSection.update.mockResolvedValue({
      id: 'newsec',
      ordinal: 0,
      title: 'New',
      description: null,
    });

    const res = await sectionPATCH(req({ title: 'New' }), ctx(SECTION_PARAMS));
    const json = await res.json();
    expect(res.status).toBe(200);
    // The edit lands on the forked copy, not the original.
    expect(prismaMock.appQuestionnaireSection.update.mock.calls[0][0].where).toEqual({
      id: 'newsec',
    });
    expect(json.meta).toMatchObject({ forked: true, versionId: 'v2', versionNumber: 2 });
  });

  it('404s when the targeted id has no entry in the fork map (stale id)', async () => {
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
      sectionIdMap: new Map(), // sec-1 not present
      questionIdMap: new Map(),
    });
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({
      id: 'sec-1',
      ordinal: 0,
      title: 'Old',
      description: null,
    });

    const res = await sectionPATCH(req({ title: 'New' }), ctx(SECTION_PARAMS));
    expect(res.status).toBe(404);
    expect(prismaMock.appQuestionnaireSection.update).not.toHaveBeenCalled();
  });
});

// ─── Section reorder ──────────────────────────────────────────────────────────

describe('section reorder', () => {
  it('rewrites ordinals for a valid permutation', async () => {
    prismaMock.appQuestionnaireSection.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    prismaMock.appQuestionnaireSection.update.mockResolvedValue({});

    const res = await reorderSectionsPATCH(req({ order: ['s2', 's1'] }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionnaireSection.update).toHaveBeenNthCalledWith(1, {
      where: { id: 's2' },
      data: { ordinal: 0 },
    });
    expect(prismaMock.appQuestionnaireSection.update).toHaveBeenNthCalledWith(2, {
      where: { id: 's1' },
      data: { ordinal: 1 },
    });
  });

  it('400s when the order is not a permutation of the version sections', async () => {
    prismaMock.appQuestionnaireSection.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    const res = await reorderSectionsPATCH(req({ order: ['s1', 'foreign'] }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(400);
    expect(prismaMock.appQuestionnaireSection.update).not.toHaveBeenCalled();
  });

  it('remaps the order through the fork when the version is launched', async () => {
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
      sectionIdMap: new Map([
        ['s1', 'n1'],
        ['s2', 'n2'],
      ]),
      questionIdMap: new Map(),
    });
    prismaMock.appQuestionnaireSection.findMany.mockResolvedValue([{ id: 'n1' }, { id: 'n2' }]);
    prismaMock.appQuestionnaireSection.update.mockResolvedValue({});

    const res = await reorderSectionsPATCH(req({ order: ['s2', 's1'] }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(200);
    // Ordinals applied to the forked copies, in the requested order.
    expect(prismaMock.appQuestionnaireSection.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'n2' },
      data: { ordinal: 0 },
    });
  });

  it('400s when a reordered id is absent from the fork map', async () => {
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
      sectionIdMap: new Map([['s1', 'n1']]), // s2 missing
      questionIdMap: new Map(),
    });
    const res = await reorderSectionsPATCH(req({ order: ['s1', 's2'] }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(400);
    expect(prismaMock.appQuestionnaireSection.update).not.toHaveBeenCalled();
  });

  it('404s when the version does not resolve (scope)', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await reorderSectionsPATCH(req({ order: ['s1'] }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(404);
  });
});

// ─── Section PATCH / DELETE ───────────────────────────────────────────────────

describe('section edit/delete', () => {
  const SECTION_PARAMS = { id: 'qn-1', vid: 'v1', sectionId: 'sec-1' };

  it('404s a section from another version (scope check)', async () => {
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue(null);
    const res = await sectionPATCH(req({ title: 'New' }), ctx(SECTION_PARAMS));
    expect(res.status).toBe(404);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it('404s when the version does not resolve (scope)', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await sectionPATCH(req({ title: 'New' }), ctx(SECTION_PARAMS));
    expect(res.status).toBe(404);
  });

  it('404s when the version does not resolve (scope)', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await sectionDELETE(req(), ctx(SECTION_PARAMS));
    expect(res.status).toBe(404);
  });

  it('updates title and description together', async () => {
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({
      id: 'sec-1',
      ordinal: 0,
      title: 'Old',
      description: 'old',
    });
    prismaMock.appQuestionnaireSection.update.mockResolvedValue({
      id: 'sec-1',
      ordinal: 0,
      title: 'New',
      description: 'new',
    });
    await sectionPATCH(req({ title: 'New', description: 'new' }), ctx(SECTION_PARAMS));
    const data = prismaMock.appQuestionnaireSection.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ title: 'New', description: 'new' });
  });

  it('updates a scoped section and audits it', async () => {
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({
      id: 'sec-1',
      ordinal: 0,
      title: 'Old',
      description: null,
    });
    prismaMock.appQuestionnaireSection.update.mockResolvedValue({
      id: 'sec-1',
      ordinal: 0,
      title: 'New',
      description: null,
    });
    const res = await sectionPATCH(req({ title: 'New' }), ctx(SECTION_PARAMS));
    expect(res.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_section.update', entityId: 'sec-1' })
    );
  });

  it('deletes a scoped section (cascades questions)', async () => {
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({
      id: 'sec-1',
      ordinal: 0,
      title: 'Gone',
      description: null,
    });
    prismaMock.appQuestionnaireSection.delete.mockResolvedValue({});
    const res = await sectionDELETE(req(), ctx(SECTION_PARAMS));
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionnaireSection.delete).toHaveBeenCalledWith({
      where: { id: 'sec-1' },
    });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_section.delete' })
    );
  });

  it('deletes the forked copy and 404s a stale id when the version is launched', async () => {
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({
      id: 'sec-1',
      ordinal: 0,
      title: 'Gone',
      description: null,
    });
    // Forked: delete lands on the mapped copy.
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValueOnce({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
      sectionIdMap: new Map([['sec-1', 'newsec']]),
      questionIdMap: new Map(),
    });
    prismaMock.appQuestionnaireSection.delete.mockResolvedValue({});
    const ok = await sectionDELETE(req(), ctx(SECTION_PARAMS));
    expect(ok.status).toBe(200);
    expect(prismaMock.appQuestionnaireSection.delete).toHaveBeenCalledWith({
      where: { id: 'newsec' },
    });

    // Forked but the id isn't in the map → 404, no delete.
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValueOnce({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
      sectionIdMap: new Map(),
      questionIdMap: new Map(),
    });
    prismaMock.appQuestionnaireSection.delete.mockClear();
    const stale = await sectionDELETE(req(), ctx(SECTION_PARAMS));
    expect(stale.status).toBe(404);
    expect(prismaMock.appQuestionnaireSection.delete).not.toHaveBeenCalled();
  });
});

// ─── Question reorder ─────────────────────────────────────────────────────────

describe('question reorder', () => {
  const SECTION_PARAMS = { id: 'qn-1', vid: 'v1', sectionId: 'sec-1' };

  it('rewrites ordinals within a scoped section', async () => {
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({ id: 'sec-1' });
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([{ id: 'q1' }, { id: 'q2' }]);
    prismaMock.appQuestionSlot.update.mockResolvedValue({});

    const res = await reorderQuestionsPATCH(req({ order: ['q2', 'q1'] }), ctx(SECTION_PARAMS));
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionSlot.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'q2' },
      data: { ordinal: 0 },
    });
  });

  it('400s when a reordered question id is absent from the fork map', async () => {
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
      sectionIdMap: new Map([['sec-1', 'sec-1n']]),
      questionIdMap: new Map([['q1', 'q1n']]), // q2 missing
    });
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({ id: 'sec-1' });
    const res = await reorderQuestionsPATCH(req({ order: ['q1', 'q2'] }), ctx(SECTION_PARAMS));
    expect(res.status).toBe(400);
    expect(prismaMock.appQuestionSlot.update).not.toHaveBeenCalled();
  });

  it('404s when the section is not in the version (scope)', async () => {
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue(null);
    const res = await reorderQuestionsPATCH(req({ order: ['q1'] }), ctx(SECTION_PARAMS));
    expect(res.status).toBe(404);
  });

  it('404s when the version does not resolve (scope)', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await reorderQuestionsPATCH(req({ order: ['q1'] }), ctx(SECTION_PARAMS));
    expect(res.status).toBe(404);
  });
});

// ─── Question PATCH / DELETE ──────────────────────────────────────────────────

describe('question edit/delete', () => {
  const QUESTION_PARAMS = { id: 'qn-1', vid: 'v1', questionId: 'q-1' };

  const existingQuestion = {
    id: 'q-1',
    sectionId: 'sec-1',
    ordinal: 0,
    key: 'name',
    prompt: 'Name?',
    guidelines: null,
    rationale: null,
    type: 'free_text',
    typeConfig: null,
    required: false,
    weight: 1,
  };

  it('404s a question from another version (scope check)', async () => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue(null);
    const res = await questionPATCH(req({ prompt: 'x' }), ctx(QUESTION_PARAMS));
    expect(res.status).toBe(404);
  });

  it('rejects a type change whose existing config is incompatible', async () => {
    // free_text → single_choice with no fresh config: the null config fails the
    // choice schema, so the change is rejected before any write.
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue(existingQuestion);
    const res = await questionPATCH(req({ type: 'single_choice' }), ctx(QUESTION_PARAMS));
    expect(res.status).toBe(400);
    expect(prismaMock.appQuestionSlot.update).not.toHaveBeenCalled();
  });

  it('rejects a move to a section not in the version', async () => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue(existingQuestion);
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue(null); // target not found
    const res = await questionPATCH(req({ sectionId: 'foreign-sec' }), ctx(QUESTION_PARAMS));
    expect(res.status).toBe(400);
    expect(prismaMock.appQuestionSlot.update).not.toHaveBeenCalled();
  });

  it('moves a question to a sibling section in the same version', async () => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue(existingQuestion);
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({ id: 'sec-2' });
    prismaMock.appQuestionSlot.count.mockResolvedValue(3); // append at end of target
    prismaMock.appQuestionSlot.update.mockResolvedValue({
      ...existingQuestion,
      sectionId: 'sec-2',
    });

    const res = await questionPATCH(req({ sectionId: 'sec-2' }), ctx(QUESTION_PARAMS));
    expect(res.status).toBe(200);
    const arg = prismaMock.appQuestionSlot.update.mock.calls[0][0];
    expect(arg.data.section).toEqual({ connect: { id: 'sec-2' } });
    expect(arg.data.ordinal).toBe(3);
  });

  it('edits scalar fields without touching type/section', async () => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue(existingQuestion);
    prismaMock.appQuestionSlot.update.mockResolvedValue({ ...existingQuestion, prompt: 'New?' });
    await questionPATCH(
      req({
        prompt: 'New?',
        guidelines: 'g',
        rationale: 'r',
        required: true,
        weight: 0.8,
        ordinal: 1,
      }),
      ctx(QUESTION_PARAMS)
    );
    const data = prismaMock.appQuestionSlot.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      prompt: 'New?',
      guidelines: 'g',
      rationale: 'r',
      required: true,
      weight: 0.8,
      ordinal: 1,
    });
    expect(data).not.toHaveProperty('section'); // no move
    expect(data).not.toHaveProperty('typeConfig'); // type untouched
  });

  it('persists a fidelity change on its own', async () => {
    // The single-question write path for the Structure editor's fidelity slider. Sending only
    // `fidelity` must not disturb any sibling field.
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue(existingQuestion);
    prismaMock.appQuestionSlot.update.mockResolvedValue({ ...existingQuestion, fidelity: 1 });

    await questionPATCH(req({ fidelity: 1 }), ctx(QUESTION_PARAMS));

    const data = prismaMock.appQuestionSlot.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ fidelity: 1 });
    expect(data).not.toHaveProperty('required');
    expect(data).not.toHaveProperty('weight');
    expect(data).not.toHaveProperty('prompt');
  });

  it('rejects a fidelity outside the slider range', async () => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue(existingQuestion);
    const res = await questionPATCH(req({ fidelity: 1.5 }), ctx(QUESTION_PARAMS));
    expect(res.status).toBe(400);
    expect(prismaMock.appQuestionSlot.update).not.toHaveBeenCalled();
  });

  it('resets config on a type-only change to a config-less type', async () => {
    // single_choice → free_text without a fresh config: the stale choices are
    // dropped (reset to null), not re-validated against free_text.
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue({
      ...existingQuestion,
      type: 'single_choice',
      typeConfig: {
        choices: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
    });
    prismaMock.appQuestionSlot.update.mockResolvedValue(existingQuestion);
    const res = await questionPATCH(req({ type: 'free_text' }), ctx(QUESTION_PARAMS));
    expect(res.status).toBe(200);
    const data = prismaMock.appQuestionSlot.update.mock.calls[0][0].data;
    expect(data.typeConfig).toBe(Prisma.JsonNull);
  });

  it('re-validates a typeConfig-only change against the stored type', async () => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue({
      ...existingQuestion,
      type: 'likert',
      typeConfig: { min: 1, max: 5, labels: ['a', 'b', 'c', 'd', 'e'] },
    });
    prismaMock.appQuestionSlot.update.mockResolvedValue(existingQuestion);
    // The stored type (likert) drives validation — a likert now requires per-point labels.
    await questionPATCH(
      req({ typeConfig: { min: 1, max: 3, labels: ['Low', 'Mid', 'High'] } }),
      ctx(QUESTION_PARAMS)
    );
    const data = prismaMock.appQuestionSlot.update.mock.calls[0][0].data;
    expect(data.typeConfig).toEqual({ min: 1, max: 3, labels: ['Low', 'Mid', 'High'] });
  });

  it('moves with an explicit ordinal (no append count)', async () => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue(existingQuestion);
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({ id: 'sec-2' });
    prismaMock.appQuestionSlot.update.mockResolvedValue(existingQuestion);
    await questionPATCH(req({ sectionId: 'sec-2', ordinal: 0 }), ctx(QUESTION_PARAMS));
    const data = prismaMock.appQuestionSlot.update.mock.calls[0][0].data;
    expect(data.section).toEqual({ connect: { id: 'sec-2' } });
    expect(data.ordinal).toBe(0);
    expect(prismaMock.appQuestionSlot.count).not.toHaveBeenCalled();
  });

  it('deletes a scoped question', async () => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue(existingQuestion);
    prismaMock.appQuestionSlot.delete.mockResolvedValue({});
    const res = await questionDELETE(req(), ctx(QUESTION_PARAMS));
    expect(res.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_question.delete' })
    );
  });
});

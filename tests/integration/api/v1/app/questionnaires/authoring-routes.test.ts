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

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
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
  (isFeatureEnabled as unknown as Mock).mockResolvedValue(true);
  setAuth(mockAdminUser());
  (forkVersionIfLaunched as unknown as Mock).mockResolvedValue(noFork());
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
    it(`${name}: 404s when the flag is off, before auth`, async () => {
      (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
      const res = await call();
      expect(res.status).toBe(404);
      expect(auth.api.getSession).not.toHaveBeenCalled();
    });

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

  it('blocks launch when the version is not ready', async () => {
    // draft → launched, but no goal / no sections / no questions.
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({ goal: null });
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(0);
    prismaMock.appQuestionSlot.count.mockResolvedValue(0);

    const res = await statusPATCH(req({ status: 'launched' }), ctx(VERSION_PARAMS));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error.details).toMatchObject({ goal: expect.any(Array) });
  });

  it('launches a ready version and audits the transition', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue({ goal: 'A goal' });
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(2);
    prismaMock.appQuestionSlot.count.mockResolvedValue(5);
    prismaMock.appQuestionnaireVersion.update.mockResolvedValue({
      id: 'v1',
      versionNumber: 1,
      status: 'launched',
    });

    const res = await statusPATCH(req({ status: 'launched' }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_version.status' })
    );
    // Status route never forks.
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
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

  it('derives a key from the prompt and creates the question (201)', async () => {
    prismaMock.appQuestionSlot.create.mockResolvedValue({
      id: 'q-1',
      key: 'do_you_smoke',
      sectionId: 'sec-1',
    });

    const res = await createQuestionPOST(
      req({ prompt: 'Do you smoke?', type: 'boolean' }),
      ctx(QUESTION_PARAMS)
    );
    expect(res.status).toBe(201);
    const data = prismaMock.appQuestionSlot.create.mock.calls[0][0].data;
    expect(data.key).toBe('do_you_smoke');
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_question.create' })
    );
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
    await createQuestionPOST(
      req({
        prompt: 'Rate it',
        type: 'likert',
        key: 'rating',
        guidelines: '1–5',
        rationale: 'satisfaction',
        required: true,
        weight: 2,
        ordinal: 0,
        typeConfig: { min: 1, max: 5 },
      }),
      ctx(QUESTION_PARAMS)
    );
    const data = prismaMock.appQuestionSlot.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      key: 'rating',
      ordinal: 0,
      required: true,
      weight: 2,
      guidelines: '1–5',
      rationale: 'satisfaction',
      typeConfig: { min: 1, max: 5 },
    });
    expect(prismaMock.appQuestionSlot.count).not.toHaveBeenCalled(); // explicit ordinal
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
        weight: 3,
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
      weight: 3,
      ordinal: 1,
    });
    expect(data).not.toHaveProperty('section'); // no move
    expect(data).not.toHaveProperty('typeConfig'); // type untouched
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
      typeConfig: { min: 1, max: 5 },
    });
    prismaMock.appQuestionSlot.update.mockResolvedValue(existingQuestion);
    await questionPATCH(req({ typeConfig: { min: 0, max: 10 } }), ctx(QUESTION_PARAMS));
    const data = prismaMock.appQuestionSlot.update.mock.calls[0][0].data;
    expect(data.typeConfig).toEqual({ min: 0, max: 10 });
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

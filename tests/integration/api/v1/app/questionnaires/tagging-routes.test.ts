/**
 * Integration test: questionnaire tagging mutation routes (F2.2).
 *
 * Exercises the HTTP orchestration of the tag surface with the DB seam (`prisma`)
 * and the fork writer mocked — gate order, auth, scope-404, the create/rename/
 * delete pipeline, normalised-label dedup mapping (P2002 → 400), and the replace-set
 * assignment endpoint: cross-version rejection (before fork), replace semantics,
 * empty-clears, fork question+tag remap, and audit emission.
 *
 * The fork deep-copy itself (vocabulary + assignment re-linking) is unit-tested in
 * fork.test.ts; the pure label/schema logic in the tagging/* unit tests.
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
  appQuestionnaireVersion: { findFirst: vi.fn() },
  appQuestionTag: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  appQuestionSlot: { findFirst: vi.fn() },
  appQuestionSlotTag: { deleteMany: vi.fn(), createMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

// The assignment route replaces links inside a transaction — run the callback
// against the same prisma mock so deleteMany/createMany are recorded.
vi.mock('@/lib/db/utils', () => ({
  executeTransaction: vi.fn((cb: (tx: typeof prismaMock) => unknown) => cb(prismaMock)),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST as createTagPOST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/tags/route';
import {
  PATCH as tagPATCH,
  DELETE as tagDELETE,
} from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/tags/[tagId]/route';
import { PUT as assignPUT } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/questions/[questionId]/tags/route';

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
    url: 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/tags',
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

const TAG_PARAMS = { id: 'qn-1', vid: 'v1', tagId: 'tag-1' };
const VERSION_PARAMS = { id: 'qn-1', vid: 'v1' };
const QUESTION_PARAMS = { id: 'qn-1', vid: 'v1', questionId: 'q1' };

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

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

// ─── Gate + auth matrix ───────────────────────────────────────────────────────

describe('gate order + auth', () => {
  const cases = [
    { name: 'tag POST', call: () => createTagPOST(req({ label: 'Pricing' }), ctx(VERSION_PARAMS)) },
    { name: 'tag PATCH', call: () => tagPATCH(req({ label: 'Pricing' }), ctx(TAG_PARAMS)) },
    { name: 'tag DELETE', call: () => tagDELETE(req(), ctx(TAG_PARAMS)) },
    {
      name: 'assignment PUT',
      call: () => assignPUT(req({ tagIds: [] }), ctx(QUESTION_PARAMS)),
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
  it('tag POST 404s when the id/vid pair does not resolve', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await createTagPOST(req({ label: 'Pricing' }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(404);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it('tag PATCH 404s when the id/vid pair does not resolve', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await tagPATCH(req({ label: 'New' }), ctx(TAG_PARAMS));
    expect(res.status).toBe(404);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it('tag PATCH 404s when the tag is not in the version', async () => {
    prismaMock.appQuestionTag.findFirst.mockResolvedValue(null);
    const res = await tagPATCH(req({ label: 'New' }), ctx(TAG_PARAMS));
    expect(res.status).toBe(404);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it('tag DELETE 404s when the id/vid pair does not resolve', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await tagDELETE(req(), ctx(TAG_PARAMS));
    expect(res.status).toBe(404);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it('tag DELETE 404s when the tag is not in the version', async () => {
    prismaMock.appQuestionTag.findFirst.mockResolvedValue(null);
    const res = await tagDELETE(req(), ctx(TAG_PARAMS));
    expect(res.status).toBe(404);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it('assignment PUT 404s when the id/vid pair does not resolve', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await assignPUT(req({ tagIds: [] }), ctx(QUESTION_PARAMS));
    expect(res.status).toBe(404);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });
});

// ─── Create ───────────────────────────────────────────────────────────────────

describe('tag POST', () => {
  it('creates a tag, derives normalizedLabel server-side, and audits', async () => {
    prismaMock.appQuestionTag.create.mockResolvedValue({
      id: 'tag-1',
      label: 'Go To Market',
      normalizedLabel: 'go to market',
      color: 'blue',
    });

    const res = await createTagPOST(
      req({ label: '  Go To Market ', color: 'blue' }),
      ctx(VERSION_PARAMS)
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.meta).toMatchObject({ forked: false, versionId: 'v1' });
    const data = prismaMock.appQuestionTag.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      versionId: 'v1',
      label: 'Go To Market',
      normalizedLabel: 'go to market',
      color: 'blue',
    });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_tag.create', entityId: 'tag-1' })
    );
  });

  it('rejects a duplicate label before forking (no orphan draft)', async () => {
    // assertTagLabelAvailable finds a clash → 400 before forkVersionIfLaunched runs.
    // Once-scoped so the persistent implementation doesn't leak into sibling tests
    // (clearAllMocks resets call history, not mockResolvedValue).
    prismaMock.appQuestionTag.findFirst.mockResolvedValueOnce({ id: 'tag-existing' });
    const res = await createTagPOST(req({ label: 'Pricing' }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(400);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionTag.create).not.toHaveBeenCalled();
  });

  it('maps a duplicate-label P2002 to a 400 (write-race backstop)', async () => {
    prismaMock.appQuestionTag.create.mockRejectedValue(p2002());
    const res = await createTagPOST(req({ label: 'Pricing' }), ctx(VERSION_PARAMS));
    expect(res.status).toBe(400);
  });

  it('creates on the forked draft when the version is launched', async () => {
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
    });
    prismaMock.appQuestionTag.create.mockResolvedValue({
      id: 'tag-9',
      label: 'Pricing',
      normalizedLabel: 'pricing',
      color: null,
    });

    const res = await createTagPOST(req({ label: 'Pricing' }), ctx(VERSION_PARAMS));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.meta).toMatchObject({ forked: true, versionId: 'v2' });
    expect(prismaMock.appQuestionTag.create.mock.calls[0][0].data.versionId).toBe('v2');
  });
});

// ─── Rename / recolour / delete ───────────────────────────────────────────────

describe('tag PATCH / DELETE', () => {
  beforeEach(() => {
    // Two callers share appQuestionTag.findFirst: loadScopedTag (queries by id →
    // the tag under edit) and assertTagLabelAvailable (queries by normalizedLabel →
    // default: no clash). Distinguish by the where shape so renames aren't falsely
    // rejected. Individual tests override with mockResolvedValueOnce as needed.
    prismaMock.appQuestionTag.findFirst.mockImplementation((args) =>
      Promise.resolve(
        args?.where?.normalizedLabel !== undefined
          ? null
          : { id: 'tag-1', label: 'Old', normalizedLabel: 'old', color: null }
      )
    );
  });

  it('renames a tag, re-deriving normalizedLabel, and audits', async () => {
    prismaMock.appQuestionTag.update.mockResolvedValue({
      id: 'tag-1',
      label: 'New Name',
      normalizedLabel: 'new name',
      color: null,
    });

    const res = await tagPATCH(req({ label: 'New Name' }), ctx(TAG_PARAMS));
    expect(res.status).toBe(200);
    const data = prismaMock.appQuestionTag.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ label: 'New Name', normalizedLabel: 'new name' });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_tag.update', entityId: 'tag-1' })
    );
  });

  it('recolours without touching the label', async () => {
    prismaMock.appQuestionTag.update.mockResolvedValue({ id: 'tag-1' });
    const res = await tagPATCH(req({ color: 'green' }), ctx(TAG_PARAMS));
    expect(res.status).toBe(200);
    const data = prismaMock.appQuestionTag.update.mock.calls[0][0].data;
    expect(data).toEqual({ color: 'green' });
    expect(data).not.toHaveProperty('label');
  });

  it('rejects a rename to an existing label before forking (no orphan draft)', async () => {
    // First findFirst is loadScopedTag (the tag); second is assertTagLabelAvailable
    // (a different tag already holds the target label) → 400 before forking.
    prismaMock.appQuestionTag.findFirst
      .mockResolvedValueOnce({ id: 'tag-1', label: 'Old', normalizedLabel: 'old', color: null })
      .mockResolvedValueOnce({ id: 'tag-2' });
    const res = await tagPATCH(req({ label: 'Taken' }), ctx(TAG_PARAMS));
    expect(res.status).toBe(400);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionTag.update).not.toHaveBeenCalled();
  });

  it('maps a rename-collision P2002 to a 400 (write-race backstop)', async () => {
    prismaMock.appQuestionTag.update.mockRejectedValue(p2002());
    const res = await tagPATCH(req({ label: 'Clash' }), ctx(TAG_PARAMS));
    expect(res.status).toBe(400);
  });

  it('propagates a non-P2002 update error as a 500 (not a dedup 400)', async () => {
    prismaMock.appQuestionTag.update.mockRejectedValue(new Error('connection reset'));
    const res = await tagPATCH(req({ label: 'New' }), ctx(TAG_PARAMS));
    expect(res.status).toBe(500);
  });

  it('deletes a tag and audits', async () => {
    prismaMock.appQuestionTag.delete.mockResolvedValue({ id: 'tag-1' });
    const res = await tagDELETE(req(), ctx(TAG_PARAMS));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ id: 'tag-1', deleted: true });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_tag.delete', entityId: 'tag-1' })
    );
  });
});

// ─── Replace-set assignment ───────────────────────────────────────────────────

describe('assignment PUT', () => {
  beforeEach(() => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue({ id: 'q1', key: 'full_name' });
  });

  it('404s when the question is not in the version', async () => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue(null);
    const res = await assignPUT(req({ tagIds: ['t1'] }), ctx(QUESTION_PARAMS));
    expect(res.status).toBe(404);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it('rejects a cross-version tag id with a 400, before forking', async () => {
    // Only one of the two requested ids resolves in this version.
    prismaMock.appQuestionTag.findMany.mockResolvedValueOnce([{ id: 't1' }]);
    const res = await assignPUT(req({ tagIds: ['t1', 't-other'] }), ctx(QUESTION_PARAMS));
    expect(res.status).toBe(400);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionSlotTag.deleteMany).not.toHaveBeenCalled();
  });

  it('replaces the set: clears then re-creates the validated links, and audits', async () => {
    // Single validation query carries label/color — the response is built from it
    // (no readback). Returned out of order to prove the response sorts by label.
    prismaMock.appQuestionTag.findMany.mockResolvedValueOnce([
      { id: 't2', label: 'Optional', color: null, normalizedLabel: 'optional' },
      { id: 't1', label: 'Core', color: 'blue', normalizedLabel: 'core' },
    ]);

    const res = await assignPUT(req({ tagIds: ['t1', 't2'] }), ctx(QUESTION_PARAMS));
    const json = await res.json();

    expect(res.status).toBe(200);
    // Exactly one tag query — the validation fetch; no second readback round-trip.
    expect(prismaMock.appQuestionTag.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.appQuestionSlotTag.deleteMany).toHaveBeenCalledWith({
      where: { questionSlotId: 'q1' },
    });
    expect(prismaMock.appQuestionSlotTag.createMany).toHaveBeenCalledWith({
      data: [
        { questionSlotId: 'q1', tagId: 't2' },
        { questionSlotId: 'q1', tagId: 't1' },
      ],
    });
    // Response projects to {id,label,color} and is ordered by normalized label.
    expect(json.data.tags).toEqual([
      { id: 't1', label: 'Core', color: 'blue' },
      { id: 't2', label: 'Optional', color: null },
    ]);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_tag.assign', entityId: 'q1' })
    );
  });

  it('clears all assignments on an empty set without a create or a tag lookup', async () => {
    const res = await assignPUT(req({ tagIds: [] }), ctx(QUESTION_PARAMS));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionSlotTag.deleteMany).toHaveBeenCalledWith({
      where: { questionSlotId: 'q1' },
    });
    expect(prismaMock.appQuestionSlotTag.createMany).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionTag.findMany).not.toHaveBeenCalled();
    expect(json.data.tags).toEqual([]);
  });

  it('remaps the question and tag ids through the fork map when launched', async () => {
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
      questionIdMap: new Map([['q1', 'q1-new']]),
      tagIdMap: new Map([['t1', 't1-new']]),
    });
    // Validation runs against the original version (id 't1'); the response remaps to
    // the forked copy's id ('t1-new') while carrying the label/color from validation.
    prismaMock.appQuestionTag.findMany.mockResolvedValueOnce([
      { id: 't1', label: 'Core', color: 'blue', normalizedLabel: 'core' },
    ]);

    const res = await assignPUT(req({ tagIds: ['t1'] }), ctx(QUESTION_PARAMS));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.meta).toMatchObject({ forked: true, versionId: 'v2' });
    expect(prismaMock.appQuestionSlotTag.deleteMany).toHaveBeenCalledWith({
      where: { questionSlotId: 'q1-new' },
    });
    expect(prismaMock.appQuestionSlotTag.createMany).toHaveBeenCalledWith({
      data: [{ questionSlotId: 'q1-new', tagId: 't1-new' }],
    });
    expect(json.data.tags).toEqual([{ id: 't1-new', label: 'Core', color: 'blue' }]);
  });

  it('409s when a validated tag did not survive the fork (concurrent delete)', async () => {
    // Validation passed against the original version, but the fork map lacks the
    // tag — surfaced as a 409 rather than a silent partial assignment.
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
      questionIdMap: new Map([['q1', 'q1-new']]),
      tagIdMap: new Map(), // t1 not copied
    });
    prismaMock.appQuestionTag.findMany.mockResolvedValueOnce([
      { id: 't1', label: 'Core', color: 'blue', normalizedLabel: 'core' },
    ]);

    const res = await assignPUT(req({ tagIds: ['t1'] }), ctx(QUESTION_PARAMS));
    expect(res.status).toBe(409);
    expect(prismaMock.appQuestionSlotTag.createMany).not.toHaveBeenCalled();
  });
});

/**
 * Integration test: extraction-change review routes (F2.3).
 *
 * Exercises the HTTP orchestration of the list + revert surface with the DB seam
 * (`prisma`), the fork writer, and the transaction wrapper mocked — gate order,
 * auth, scope-404, list enrichment + filters, the revert happy paths (one per
 * family), the clean-failure 422 (no writes), re-revert 409, the launched-version
 * fork (inverse applied to the draft, source row flipped), and audit emission.
 *
 * The pure revert planner is unit-tested exhaustively in
 * extraction-review/planner.test.ts; here we assert the route wiring around it.
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

vi.mock('@/app/api/v1/app/questionnaires/_lib/fork', () => ({ forkVersionIfLaunched: vi.fn() }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  appQuestionnaireExtractionChange: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    groupBy: vi.fn(),
    update: vi.fn(),
  },
  appQuestionnaireSection: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  appQuestionSlot: {
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));
// test-review:accept mock-realism — executeTransaction runs the callback eagerly with
// no rollback. Modelling rollback-on-throw would need a fake transactional store; we
// don't, because the route dry-runs the planner BEFORE any write (the 422-writes-nothing
// path is asserted separately), so the executor only runs against a validated plan.
vi.mock('@/lib/db/utils', () => ({
  executeTransaction: vi.fn((cb: (tx: typeof prismaMock) => unknown) => cb(prismaMock)),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET as listGET } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/changes/route';
import { POST as revertPOST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/changes/[changeId]/revert/route';

import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { mockAdminUser, mockAuthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

function req(
  url = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/changes'
): NextRequest {
  return { url, headers: new Headers(), json: async () => ({}) } as unknown as NextRequest;
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

const VERSION_PARAMS = { id: 'qn-1', vid: 'v1' };
const REVERT_PARAMS = { id: 'qn-1', vid: 'v1', changeId: 'chg-1' };

interface ChangeRow {
  id: string;
  changeType: string;
  targetEntityType: string;
  targetEntityId: string | null;
  sourceQuote: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  rationale: string | null;
  confidence: number | null;
  status: string;
  revertedAt: Date | null;
  createdAt: Date;
}

function changeRow(over: Partial<ChangeRow> & { id: string; changeType: string }): ChangeRow {
  return {
    targetEntityType: 'version',
    targetEntityId: 'v1',
    sourceQuote: null,
    beforeJson: null,
    afterJson: null,
    rationale: null,
    confidence: null,
    status: 'applied',
    revertedAt: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    ...over,
  };
}

/** A snapshot version row for `buildGraphSnapshot` (findUnique). */
function snapshotRow(over?: Record<string, unknown>) {
  return {
    goal: 'Measure satisfaction',
    goalProvenance: 'inferred',
    audience: null,
    audienceProvenance: null,
    sections: [],
    ...over,
  };
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
  prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(snapshotRow());
  prismaMock.appQuestionnaireVersion.update.mockResolvedValue({});
  prismaMock.appQuestionnaireExtractionChange.findMany.mockResolvedValue([]);
  prismaMock.appQuestionnaireExtractionChange.groupBy.mockResolvedValue([]);
  prismaMock.appQuestionnaireExtractionChange.update.mockResolvedValue({});
  prismaMock.appQuestionSlot.findMany.mockResolvedValue([]);
  // Safe defaults for the executor write mocks. `vi.clearAllMocks()` resets call
  // history but NOT implementations set via `mockResolvedValue`, so without these a
  // value set in one test would bleed into later tests in execution order.
  prismaMock.appQuestionSlot.count.mockResolvedValue(0);
  prismaMock.appQuestionSlot.create.mockResolvedValue({ id: 'new-q' });
  prismaMock.appQuestionSlot.delete.mockResolvedValue({ id: 'deleted-q' });
  prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue(null);
  prismaMock.appQuestionnaireSection.create.mockResolvedValue({ id: 'new-sec' });
  prismaMock.appQuestionnaireSection.update.mockResolvedValue({});
  prismaMock.appQuestionnaireSection.delete.mockResolvedValue({ id: 'deleted-sec' });
});

// ─── Gate + auth ──────────────────────────────────────────────────────────────

describe('gate + auth', () => {
  it('returns 404 when the flag is off, before auth', async () => {
    (isFeatureEnabled as unknown as Mock).mockResolvedValue(false);
    const res = await listGET(req(), ctx(VERSION_PARAMS));
    expect(res.status).toBe(404);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    const res = await listGET(req(), ctx(VERSION_PARAMS));
    expect(res.status).toBe(403);
  });

  it('returns 404 when the version does not resolve (list)', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await listGET(req(), ctx(VERSION_PARAMS));
    expect(res.status).toBe(404);
  });

  it('returns 404 when the change does not resolve (revert)', async () => {
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(null);
    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(404);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });
});

// ─── List ─────────────────────────────────────────────────────────────────────

describe('GET changes', () => {
  it('lists rows with status counts and a per-row revert verdict', async () => {
    prismaMock.appQuestionnaireExtractionChange.findMany.mockResolvedValue([
      changeRow({ id: 'chg-1', changeType: 'infer_goal', afterJson: 'Measure satisfaction' }),
    ]);
    prismaMock.appQuestionnaireExtractionChange.groupBy.mockResolvedValue([
      { status: 'applied', _count: { _all: 1 } },
    ]);

    const res = await listGET(req(), ctx(VERSION_PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.counts).toEqual({ applied: 1, reverted: 0 });
    expect(body.data.changes).toHaveLength(1);
    // goalProvenance is 'inferred' in the snapshot → this infer_goal is revertable.
    expect(body.data.changes[0].revertable).toBe(true);
    expect(body.data.changes[0].revertSummary).toMatch(/goal/i);
  });

  it('marks a change unrevertable with a typed reason when it can’t be reconciled', async () => {
    // An infer_goal whose goal the admin has since taken over → graph_drift.
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      snapshotRow({ goalProvenance: 'admin-supplied' })
    );
    prismaMock.appQuestionnaireExtractionChange.findMany.mockResolvedValue([
      changeRow({ id: 'chg-1', changeType: 'infer_goal', afterJson: 'Old goal' }),
    ]);

    const res = await listGET(req(), ctx(VERSION_PARAMS));
    const body = await res.json();
    expect(body.data.changes[0].revertable).toBe(false);
    expect(body.data.changes[0].revertBlockedReason).toBe('graph_drift');
  });

  it('passes the status filter through to the query', async () => {
    await listGET(
      req(
        'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/changes?status=reverted'
      ),
      ctx(VERSION_PARAMS)
    );
    expect(prismaMock.appQuestionnaireExtractionChange.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'reverted', versionId: 'v1' }),
      })
    );
  });

  it('passes the changeType filter through to the query', async () => {
    await listGET(
      req(
        'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/changes?changeType=infer_goal'
      ),
      ctx(VERSION_PARAMS)
    );
    expect(prismaMock.appQuestionnaireExtractionChange.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ changeType: 'infer_goal', versionId: 'v1' }),
      })
    );
  });

  it('passes the targetEntityType filter through to the query', async () => {
    await listGET(
      req(
        'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/changes?targetEntityType=question'
      ),
      ctx(VERSION_PARAMS)
    );
    expect(prismaMock.appQuestionnaireExtractionChange.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ targetEntityType: 'question', versionId: 'v1' }),
      })
    );
  });

  it('returns an empty/unrevertable enrichment when the version snapshot is gone', async () => {
    // buildGraphSnapshot falls back to EMPTY_SNAPSHOT when findUnique resolves null;
    // a prune_question then has no section to restore into → unrevertable.
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(null);
    prismaMock.appQuestionnaireExtractionChange.findMany.mockResolvedValue([
      changeRow({
        id: 'chg-1',
        changeType: 'prune_question',
        targetEntityType: 'question',
        targetEntityId: null,
        beforeJson: { prompt: 'Dropped?' },
      }),
    ]);

    const res = await listGET(req(), ctx(VERSION_PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.changes[0].revertable).toBe(false);
    expect(body.data.changes[0].revertBlockedReason).toBe('target_not_found');
  });

  it('rejects an unknown filter value with 400', async () => {
    const res = await listGET(
      req('http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/changes?status=bogus'),
      ctx(VERSION_PARAMS)
    );
    expect(res.status).toBe(400);
  });
});

// ─── Revert ─────────────────────────────────────────────────────────────────

describe('POST revert', () => {
  it('reverts an infer_goal: clears the goal and flips the row', async () => {
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(
      changeRow({ id: 'chg-1', changeType: 'infer_goal', afterJson: 'Measure satisfaction' })
    );

    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('reverted');

    // The version goal was cleared…
    expect(prismaMock.appQuestionnaireVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ goal: null, goalProvenance: null }),
      })
    );
    // …and the source change row marked reverted.
    expect(prismaMock.appQuestionnaireExtractionChange.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'chg-1' },
        data: expect.objectContaining({ status: 'reverted' }),
      })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'questionnaire_change.revert' })
    );
  });

  it('re-creates a pruned question and flips the row', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      snapshotRow({
        sections: [{ id: 'sec-1', ordinal: 0, title: 'A', description: null, questions: [] }],
      })
    );
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(
      changeRow({
        id: 'chg-1',
        changeType: 'prune_question',
        targetEntityType: 'question',
        targetEntityId: null,
        beforeJson: { prompt: 'Dropped question?' },
      })
    );
    prismaMock.appQuestionSlot.count.mockResolvedValue(0);
    prismaMock.appQuestionSlot.create.mockResolvedValue({ id: 'new-q' });

    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionSlot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sectionId: 'sec-1', prompt: 'Dropped question?' }),
      })
    );
  });

  it('returns 422 REVERT_IMPOSSIBLE and writes nothing when the target is ambiguous', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      snapshotRow({
        sections: [
          {
            id: 'sec-1',
            ordinal: 0,
            title: 'A',
            description: null,
            questions: [baseQ('q1', 'Same prompt'), baseQ('q2', 'Same prompt')],
          },
        ],
      })
    );
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(
      changeRow({
        id: 'chg-1',
        changeType: 'rewrite_prompt',
        targetEntityType: 'question',
        targetEntityId: null,
        beforeJson: { prompt: 'old' },
        afterJson: { prompt: 'Same prompt' },
      })
    );

    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('REVERT_IMPOSSIBLE');
    expect(body.error.details.reason).toBe('ambiguous_target');
    // No fork (dry-run failed first) and no row flip.
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionnaireExtractionChange.update).not.toHaveBeenCalled();
  });

  it('returns 409 when the change was already reverted', async () => {
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(
      changeRow({ id: 'chg-1', changeType: 'infer_goal', status: 'reverted' })
    );
    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(409);
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it('on a launched version, forks and flips the source row, returning fork meta', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      id: 'v1',
      questionnaireId: 'qn-1',
      versionNumber: 1,
      status: 'launched',
    });
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
      versionId: 'draft-2',
      forked: true,
      versionNumber: 2,
    });
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(
      changeRow({ id: 'chg-1', changeType: 'infer_goal', afterJson: 'Measure satisfaction' })
    );

    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('reverted');
    expect(body.meta.forked).toBe(true);
    expect(body.meta.versionId).toBe('draft-2');
    // Inverse applied to the DRAFT…
    expect(prismaMock.appQuestionnaireVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'draft-2' } })
    );
    // …source change row (chg-1) still flipped.
    expect(prismaMock.appQuestionnaireExtractionChange.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'chg-1' } })
    );
  });
});

// ─── Revert executor: one case per applyOp arm ────────────────────────────────

describe('POST revert · executor write-path', () => {
  it('set-audience: clears the still-inferred subset and writes the remaining audience', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      snapshotRow({
        audience: { role: 'Manager', locale: 'en' },
        audienceProvenance: { role: 'inferred', locale: 'admin-supplied' },
      })
    );
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(
      changeRow({ id: 'chg-1', changeType: 'infer_audience', afterJson: { role: 'Manager' } })
    );

    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(200);
    // `role` (inferred) cleared, `locale` (admin) retained → a non-null audience write.
    expect(prismaMock.appQuestionnaireVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ audience: { locale: 'en' } }),
      })
    );
  });

  it('set-audience: writes JsonNull when every inferred field is cleared', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      snapshotRow({ audience: { role: 'Manager' }, audienceProvenance: { role: 'inferred' } })
    );
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(
      changeRow({ id: 'chg-1', changeType: 'infer_audience', afterJson: { role: 'Manager' } })
    );

    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(200);
    const call = prismaMock.appQuestionnaireVersion.update.mock.calls[0][0];
    // A null audience must be written as the Prisma.JsonNull sentinel, not literal null
    // (literal null would be interpreted as "no change" / DbNull depending on column).
    expect(call.data.audience).toBe(Prisma.JsonNull);
    expect(call.data.audienceProvenance).toBe(Prisma.JsonNull);
  });

  it('update-question: restores the prior prompt onto the matched question', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      snapshotRow({
        sections: [
          {
            id: 'sec-1',
            ordinal: 0,
            title: 'A',
            description: null,
            questions: [baseQ('q1', 'New prompt')],
          },
        ],
      })
    );
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(
      changeRow({
        id: 'chg-1',
        changeType: 'rewrite_prompt',
        targetEntityType: 'question',
        targetEntityId: null,
        beforeJson: { prompt: 'Old prompt' },
        afterJson: { prompt: 'New prompt' },
      })
    );

    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'q1' }, data: { prompt: 'Old prompt' } })
    );
  });

  it('update-question: clears an augmented guideline (augment_question)', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      snapshotRow({
        sections: [
          {
            id: 'sec-1',
            ordinal: 0,
            title: 'A',
            description: null,
            questions: [{ ...baseQ('q1', 'Q'), guidelines: 'Added help' }],
          },
        ],
      })
    );
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(
      changeRow({
        id: 'chg-1',
        changeType: 'augment_question',
        targetEntityType: 'question',
        targetEntityId: null,
        beforeJson: { prompt: 'Q' },
        afterJson: { prompt: 'Q', guidelines: 'Added help' },
      })
    );

    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(200);
    // The augmentation is reverted by clearing the guideline the edit added.
    expect(prismaMock.appQuestionSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'q1' },
        data: expect.objectContaining({ guidelines: null }),
      })
    );
  });

  it('update-question: restores the prior type + config (infer_type)', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      snapshotRow({
        sections: [
          {
            id: 'sec-1',
            ordinal: 0,
            title: 'A',
            description: null,
            questions: [{ ...baseQ('q1', 'Pick?'), type: 'numeric' }],
          },
        ],
      })
    );
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(
      changeRow({
        id: 'chg-1',
        changeType: 'infer_type',
        targetEntityType: 'question',
        targetEntityId: null,
        beforeJson: { type: 'numeric', typeConfig: { min: 0, max: 5 } },
        afterJson: { type: 'numeric' },
      })
    );

    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'q1' },
        data: expect.objectContaining({ type: 'numeric', typeConfig: { min: 0, max: 5 } }),
      })
    );
  });

  it('update-section: restores a section title from beforeJson (correct_spelling)', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      snapshotRow({
        sections: [{ id: 'sec-1', ordinal: 0, title: 'Setcion', description: null, questions: [] }],
      })
    );
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(
      changeRow({
        id: 'chg-1',
        changeType: 'correct_spelling',
        targetEntityType: 'section',
        targetEntityId: null,
        beforeJson: { title: 'Section' },
        afterJson: { title: 'Setcion' },
      })
    );

    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionnaireSection.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sec-1' }, data: { title: 'Section' } })
    );
  });

  it('create-section: re-creates a pruned section with its questions at the append ordinal', async () => {
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(
      changeRow({
        id: 'chg-1',
        changeType: 'prune_section',
        targetEntityType: 'section',
        targetEntityId: null,
        beforeJson: {
          title: 'Demographics',
          description: 'About you',
          questions: [
            {
              prompt: 'Your age?',
              guidelines: 'A number',
              rationale: 'needed',
              typeConfig: { min: 0 },
            },
          ],
        },
      })
    );
    // Existing section sits at ordinal 2 → the re-created section appends at 3.
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({ ordinal: 2 });
    prismaMock.appQuestionnaireSection.create.mockResolvedValue({ id: 'restored-sec' });
    prismaMock.appQuestionSlot.create.mockResolvedValue({ id: 'restored-q' });

    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionnaireSection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ordinal: 3,
          title: 'Demographics',
          description: 'About you',
        }),
      })
    );
    // The child question is created with the restored guidelines/rationale/typeConfig.
    expect(prismaMock.appQuestionSlot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sectionId: 'restored-sec',
          prompt: 'Your age?',
          guidelines: 'A number',
          rationale: 'needed',
        }),
      })
    );
  });

  it('delete-question + create-question: reverts a merge back into its sources', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      snapshotRow({
        sections: [
          {
            id: 'sec-1',
            ordinal: 0,
            title: 'A',
            description: null,
            questions: [baseQ('merged', 'Combined Q')],
          },
        ],
      })
    );
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(
      changeRow({
        id: 'chg-1',
        changeType: 'merge_questions',
        targetEntityType: 'question',
        targetEntityId: null,
        beforeJson: [{ prompt: 'Source one' }, { prompt: 'Source two' }],
        afterJson: { prompt: 'Combined Q' },
      })
    );
    prismaMock.appQuestionSlot.count.mockResolvedValue(1);
    prismaMock.appQuestionSlot.delete.mockResolvedValue({ id: 'merged' });
    prismaMock.appQuestionSlot.create.mockResolvedValue({ id: 'new-source' });

    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionSlot.delete).toHaveBeenCalledWith({ where: { id: 'merged' } });
    expect(prismaMock.appQuestionSlot.create).toHaveBeenCalledTimes(2);
  });

  it('delete-section: removes an added section that is still empty', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      snapshotRow({
        sections: [{ id: 'sec-1', ordinal: 0, title: 'Added', description: null, questions: [] }],
      })
    );
    prismaMock.appQuestionnaireExtractionChange.findFirst.mockResolvedValue(
      changeRow({
        id: 'chg-1',
        changeType: 'add_section',
        targetEntityType: 'section',
        targetEntityId: null,
        afterJson: { title: 'Added' },
      })
    );
    prismaMock.appQuestionnaireSection.delete.mockResolvedValue({ id: 'sec-1' });

    const res = await revertPOST(req(), ctx(REVERT_PARAMS));
    expect(res.status).toBe(200);
    expect(prismaMock.appQuestionnaireSection.delete).toHaveBeenCalledWith({
      where: { id: 'sec-1' },
    });
  });
});

// ─── List enrichment over a populated graph ───────────────────────────────────

describe('GET changes · enrichment over a populated snapshot', () => {
  it('projects the graph, derives a target label per op kind, and tallies reverted rows', async () => {
    prismaMock.appQuestionnaireVersion.findUnique.mockResolvedValue(
      snapshotRow({
        goalProvenance: 'not-a-real-provenance', // exercises the asFieldProvenance reject path
        audience: { role: 'Manager' },
        audienceProvenance: { role: 'inferred' },
        sections: [
          {
            id: 'sec-1',
            ordinal: 0,
            title: 'Background',
            description: 'desc',
            questions: [baseQ('q1', 'What is your role?')],
          },
          { id: 'sec-2', ordinal: 1, title: 'Extras', description: null, questions: [] },
        ],
      })
    );
    prismaMock.appQuestionnaireExtractionChange.findMany.mockResolvedValue([
      // set-audience → label 'Audience'
      changeRow({ id: 'c-aud', changeType: 'infer_audience', afterJson: { role: 'Manager' } }),
      // update-question → label is the resolved question key 'q1'
      changeRow({
        id: 'c-edit',
        changeType: 'rewrite_prompt',
        targetEntityType: 'question',
        targetEntityId: null,
        beforeJson: { prompt: 'old' },
        afterJson: { prompt: 'What is your role?' },
      }),
      // create-section → label is the section title from beforeJson
      changeRow({
        id: 'c-prune-s',
        changeType: 'prune_section',
        targetEntityType: 'section',
        targetEntityId: null,
        beforeJson: { title: 'Demographics', questions: [] },
      }),
      // create-question → label is the resolved parent section title 'Background'
      changeRow({
        id: 'c-prune-q',
        changeType: 'prune_question',
        targetEntityType: 'question',
        targetEntityId: null,
        beforeJson: { prompt: 'Dropped?' },
      }),
      // update-section → label is the resolved section title 'Background'
      changeRow({
        id: 'c-sec',
        changeType: 'correct_spelling',
        targetEntityType: 'section',
        targetEntityId: null,
        beforeJson: { title: 'Old BG' },
        afterJson: { title: 'Background' },
      }),
      // delete-section → label is the (empty) added section's title 'Extras'
      changeRow({
        id: 'c-add',
        changeType: 'add_section',
        targetEntityType: 'section',
        targetEntityId: null,
        afterJson: { title: 'Extras' },
      }),
      // already-reverted row → no verdict, counted under `reverted`
      changeRow({ id: 'c-done', changeType: 'infer_goal', status: 'reverted' }),
    ]);
    prismaMock.appQuestionnaireExtractionChange.groupBy.mockResolvedValue([
      { status: 'applied', _count: { _all: 6 } },
      { status: 'reverted', _count: { _all: 1 } },
    ]);

    const res = await listGET(req(), ctx(VERSION_PARAMS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.counts).toEqual({ applied: 6, reverted: 1 });
    const byId = Object.fromEntries(body.data.changes.map((c: { id: string }) => [c.id, c]));
    expect(byId['c-aud'].resolvedTargetLabel).toBe('Audience');
    expect(byId['c-edit'].resolvedTargetLabel).toBe('q1');
    expect(byId['c-prune-s'].resolvedTargetLabel).toBe('Demographics');
    expect(byId['c-prune-q'].resolvedTargetLabel).toBe('Background');
    expect(byId['c-sec'].resolvedTargetLabel).toBe('Background');
    expect(byId['c-add'].resolvedTargetLabel).toBe('Extras');
    // A reverted row carries no verdict.
    expect(byId['c-done'].revertable).toBe(false);
    expect(byId['c-done'].revertBlockedReason).toBeNull();
  });
});

/** A snapshot question row (matches the buildGraphSnapshot question select). */
function baseQ(id: string, prompt: string) {
  return {
    id,
    sectionId: 'sec-1',
    ordinal: 0,
    key: id,
    prompt,
    guidelines: null,
    rationale: null,
    type: 'free_text',
    typeConfig: null,
    required: false,
    weight: 1,
  };
}
